import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import type { Scope } from "@aistudy/contracts";
import { OpeningSourceError } from "./opening-sources";

/** Reconstruct the verified public original from the bound version-zero lesson chunks. */
export async function readOpeningExamPublicSource(
  sql: Sql, scope: Scope, sourceId: string, version: number,
): Promise<{ text: string; bytes: number } | null> {
  if (version !== 0) return null;
  const [source] = await sql`SELECT s.mime,s.upload_state,s.parse_state,v.bytes,v.sha256,v.availability
    FROM opening_exam_bindings b JOIN opening_exam_sprints sprint ON sprint.id=b.sprint_id
    JOIN workspaces w ON w.id=sprint.workspace_id AND w.owner_user_id=sprint.owner_user_id
    JOIN opening_sources s ON s.id::text=b.binding->>'packSourceId' AND s.workspace_id=sprint.workspace_id
    LEFT JOIN opening_source_versions v ON v.source_id=s.id AND v.workspace_id=s.workspace_id AND v.version=0
    WHERE sprint.workspace_id=${scope.workspaceId} AND sprint.owner_user_id=${scope.ownerUserId} AND s.id=${sourceId}`;
  if (!source) return null;
  if (source.mime !== "text/plain" || source.upload_state !== "uploaded" || source.parse_state !== "ready"
    || source.availability !== "available") throw new OpeningSourceError("CONFLICT", "公开串讲原文当前不可用");
  const chunks = await sql`SELECT text FROM opening_source_chunks WHERE source_id=${sourceId} AND source_version=0 ORDER BY page,id`;
  if (!chunks.length || chunks.some(chunk => typeof chunk.text !== "string")) {
    throw new OpeningSourceError("CONFLICT", "公开串讲原文不完整");
  }
  const text = chunks.map(chunk => String(chunk.text)).join("\n\n"), bytes = Buffer.byteLength(text, "utf8");
  if (bytes !== Number(source.bytes) || createHash("sha256").update(text).digest("hex") !== source.sha256) {
    throw new OpeningSourceError("CONFLICT", "公开串讲原文校验失败，请保留记录并联系维护者");
  }
  return { text, bytes };
}
