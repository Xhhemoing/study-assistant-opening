import { createHash, randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type {
  PlanDraft,
  PlannedBlock,
  TaskCreateInput,
  TaskItem,
  TimeBlock,
  WeekSession,
} from "@aistudy/contracts";
import type { OpeningScope } from "./opening-sources";

export type OpeningPlanErrorCode = "NOT_FOUND" | "VALIDATION" | "CONFLICT";

export class OpeningPlanError extends Error {
  readonly code: OpeningPlanErrorCode;
  constructor(code: OpeningPlanErrorCode, message: string) {
    super(message);
    this.name = "OpeningPlanError";
    this.code = code;
  }
}

export type ProposePlanInput = {
  date: string;
  tasks: TaskItem[];
  free: TimeBlock[];
  blocks: PlannedBlock[];
  unscheduledTaskIds: string[];
  clientKey?: string | null;
};

function fingerprintHardBlocks(blocks: TimeBlock[]): string {
  const hard = blocks
    .filter((b) => b.kind !== "free")
    .map((b) => `${b.kind}:${b.start}:${b.end}`)
    .sort();
  return createHash("sha256").update(hard.join("|")).digest("hex");
}

function mapTask(row: Record<string, unknown>): TaskItem {
  return {
    id: row.id as string,
    title: row.title as string,
    minutes: Number(row.minutes),
    dueAt: row.due_at ? new Date(row.due_at as string | Date).toISOString() : null,
    priority: Number(row.priority),
    status: row.status as TaskItem["status"],
  };
}

function mapDraft(row: Record<string, unknown>): PlanDraft {
  return {
    id: row.id as string,
    date: String(row.day),
    version: Number(row.version),
    baseVersion: Number(row.base_version),
    status: row.status as PlanDraft["status"],
    blocks: (row.blocks as PlannedBlock[]) ?? [],
    unscheduledTaskIds: (row.unscheduled_task_ids as string[]) ?? [],
  };
}

export function createOpeningPlansRepository(sql: Sql) {
  return {
    async listTasks(scope: OpeningScope): Promise<TaskItem[]> {
      const rows = await sql`
        SELECT * FROM opening_tasks
        WHERE workspace_id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
        ORDER BY created_at ASC`;
      return rows.map((r) => mapTask(r as Record<string, unknown>));
    },

    async createTask(
      scope: OpeningScope,
      input: TaskCreateInput & { dueText?: string | null },
    ): Promise<TaskItem> {
      if (input.dueText && input.dueAt) {
        throw new OpeningPlanError("VALIDATION", "ambiguous dueText cannot become a formal deadline");
      }
      const id = randomUUID();
      return sql.begin(async (tx) => {
        if (input.candidateId) {
          const consumed = await tx`
            UPDATE opening_assistant_candidates
            SET status = 'accepted', updated_at = now()
            WHERE id = ${input.candidateId}
              AND workspace_id = ${scope.workspaceId}
              AND status = 'pending'
            RETURNING id`;
          if (!consumed.length) {
            throw new OpeningPlanError("CONFLICT", "candidate missing or already consumed");
          }
        }
        const rows = await tx`
          INSERT INTO opening_tasks (
            id, workspace_id, owner_user_id, title, minutes, due_at, due_text,
            priority, status, version, candidate_id
          ) VALUES (
            ${id}, ${scope.workspaceId}, ${scope.ownerUserId}, ${input.title}, ${input.minutes},
            ${input.dueAt}, ${input.dueText ?? null}, ${input.priority}, ${"pending"}, ${1},
            ${input.candidateId}
          ) RETURNING *`;
        return mapTask(rows[0] as Record<string, unknown>);
      });
    },

    async listTimetable(scope: OpeningScope): Promise<WeekSession[]> {
      const rows = await sql`
        SELECT * FROM opening_timetable_sessions
        WHERE workspace_id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
        ORDER BY weekday, start_period`;
      return rows.map((row) => {
        const r = row as Record<string, unknown>;
        return {
          courseName: r.course_name as string,
          courseId: (r.course_id as string | null) ?? null,
          weekday: Number(r.weekday),
          weeks: (r.weeks as number[]) ?? [],
          startPeriod: Number(r.start_period),
          endPeriod: Number(r.end_period),
        };
      });
    },

    async replaceTimetable(scope: OpeningScope, sessions: WeekSession[]): Promise<WeekSession[]> {
      await sql.begin(async (tx) => {
        await tx`DELETE FROM opening_timetable_sessions
          WHERE workspace_id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}`;
        for (const s of sessions) {
          await tx`
            INSERT INTO opening_timetable_sessions (
              id, workspace_id, owner_user_id, course_name, course_id, weekday, weeks, start_period, end_period
            ) VALUES (
              ${randomUUID()}, ${scope.workspaceId}, ${scope.ownerUserId}, ${s.courseName},
              ${s.courseId ?? null}, ${s.weekday}, ${s.weeks}, ${s.startPeriod}, ${s.endPeriod}
            )`;
        }
      });
      return this.listTimetable(scope);
    },

    async listHardBlocks(scope: OpeningScope, day: string): Promise<TimeBlock[]> {
      const rows = await sql`
        SELECT start_at, end_at, kind FROM opening_hard_blocks
        WHERE workspace_id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
          AND day = ${day}::date`;
      return rows.map((row) => {
        const r = row as Record<string, unknown>;
        return {
          start: new Date(r.start_at as string | Date).toISOString(),
          end: new Date(r.end_at as string | Date).toISOString(),
          kind: r.kind as TimeBlock["kind"],
        };
      });
    },

    async upsertHardBlocks(scope: OpeningScope, day: string, blocks: TimeBlock[]): Promise<void> {
      await sql.begin(async (tx) => {
        await tx`DELETE FROM opening_hard_blocks
          WHERE workspace_id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
            AND day = ${day}::date`;
        for (const b of blocks.filter((x) => x.kind !== "free")) {
          await tx`
            INSERT INTO opening_hard_blocks (
              id, workspace_id, owner_user_id, day, start_at, end_at, kind
            ) VALUES (
              ${randomUUID()}, ${scope.workspaceId}, ${scope.ownerUserId}, ${day}::date,
              ${b.start}, ${b.end}, ${b.kind}
            )`;
        }
        const fp = fingerprintHardBlocks(blocks);
        await tx`
          INSERT INTO opening_plan_state (workspace_id, day, hard_blocks_fingerprint)
          VALUES (${scope.workspaceId}, ${day}::date, ${fp})
          ON CONFLICT (workspace_id, day) DO UPDATE
            SET hard_blocks_fingerprint = EXCLUDED.hard_blocks_fingerprint, updated_at = now()`;
      });
    },

    async getToday(scope: OpeningScope, day: string): Promise<{
      acceptedVersion: number;
      blocks: PlannedBlock[];
      hardBlocksFingerprint: string;
    } | null> {
      const rows = await sql`
        SELECT accepted_version, accepted_blocks, hard_blocks_fingerprint FROM opening_plan_state
        WHERE workspace_id = ${scope.workspaceId} AND day = ${day}::date`;
      if (!rows.length) return null;
      const r = rows[0] as Record<string, unknown>;
      return {
        acceptedVersion: Number(r.accepted_version),
        blocks: (r.accepted_blocks as PlannedBlock[]) ?? [],
        hardBlocksFingerprint: String(r.hard_blocks_fingerprint ?? ""),
      };
    },

    async proposePlan(scope: OpeningScope, input: ProposePlanInput): Promise<PlanDraft> {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
        throw new OpeningPlanError("VALIDATION", "date must be YYYY-MM-DD (no invented dates)");
      }
      const state = await this.getToday(scope, input.date);
      const baseVersion = state?.acceptedVersion ?? 0;
      const fp = fingerprintHardBlocks(input.free);
      const id = randomUUID();
      const snapshot = {
        tasks: input.tasks,
        free: input.free,
        proposedAt: new Date().toISOString(),
      };
      const rows = await sql`
        INSERT INTO opening_plan_drafts (
          id, workspace_id, owner_user_id, day, version, base_version, status,
          blocks, unscheduled_task_ids, input_snapshot, hard_blocks_fingerprint, propose_client_key
        ) VALUES (
          ${id}, ${scope.workspaceId}, ${scope.ownerUserId}, ${input.date}::date, ${0}, ${baseVersion},
          ${"draft"}, ${sql.json(input.blocks as never)}, ${sql.json(input.unscheduledTaskIds as never)},
          ${sql.json(snapshot as never)}, ${fp}, ${input.clientKey ?? null}
        ) RETURNING *`;
      return mapDraft(rows[0] as Record<string, unknown>);
    },

    async rejectPlan(scope: OpeningScope, draftId: string): Promise<PlanDraft> {
      const rows = await sql`
        UPDATE opening_plan_drafts SET status = 'rejected', updated_at = now()
        WHERE id = ${draftId} AND workspace_id = ${scope.workspaceId}
          AND owner_user_id = ${scope.ownerUserId} AND status = 'draft'
        RETURNING *`;
      if (!rows.length) throw new OpeningPlanError("NOT_FOUND", "draft not found");
      return mapDraft(rows[0] as Record<string, unknown>);
    },

    async acceptPlan(
      scope: OpeningScope,
      input: { draftId: string; expectedBaseVersion: number; clientKey: string },
    ): Promise<PlanDraft> {
      const payloadHash = createHash("sha256")
        .update(JSON.stringify({ draftId: input.draftId, expectedBaseVersion: input.expectedBaseVersion }))
        .digest("hex");

      return sql.begin(async (tx) => {
        const existing = await tx`
          SELECT draft_id, payload_hash FROM opening_plan_acceptances
          WHERE workspace_id = ${scope.workspaceId} AND client_key = ${input.clientKey}
          FOR UPDATE`;
        if (existing.length) {
          const row = existing[0] as Record<string, unknown>;
          if (String(row.payload_hash) !== payloadHash) {
            throw new OpeningPlanError("CONFLICT", "clientKey payload differs");
          }
          const drafts = await tx`SELECT * FROM opening_plan_drafts WHERE id = ${row.draft_id as string}`;
          if (!drafts.length) throw new OpeningPlanError("NOT_FOUND", "accepted draft missing");
          return mapDraft(drafts[0] as Record<string, unknown>);
        }

        const drafts = await tx`
          SELECT * FROM opening_plan_drafts
          WHERE id = ${input.draftId} AND workspace_id = ${scope.workspaceId}
            AND owner_user_id = ${scope.ownerUserId}
          FOR UPDATE`;
        if (!drafts.length) throw new OpeningPlanError("NOT_FOUND", "draft not found");
        const draft = drafts[0] as Record<string, unknown>;
        if (draft.status !== "draft") {
          throw new OpeningPlanError("CONFLICT", "draft is not open");
        }
        const day = String(draft.day);

        await tx`SELECT workspace_id FROM opening_plan_state
          WHERE workspace_id = ${scope.workspaceId} AND day = ${day}::date
          FOR UPDATE`;
        const stateRows = await tx`
          SELECT accepted_version, hard_blocks_fingerprint FROM opening_plan_state
          WHERE workspace_id = ${scope.workspaceId} AND day = ${day}::date`;
        const acceptedVersion = stateRows.length
          ? Number((stateRows[0] as Record<string, unknown>).accepted_version)
          : 0;
        const currentFp = stateRows.length
          ? String((stateRows[0] as Record<string, unknown>).hard_blocks_fingerprint ?? "")
          : "";

        if (Number(draft.base_version) !== input.expectedBaseVersion) {
          throw new OpeningPlanError("CONFLICT", "stale expectedBaseVersion");
        }
        if (acceptedVersion !== Number(draft.base_version)) {
          throw new OpeningPlanError("CONFLICT", "stale draft baseVersion");
        }
        if (currentFp && currentFp !== String(draft.hard_blocks_fingerprint)) {
          throw new OpeningPlanError("CONFLICT", "hard blocks changed; draft stale");
        }

        const nextVersion = acceptedVersion + 1;
        const blocks = (draft.blocks as PlannedBlock[]) ?? [];
        await tx`
          INSERT INTO opening_plan_state (
            workspace_id, day, accepted_version, accepted_blocks, hard_blocks_fingerprint
          ) VALUES (
            ${scope.workspaceId}, ${day}::date, ${nextVersion}, ${tx.json(blocks as never)},
            ${String(draft.hard_blocks_fingerprint)}
          )
          ON CONFLICT (workspace_id, day) DO UPDATE SET
            accepted_version = EXCLUDED.accepted_version,
            accepted_blocks = EXCLUDED.accepted_blocks,
            hard_blocks_fingerprint = EXCLUDED.hard_blocks_fingerprint,
            updated_at = now()`;

        const updated = await tx`
          UPDATE opening_plan_drafts
          SET status = 'accepted', version = ${nextVersion}, updated_at = now()
          WHERE id = ${input.draftId}
          RETURNING *`;

        await tx`
          INSERT INTO opening_plan_acceptances (
            workspace_id, client_key, draft_id, day, accepted_version, payload_hash
          ) VALUES (
            ${scope.workspaceId}, ${input.clientKey}, ${input.draftId}, ${day}::date,
            ${nextVersion}, ${payloadHash}
          )`;

        return mapDraft(updated[0] as Record<string, unknown>);
      });
    },
  };
}

export type OpeningPlansRepository = ReturnType<typeof createOpeningPlansRepository>;
