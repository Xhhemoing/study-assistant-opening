import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Sql } from "postgres";
import type {
  Scope,
  TeachingActivity,
  TeachingActivityAssociateCourseInput,
  TeachingActivityCreateInput,
} from "@aistudy/contracts";
import {
  admitLearningSources,
  learningError,
  learningIso,
  lockLearningOwner,
} from "./opening-learning-facts";

function mapTeachingActivity(row: Record<string, unknown>): TeachingActivity {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    ownerUserId: String(row.owner_user_id),
    courseId: (row.course_id ?? null) as string | null,
    status: row.status as TeachingActivity["status"],
    generateStatus: row.generate_status as TeachingActivity["generateStatus"],
    intentKind: row.intent_kind as TeachingActivity["intentKind"],
    intentSummary: String(row.intent_summary),
    sourceIds: (row.source_ids ?? []) as string[],
    pathVersion: Number(row.path_version),
    contentVersion: Number(row.content_version),
    checkpointJson: (row.checkpoint_json ?? undefined) as TeachingActivity["checkpointJson"],
    clientKey: String(row.client_key),
    createdAt: learningIso(row.created_at)!,
    updatedAt: learningIso(row.updated_at)!,
  };
}

export async function assertOwnedActivity(
  sql: Sql,
  scope: Scope,
  activityId: string,
): Promise<TeachingActivity> {
  const rows = await sql`
    SELECT a.* FROM opening_teaching_activities a
    JOIN workspaces w ON w.id = a.workspace_id AND w.owner_user_id = ${scope.ownerUserId}
    WHERE a.id = ${activityId}
      AND a.workspace_id = ${scope.workspaceId}
      AND a.owner_user_id = ${scope.ownerUserId}`;
  if (!rows.length) throw learningError("NOT_FOUND", "teaching activity not found");
  return mapTeachingActivity(rows[0] as Record<string, unknown>);
}

/** Resolve or create the synthetic course_continue activity used by v1 course entry. */
export async function ensureCourseContinueActivity(
  sql: Sql,
  scope: Scope,
  courseId: string,
): Promise<string> {
  const clientKey = `legacy-course-continue:${courseId}`;
  const createIntent = { intentKind: "course_continue", courseId, legacy: true };
  return sql.begin(async (tx) => {
    await lockLearningOwner(tx, scope);
    const existing = await tx`
      SELECT id FROM opening_teaching_activities
      WHERE workspace_id = ${scope.workspaceId}
        AND owner_user_id = ${scope.ownerUserId}
        AND client_key = ${clientKey}
      FOR UPDATE`;
    if (existing[0]) return String(existing[0].id);
    const course = await tx`
      SELECT id FROM courses
      WHERE id = ${courseId} AND workspace_id = ${scope.workspaceId} AND archived_at IS NULL
      FOR SHARE`;
    if (!course.length) throw learningError("NOT_FOUND", "course not found");
    const id = randomUUID();
    const rows = await tx`
      INSERT INTO opening_teaching_activities (
        id, workspace_id, owner_user_id, course_id, status, generate_status,
        intent_kind, intent_summary, source_ids, goal_json, path_version, content_version,
        checkpoint_json, client_key, create_intent
      ) VALUES (
        ${id}, ${scope.workspaceId}, ${scope.ownerUserId}, ${courseId}, 'active', 'ready',
        'course_continue', 'Legacy course activity', ${[] as string[]}, ${tx.json({})},
        1, 0, ${tx.json({})}, ${clientKey}, ${tx.json(createIntent as never)}
      )
      ON CONFLICT (workspace_id, owner_user_id, client_key) DO NOTHING
      RETURNING id`;
    if (rows[0]) return String(rows[0].id);
    const raced = await tx`
      SELECT id FROM opening_teaching_activities
      WHERE workspace_id = ${scope.workspaceId}
        AND owner_user_id = ${scope.ownerUserId}
        AND client_key = ${clientKey}`;
    if (!raced[0]) throw learningError("CONFLICT", "course continue activity write conflict");
    return String(raced[0].id);
  });
}

