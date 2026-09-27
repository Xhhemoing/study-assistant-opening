import type { Sql } from "postgres";
import type { OpeningConversationScope } from "./opening-conversations";

/** Last saved user intent, filtered against current source authority and versions. */
export async function readOpeningConversationSelection(sql: Sql, scope: OpeningConversationScope, conversationId: string) {
  const turns = await sql`
    SELECT t.source_ids, t.source_versions, t.current_page, t.chunk_id
    FROM opening_turns t JOIN opening_conversations c ON c.id = t.conversation_id
    WHERE c.id = ${conversationId} AND c.workspace_id = ${scope.workspaceId}
      AND c.owner_user_id = ${scope.ownerUserId} AND t.workspace_id = c.workspace_id
      AND t.role = 'user'
    ORDER BY t.created_at DESC, t.id DESC LIMIT 1`;
  const turn = turns[0];
  if (!turn) return null;
  const requested = turn.source_ids as string[];
  const versions = (turn.source_versions ?? {}) as Record<string, number>;
  const sources = requested.length ? await sql`
    SELECT s.id, s.version FROM opening_sources s
    WHERE s.workspace_id = ${scope.workspaceId} AND s.id IN ${sql(requested)}
      AND s.upload_state = 'uploaded' AND s.parse_state = 'ready'
      AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e
        WHERE e.workspace_id = s.workspace_id AND e.source_id = s.id)` : [];
  const valid = new Set(sources.filter((s) => versions[s.id as string] === Number(s.version)).map((s) => s.id as string));
  return {
    sourceIds: requested.filter((id) => valid.has(id)),
    currentPage: turn.current_page == null ? null : Number(turn.current_page),
    chunkId: (turn.chunk_id as string | null) ?? null,
  };
}
