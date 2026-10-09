import type { Scope } from "@aistudy/contracts";
import type { ExtractableImportChunk } from "@aistudy/domain";
import type { Sql } from "postgres";
import { OpeningKnowledgeError } from "./opening-knowledge";

export type OpeningImportChunksRepository = {
  listAuthorizedImportChunks(
    scope: Scope,
    courseId: string,
    receiptIds?: string[],
  ): Promise<ExtractableImportChunk[]>;
};

/** Map durable connection.kind → digest channel tag (imap → mail). */
export function channelFromConnectionKind(kind: string): string {
  if (kind === "imap") return "mail";
  if (kind === "dingtalk") return "dingtalk";
  return kind;
}

async function assertOwnedCourse(sql: Sql, scope: Scope, courseId: string): Promise<void> {
  const rows = await sql`
    SELECT c.id FROM courses c
    JOIN workspaces w ON w.id = c.workspace_id
    WHERE c.id = ${courseId}
      AND c.workspace_id = ${scope.workspaceId}
      AND w.owner_user_id = ${scope.ownerUserId}
      AND c.archived_at IS NULL`;
  if (!rows.length) throw new OpeningKnowledgeError("NOT_FOUND", "course not found");
}

type ChunkRow = {
  receipt_id: string;
  source_id: string;
  connection_kind: string;
  text: string;
};

/**
 * Authorized ImportReceipt + course-linked source chunks for extract-study-actions.
 * One ExtractableImportChunk per receipt; text joined from ordered chunk pages.
 * sentAt is always null until a durable notification send-time column exists
 * (never receipt/source created_at — those are sync/ingest clocks).
 */
export async function listAuthorizedImportChunks(
  sql: Sql,
  scope: Scope,
  courseId: string,
  receiptIds?: string[],
): Promise<ExtractableImportChunk[]> {
  await assertOwnedCourse(sql, scope, courseId);
  if (receiptIds !== undefined && receiptIds.length === 0) return [];

  const rows =
    receiptIds !== undefined
      ? await sql`
          SELECT
            r.id AS receipt_id,
            r.source_id AS source_id,
            conn.kind AS connection_kind,
            c.text AS text
          FROM opening_import_receipts r
          JOIN opening_connections conn
            ON conn.id = r.connection_id
            AND conn.workspace_id = r.workspace_id
            AND conn.owner_user_id = r.owner_user_id
          JOIN opening_sources s ON s.id = r.source_id
          JOIN course_asset_memberships m
            ON m.workspace_id = s.workspace_id
            AND m.asset_type = 'source'
            AND m.asset_id = s.id
            AND m.course_id = ${courseId}
          JOIN opening_source_chunks c
            ON c.source_id = s.id
            AND c.source_version = s.version
          WHERE r.workspace_id = ${scope.workspaceId}
            AND r.owner_user_id = ${scope.ownerUserId}
            AND s.workspace_id = ${scope.workspaceId}
            AND s.upload_state = 'uploaded'
            AND s.parse_state = 'ready'
            AND conn.state <> 'revoked'
            AND c.text ~ '[^[:space:]]'
            AND r.id IN ${sql(receiptIds)}
          ORDER BY r.id, c.page NULLS LAST, c.created_at`
      : await sql`
          SELECT
            r.id AS receipt_id,
            r.source_id AS source_id,
            conn.kind AS connection_kind,
            c.text AS text
          FROM opening_import_receipts r
          JOIN opening_connections conn
            ON conn.id = r.connection_id
            AND conn.workspace_id = r.workspace_id
            AND conn.owner_user_id = r.owner_user_id
          JOIN opening_sources s ON s.id = r.source_id
          JOIN course_asset_memberships m
            ON m.workspace_id = s.workspace_id
            AND m.asset_type = 'source'
            AND m.asset_id = s.id
            AND m.course_id = ${courseId}
          JOIN opening_source_chunks c
            ON c.source_id = s.id
            AND c.source_version = s.version
          WHERE r.workspace_id = ${scope.workspaceId}
            AND r.owner_user_id = ${scope.ownerUserId}
            AND s.workspace_id = ${scope.workspaceId}
            AND s.upload_state = 'uploaded'
            AND s.parse_state = 'ready'
            AND conn.state <> 'revoked'
            AND c.text ~ '[^[:space:]]'
          ORDER BY r.id, c.page NULLS LAST, c.created_at`;

  const byReceipt = new Map<string, { sourceId: string; kind: string; texts: string[] }>();
  for (const raw of rows) {
    const row = raw as ChunkRow;
    const receiptId = String(row.receipt_id);
    const text = String(row.text ?? "").trim();
    if (!text) continue;
    let entry = byReceipt.get(receiptId);
    if (!entry) {
      entry = {
        sourceId: String(row.source_id),
        kind: String(row.connection_kind),
        texts: [],
      };
      byReceipt.set(receiptId, entry);
    }
    entry.texts.push(text);
  }

  const out: ExtractableImportChunk[] = [];
  for (const [receiptId, entry] of byReceipt) {
    out.push({
      sourceId: entry.sourceId,
      receiptId,
      text: entry.texts.join("\n"),
      // No durable notification send-time column today — never invent from created_at.
      sentAt: null,
      channel: channelFromConnectionKind(entry.kind),
    });
  }
  return out;
}

export function createOpeningImportChunksRepository(sql: Sql): OpeningImportChunksRepository {
  return {
    listAuthorizedImportChunks: (scope, courseId, receiptIds) =>
      listAuthorizedImportChunks(sql, scope, courseId, receiptIds),
  };
}
