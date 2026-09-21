import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type { Citation } from "@aistudy/contracts";
import type { OpeningScope } from "./opening-sources";
import { loadTutorHistory } from "./opening-tutor-history";

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
  async function markTerminal(input: {
    scope: OpeningScope;
    jobId: string;
    message: string;
    status: "failed" | "outcome_unknown";
  }): Promise<void> {
    await sql.begin(async (tx) => {
      const rows = input.status === "failed"
        ? await tx`
            UPDATE opening_tutor_jobs SET status = 'failed', error = ${tx.json({ message: input.message } as never)},
              updated_at = now()
            WHERE id = ${input.jobId} AND workspace_id = ${input.scope.workspaceId}
              AND status IN ('running', 'queued')
            RETURNING assistant_turn_id
          `
        : await tx`
            UPDATE opening_tutor_jobs SET status = 'outcome_unknown',
              error = ${tx.json({ message: input.message } as never)}, updated_at = now()
            WHERE id = ${input.jobId} AND workspace_id = ${input.scope.workspaceId}
              AND status = 'running'
            RETURNING assistant_turn_id
          `;
      if (!rows.length) return;
      const assistantTurnId = (rows[0] as Record<string, unknown>).assistant_turn_id as string;
      if (input.status === "failed") {
        await tx`
          UPDATE opening_turns SET text = ${input.message}, status = 'failed'
          WHERE id = ${assistantTurnId} AND workspace_id = ${input.scope.workspaceId}
        `;
      } else {
        await tx`
          UPDATE opening_turns SET text = ${input.message}, status = 'outcome_unknown'
          WHERE id = ${assistantTurnId} AND workspace_id = ${input.scope.workspaceId}
        `;
      }
    });
  }

  return {
    loadHistory: (scope: OpeningScope, currentTurnId: string) => loadTutorHistory(sql, scope, currentTurnId),
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
        SELECT j.* FROM opening_tutor_jobs j
        JOIN opening_conversations c ON c.id = j.conversation_id
        WHERE j.id = ${id}
          AND j.workspace_id = ${scope.workspaceId}
          AND c.workspace_id = ${scope.workspaceId}
          AND c.owner_user_id = ${scope.ownerUserId}
        LIMIT 1
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
      citations: Citation[];
      candidates: Array<{ payload: unknown; sourceIds: string[] }>;
      helpExposure?: {
        id: string;
        sessionId: string;
        problemId: string | null;
        turnId: string;
        level: "hinted" | "revealed";
        delivered: true;
      };
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
        const assistant = await tx`
          UPDATE opening_turns SET text = ${input.text}, citations = ${tx.json(input.citations as never)}, status = 'complete'
          WHERE id = ${input.assistantTurnId} AND workspace_id = ${input.scope.workspaceId}
          RETURNING id
        `;
        if (!assistant.length) throw new Error("assistant turn was not persisted");
        if (input.helpExposure) {
          const session = await tx`
            SELECT id FROM opening_learning_sessions
            WHERE id = ${input.helpExposure.sessionId}
              AND workspace_id = ${input.scope.workspaceId}
              AND owner_user_id = ${input.scope.ownerUserId}
            LIMIT 1
          `;
          if (!session.length) throw new Error("session not found");
          await tx`
            INSERT INTO opening_help_exposures
              (id, workspace_id, session_id, problem_id, turn_id, level, delivered)
            VALUES (
              ${input.helpExposure.id}, ${input.scope.workspaceId},
              ${input.helpExposure.sessionId}, ${input.helpExposure.problemId},
              ${input.helpExposure.turnId}, ${input.helpExposure.level}, TRUE
            )
          `;
        }
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
      sourceVersions: Record<string, number>;
      currentPage: number | null;
      chunkId: string | null;
      learningSessionId: string | null;
    } | null> {
      const rows = await sql`
        SELECT text, mode, source_ids, source_versions, current_page, chunk_id, learning_session_id FROM opening_turns
        WHERE id = ${id} AND workspace_id = ${workspaceId} LIMIT 1
      `;
      if (!rows.length) return null;
      const row = rows[0] as Record<string, unknown>;
      return {
        text: row.text as string,
        mode: row.mode as string,
        sourceIds: (row.source_ids as string[]) ?? [],
        sourceVersions: (row.source_versions as Record<string, number>) ?? {},
        currentPage: (row.current_page as number | null) ?? null,
        chunkId: (row.chunk_id as string | null) ?? null,
        learningSessionId: (row.learning_session_id as string | null) ?? null,
      };
    },

    async fail(scope: OpeningScope, jobId: string, message: string): Promise<void> {
      await markTerminal({ scope, jobId, message, status: "failed" });
    },

    async markUnknown(scope: OpeningScope, jobId: string, message: string): Promise<void> {
      await markTerminal({ scope, jobId, message, status: "outcome_unknown" });
    },
  };
}
