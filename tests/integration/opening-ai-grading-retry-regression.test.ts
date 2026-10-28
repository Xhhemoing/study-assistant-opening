import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { AiGradingProposal, ProviderOutput } from "@aistudy/contracts";
import { createOpeningAiGradingRepository, createOpeningBudgetRepository, createOpeningJobRepository } from "@aistudy/database";
import { createOpeningAiGradingJobRepository } from "../../packages/database/src/repositories/opening-ai-grading-jobs";
import { createOpeningAiGradingService, type OpeningAiGradingServiceDeps } from "../../packages/ai/src/opening/ai-grading-service";
import { createModelGateway, type ResolvedTaskModel } from "../../packages/ai/src/opening/model-gateway";
import { OpeningProviderError } from "../../packages/ai/src/opening/provider";
import { createGradeObservationHandler } from "../../apps/worker/src/jobs/grade-observation";
import { runJob } from "../../apps/worker/src/runtime/run-job";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";

let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => { await fixture.reset(); await fixture.sql`TRUNCATE opening_learning_sessions,opening_conversations CASCADE`; });
afterAll(async () => { await fixture?.close(); });
const proposal: AiGradingProposal = { outcome: "correct", confidence: .95, questionMatch: true, feedback: "结果为1。",
  criteria: [{ label: "分数相加", verdict: "correct", feedback: "同分母相加。" }] };
const output: ProviderOutput = { text: JSON.stringify(proposal), inputTokens: 10, outputTokens: 10,
  citedChunkIds: [], requestId: null, candidates: [] };
function model(name: string, price: number, complete = vi.fn(async () => output)): ResolvedTaskModel {
  return { provider: { complete }, modelSnapshot: { id: name, providerId: "fixture", modelName: name,
    inputCentsPerMillion: price, outputCentsPerMillion: price }, inputCentsPerMillion: price, outputCentsPerMillion: price };
}
async function setup() {
  const f = await learningAttemptFixture(fixture);
  // This suite exercises text-only paid retries, not a synthetic backup image locator.
  await fixture.sql`UPDATE opening_source_chunks SET image_object_key=NULL WHERE id=${f.chunkId}`;
  const original = await f.submit(await f.start(), { outcome: "unverified" });
  const repository = createOpeningAiGradingRepository(fixture.sql), jobs = createOpeningAiGradingJobRepository(fixture.sql);
  const queue = createOpeningJobRepository(fixture.sql), status = await jobs.read(fixture.scope, { observationId: original.id });
  const budget = createOpeningBudgetRepository(fixture.sql, { envCapCents: 100_000 });
  const api: ReturnType<OpeningAiGradingServiceDeps["budget"]> = {
    reserve: input => budget.reserve(fixture.scope, input), release: (...args) => budget.release(fixture.scope, ...args),
    claimExecution: id => budget.claimExecution(fixture.scope, id), settle: (...args) => budget.settle(fixture.scope, ...args),
    markUnknown: id => budget.markUnknown(fixture.scope, id),
  };
  let current = model("old-model", 1);
  const gateway = createModelGateway({ resolve: async () => current });
  const deps: OpeningAiGradingServiceDeps = { repository, gateway, budget: () => api, images: async () => [] };
  const operationId = (await repository.context(fixture.scope, { observationId: original.id })).operationId;
  return { original, repository, jobs, queue, budget, api, deps, operationId, jobId: status.jobId!,
    service: createOpeningAiGradingService(deps), setModel: (next: ResolvedTaskModel) => { current = next; } };
}

