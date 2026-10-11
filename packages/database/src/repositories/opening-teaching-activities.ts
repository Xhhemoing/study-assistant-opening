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
  };
}

export type OpeningTeachingActivitiesRepository = ReturnType<
  typeof createOpeningTeachingActivitiesRepository
>;
