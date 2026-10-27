import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProviderInput, ProviderOutput } from "@aistudy/contracts";
import { createOpeningAiGradingRepository, createOpeningBudgetRepository, createOpeningSourceChunksRepository, createOpeningSourceRepository,
  openingJobScope, type OpeningJobRecord } from "@aistudy/database";
import { createOpeningSourceVisualRecognitionsRepository } from "../../packages/database/src/repositories/opening-source-visual-recognitions";
import { createModelGateway } from "../../packages/ai/src/opening/model-gateway";
import { OpeningProviderError } from "../../packages/ai/src/opening/provider";
import { createOpeningAiGradingService } from "../../packages/ai/src/opening/ai-grading-service";
import { createCompilerProviderInput } from "../../packages/ai/src/opening/teaching-compiler";
import { createParseSourceHandler } from "../../apps/worker/src/jobs/parse-source";
import { createSourceVisualRecognition } from "../../apps/worker/src/runtime/source-visual-recognition";
import { createOpeningMaterialRetriever } from "../../apps/worker/src/runtime/material-retrieval";
import { createSourcePageImages } from "../../apps/worker/src/runtime/source-page-images";
import { scopeBudget } from "../../apps/worker/src/runtime/model-gateway";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=", "base64");
const data = `data:image/png;base64,${png.toString("base64")}`;
const storage = { finalKey: (id: string, version: number) => `opening/sources/${id}/v${version}`, presignGet: async () => data };
const recognized = { transcription: "x^2+y^2=1", description: "圆的方程，指数为2。", uncertainties: [], contentKinds: ["formula"] };
const response = (value: unknown): ProviderOutput => ({ text: JSON.stringify(value), inputTokens: 100, outputTokens: 100, citedChunkIds: [], candidates: [], requestId: null });
let f: OpeningFixture;
const dirs: string[] = [];
beforeEach(async () => { f = await createOpeningFixture(); });
afterEach(async () => { await f?.close(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function fixture(complete = vi.fn(async (_input: ProviderInput) => response(recognized)), fallback?: typeof complete) {
  const sourceId = randomUUID();
  await f.sql`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
    VALUES(${sourceId},${f.scope.workspaceId},'formula.png','image/png',${png.length},${"ac".repeat(32)},1,'uploaded','running')`;
  const makeJob = async (): Promise<OpeningJobRecord> => {
    const id = randomUUID(), claimToken = randomUUID(), key = `parse-visual:${id}`, payload = { sourceId, sourceVersion: 1 };
    await f.sql`INSERT INTO opening_jobs(id,workspace_id,owner_user_id,key,kind,payload,state,privacy_epoch,claim_token)
      VALUES(${id},${f.scope.workspaceId},${f.scope.ownerUserId},${key},'parse',${f.sql.json(payload)},'running',0,${claimToken})`;
    return { id, ...f.scope, key, kind: "parse", payload, result: null, state: "running", privacyEpoch: 0, claimToken };
  };
  const job = await makeJob();
  const budget = createOpeningBudgetRepository(f.sql, { envCapCents: 100000 });
  const resolvedModel = (provider: typeof complete, id = "controlled") => ({ provider: { complete: provider }, supportsVision: true,
    inputCentsPerMillion: 100, outputCentsPerMillion: 100, mediaInputTokenUpperBound: 1000, mediaInputCentsPerMillion: 100, mediaMaxInputBytes: 1000000,
    modelSnapshot: { id, providerId: "fixture", modelName: "gpt-6-luna", inputCentsPerMillion: 100, outputCentsPerMillion: 100,
      mediaInputTokenUpperBound: 1000, mediaInputCentsPerMillion: 100, mediaMaxInputBytes: 1000000 } });
  const gateway = createModelGateway({ resolve: async () => resolvedModel(complete),
    ...(fallback ? { resolveFallback: async () => resolvedModel(fallback, "controlled-fallback") } : {}) });
  const repository = createOpeningSourceVisualRecognitionsRepository(f.sql);
  const recognizePage = createSourceVisualRecognition({ repository, gateway, budget: scope => scopeBudget(budget, scope), storage });
  const chunks = createOpeningSourceChunksRepository(f.sql), tempDir = await mkdtemp(path.join(os.tmpdir(), "aistudy-visual-chain-"));
  dirs.push(tempDir);
  const parse = createParseSourceHandler({ sources: createOpeningSourceRepository(f.sql), chunks, storage,
    runner: async () => { throw new Error("image input must not run the document parser"); }, tempDir, recognizePage,
    assertCurrent: (scope, input) => repository.assertCurrent(scope, input) });
  return { sourceId, job, makeJob, parse, budget, gateway, repository, chunks, complete };
}

it("imports an image through the paid gateway, persists page cache/chunks/index outbox, retrieves its formula and teaches with the same original", async () => {
  const x = await fixture();
  await x.parse(x.job, x.job.payload);
  const chunks = await x.chunks.listChunks(f.scope, x.sourceId);
  expect(chunks).toHaveLength(1);
  expect(chunks[0]).toMatchObject({ sourceVersion: 1, page: 1, imageObjectKey: storage.finalKey(x.sourceId, 1) });
  expect(chunks[0]!.text).toContain(recognized.transcription);
  expect(await f.sql`SELECT id FROM opening_jobs WHERE workspace_id=${f.scope.workspaceId} AND kind='index-source' AND payload->>'sourceId'=${x.sourceId}`).toHaveLength(1);
  const retrieve = createOpeningMaterialRetriever(f.sql, x.budget, null);
  const found = await retrieve(f.scope, { chunks, sourceIds: [x.sourceId], query: "x^2+y^2=1", maxCharacters: 6000, operationId: "controlled-lexical" });
  expect(found.mode).toBe("lexical"); expect(found.chunks[0]!.text).toContain(recognized.transcription);
  const images = createSourcePageImages(f.sql, storage as never);
  const compiled = await createCompilerProviderInput({ loadChunks: () => Promise.resolve(chunks), loadPageImages: (scope, input) => images(scope as typeof f.scope, input), intentSummary: "圆的方程" })(
    f.scope, { activityId: randomUUID(), expectedContentVersion: 0, sourceIds: [x.sourceId] });
  expect(compiled).toMatchObject({ mediaCapability: "text_plus_page_images", imageParts: [{ sourceId: x.sourceId, physicalPage: 1, data }] });
  expect(compiled.chunks[0]!.id).toBe(chunks[0]!.id);
  await x.parse(x.job, x.job.payload);
  const retry = await x.makeJob(); await x.parse(retry, retry.payload);
  expect((await x.chunks.listChunks(f.scope, x.sourceId)).map(row => row.id)).toEqual(chunks.map(row => row.id));
  expect(x.complete).toHaveBeenCalledTimes(1);
  expect(await f.sql`SELECT id FROM opening_budget_reservations WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(1);
  expect(await x.repository.read(openingJobScope(retry), { sourceId: x.sourceId, sourceVersion: 1, physicalPage: 1 })).toMatchObject({ result: recognized });
});

it("does not resend a page after a sent network failure and never publishes it ready", async () => {
  const provider = vi.fn(async (_input: ProviderInput): Promise<ProviderOutput> => { throw new OpeningProviderError("PROVIDER_NETWORK", "controlled sent failure", true, true); });
  const x = await fixture(provider);
  await expect(x.parse(x.job, x.job.payload)).rejects.toBeDefined();
  await expect(x.parse(x.job, x.job.payload)).rejects.toBeDefined();
  expect(provider).toHaveBeenCalledTimes(1);
  expect(await x.chunks.listChunks(f.scope, x.sourceId)).toEqual([]);
  expect(await f.sql`SELECT source_id FROM opening_source_visual_recognitions WHERE source_id=${x.sourceId}`).toHaveLength(0);
  expect((await f.sql`SELECT parse_state FROM opening_sources WHERE id=${x.sourceId}`)[0]!.parse_state).not.toBe("ready");
  const charges = await f.sql`SELECT state,outcome_unknown_at FROM opening_budget_reservations WHERE workspace_id=${f.scope.workspaceId}`;
  expect(charges).toHaveLength(1); expect(charges[0]!.outcome_unknown_at).not.toBeNull();
});

it("safely retries a confirmed not-sent page under the deterministic reservation family", async () => {
  const provider = vi.fn(async (_input: ProviderInput) => response(recognized));
  provider.mockRejectedValueOnce(new OpeningProviderError("PROVIDER_AUTH", "controlled auth rejection", false, false));
  const x = await fixture(provider);
  await expect(x.parse(x.job, x.job.payload)).rejects.toBeDefined();
  expect(await x.chunks.listChunks(f.scope, x.sourceId)).toEqual([]);
  await x.parse(x.job, x.job.payload);
  expect(provider).toHaveBeenCalledTimes(2);
  expect((await x.chunks.listChunks(f.scope, x.sourceId))[0]!.text).toContain(recognized.transcription);
  const charges = await f.sql`SELECT state,request_id FROM opening_budget_reservations WHERE workspace_id=${f.scope.workspaceId}`;
  expect(charges).toHaveLength(2); expect(charges.map(row => row.state).sort()).toEqual(["completed", "released"]);
  expect(charges.some(row => String(row.request_id).includes(":retry:"))).toBe(true);
});

it("does not bypass a sent-unknown fallback after its primary was confirmed released", async () => {
  const primary = vi.fn(async (_input: ProviderInput): Promise<ProviderOutput> => { throw new OpeningProviderError("PROVIDER_AUTH", "controlled auth rejection", false, false); });
  const fallback = vi.fn(async (_input: ProviderInput): Promise<ProviderOutput> => { throw new OpeningProviderError("PROVIDER_NETWORK", "controlled fallback unknown", true, true); });
  const x = await fixture(primary, fallback);
  await expect(x.parse(x.job, x.job.payload)).rejects.toBeDefined();
  await expect(x.parse(x.job, x.job.payload)).rejects.toBeDefined();
  expect(primary).toHaveBeenCalledTimes(1); expect(fallback).toHaveBeenCalledTimes(1);
  expect(await x.chunks.listChunks(f.scope, x.sourceId)).toEqual([]);
  const charges = await f.sql`SELECT state,outcome_unknown_at FROM opening_budget_reservations WHERE workspace_id=${f.scope.workspaceId}`;
  expect(charges).toHaveLength(2); expect(charges.filter(row => row.state === "released")).toHaveLength(1);
  expect(charges.filter(row => row.outcome_unknown_at != null)).toHaveLength(1);
});

it.each(["cancel", "privacy"] as const)("rejects cache and chunk writes after %s while the provider is returning", async change => {
  let sourceId = "", jobId = "";
  const provider = vi.fn(async (_input: ProviderInput) => {
    if (change === "cancel") await f.sql`UPDATE opening_jobs SET state='cancelled' WHERE id=${jobId}`;
    else {
      await f.sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id,deleted_at) VALUES(${f.scope.workspaceId},${sourceId},now())`;
      await f.sql`UPDATE workspaces SET privacy_epoch=privacy_epoch+1 WHERE id=${f.scope.workspaceId}`;
    }
    return response(recognized);
  });
  const x = await fixture(provider); sourceId = x.sourceId; jobId = x.job.id;
  await expect(x.parse(x.job, x.job.payload)).rejects.toBeDefined();
  expect(provider).toHaveBeenCalledTimes(1);
  expect(await f.sql`SELECT source_id FROM opening_source_visual_recognitions WHERE source_id=${sourceId}`).toHaveLength(0);
  expect(await x.chunks.listChunks(f.scope, sourceId)).toEqual([]);
  expect((await f.sql`SELECT parse_state FROM opening_sources WHERE id=${sourceId}`)[0]!.parse_state).not.toBe("ready");
});

it("passes the immutable question's reference original to grading separately from the saved student answer", async () => {
  const x = await learningAttemptFixture(f);
  await f.sql`UPDATE opening_sources SET mime='image/png',bytes=${png.length} WHERE id=${x.sourceId}`;
  const stem = "根据图中圆的方程，圆心是什么？";
  await f.sql`UPDATE opening_source_chunks SET text=${stem},image_object_key=${storage.finalKey(x.sourceId, 1)} WHERE id=${x.chunkId}`;
  const attempt = await x.start({ problem: { sourceId: x.sourceId, chunkId: x.chunkId, physicalPage: 1, stemSnapshot: stem, artifactKind: "reference_item" } });
  const observation = await x.learning.insertObservation(f.scope, { attemptId: attempt.id, sessionId: x.sessionId, courseId: x.courseId,
    skillLabel: "fractions", sourceIds: [x.sourceId], problemId: attempt.problemId, answer: "圆心是原点", outcome: "unverified", assistance: "independent", clientKey: randomUUID() });
  const repository = createOpeningAiGradingRepository(f.sql), context = await repository.context(f.scope, { observationId: observation.id });
  expect(context.stem).toBe(stem);
  expect(context.referenceSources).toEqual([{ sourceId: x.sourceId, sourceVersion: 1, physicalPage: 1 }]);
  const provider = vi.fn(async (_input: ProviderInput) => response({ outcome: "unverified", confidence: .4, questionMatch: true,
    feedback: "图示不足，保留原答并请补充清晰题目。", criteria: [{ label: "题图对应", verdict: "unverified", feedback: "需要核对原图。" }] }));
  const visual = await fixture(provider);
  const service = createOpeningAiGradingService({ repository, gateway: visual.gateway, budget: scope => scopeBudget(visual.budget, scope), images: createSourcePageImages(f.sql, storage as never) });
  await service.grade(f.scope, { observationId: observation.id });
  const sent = provider.mock.calls[0]![0];
  expect(sent.imageParts).toEqual([{ sourceId: x.sourceId, physicalPage: 1, mediaType: "image/png", data }]);
  expect(JSON.parse(sent.text)).toMatchObject({ studentAnswer: observation.answer, imageRoles: [{ role: "reference_material", sourceId: x.sourceId, physicalPage: 1 }] });
  expect((await f.sql`SELECT answer FROM opening_learning_observations WHERE id=${observation.id}`)[0]!.answer).toBe(observation.answer);
});

it("refuses a stale PDF page even if its old chunk remains after the source advanced", async () => {
  const x = await fixture();
  await x.parse(x.job, x.job.payload);
  await f.sql`UPDATE opening_sources SET mime='application/pdf',version=2 WHERE id=${x.sourceId}`;
  const presignGet = vi.fn(async () => data);
  await expect(createSourcePageImages(f.sql, { ...storage, presignGet } as never)(f.scope, {
    sourceIds: [x.sourceId], sourceVersions: { [x.sourceId]: 1 }, physicalPage: 1,
  })).rejects.toMatchObject({ code: "CONFLICT" });
  expect(presignGet).not.toHaveBeenCalled();
});
