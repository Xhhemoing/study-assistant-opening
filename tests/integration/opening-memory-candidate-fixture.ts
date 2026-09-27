import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type { OpeningScope } from "@aistudy/database";

export async function insertOwnedConversation(sql: Sql, scope: OpeningScope): Promise<string> {
  const conversationId = randomUUID();
  await sql`
    INSERT INTO opening_conversations (id, workspace_id, owner_user_id, title)
    VALUES (${conversationId}, ${scope.workspaceId}, ${scope.ownerUserId}, 'candidate')`;
  return conversationId;
}

export async function insertTurn(
  sql: Sql,
  scope: OpeningScope,
  conversationId: string,
  input: {
    status?: "pending" | "complete" | "failed";
    sourceIds?: string[];
    citations?: unknown;
  } = {},
): Promise<string> {
  const turnId = randomUUID();
  await sql`
    INSERT INTO opening_turns (
      id, workspace_id, conversation_id, role, text, mode, status, source_ids, citations
    ) VALUES (
      ${turnId}, ${scope.workspaceId}, ${conversationId}, 'assistant', 'reply', 'explain',
      ${input.status ?? "complete"}, ${sql.array(input.sourceIds ?? [])}::uuid[],
      ${sql.json((input.citations ?? []) as never)}
    )`;
  return turnId;
}

export async function insertCandidate(
  sql: Sql,
  scope: OpeningScope,
  input: {
    conversationId: string;
    sourceTurnId: string;
    sourceIds?: string[];
    payload: unknown;
    id?: string;
  },
): Promise<string> {
  const id = input.id ?? randomUUID();
  await sql`
    INSERT INTO opening_assistant_candidates (
      id, workspace_id, conversation_id, source_turn_id, source_ids, payload, status
    ) VALUES (
      ${id}, ${scope.workspaceId}, ${input.conversationId}, ${input.sourceTurnId},
      ${sql.json((input.sourceIds ?? []) as never)}, ${sql.json(input.payload as never)}, 'pending'
    )`;
  return id;
}

export async function counts(sql: Sql, scope: OpeningScope): Promise<{ memories: number; accepted: number }> {
  const [memories] = await sql`
    SELECT count(*)::int AS n FROM opening_memories WHERE workspace_id = ${scope.workspaceId}`;
  const [accepted] = await sql`
    SELECT count(*)::int AS n FROM opening_assistant_candidates
    WHERE workspace_id = ${scope.workspaceId} AND status = 'accepted'`;
  return { memories: memories!.n as number, accepted: accepted!.n as number };
}