it.each(["not_sent", "cancelled"] as const)("retries a confirmed %s release after switching models through the real gateway and budget repository", async reason => {
  const f = await setup(), oldCalls = vi.fn(async (): Promise<ProviderOutput> => { throw new OpeningProviderError("PROVIDER_AUTH", "bad old credentials"); });
  const old = model("old-model", 1, oldCalls), nextCalls = vi.fn(async () => output), next = model("replacement-model", 20_000, nextCalls);
  f.setModel(old);
  const handler = createGradeObservationHandler(f.deps);
  if (reason === "not_sent") {
    await runJob(f.queue, f.jobId, handler);
    expect((await f.queue.get(fixture.scope, f.jobId)).state).toBe("failed");
    expect(oldCalls).toHaveBeenCalledTimes(1);
  } else {
    await f.budget.reserve(fixture.scope, { purpose: "grade-text", requestId: f.operationId, amountCents: 7,
      parentBudget: { id: f.operationId }, modelSnapshot: old.modelSnapshot });
    await f.budget.release(fixture.scope, f.operationId, "cancelled");
    await f.queue.cancel(fixture.scope, f.jobId);
  }
  const [before] = await fixture.sql`SELECT * FROM opening_budget_reservations WHERE request_id=${f.operationId}`;
  expect(before).toMatchObject({ state: "released", release_reason: reason, model_snapshot: old.modelSnapshot });
  // The generic budget contract is deliberately NOT relaxed for changed snapshots or amounts.
  await expect(f.budget.reserve(fixture.scope, { purpose: "grade-text", requestId: f.operationId, amountCents: 99,
    parentBudget: { id: f.operationId }, modelSnapshot: next.modelSnapshot })).rejects.toMatchObject({ code: "CONFLICT" });
  f.setModel(next);
  expect(await f.jobs.enqueue(fixture.scope, { observationId: f.original.id })).toMatchObject({ status: "queued", answerRevision: 1 });
  await runJob(f.queue, f.jobId, handler);
  expect((await f.queue.get(fixture.scope, f.jobId)).state).toBe("succeeded");
  const result = await f.service.grade(fixture.scope, { observationId: f.original.id });
  expect(result.aiEvaluation?.modelLabel).toBe("replacement-model");
  expect(nextCalls).toHaveBeenCalledTimes(1);
  const rows = await fixture.sql`SELECT * FROM opening_budget_reservations ORDER BY created_at,id`;
  expect(rows).toHaveLength(2);
  expect(rows.find(row => row.request_id === f.operationId)).toEqual(before);
  expect(rows.find(row => row.request_id === `${f.operationId}:retry:${before!.id}`)).toMatchObject({
    state: "completed", model_snapshot: next.modelSnapshot, result_ref: `ai-grade:${f.original.id}`,
  });
  expect(await f.jobs.enqueue(fixture.scope, { observationId: result.id })).toMatchObject({ status: "graded", retryable: false, answerRevision: 1 });
  expect(nextCalls).toHaveBeenCalledTimes(1);
});

it("follows released deterministic retry keys without touching any old model snapshots", async () => {
  const f = await setup(), old = model("removed-model", 1);
  const first = await f.budget.reserve(fixture.scope, { purpose: "grade-text", amountCents: 8, requestId: f.operationId,
    modelSnapshot: old.modelSnapshot, parentBudget: { id: f.operationId } });
  await f.budget.release(fixture.scope, first.requestId, "not_sent");
  const retryKey = `${f.operationId}:retry:${first.id}`;
  const second = await f.budget.reserve(fixture.scope, { purpose: "grade-text", amountCents: 9, requestId: retryKey,
    modelSnapshot: old.modelSnapshot, parentBudget: { id: retryKey } });
  await f.budget.release(fixture.scope, second.requestId, "cancelled");
  const complete = vi.fn(async () => output); f.setModel(model("third-model", 20_000, complete));
  expect((await f.service.grade(fixture.scope, { observationId: f.original.id })).outcome).toBe("correct");
  expect(complete).toHaveBeenCalledTimes(1);
  const rows = await fixture.sql`SELECT request_id,state FROM opening_budget_reservations`;
  expect(rows).toHaveLength(3);
  expect(rows).toContainEqual({ request_id: `${f.operationId}:retry:${second.id}`, state: "completed" });
});

it.each(["unknown", "completed", "claimed", "reserved", "unconfirmed"] as const)("does not use a changed model to bypass a %s fallback or retry reservation", async disposition => {
  const f = await setup(), old = model("old-model", 1);
  const first = await f.budget.reserve(fixture.scope, { purpose: "grade-text", amountCents: 7, requestId: f.operationId,
    modelSnapshot: old.modelSnapshot, parentBudget: { id: f.operationId } });
  await f.budget.release(fixture.scope, first.requestId, "not_sent");
  // Unknown/completed/claimed siblings must block the entire family even with no configured fallback.
  const blockedKey = disposition === "reserved" ? `${f.operationId}:retry:${first.id}` : `${f.operationId}:fallback`;
  const blocked = await f.budget.reserve(fixture.scope, { purpose: "grade-text", amountCents: 7, requestId: blockedKey,
    modelSnapshot: old.modelSnapshot, parentBudget: { id: disposition === "reserved" ? blockedKey : f.operationId } });
  if (disposition === "unknown") await f.budget.markUnknown(fixture.scope, blocked.id);
  if (disposition === "claimed") await f.budget.claimExecution(fixture.scope, blocked.id);
  if (disposition === "completed") await f.budget.settle(fixture.scope, blocked.id, 1);
  if (disposition === "unconfirmed") {
    await f.budget.release(fixture.scope, blocked.requestId, "not_sent");
    await fixture.sql`UPDATE opening_budget_reservations SET release_reason=NULL WHERE id=${blocked.id}`;
  }
  const complete = vi.fn(async () => output); f.setModel(model("new-model", 20_000, complete));
  const before = await fixture.sql`SELECT * FROM opening_budget_reservations ORDER BY id`;
  await expect(f.service.grade(fixture.scope, { observationId: f.original.id })).rejects.toMatchObject({
    code: disposition === "unknown" || disposition === "claimed" ? "GRADING_UNKNOWN_COST" : "CONFLICT",
  });
  expect(complete).not.toHaveBeenCalled();
  expect(await fixture.sql`SELECT * FROM opening_budget_reservations ORDER BY id`).toEqual(before);
  expect(await fixture.sql`SELECT id FROM opening_learning_observations WHERE revises_observation_id=${f.original.id}`).toHaveLength(0);
});

