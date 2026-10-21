import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOpeningSourceChunksRepository, createOpeningSourceEmbeddingsRepository } from "@aistudy/database";
import { segmentMaterialChunks } from "@aistudy/ai";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let f: OpeningFixture;
beforeAll(async () => { f = await createOpeningFixture(); });
afterAll(async () => { await f?.close(); });
const model = { modelKey: "https://embedding.example.test|model|3", dimensions: 3 };

async function seed(text: string, scope = f.scope) {
  const sourceId = randomUUID();
  await f.sql`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
    VALUES(${sourceId},${scope.workspaceId},'material.txt','text/plain',${Buffer.byteLength(text)},${"ab".repeat(32)},1,'uploaded','running')`;
  await createOpeningSourceChunksRepository(f.sql).replaceChunks(scope, { sourceId, sourceVersion: 1,
    chunks: [{ text, page: 1, slideLabel: null, startMs: null, endMs: null, imageObjectKey: null }] });
  const repository = createOpeningSourceEmbeddingsRepository(f.sql);
  const snapshot = (await repository.snapshot(scope, sourceId))!;
  await repository.store(scope, snapshot, model, segmentMaterialChunks(snapshot.chunks).map(segment => ({ ...segment, vector: [1, 0, 0] })));
  return { sourceId, snapshot, repository };
}

describe("pgvector material repository", () => {
  it("commits parsing readiness and index outbox together, and supports old-source reindex", async () => {
    const s = await seed("矩阵的零空间");
    const jobs = await f.sql`SELECT j.id,j.payload,o.payload AS dispatch FROM opening_jobs j JOIN opening_outbox o ON o.job_id=j.id
      WHERE j.kind='index-source' AND j.workspace_id=${f.scope.workspaceId} AND j.payload->>'sourceId'=${s.sourceId}`;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toEqual({ sourceId: s.sourceId, sourceVersion: 1 });
    expect(jobs[0]?.dispatch).toMatchObject({ kind: "index-source", sourceId: s.sourceId });
    const rebuilt = await s.repository.reindex(f.scope, s.sourceId);
    expect(rebuilt.jobId).not.toBe(jobs[0]?.id);
    await expect(s.repository.reindex(f.otherScope, s.sourceId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("filters owner, privacy, source version, model and dimensions before cosine distance", async () => {
    const a = await seed("核空间 kernel"), b = await seed("foreign secret", f.otherScope);
    const query = { ...model, sourceIds: [a.sourceId, b.sourceId], vector: [1, 0, 0] };
    expect((await a.repository.search(f.scope, query)).map(row => row.chunk.sourceId)).toEqual([a.sourceId]);
    expect(await a.repository.search({ ...f.scope, ownerUserId: f.otherScope.ownerUserId }, query)).toEqual([]);
    expect(await a.repository.search(f.scope, { ...query, modelKey: "different-model" })).toEqual([]);
    await a.repository.store(f.scope, a.snapshot, { modelKey: "2d-model", dimensions: 2 },
      segmentMaterialChunks(a.snapshot.chunks).map(segment => ({ ...segment, vector: [1, 0] })));
    expect(await a.repository.search(f.scope, query)).toHaveLength(1);
    await f.sql`UPDATE opening_sources SET version=2,parse_state='running' WHERE id=${a.sourceId}`;
    expect(await a.repository.search(f.scope, query)).toEqual([]);
    expect(await a.repository.hasIndex(f.scope, { ...model, sourceIds: [a.sourceId] })).toBe(false);
    // Explicit historical pages remain readable while the replacement is parsing; dense recall uses current versions only.
    expect((await a.repository.authorizeChunks(f.scope, a.snapshot.chunks)).chunks).toEqual(a.snapshot.chunks);
    await expect(a.repository.store(f.scope, a.snapshot, model, [])).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rechecks exclusion/epoch at send and write boundaries and removes excluded lexical chunks", async () => {
    const s = await seed("private mathematics");
    await f.sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id,deleted_at) VALUES(${f.scope.workspaceId},${s.sourceId},now())`;
    await f.sql`UPDATE workspaces SET privacy_epoch=privacy_epoch+1 WHERE id=${f.scope.workspaceId}`;
    await expect(s.repository.assertCurrent(f.scope, s.snapshot)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(s.repository.store(f.scope, s.snapshot, model, [])).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await s.repository.search(f.scope, { ...model, sourceIds: [s.sourceId], vector: [1, 0, 0] })).toEqual([]);
    expect((await s.repository.authorizeChunks(f.scope, s.snapshot.chunks)).chunks).toEqual([]);
    await expect(s.repository.reindex(f.scope, s.sourceId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("keeps long-page tail vectors and cascades them when physical chunks or sources are deleted", async () => {
    const s = await seed("汉".repeat(5000) + "last theorem");
    const found = await s.repository.search(f.scope, { ...model, sourceIds: [s.sourceId], vector: [1, 0, 0] });
    expect(found).toHaveLength(3);
    expect(found.sort((a, b) => a.segmentIndex - b.segmentIndex).map(row => row.chunk.text).join("")).toBe(s.snapshot.chunks[0]!.text);
    await createOpeningSourceChunksRepository(f.sql).replaceChunks(f.scope, { sourceId: s.sourceId, sourceVersion: 1,
      chunks: [{ text: "replacement", page: 1, slideLabel: null, startMs: null, endMs: null, imageObjectKey: null }] });
    expect(await f.sql`SELECT 1 FROM opening_source_embeddings WHERE source_id=${s.sourceId}`).toHaveLength(0);
    const second = await seed("delete cascade");
    await f.sql`DELETE FROM opening_sources WHERE id=${second.sourceId}`;
    expect(await f.sql`SELECT 1 FROM opening_source_embeddings WHERE source_id=${second.sourceId}`).toHaveLength(0);
  });
});
