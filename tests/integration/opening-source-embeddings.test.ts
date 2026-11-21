import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createOpeningBudgetRepository, createOpeningSourceChunksRepository, createOpeningSourceEmbeddingsRepository } from "@aistudy/database";
import { segmentMaterialChunks } from "@aistudy/ai";
import * as network from "../../packages/ai/src/opening/provider-network";
import { createOpeningMaterialRetriever, retrievalBudgetId } from "../../apps/worker/src/runtime/material-retrieval";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let f: OpeningFixture;
beforeAll(async () => { f = await createOpeningFixture(); });
afterAll(async () => { await f?.close(); });
const model = { modelKey: "https://embedding.example.test|model|3", dimensions: 3 };

async function seed(text: string | string[], scope = f.scope) {
  const pages = typeof text === "string" ? [text] : text;
  const sourceId = randomUUID();
  await f.sql`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
    VALUES(${sourceId},${scope.workspaceId},'material.txt','text/plain',${Buffer.byteLength(pages.join(""))},${"ab".repeat(32)},1,'uploaded','running')`;
  await createOpeningSourceChunksRepository(f.sql).replaceChunks(scope, { sourceId, sourceVersion: 1,
    chunks: pages.map((text, i) => ({ text, page: i + 1, slideLabel: null, startMs: null, endMs: null, imageObjectKey: null })) });
  const repository = createOpeningSourceEmbeddingsRepository(f.sql);
  const snapshot = (await repository.snapshot(scope, sourceId))!;
  await repository.store(scope, snapshot, model, segmentMaterialChunks(snapshot.chunks).map(segment => ({ ...segment, vector: [1, 0, 0] })));
  return { sourceId, snapshot, repository };
}

