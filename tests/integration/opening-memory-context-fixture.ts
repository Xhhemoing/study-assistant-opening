import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type { OpeningScope } from "@aistudy/database";

export async function insertOwnedTurn(
  sql: Sql,
  scope: OpeningScope,
  input: { sourceIds?: string[]; citations?: unknown; role?: "user" | "assistant"; contextSourceRefs?: unknown } = {},
): Promise<string> {
  const turnId = randomUUID();
  const conversationId = randomUUID();
  await sql`
    INSERT INTO opening_conversations (id, workspace_id, owner_user_id, title)
    VALUES (${conversationId}, ${scope.workspaceId}, ${scope.ownerUserId}, 'context')`;
  await sql`
    INSERT INTO opening_turns (
      id, workspace_id, conversation_id, role, text, mode, status, source_ids, citations, source_versions, context_source_refs
    ) VALUES (
      ${turnId}, ${scope.workspaceId}, ${conversationId}, ${input.role ?? "user"},
      'owned turn', 'explain', 'complete', ${sql.array(input.sourceIds ?? [])}::uuid[],
      ${sql.json((input.citations ?? []) as never)},
      (SELECT COALESCE(jsonb_object_agg(id::text,version), '{}'::jsonb) FROM opening_sources WHERE id=ANY(${sql.array(input.sourceIds ?? [])}::uuid[])),
      ${input.contextSourceRefs === undefined ? null : sql.json(input.contextSourceRefs as never)}
    )`;
  return turnId;
}

export async function insertSource(
  sql: Sql,
  scope: OpeningScope,
  state: "uploaded" | "rejected" = "uploaded",
  version = 0,
): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO opening_sources (
      id, workspace_id, name, mime, bytes, sha256, version, upload_state, parse_state
    ) VALUES (
      ${id}, ${scope.workspaceId}, 'source.pdf', 'application/pdf', 1,
      ${"a".repeat(64)}, ${version}, ${state}, 'ready'
    )`;
  return id;
}

export async function insertMemory(
  sql: Sql,
  scope: OpeningScope,
  text: string,
  sourceTurnIds: string[],
): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO opening_memories (
      id, workspace_id, course_id, kind, text, source_turn_ids, version, status
    ) VALUES (
      ${id}, ${scope.workspaceId}, NULL, 'confirmed', ${text},
      ${sql.json(sourceTurnIds as never)}, 1, 'active'
    )`;
  return id;
}
