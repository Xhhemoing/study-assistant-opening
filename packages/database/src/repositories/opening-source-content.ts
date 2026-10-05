import type { Sql } from "postgres";
import { OpeningSourceError, type OpeningScope } from "./opening-sources";

/** Owner-only, version-pinned plain text; object keys and rendered HTML never leave this reader. */
export async function readOpeningSourceContent(sql: Sql, scope: OpeningScope, id: string, input: { version?: number; page?: number }) {
  return sql.begin("isolation level repeatable read read only", async tx => {
    const rows = await tx`SELECT s.version,s.mime,s.parse_state,s.upload_state FROM opening_sources s
      JOIN workspaces w ON w.id=s.workspace_id AND w.owner_user_id=${scope.ownerUserId}
      WHERE s.id=${id} AND s.workspace_id=${scope.workspaceId}`;
    const source = rows[0];
    if (!source) throw new OpeningSourceError("NOT_FOUND", "Source not found");
    const version = input.version ?? Number(source.version);
    if (version < 0 || version > Number(source.version)) throw new OpeningSourceError("NOT_FOUND", "Source version not found");
    if (source.upload_state !== "uploaded" || (version === Number(source.version) && source.parse_state !== "ready")) {
      throw new OpeningSourceError("CONFLICT", "材料尚未完成正文解析");
    }
    const stats = await tx`SELECT page,sum(length(text))::int AS characters,bool_or(text ~ '[^[:space:]]') AS readable
      FROM opening_source_chunks WHERE source_id=${id} AND source_version=${version} GROUP BY page ORDER BY page NULLS LAST`;
    if (!stats.length) throw new OpeningSourceError("NOT_FOUND", "该版本没有解析正文");
    const pages = stats.map(row => row.page == null ? null : Number(row.page));
    const page = input.page ?? pages[0]!;
    if (!pages.includes(page)) throw new OpeningSourceError("NOT_FOUND", "该页没有解析记录");
    // Limit each database value before sending; a physical page may contain multiple chunks.
    const bodies = await tx`SELECT left(text,20001) AS text FROM opening_source_chunks
      WHERE source_id=${id} AND source_version=${version} AND page IS NOT DISTINCT FROM ${page} ORDER BY created_at,id`;
    const text = bodies.map(row => String(row.text)).join("\n\n");
    return { sourceId: id, version, currentVersion: Number(source.version), page, pages,
      pageKind: source.mime === "text/markdown" || source.mime === "text/html" ? "section" as const : "physical" as const,
      readablePages: stats.filter(row => row.readable).length,
      characters: stats.reduce((sum, row) => sum + Number(row.characters), 0),
      text: text.slice(0,20000), truncated: text.length > 20000 };
  });
}
