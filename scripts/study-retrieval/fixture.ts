import { readFile } from "node:fs/promises";
import path from "node:path";
import { systemQueryResultSchema, type SystemQueryRequest, type SystemQueryResult } from "../../packages/contracts/src/index";
import type { MaterialRetrievalEvaluation } from "../../packages/contracts/src/opening/material-retrieval-evaluation";

export const RETRIEVAL_FIXTURE_SCOPE = { workspaceId: "99000000-0000-4000-8000-000000000001", ownerUserId: "99000000-0000-4000-8000-000000000002" };
export const materialFixtureSourceId = (index: number) => `11000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
export const materialFixtureChunkId = (index: number, page: number) => `22000000-0000-4000-8000-${String(index * 100 + page).padStart(12, "0")}`;
export type MaterialFixtureChunk = { id: string; sourceId: string; sourceVersion: number; physicalPage: number; text: string; originPath: string; originalChunkId: string };
/** Reuses the existing 14 substantive teaching chunks. No held-out examples are read. */
export async function loadMaterialRetrievalFixture(repoRoot: string): Promise<MaterialFixtureChunk[]> {
  const base = path.join(repoRoot, "tests/fixtures/opening/teaching/unit-rank-nullspace");
  const index = JSON.parse(await readFile(path.join(base, "materials/sources-index.json"), "utf8")) as Array<{ sourceId: string; path: string; authorizedForTeachingRetrieval: boolean; chunkHints: Array<{ chunkId: string; page: number }> }>;
  const allow = JSON.parse(await readFile(path.join(base, "lecture/retrieval-allowlist.json"), "utf8")) as { authorizedSourceIds: string[] };
  const chunks: MaterialFixtureChunk[] = [];
  for (const [position, source] of index.entries()) {
    if (!source.authorizedForTeachingRetrieval || !allow.authorizedSourceIds.includes(source.sourceId) || !/^materials\/[^/]+\.md$/.test(source.path)) throw new Error("Fixture teaching allowlist violation");
    const text = await readFile(path.join(base, source.path), "utf8");
    const pages = text.split(/<!-- page:(\d+) -->/);
    for (const hint of source.chunkHints) {
      const offset = pages.findIndex((part, i) => i % 2 === 1 && Number(part) === hint.page);
      if (offset < 0 || !pages[offset + 1]?.trim()) throw new Error("Missing fixture material page");
      chunks.push({ id: materialFixtureChunkId(position + 1, hint.page), sourceId: materialFixtureSourceId(position + 1), sourceVersion: 1,
        physicalPage: hint.page, text: pages[offset + 1]!.trim(), originPath: `tests/fixtures/opening/teaching/unit-rank-nullspace/${source.path}`, originalChunkId: hint.chunkId });
    }
  }
  return chunks;
}
/** Offline compatibility adapter only; the live runner below calls the real SQL reader. */
export function createFixtureMaterialReader(chunks: MaterialFixtureChunk[], requestedScope: MaterialRetrievalEvaluation["scope"]) {
  return async (request: SystemQueryRequest): Promise<SystemQueryResult> => {
    if (request.name !== "materials") throw new Error("Fixture adapter accepts only material reads");
    const authorized = requestedScope.workspaceId === RETRIEVAL_FIXTURE_SCOPE.workspaceId && requestedScope.ownerUserId === RETRIEVAL_FIXTURE_SCOPE.ownerUserId;
    const args = request.arguments;
    const matched = authorized ? chunks.filter(chunk => (!args.sourceId || chunk.sourceId === args.sourceId)
      && (args.sourceVersion === undefined || args.sourceVersion === chunk.sourceVersion) && (!args.physicalPage || args.physicalPage === chunk.physicalPage)
      && (!args.query || chunk.text.toLowerCase().includes(args.query.trim().toLowerCase())))
      .sort((a, b) => a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : a.physicalPage - b.physicalPage || a.id.localeCompare(b.id)) : [];
    const more = matched.length > args.offset + args.limit;
    const rows = matched.slice(args.offset, args.offset + args.limit);
    return systemQueryResultSchema.parse({ name: "materials", authorization: { purpose: "system_record_lookup", workspaceId: RETRIEVAL_FIXTURE_SCOPE.workspaceId,
      principalId: RETRIEVAL_FIXTURE_SCOPE.ownerUserId, role: "workspace_owner", permissionRevision: "fixture-owner:privacy:0" },
      asOf: "2026-10-11T00:00:00Z", version: "fixture:rank-nullspace-v1", status: !authorized ? "unknown" : more ? "partial" : "ok",
      reason: !authorized ? "not_available" : more ? "truncated" : "read", nextOffset: more ? args.offset + args.limit : null,
      evidence: [], sourceRefs: rows.map(chunk => ({ sourceId: chunk.sourceId, sourceVersion: chunk.sourceVersion })),
      data: rows.map(chunk => ({ id: chunk.id, sourceId: chunk.sourceId, sourceVersion: chunk.sourceVersion, physicalPage: chunk.physicalPage,
        truncated: false, exposure: "content_withheld", summary: "Repository teaching fixture location; body withheld" })) });
  };
}
