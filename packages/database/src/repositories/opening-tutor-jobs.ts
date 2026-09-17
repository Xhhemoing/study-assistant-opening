import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type { OpeningScope } from "./opening-sources";

export type OpeningTutorJobRecord = {
  id: string;
  workspaceId: string;
  ownerUserId?: string;
  conversationId: string;
  userTurnId: string;
  assistantTurnId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "outcome_unknown";
  mode: string;
  error: { message: string } | null;
  createdAt: string;
  updatedAt: string;
};

function mapJob(row: Record<string, unknown>): OpeningTutorJobRecord {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    conversationId: row.conversation_id as string,
    userTurnId: row.user_turn_id as string,
    assistantTurnId: row.assistant_turn_id as string,
    status: row.status as OpeningTutorJobRecord["status"],
    mode: row.mode as string,
    error: (row.error as OpeningTutorJobRecord["error"]) ?? null,
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString(),
  };
}

export type OpeningTutorJobsRepository = ReturnType<typeof createOpeningTutorJobsRepository>;

/**
 * Durable tutor job state machine (0017). Claims are CAS so a BullMQ
 * redelivery rechecks the DB before executing; results are written ONCE
 * transactionally together with the assistant turn and candidates.
 */
export function createOpeningTutorJobsRepository(sql: Sql) {
  return {
    async claim(id: string): Promise<OpeningTutorJobRecord | null> {
      const rows = await sql`
        UPDATE opening_tutor_jobs j SET status = 'running', updated_at = now()
        FROM workspaces w
        WHERE j.id = ${id} AND j.workspace_id = w.id
          AND j.status IN ('queued', 'running')
          AND (j.status = 'queued' OR j.updated_at < now() - interval '5 minutes')
        RETURNING j.*, w.owner_user_id
      `;
      if (!rows.length) return null;
      const row = rows[0] as Record<string, unknown>;
      return { ...mapJob(row), ownerUserId: row.owner_user_id as string };
    },

    async get(scope: OpeningScope, id: string): Promise<OpeningTutorJobRecord | null> {
      const rows = await sql`
        SELECT * FROM opening_tutor_jobs
        WHERE id = ${id} AND workspace_id = ${scope.workspaceId} LIMIT 1
      `;
      return rows.length ? mapJob(rows[0] as Record<string, unknown>) : null;
    },

    async listQueued(limit: number): Promise<OpeningTutorJobRecord[]> {
      const rows = await sql`
        SELECT * FROM opening_tutor_jobs WHERE status = 'queued'
        ORDER BY created_at ASC LIMIT ${limit}
      `;
      return rows.map((row) => mapJob(row as Record<string, unknown>));
    },

    /**
     * One transaction: assistant turn completes, validated candidates are
     * stored pending with program-assigned provenance, job succeeds.
     */
    async completeTurn(input: {
      scope: OpeningScope;
      jobId: string;
      assistantTurnId: string;
      text: string;
      candidates: Array<{ payload: unknown; sourceIds: string[] }>;
    }): Promise<void> {
      await sql.begin(async (tx) => {
        const claimed = await tx`
          UPDATE opening_tutor_jobs SET status = 'succeeded', error = NULL, updated_at = now()
          WHERE id = ${input.jobId}
            AND workspace_id = ${input.scope.workspaceId}
            AND status = 'running'
          RETURNING id
        `;
        if (!claimed.length) return;
        await tx`
          UPDATE opening_turns SET text = ${input.text}, status = 'complete'
          WHERE id = ${input.assistantTurnId} AND workspace_id = ${input.scope.workspaceId}
        `;
        for (const candidate of input.candidates) {
          await tx`
            INSERT INTO opening_assistant_candidates (
              id, workspace_id, conversation_id, source_turn_id, source_ids, payload
            ) VALUES (
              ${randomUUID()}, ${input.scope.workspaceId},
              (SELECT conversation_id FROM opening_tutor_jobs WHERE id = ${input.jobId}),
              ${input.assistantTurnId},
              ${tx.json(candidate.sourceIds as never)}, ${tx.json(candidate.payload as never)}
            )
          `;
        }
      });
    },

    async getUserTurn(id: string, workspaceId: string): Promise<{
      text: string;
      mode: string;
      sourceIds: string[];
      currentPage: number | null;
      chunkId: string | null;
    } | null> {
      const rows = await sql`
        SELECT text, mode, source_ids, current_page, chunk_id FROM opening_turns
        WHERE id = ${id} AND workspace_id = ${workspaceId} LIMIT 1
      `;
      if (!rows.length) return null;
      const row = rows[0] as Record<string, unknown>;
      return {
        text: row.text as string,
        mode: row.mode as string,
        sourceIds: (row.source_ids as string[]) ?? [],
        currentPage: (row.current_page as number | null) ?? null,
        chunkId: (row.chunk_id as string | null) ?? null,
      };
    },

    async fail(scope: OpeningScope, jobId: string, message: string): Promise<void> {
      await sql`
        UPDATE opening_tutor_jobs SET status = 'failed', error = ${sql.json({ message } as never)},
          updated_at = now()
        WHERE id = ${jobId} AND workspace_id = ${scope.workspaceId}
          AND status IN ('running', 'queued')
      `;
    },

    async markUnknown(scope: OpeningScope, jobId: string, message: string): Promise<void> {
      await sql`
        UPDATE opening_tutor_jobs SET status = 'outcome_unknown',
          error = ${sql.json({ message } as never)}, updated_at = now()
        WHERE id = ${jobId} AND workspace_id = ${scope.workspaceId}
          AND status = 'running'
      `;
    },
  };
}