it("only recognizes a released receipt for its owner, exact request, purpose and pinned parent", async () => {
  const f = await setup(), input = { purpose: "grade-text", amountCents: 7, requestId: f.operationId, parentBudget: { id: f.operationId } };
  const row = await f.budget.reserve(fixture.scope, input);
  expect(await f.repository.releasedReservation(fixture.scope, input)).toBeNull();
  await f.budget.release(fixture.scope, f.operationId, "not_sent");
  expect(await f.repository.releasedReservation(fixture.scope, input)).toMatchObject({ id: row.id, state: "released", releaseReason: "not_sent" });
  expect(await f.repository.releasedReservation(fixture.otherScope, input)).toBeNull();
  expect(await f.repository.releasedReservation({ ...fixture.scope, ownerUserId: fixture.otherScope.ownerUserId }, input)).toBeNull();
  expect(await f.repository.releasedReservation(fixture.scope, { ...input, requestId: randomUUID() })).toBeNull();
  expect(await f.repository.releasedReservation(fixture.scope, { ...input, purpose: "tutor" })).toBeNull();
  expect(await f.repository.releasedReservation(fixture.scope, { ...input, parentBudget: { id: randomUUID() } })).toBeNull();
});

it("concurrent changed-model retries share one deterministic reservation and one provider claim", async () => {
  const f = await setup(), old = model("old-model", 1);
  const released = await f.budget.reserve(fixture.scope, { purpose: "grade-text", amountCents: 7, requestId: f.operationId,
    modelSnapshot: old.modelSnapshot, parentBudget: { id: f.operationId } });
  await f.budget.release(fixture.scope, f.operationId, "not_sent");
  const complete = vi.fn(async () => output); f.setModel(model("new-model", 20_000, complete));
  const results = await Promise.allSettled([f.service.grade(fixture.scope, { observationId: f.original.id }),
    f.service.grade(fixture.scope, { observationId: f.original.id })]);
  expect(results.some(result => result.status === "fulfilled")).toBe(true);
  expect(complete).toHaveBeenCalledTimes(1);
  const reservations = await fixture.sql`SELECT request_id,state FROM opening_budget_reservations`;
  expect(reservations).toHaveLength(2);
  expect(reservations).toContainEqual({ request_id: `${f.operationId}:retry:${released.id}`, state: "completed" });
  expect(await fixture.sql`SELECT id FROM opening_learning_observations WHERE revises_observation_id=${f.original.id}`).toHaveLength(1);
});

it("replays confirmed released fallback receipts after model changes before selecting a deterministic retry key", async () => {
  const f = await setup(), old = model("old-model", 1);
  const primary = await f.budget.reserve(fixture.scope, { purpose: "grade-text", amountCents: 7, requestId: f.operationId,
    modelSnapshot: old.modelSnapshot, parentBudget: { id: f.operationId } });
  await f.budget.release(fixture.scope, primary.requestId, "not_sent");
  const fallback = await f.budget.reserve(fixture.scope, { purpose: "grade-text", amountCents: 8, requestId: `${f.operationId}:fallback`,
    modelSnapshot: old.modelSnapshot, parentBudget: { id: f.operationId } });
  await f.budget.release(fixture.scope, fallback.requestId, "cancelled");
  const complete = vi.fn(async () => output), changed = model("new-model", 20_000, complete);
  const gateway = createModelGateway({ resolve: async () => changed, resolveFallback: async () => changed });
  const service = createOpeningAiGradingService({ ...f.deps, gateway });
  expect((await service.grade(fixture.scope, { observationId: f.original.id })).outcome).toBe("correct");
  expect(complete).toHaveBeenCalledTimes(1);
  const reservations = await fixture.sql`SELECT request_id,state FROM opening_budget_reservations`;
  expect(reservations).toHaveLength(3);
  expect(reservations).toContainEqual({ request_id: `${f.operationId}:retry:${fallback.id}`, state: "completed" });
});
