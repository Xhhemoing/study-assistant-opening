import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type { OpeningScope } from "./opening-sources";

export type CandidateDecision = "accepted" | "discarded";
export type OpeningCandidate = { id: string; workspaceId: string; conversationId: string; sourceTurnId: string; sourceIds: string[]; payload: unknown; status: "pending" | "accepted" | "discarded"; createdAt: string; updatedAt: string };

function map(row: Record<string, unknown>): OpeningCandidate {
  return { id: row.id as string, workspaceId: row.workspace_id as string, conversationId: row.conversation_id as string, sourceTurnId: row.source_turn_id as string, sourceIds: (row.source_ids as string[]) ?? [], payload: row.payload, status: row.status as OpeningCandidate["status"], createdAt: new Date(row.created_at as string | Date).toISOString(), updatedAt: new Date(row.updated_at as string | Date).toISOString() };
}

export function createOpeningCandidateRepository(sql: Sql) {
  return {
    async saveCandidate(scope: OpeningScope, input: { conversationId: string; sourceTurnId: string; sourceIds: string[]; payload: unknown }) {
      const rows = await sql`INSERT INTO opening_assistant_candidates (id, workspace_id, conversation_id, source_turn_id, source_ids, payload) VALUES (${randomUUID()}, ${scope.workspaceId}, ${input.conversationId}, ${input.sourceTurnId}, ${sql.json(input.sourceIds as never)}, ${sql.json(input.payload as never)}) RETURNING *`;
      return map(rows[0] as Record<string, unknown>);
    },
    async listPending(scope: OpeningScope) {
      const rows = await sql`
        SELECT c.*
        FROM opening_assistant_candidates c
        INNER JOIN opening_conversations conv
          ON conv.id = c.conversation_id
         AND conv.workspace_id = c.workspace_id
         AND conv.owner_user_id = ${scope.ownerUserId}
        WHERE c.workspace_id = ${scope.workspaceId}
          AND c.status = 'pending'
        ORDER BY c.created_at ASC`;
      return rows.map((row) => map(row as Record<string, unknown>));
    },
    async decide(scope: OpeningScope, id: string, decision: CandidateDecision) {
      const rows = await sql`
        UPDATE opening_assistant_candidates c
        SET status = ${decision}, updated_at = now()
        WHERE c.id = ${id} AND c.workspace_id = ${scope.workspaceId} AND c.status = 'pending'
          AND EXISTS (
            SELECT 1 FROM opening_conversations conv
            WHERE conv.id = c.conversation_id
              AND conv.workspace_id = c.workspace_id
              AND conv.owner_user_id = ${scope.ownerUserId}
          )
        RETURNING c.*`;
      if (!rows.length) return null;
      return map(rows[0] as Record<string, unknown>);
    },
  };
}
export type OpeningCandidateRepository = ReturnType<typeof createOpeningCandidateRepository>;