export function createOpeningTeachingActivitiesRepository(sql: Sql) {
  return {
    assertOwnedActivity: (scope: Scope, activityId: string) =>
      assertOwnedActivity(sql, scope, activityId),

    async get(scope: Scope, activityId: string): Promise<TeachingActivity | null> {
      try {
        return await assertOwnedActivity(sql, scope, activityId);
      } catch (error) {
        if ((error as { code?: string }).code === "NOT_FOUND") return null;
        throw error;
      }
    },

    async listByOwner(scope: Scope): Promise<TeachingActivity[]> {
      const rows = await sql`
        SELECT a.* FROM opening_teaching_activities a
        JOIN workspaces w ON w.id = a.workspace_id AND w.owner_user_id = ${scope.ownerUserId}
        WHERE a.workspace_id = ${scope.workspaceId}
          AND a.owner_user_id = ${scope.ownerUserId}
        ORDER BY a.updated_at DESC, a.id`;
      return rows.map((row) => mapTeachingActivity(row as Record<string, unknown>));
    },

    async create(scope: Scope, input: TeachingActivityCreateInput): Promise<TeachingActivity> {
      return sql.begin(async (tx) => {
        await lockLearningOwner(tx, scope);
        const sourceIds = [...new Set(input.sourceIds ?? [])].sort();
        if (sourceIds.length) await admitLearningSources(tx, scope, sourceIds);
        if (input.courseId) {
          const course = await tx`
            SELECT id FROM courses
            WHERE id = ${input.courseId}
              AND workspace_id = ${scope.workspaceId}
              AND archived_at IS NULL
            FOR SHARE`;
          if (!course.length) throw learningError("NOT_FOUND", "course not found");
        }
        const replay = await tx`
          SELECT * FROM opening_teaching_activities
          WHERE workspace_id = ${scope.workspaceId}
            AND owner_user_id = ${scope.ownerUserId}
            AND client_key = ${input.clientKey}
          FOR UPDATE`;
        if (replay[0]) {
          if (!isDeepStrictEqual(replay[0].create_intent, input.createIntent)) {
            throw learningError("CONFLICT", "activity clientKey payload conflict");
          }
          return mapTeachingActivity(replay[0] as Record<string, unknown>);
        }
        const id = randomUUID();
        const goalJson = input.goalJson ?? {};
        const rows = await tx`
          INSERT INTO opening_teaching_activities (
            id, workspace_id, owner_user_id, course_id, status, generate_status,
            intent_kind, intent_summary, source_ids, goal_json, path_version, content_version,
            checkpoint_json, client_key, create_intent
          ) VALUES (
            ${id}, ${scope.workspaceId}, ${scope.ownerUserId}, ${input.courseId ?? null},
            'active', 'ready', ${input.intentKind}, ${input.intentSummary}, ${sourceIds},
            ${tx.json(goalJson as never)}, 1, 0, ${tx.json({})}, ${input.clientKey},
            ${tx.json(input.createIntent as never)}
          )
          ON CONFLICT (workspace_id, owner_user_id, client_key) DO NOTHING
          RETURNING *`;
        if (!rows[0]) throw learningError("CONFLICT", "activity clientKey already used");
        return mapTeachingActivity(rows[0] as Record<string, unknown>);
      });
    },

    /**
     * Associate / unassociate course on the activity row only.
     * Never rewrites historical observation/attempt course_id (ADR D5 #4).
     */
    async associateCourse(
      scope: Scope,
      activityId: string,
      input: TeachingActivityAssociateCourseInput,
    ): Promise<TeachingActivity> {
      return sql.begin(async (tx) => {
        await lockLearningOwner(tx, scope);
        const rows = await tx`
          SELECT * FROM opening_teaching_activities
          WHERE id = ${activityId}
            AND workspace_id = ${scope.workspaceId}
            AND owner_user_id = ${scope.ownerUserId}
          FOR UPDATE`;
        if (!rows.length) throw learningError("NOT_FOUND", "teaching activity not found");
        const current = rows[0] as Record<string, unknown>;
        if (input.expectedUpdatedAt) {
          const currentUpdated = learningIso(current.updated_at);
          if (currentUpdated !== input.expectedUpdatedAt) {
            throw learningError("CONFLICT", "teaching activity updated_at mismatch");
          }
        }
        if (input.courseId) {
          const course = await tx`
            SELECT id FROM courses
            WHERE id = ${input.courseId}
              AND workspace_id = ${scope.workspaceId}
              AND archived_at IS NULL
            FOR SHARE`;
          if (!course.length) throw learningError("NOT_FOUND", "course not found");
          if ((current.source_ids as string[]).length) {
            await admitLearningSources(tx, scope, current.source_ids as string[]);
          }
        }
        const updated = await tx`
          UPDATE opening_teaching_activities
          SET course_id = ${input.courseId}, updated_at = now()
          WHERE id = ${activityId}
            AND workspace_id = ${scope.workspaceId}
            AND owner_user_id = ${scope.ownerUserId}
          RETURNING *`;
        return mapTeachingActivity(updated[0] as Record<string, unknown>);
      });
    },

    /**
     * Fence generate_status transitions (V2-07). Returns false when no row matched the from-set.
     */
    async setGenerateStatus(
      scope: Scope,
      activityId: string,
      status: TeachingActivity["generateStatus"],
      options?: { from?: readonly TeachingActivity["generateStatus"][] },
    ): Promise<boolean> {
      const from = options?.from;
      if (from && from.length) {
        const fromList = [...from];
        const rows = await sql`
          UPDATE opening_teaching_activities
          SET generate_status = ${status}, updated_at = now()
          WHERE id = ${activityId}
            AND workspace_id = ${scope.workspaceId}
            AND owner_user_id = ${scope.ownerUserId}
            AND generate_status = ANY(${fromList}::text[])
          RETURNING id`;
        return rows.length > 0;
      }
      const rows = await sql`
        UPDATE opening_teaching_activities
        SET generate_status = ${status}, updated_at = now()
        WHERE id = ${activityId}
          AND workspace_id = ${scope.workspaceId}
          AND owner_user_id = ${scope.ownerUserId}
        RETURNING id`;
      return rows.length > 0;
    },

    /**
     * Enqueue compile-teaching-unit (V2-07). Key = compile-teaching-unit:{activityId}:{mode}:{clientKey}.
     * On create: outbox + activity generate_status=queued.
     */
    async enqueueCompileTeachingUnit(
      scope: Scope,
      input: {
        activityId: string;
        mode: "generate" | "repair";
        clientKey: string;
        expectedContentVersion: number;
        teachingUnitId?: string;
        expectedUnitVersion?: number;
        sourceIds?: string[];
      },
    ): Promise<{ jobId: string; kind: "compile-teaching-unit"; created: boolean }> {
      if (input.clientKey.length < 8) {
        throw learningError("VALIDATION", "clientKey is too short");
      }
      if (input.mode !== "generate" && input.mode !== "repair") {
        throw learningError("VALIDATION", "mode must be generate|repair");
      }
      if (
        typeof input.expectedContentVersion !== "number" ||
        !Number.isInteger(input.expectedContentVersion) ||
        input.expectedContentVersion < 0
      ) {
        throw learningError("VALIDATION", "expectedContentVersion must be a non-negative integer");
      }
      if (input.mode === "repair" && !input.teachingUnitId) {
        throw learningError("VALIDATION", "repair requires teachingUnitId");
      }
      await assertOwnedActivity(sql, scope, input.activityId);
      const key = `compile-teaching-unit:${input.activityId}:${input.mode}:${input.clientKey}`;
      const payload = {
        mode: input.mode,
        activityId: input.activityId,
        expectedContentVersion: input.expectedContentVersion,
        clientKey: input.clientKey,
        ...(input.teachingUnitId ? { teachingUnitId: input.teachingUnitId } : {}),
        ...(input.expectedUnitVersion != null
          ? { expectedUnitVersion: input.expectedUnitVersion }
          : {}),
        ...(input.sourceIds ? { sourceIds: [...input.sourceIds].sort() } : {}),
      };
      return sql.begin(async (tx) => {
        const [workspace] = await tx`
          SELECT privacy_epoch FROM workspaces
          WHERE id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId} FOR SHARE`;
        if (!workspace) throw learningError("NOT_FOUND", "workspace not found");
        const privacyEpoch = Number((workspace as { privacy_epoch?: number }).privacy_epoch ?? 0);
        const jobId = randomUUID();
        const inserted = await tx`
          INSERT INTO opening_jobs (id, workspace_id, owner_user_id, key, kind, payload, privacy_epoch)
          VALUES (
            ${jobId}, ${scope.workspaceId}, ${scope.ownerUserId}, ${key},
            ${"compile-teaching-unit"}, ${tx.json(payload as never)}, ${privacyEpoch}
          )
          ON CONFLICT (workspace_id, key) DO NOTHING
          RETURNING id`;
        if (inserted.length) {
          await tx`
            INSERT INTO opening_outbox (workspace_id, job_id, topic, payload)
            VALUES (
              ${scope.workspaceId}, ${jobId}, ${"opening.job.enqueue"},
              ${tx.json({ jobId, kind: "compile-teaching-unit", activityId: input.activityId } as never)}
            )`;
          await tx`
            UPDATE opening_teaching_activities
            SET generate_status = ${"queued"}, updated_at = now()
            WHERE id = ${input.activityId}
              AND workspace_id = ${scope.workspaceId}
              AND owner_user_id = ${scope.ownerUserId}`;
          return { jobId, kind: "compile-teaching-unit" as const, created: true };
        }
        const existing = await tx`
          SELECT id, payload FROM opening_jobs
          WHERE workspace_id = ${scope.workspaceId} AND key = ${key}`;
        const row = existing[0] as Record<string, unknown> | undefined;
        if (!row) throw learningError("NOT_FOUND", "compile job disappeared after conflict");
        if (JSON.stringify(row.payload) !== JSON.stringify(payload)) {
          throw learningError("CONFLICT", "idempotency payload differs for the same key");
        }
        return { jobId: String(row.id), kind: "compile-teaching-unit" as const, created: false };
      });
    },
  };
}

export type OpeningTeachingActivitiesRepository = ReturnType<
  typeof createOpeningTeachingActivitiesRepository
>;