describe("pgvector material repository", () => {
  it("ranks the three admitted pages even with 55 closer pages in the same book", async () => {
    const book = await seed(Array.from({ length: 58 }, (_, i) => `page ${i + 1}`));
    const other = await seed("another book");
    const targets = book.snapshot.chunks.filter(chunk => chunk.page! > 55);
    await book.repository.store(f.scope, book.snapshot, model,
      segmentMaterialChunks(targets).map(segment => ({ ...segment, vector: [0, 1, 0] })));
    const chunkIds = targets.map(chunk => chunk.id);
    const query = { ...model, vector: [1, 0, 0], sourceIds: [book.sourceId], privacyEpoch: book.snapshot.privacyEpoch,
      chunkIds: [...chunkIds, other.snapshot.chunks[0]!.id] };
    const search = (scope: typeof query) => book.repository.search(f.scope, scope);
    expect((await search(query)).map(row => row.chunk.id).sort()).toEqual(chunkIds.sort());
    expect(await search({ ...query, sourceIds: [] })).toEqual([]);
    expect(await search({ ...query, chunkIds: [] })).toEqual([]);
    expect(await search({ ...query, privacyEpoch: query.privacyEpoch + 1 })).toEqual([]);
    expect(await book.repository.hasIndex(f.scope, { ...query, chunkIds: [other.snapshot.chunks[0]!.id] })).toBe(false);
  });

  it("holds a timed-out embedding once, then admits the tutor within the remaining workspace cap", async () => {
    const { sourceId, snapshot, repository } = await seed("matrix kernel");
    const budget = createOpeningBudgetRepository(f.sql, { envCapCents: 10 });
    const retrieve = createOpeningMaterialRetriever(f.sql, budget, { ...model, modelName: "embedding",
      baseUrl: "https://embedding.example.test/v1", apiKey: "fixture", billing: "metered",
      inputCentsPerMillion: 1, requestDimensions: true, dailyRequestCap: null });
    const parentBudget = { id: `study-turn:${randomUUID()}` };
    const input = { courseContext: { courseId: null, materialUse: "citation" as const }, chunks: snapshot.chunks,
      sourceIds: [sourceId], query: "kernel", maxCharacters: 2000, operationId: randomUUID(), parentBudget };
    const send = vi.spyOn(network, "fetchOpeningProvider").mockImplementation((_url, init) =>
      new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true })));
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(await retrieve(f.scope, input)).toMatchObject({ mode: "lexical", chunks: snapshot.chunks });
      }
      expect(send).toHaveBeenCalledTimes(1);
      const rows = await f.sql`SELECT state, amount_cents, outcome_unknown_at FROM opening_budget_reservations
        WHERE workspace_id=${f.scope.workspaceId} AND request_id=${`material-query:${input.operationId}`}`;
      expect(rows).toMatchObject([{ state: "reserved", amount_cents: 1, outcome_unknown_at: expect.any(Date) }]);
      const tutor = { purpose: "tutor", parentBudget, requestId: randomUUID() };
      await expect(budget.reserve(f.scope, { ...tutor, amountCents: 10 })).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
      await expect(budget.reserve(f.scope, { ...tutor, amountCents: 9 })).resolves.toMatchObject({ state: "reserved" });
      await budget.release(f.scope, tutor.requestId, "not_sent");
      expect(await budget.isParentNotSent(f.scope, parentBudget.id)).toBe(true);
      expect(await repository.isTurnWithRetrievalNotSent(f.scope, parentBudget.id, retrievalBudgetId(parentBudget.id))).toBe(false);
    } finally {
      send.mockRestore();
    }
  });

  it("enforces aggregate spend and call limits across retrieval and tutor under unlimited daily mode while isolating unknown blocking", async () => {
    const { sourceId, snapshot } = await seed("matrix kernel");
    const unlimitedBudget = createOpeningBudgetRepository(f.sql, { envCapCents: 0, dailyQuotaMode: "unlimited", parentCapCents: 10 });
    const retrieve = createOpeningMaterialRetriever(f.sql, unlimitedBudget, { ...model, modelName: "embedding",
      baseUrl: "https://embedding.example.test/v1", apiKey: "fixture", billing: "metered",
      inputCentsPerMillion: 1, requestDimensions: true, dailyRequestCap: null });
    const turnId = `study-turn:${randomUUID()}`;
    const parentBudget = { id: turnId, maxProviderCalls: 2 };
    const opId = randomUUID();
    const input = { courseContext: { courseId: null, materialUse: "citation" as const }, chunks: snapshot.chunks,
      sourceIds: [sourceId], query: "kernel", maxCharacters: 2000, operationId: opId, parentBudget };
    const send = vi.spyOn(network, "fetchOpeningProvider").mockImplementation((_url, init) =>
      new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true })));
    try {
      expect(await retrieve(f.scope, input)).toMatchObject({ mode: "lexical", chunks: snapshot.chunks });
      expect(await retrieve(f.scope, input)).toMatchObject({ mode: "lexical", chunks: snapshot.chunks });
      expect(send).toHaveBeenCalledTimes(1);

      // Unknown embedding (1c, 1 call) still counts toward the turn family cap (10c, 2 calls).
      await expect(unlimitedBudget.reserve(f.scope, { purpose: "tutor", parentBudget, requestId: randomUUID(), amountCents: 10 }))
        .rejects.toMatchObject({ code: "PARENT_BUDGET_EXCEEDED" });
      // Lexical fallback tutor (9c) is NOT blocked by retrieval's unknown outcome and fits within 10c & 2 calls.
      const tutor = await unlimitedBudget.reserve(f.scope, { purpose: "tutor", parentBudget, requestId: randomUUID(), amountCents: 9 });
      expect(tutor).toMatchObject({ state: "reserved", amountCents: 9, parentInteractionId: turnId });
      await unlimitedBudget.settle(f.scope, tutor.id, 5);
      // 1c embedding + 5c tutor = 6c <= 10c, but 2 family calls already reached maxProviderCalls: 2.
      await expect(unlimitedBudget.reserve(f.scope, { purpose: "tutor", parentBudget, requestId: randomUUID(), amountCents: 1 }))
        .rejects.toMatchObject({ code: "PARENT_BUDGET_CALL_LIMIT" });
    } finally {
      send.mockRestore();
    }
  });

  it("requires a tutor reservation and admits a fresh attempt only when every recorded call was unsent", async () => {
    const repository = createOpeningSourceEmbeddingsRepository(f.sql);
    const budget = createOpeningBudgetRepository(f.sql, { envCapCents: 50 });
    const tutorId = randomUUID(), retrievalId = retrievalBudgetId(tutorId);
    const proof = () => repository.isTurnWithRetrievalNotSent(f.scope, tutorId, retrievalId);
    expect(await proof()).toBe(false);
    const tutor = { requestId: randomUUID(), purpose: "tutor", parentBudget: { id: tutorId }, amountCents: 1 };
    await budget.reserve(f.scope, tutor);
    await budget.release(f.scope, tutor.requestId, "not_sent");
    expect(await proof()).toBe(true);
    const embedding = { ...tutor, purpose: "material-embedding", requestId: randomUUID(), parentBudget: { id: retrievalId } };
    await budget.reserve(f.scope, embedding);
    expect(await proof()).toBe(false);
    await budget.release(f.scope, embedding.requestId, "cancelled");
    expect(await proof()).toBe(true);
    expect(await repository.isTurnWithRetrievalNotSent(f.otherScope, tutorId, retrievalId)).toBe(false);
  });

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
