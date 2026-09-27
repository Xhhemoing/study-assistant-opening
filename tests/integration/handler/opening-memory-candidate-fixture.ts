import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";

export async function insertOwnedConversation(
  sql: Sql,
  scope: { workspaceId: string; userId: string },
): Promise<string> {
  const conversationId = randomUUID();
  await sql`
    INSERT INTO opening_conversations (id, workspace_id, owner_user_id, title)
    VALUES (${conversationId}, ${scope.workspaceId}, ${scope.userId}, 'handler candidate')`;
  return conversationId;
}

export async function insertCompleteTurn(
  sql: Sql,
  scope: { workspaceId: string },
  conversationId: string,
): Promise<string> {
  const turnId = randomUUID();
  await sql`
    INSERT INTO opening_turns (
      id, workspace_id, conversation_id, role, text, mode, status, source_ids, citations
    ) VALUES (
      ${turnId}, ${scope.workspaceId}, ${conversationId}, 'assistant', 'reply', 'explain',
      'complete', ${sql.array([] as string[])}::uuid[], ${sql.json([] as never)}
    )`;
  return turnId;
}

export async function insertPendingMemoryCandidate(
  sql: Sql,
  scope: { workspaceId: string },
  input: { conversationId: string; sourceTurnId: string; text: string },
): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO opening_assistant_candidates (
      id, workspace_id, conversation_id, source_turn_id, source_ids, payload, status
    ) VALUES (
      ${id}, ${scope.workspaceId}, ${input.conversationId}, ${input.sourceTurnId},
      ${sql.json([] as never)},
      ${sql.json({ kind: "memory", text: input.text, temporary: false } as never)},
      'pending'
    )`;
  return id;
}
