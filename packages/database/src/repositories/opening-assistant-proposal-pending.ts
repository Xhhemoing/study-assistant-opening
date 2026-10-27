import { Buffer } from "node:buffer";
import { z } from "zod";
import type { Sql } from "postgres";
import { isoDateTimeSchema, pendingAssistantProposalsQuerySchema, uuidSchema,
  type AssistantProposalRecord, type PendingAssistantProposalsQuery, type PendingAssistantProposalsResponse, type Scope } from "@aistudy/contracts";
import { contextSourceRefsIncluded } from "./opening-context-provenance";
import { learningError } from "./opening-learning-facts";

const cursorSchema = z.object({ createdAt: isoDateTimeSchema, id: uuidSchema }).strict();
function decodeCursor(cursor: string | undefined) {
  if (!cursor) return null;
  try {
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) throw new Error("noncanonical cursor");
    return cursorSchema.parse(JSON.parse(bytes.toString("utf8")));
  } catch {
    throw learningError("VALIDATION", "invalid pending proposal cursor");
  }
}

/** One admission predicate owns both the inbox and its total, before any pagination. */
function eligible(sql: Sql, scope: Scope, conversationId?: string) {
  return sql`SELECT p.* FROM opening_assistant_proposals p
    JOIN workspaces w ON w.id=p.workspace_id AND w.owner_user_id=p.owner_user_id
    JOIN opening_turns t ON t.id=p.source_turn_id AND t.workspace_id=p.workspace_id AND t.role='user' AND t.status='complete'
    JOIN opening_conversations c ON c.id=t.conversation_id AND c.workspace_id=t.workspace_id AND c.owner_user_id=p.owner_user_id
    WHERE p.workspace_id=${scope.workspaceId} AND p.owner_user_id=${scope.ownerUserId}
      AND p.status='draft' AND p.privacy_epoch=w.privacy_epoch
      AND (${conversationId ?? null}::uuid IS NULL OR c.id=${conversationId ?? null}::uuid)
      AND ${contextSourceRefsIncluded(sql, scope.workspaceId, sql`p.context_source_refs`)}`;
}

export async function countPendingAssistantProposals(sql: Sql, scope: Scope): Promise<number> {
  const [row] = await sql`SELECT count(*)::int AS total FROM (${eligible(sql, scope)}) pending`;
  return Number(row!.total);
}

export async function listPendingAssistantProposals(
  sql: Sql, scope: Scope, raw: PendingAssistantProposalsQuery,
  map: (row: Record<string, unknown>) => AssistantProposalRecord,
): Promise<PendingAssistantProposalsResponse> {
  const query = pendingAssistantProposalsQuerySchema.parse(raw);
  const cursor = decodeCursor(query.cursor);
  if (query.conversationId) {
    const [conversation] = await sql`SELECT id FROM opening_conversations WHERE id=${query.conversationId}
      AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
    if (!conversation) throw learningError("NOT_FOUND", "conversation not found");
  }
  // Count and page share a statement snapshot. Preserve PG microseconds in the
  // cursor: a JavaScript Date would round them and skip same-millisecond rows.
  // Bind as text first so postgres.js does not apply its Date serializer either.
  const [result] = await sql`WITH eligible AS MATERIALIZED (${eligible(sql, scope, query.conversationId)}), page AS (
    SELECT *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at FROM eligible
    WHERE ${cursor === null} OR (created_at,id)<(${cursor?.createdAt ?? null}::text::timestamptz,${cursor?.id ?? null}::uuid)
    ORDER BY created_at DESC,id DESC LIMIT 41
  ) SELECT (SELECT count(*)::int FROM eligible) AS total,
    COALESCE(jsonb_agg(to_jsonb(page) ORDER BY created_at DESC,id DESC),'[]'::jsonb) AS rows FROM page`;
  const rows = result!.rows as Record<string, unknown>[];
  const page = rows.slice(0, 40), last = page.at(-1);
  return { proposals: page.map(map), total: Number(result!.total),
    nextCursor: rows.length > 40 && last
      ? Buffer.from(JSON.stringify({ createdAt: last.cursor_created_at, id: last.id })).toString("base64url") : null };
}
