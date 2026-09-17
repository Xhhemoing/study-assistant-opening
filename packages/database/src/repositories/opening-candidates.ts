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
      const rows = await sql`SELECT * FROM opening_assistant_candidates WHERE workspace_id = ${scope.workspaceId} AND status = 'pending' ORDER BY created_at ASC`;
      return rows.map((row) => map(row as Record<string, unknown>));
    },
    async decide(scope: OpeningScope, id: string, decision: CandidateDecision) {
      const rows = await sql`UPDATE opening_assistant_candidates SET status = ${decision}, updated_at = now() WHERE id = ${id} AND workspace_id = ${scope.workspaceId} AND status = 'pending' RETURNING *`;
      if (!rows.length) return null;
      return map(rows[0] as Record<string, unknown>);
    },
  };
}
export type OpeningCandidateRepository = ReturnType<typeof createOpeningCandidateRepository>;
