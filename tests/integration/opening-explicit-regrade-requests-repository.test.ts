import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { EXPLICIT_REGRADE_CONFIRMATION_TEXT, type ExplicitRegradeRequest } from "@aistudy/contracts";
import { createOpeningAiGradingJobRepository, createOpeningAiGradingRepository, createOpeningExplicitRegradeRequestRepository,
  createOpeningBudgetRepository, createOpeningJobRepository, openingJobScope, reviseOpeningLearningObservation } from "@aistudy/database";
import { createOpeningAiGradingService } from "../../packages/ai/src/opening/ai-grading-service";
import { createModelGateway } from "../../packages/ai/src/opening/model-gateway";
import { createGradeObservationHandler } from "../../apps/worker/src/jobs/grade-observation";
import { runJob } from "../../apps/worker/src/runtime/run-job";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";
import { backupRows } from "./opening-backup-records-fixture";

let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => { await fixture.reset(); await fixture.sql`TRUNCATE opening_learning_sessions,opening_conversations CASCADE`; });
afterAll(async () => { await fixture?.close(); });
const requests = () => createOpeningExplicitRegradeRequestRepository(fixture.sql);
const consent = (request: ExplicitRegradeRequest) => ({ requestId: request.requestId,
  confirmationVersion: request.confirmationVersion, acceptPossibleDoubleCharge: true });
async function unknown(photo = false) {
  const f = await learningAttemptFixture(fixture), attempt = await f.start();
  let workSource = null;
  if (photo) {
    const id = await backupRows(fixture.sql, fixture.scope).source();
    await fixture.sql`UPDATE opening_sources SET mime='image/png',parse_state='not_started' WHERE id=${id}`;
    workSource = { id, version: 1, physicalPage: 1 };
  }
  const original = photo ? await f.learning.insertObservation(fixture.scope, {
    attemptId: attempt.id, sessionId: f.sessionId, courseId: f.courseId, skillLabel: "fractions", sourceIds: [f.sourceId],
    answer: "", outcome: "unverified", assistance: "independent", clientKey: randomUUID(),
  }, { workSource: workSource! }) : await f.submit(attempt, { outcome: "unverified" });
  const [row] = await fixture.sql`SELECT grading_operation_id FROM opening_learning_observations WHERE id=${original.id}`;
  const operation = String(row!.grading_operation_id);
  // Two synthetic 9-cent unknown reservations; neither may be touched.
  for (const requestId of [operation, `${operation}:fallback`]) await fixture.sql`INSERT INTO opening_budget_reservations
    (workspace_id,purpose,amount_cents,request_id,state,execution_claimed_at,outcome_unknown_at)
    VALUES(${fixture.scope.workspaceId},'grading',9,${requestId},'reserved',now(),now())`;
  const prepare = { observationId: original.id, expectedHead: original.id, expectedGradingVersion: 0, clientKey: randomUUID() };
  return { f, original, operation, prepare, workSource };
}
async function fees() { return [...await fixture.sql`SELECT * FROM opening_budget_reservations ORDER BY request_id`]; }

it("prepares without jobs or fees and confirms one durable job/outbox without answer or fee changes", async () => {
  const { original, operation, prepare } = await unknown(), before = await fees();
  const [first, replay] = await Promise.all([requests().prepare(fixture.scope, prepare), requests().prepare(fixture.scope, prepare)]);
  expect(replay).toEqual(first);
  expect(first).toMatchObject({ expectedHead: original.id, rootObservationId: original.id, answerRevision: 1,
    previousGradingVersion: 0, gradingVersion: 1, previousOperationId: operation, state: "prepared", confirmedAt: null,
    confirmationText: EXPLICIT_REGRADE_CONFIRMATION_TEXT, jobId: null, resultObservationId: null });
  expect(first.operationId).toBe(`ai-regrade:${fixture.scope.workspaceId}:${first.requestId}`);
  const jobs = [...await fixture.sql`SELECT * FROM opening_jobs ORDER BY id`];
  const outbox = [...await fixture.sql`SELECT * FROM opening_outbox ORDER BY id`];
  const observations = [...await fixture.sql`SELECT * FROM opening_learning_observations ORDER BY id`];
  const [confirmed, repeated] = await Promise.all([requests().confirm(fixture.scope, consent(first)), requests().confirm(fixture.scope, consent(first))]);
  expect(confirmed.state).toBe("confirmed"); expect(confirmed.confirmedAt).not.toBeNull(); expect(repeated).toEqual(confirmed);
  expect(await requests().prepare(fixture.scope, prepare)).toEqual(confirmed);
  expect(await fees()).toEqual(before);
  expect(await fixture.sql`SELECT id FROM opening_jobs`).toHaveLength(jobs.length + 1);
  expect(await fixture.sql`SELECT id FROM opening_outbox`).toHaveLength(outbox.length + 1);
  expect(confirmed.jobId).not.toBeNull();
  expect(await fixture.sql`SELECT id FROM opening_jobs WHERE key=${confirmed.operationId}`).toHaveLength(1);
  expect(await fixture.sql`SELECT id FROM opening_outbox WHERE job_id=${confirmed.jobId}`).toHaveLength(1);
  expect([...await fixture.sql`SELECT * FROM opening_learning_observations ORDER BY id`]).toEqual(observations);
});

it("allows exactly one consumed successor across tabs, and a fresh version only after that operation is unknown", async () => {
  const { prepare } = await unknown();
  const tabs = await Promise.all([requests().prepare(fixture.scope, prepare), requests().prepare(fixture.scope, { ...prepare, clientKey: randomUUID() })]);
  const outcomes = await Promise.allSettled(tabs.map(tab => requests().confirm(fixture.scope, consent(tab))));
  expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
  const winner = (outcomes.find(result => result.status === "fulfilled") as PromiseFulfilledResult<ExplicitRegradeRequest>).value;
  expect(outcomes.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "CONFLICT" } });
  await expect(requests().prepare(fixture.scope, { ...prepare, clientKey: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(requests().prepare(fixture.scope, { ...prepare, expectedGradingVersion: 1, clientKey: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT" });
  await fixture.sql`INSERT INTO opening_budget_reservations(workspace_id,purpose,amount_cents,request_id,state,execution_claimed_at,outcome_unknown_at)
    VALUES(${fixture.scope.workspaceId},'grading',1,${winner.operationId},'reserved',now(),now())`;
  const second = await requests().prepare(fixture.scope, { ...prepare, expectedGradingVersion: 1, clientKey: randomUUID() });
  expect(second).toMatchObject({ gradingVersion: 2, previousGradingVersion: 1, previousOperationId: winner.operationId });
  await requests().confirm(fixture.scope, consent(second));
  await expect(requests().confirm(fixture.scope, consent(winner))).rejects.toMatchObject({ code: "CONFLICT" });
  // The partial unique index independently enforces cross-tab single consumption.
  const loser = tabs.find(tab => tab.requestId !== winner.requestId)!;
  await expect(fixture.sql`UPDATE opening_explicit_regrade_requests SET confirmed_at=now() WHERE id=${loser.requestId}`).rejects.toMatchObject({ code: "23505" });
});

it.each(["head", "answer", "epoch", "owner", "disabled", "privacy", "source", "settled"] as const)("rejects stale %s at confirmation without consuming consent or changing fees", async change => {
  const { original, f, prepare } = await unknown(), before = await fees();
  const prepared = await requests().prepare(fixture.scope, prepare);
  let scope = fixture.scope;
  if (change === "head" || change === "answer") await reviseOpeningLearningObservation(fixture.sql, scope, {
    rootObservationId: original.id, expectedHead: original.id, revisesObservationId: original.id,
    revisionKind: "replace", reason: "修正", clientKey: randomUUID(), replacement: {
      answer: change === "answer" ? "2" : original.answer, outcome: "unverified", assistance: original.assistance,
    },
  });
  if (change === "epoch") await fixture.sql`UPDATE workspaces SET privacy_epoch=privacy_epoch+1 WHERE id=${scope.workspaceId}`;
  if (change === "owner") scope = fixture.otherScope;
  if (change === "disabled") await fixture.sql`UPDATE users SET disabled_at=now() WHERE id=${scope.ownerUserId}`;
  if (change === "privacy") await fixture.sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id) VALUES(${scope.workspaceId},${f.sourceId})`;
  if (change === "source") await fixture.sql`UPDATE opening_sources SET version=version+1 WHERE id=${f.sourceId}`;
  if (change === "settled") await fixture.sql`UPDATE opening_budget_reservations SET state='completed',outcome_unknown_at=NULL WHERE workspace_id=${scope.workspaceId}`;
  const atConfirm = await fees();
  await expect(requests().confirm(scope, consent(prepared))).rejects.toThrow();
  expect((await fixture.sql`SELECT confirmed_at FROM opening_explicit_regrade_requests WHERE id=${prepared.requestId}`)[0]?.confirmed_at).toBeNull();
  expect(await fees()).toEqual(atConfirm);
  if (change !== "settled") expect(await fees()).toEqual(before);
  if (change === "disabled") await fixture.sql`UPDATE users SET disabled_at=NULL WHERE id=${fixture.scope.ownerUserId}`;
});

it("rejects foreign/rebound keys and unknown confirmations, and keeps manual-exit eligibility without changing the answer", async () => {
  const { original, prepare } = await unknown();
  const prepared = await requests().prepare(fixture.scope, prepare);
  await expect(requests().confirm(fixture.otherScope, consent(prepared))).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(requests().confirm(fixture.scope, { ...consent(prepared), requestId: randomUUID() })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(requests().prepare(fixture.scope, { ...prepare, expectedGradingVersion: 1 })).rejects.toMatchObject({ code: "CONFLICT" });
  const manual = (await reviseOpeningLearningObservation(fixture.sql, fixture.scope, {
    rootObservationId: original.id, expectedHead: original.id, revisesObservationId: original.id,
    revisionKind: "replace", reason: "人工出口", clientKey: randomUUID(), replacement: {
      answer: original.answer, outcome: "correct", assistance: original.assistance,
    },
  })).observation!;
  await expect(requests().prepare(fixture.scope, { ...prepare, observationId: manual.id, expectedHead: manual.id })).rejects.toMatchObject({ code: "CONFLICT" });
  const fresh = await requests().prepare(fixture.scope, { ...prepare, observationId: manual.id, expectedHead: manual.id, clientKey: randomUUID() });
  expect(fresh).toMatchObject({ expectedHead: manual.id, rootObservationId: original.id, answerRevision: 1 });
  await requests().confirm(fixture.scope, consent(fresh));
  expect((await fixture.sql`SELECT answer,outcome,ai_evaluation FROM opening_learning_observations WHERE id=${manual.id}`)[0])
    .toEqual({ answer: original.answer, outcome: "correct", ai_evaluation: null });
});

it.each(["unsent", "in_flight", "completed"] as const)("does not turn a %s operation into paid regrade consent", async state => {
  const { prepare } = await unknown();
  if (state === "unsent") await fixture.sql`DELETE FROM opening_budget_reservations WHERE workspace_id=${fixture.scope.workspaceId}`;
  else await fixture.sql`UPDATE opening_budget_reservations SET outcome_unknown_at=NULL,state=${state === "completed" ? "completed" : "reserved"}
    WHERE workspace_id=${fixture.scope.workspaceId}`;
  await expect(requests().prepare(fixture.scope, prepare)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await fixture.sql`SELECT id FROM opening_explicit_regrade_requests WHERE workspace_id=${fixture.scope.workspaceId}`).toHaveLength(0);
});

it("retains sealed photo identity and rejects photo changes and client-chosen operations", async () => {
  const { prepare, original, workSource } = await unknown(true);
  const prepared = await requests().prepare(fixture.scope, prepare);
  expect(prepared.workSource).toEqual(workSource);
  await expect(requests().prepare(fixture.scope, { ...prepare, operationId: "ai-regrade:invented" })).rejects.toThrow();
  await expect(requests().prepare(fixture.scope, { ...prepare, workSourceId: randomUUID() })).rejects.toThrow();
  await fixture.sql`UPDATE opening_sources SET version=version+1 WHERE id=${workSource!.id}`;
  await expect(requests().confirm(fixture.scope, consent(prepared))).rejects.toMatchObject({ code: "CONFLICT" });
  expect((await fixture.sql`SELECT grading_work_source,answer_revision FROM opening_learning_observations WHERE id=${original.id}`)[0])
    .toEqual({ grading_work_source: workSource, answer_revision: 1 });
});

it("serializes confirmation against a racing historical publication: only one can win", async () => {
  const { prepare, original } = await unknown(), before = await fees();
  const prepared = await requests().prepare(fixture.scope, prepare);
  const grades = createOpeningAiGradingRepository(fixture.sql);
  const outcomes = await Promise.allSettled([
    requests().confirm(fixture.scope, consent(prepared)),
    grades.apply(fixture.scope, { observationId: original.id }, {
      outcome: "correct", confidence: .9, questionMatch: true, feedback: "racing result",
      criteria: [{ label: "sum", verdict: "correct", feedback: "sum checked" }],
    }, "synthetic"),
  ]);
  expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "CONFLICT" } });
  const [request] = await fixture.sql`SELECT confirmed_at FROM opening_explicit_regrade_requests WHERE id=${prepared.requestId}`;
  const [root] = await fixture.sql`SELECT effective_head_id FROM opening_learning_observations WHERE id=${original.id}`;
  if (request!.confirmed_at) expect(root!.effective_head_id ?? original.id).toBe(original.id);
  else expect(root!.effective_head_id).not.toBe(original.id);
  expect(await fees()).toEqual(before);
});

it("enforces request namespace, version succession and confirmation linkage in PostgreSQL", async () => {
  const { prepare } = await unknown();
  const prepared = await requests().prepare(fixture.scope, prepare);
  await expect(fixture.sql`UPDATE opening_explicit_regrade_requests SET operation_id='ai-grade:old:random' WHERE id=${prepared.requestId}`)
    .rejects.toMatchObject({ code: "23514" });
  await expect(fixture.sql`UPDATE opening_explicit_regrade_requests SET grading_version=3 WHERE id=${prepared.requestId}`)
    .rejects.toMatchObject({ code: "23514" });
  await expect(fixture.sql`UPDATE opening_explicit_regrade_requests SET confirmation_version='unknown' WHERE id=${prepared.requestId}`)
    .rejects.toMatchObject({ code: "23514" });
  const [job] = await fixture.sql`SELECT id FROM opening_jobs WHERE workspace_id=${fixture.scope.workspaceId} LIMIT 1`;
  await expect(fixture.sql`UPDATE opening_explicit_regrade_requests SET job_id=${job!.id} WHERE id=${prepared.requestId}`)
    .rejects.toMatchObject({ code: "23514" });
});

it("keeps the legacy unknown API closed and fences late evaluation but allows old billing to settle", async () => {
  const { prepare, original, operation } = await unknown();
  const grades = createOpeningAiGradingRepository(fixture.sql), call = vi.fn();
  const service = createOpeningAiGradingService({ repository: grades, gateway: { call }, budget: () => ({} as never), images: async () => [] });
  await expect(service.grade(fixture.scope, { observationId: original.id })).rejects.toMatchObject({ code: "GRADING_UNKNOWN_COST" });
  expect(call).not.toHaveBeenCalled();
  const oldJob = await createOpeningAiGradingJobRepository(fixture.sql).read(fixture.scope, { observationId: original.id });
  const claimed = (await createOpeningJobRepository(fixture.sql).claim(oldJob.jobId!))!;
  await grades.context(openingJobScope(claimed), { observationId: original.id });
  const prepared = await requests().prepare(fixture.scope, prepare);
  // Invalid consent must not fence the historical execution.
  await expect(requests().confirm(fixture.scope, { ...consent(prepared), acceptPossibleDoubleCharge: false })).rejects.toThrow();
  await grades.context(openingJobScope(claimed), { observationId: original.id });
  await requests().confirm(fixture.scope, consent(prepared));
  await expect(grades.apply(openingJobScope(claimed), { observationId: original.id }, {
    outcome: "correct", confidence: .9, questionMatch: true, feedback: "late",
    criteria: [{ label: "sum", verdict: "correct", feedback: "late" }],
  }, "synthetic")).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(grades.context(fixture.scope, { observationId: original.id })).rejects.toMatchObject({ code: "CONFLICT" });
  // Billing is deliberately independent from the publication fence.
  await fixture.sql`UPDATE opening_budget_reservations SET state='completed',outcome_unknown_at=NULL WHERE request_id=${operation}`;
  expect((await fixture.sql`SELECT state FROM opening_budget_reservations WHERE request_id=${operation}`)[0]?.state).toBe("completed");
  expect(await fixture.sql`SELECT id FROM opening_learning_observations WHERE revises_observation_id=${original.id}`).toHaveLength(0);
  expect((await fixture.sql`SELECT effective_head_id FROM opening_learning_observations WHERE id=${original.id}`)[0]?.effective_head_id ?? original.id).toBe(original.id);
});


it("recovers a stage-one confirmed-without-job row via the actual sweep, once across concurrent recoverers", async () => {
  const { prepare } = await unknown(), before = await fees();
  const prepared = await requests().prepare(fixture.scope, prepare);
  // This is the exact durable state produced by the frozen stage-one implementation.
  await fixture.sql`UPDATE opening_explicit_regrade_requests SET confirmed_at=now() WHERE id=${prepared.requestId}`;
  expect((await requests().read(fixture.scope, prepared.requestId)).request.jobId).toBeNull();
  const counts = await Promise.all([requests().recoverConfirmed(), requests().recoverConfirmed()]);
  expect(counts.reduce((a,b) => a+b,0)).toBe(1);
  const status = await requests().read(fixture.scope, prepared.requestId);
  expect(status).toMatchObject({ request: { gradingVersion: 1, operationId: prepared.operationId }, ledger: "unsent", jobState: "queued" });
  expect(await fixture.sql`SELECT id FROM opening_jobs WHERE key=${prepared.operationId}`).toHaveLength(1);
  expect(await fixture.sql`SELECT id FROM opening_outbox WHERE job_id=${status.request.jobId}`).toHaveLength(1);
  expect(await requests().confirm(fixture.scope, consent(prepared))).toEqual(status.request);
  expect(await fees()).toEqual(before);
});

it.each([
  { photo: false, outcome: "correct" }, { photo: true, outcome: "correct" }, { photo: false, outcome: "unverified" },
] as const)("runs the confirmed version through real PG budget/gateway/worker once ($photo/$outcome), preserving old unknown fees", async ({ photo, outcome }) => {
  const { prepare, original, workSource } = await unknown(photo), before = await fees();
  await fixture.sql`UPDATE opening_source_chunks SET image_object_key=NULL`;
  const prepared = await requests().prepare(fixture.scope, prepare);
  const confirmed = await requests().confirm(fixture.scope, consent(prepared));
  expect(await fees()).toEqual(before);
  const queue = createOpeningJobRepository(fixture.sql), repository = createOpeningAiGradingRepository(fixture.sql);
  const budget = createOpeningBudgetRepository(fixture.sql, { envCapCents: 100_000 });
  const complete = vi.fn(async () => ({ text: JSON.stringify({ outcome, confidence: .95, questionMatch: true,
    feedback: "synthetic", criteria: [{ label: "sum", verdict: outcome, feedback: "checked" }] }),
    inputTokens: 10, outputTokens: 10, citedChunkIds: [], requestId: null, candidates: [] }));
  const gateway = createModelGateway({ resolve: async () => ({ provider: { complete },
    modelSnapshot: { id: "synthetic", providerId: "fixture", modelName: "synthetic", inputCentsPerMillion: 100, outputCentsPerMillion: 100,
      ...(photo ? { mediaInputTokenUpperBound: 10000, mediaMaxInputBytes: 1000000, mediaInputCentsPerMillion: 100 } : {}) },
    inputCentsPerMillion: 100, outputCentsPerMillion: 100, supportsVision: true }) });
  const handler = createGradeObservationHandler({ repository, gateway, budget: scope => ({
    reserve: input => budget.reserve(scope, input), release: (...args) => budget.release(scope, ...args),
    claimExecution: id => budget.claimExecution(scope, id), settle: (...args) => budget.settle(scope, ...args),
    markUnknown: id => budget.markUnknown(scope, id),
  }), images: async (_scope, input) => [{ sourceId: input.sourceIds[0]!, physicalPage: input.physicalPage,
    mediaType: "image/png", data: "data:image/png;base64,AA==" }] });
  expect(await runJob(queue, confirmed.jobId!, handler)).toBe(true);
  const job = await queue.get(fixture.scope, confirmed.jobId!);
  expect(job.state, JSON.stringify(job.result)).toBe("succeeded");
  expect(await runJob(queue, confirmed.jobId!, handler)).toBe(false);
  expect(complete).toHaveBeenCalledTimes(1);
  const status = await requests().read(fixture.scope, prepared.requestId);
  expect(status).toMatchObject({ ledger: "completed", jobState: "succeeded",
    status: outcome === "unverified" ? "needs_manual" : "graded", request: { gradingVersion: 1 } });
  expect(status.request.resultObservationId).not.toBeNull();
  const [head] = await fixture.sql`SELECT * FROM opening_learning_observations WHERE id=${status.request.resultObservationId}`;
  expect(head).toMatchObject({ answer: original.answer, answer_revision: 1, grading_operation_id: prepared.operationId,
    client_key: prepared.operationId, grading_work_source: workSource });
  expect(await requests().confirm(fixture.scope, consent(prepared))).toEqual(status.request);
  expect(await fixture.sql`SELECT * FROM opening_budget_reservations WHERE request_id!=${prepared.operationId} ORDER BY request_id`).toEqual(before);
  expect(await fixture.sql`SELECT id FROM opening_budget_reservations WHERE request_id=${prepared.operationId}`).toHaveLength(1);
  await fixture.sql`UPDATE opening_budget_reservations SET state='reserved',outcome_unknown_at=now() WHERE request_id=${prepared.operationId}`;
  expect((await requests().read(fixture.scope, prepared.requestId)).status).toBe("unknown_cost");
});

it.each(["epoch", "head", "photo", "payload", "cancel"] as const)("rejects stale confirmed %s before any reserve", async change => {
  const { prepare, original, workSource } = await unknown(true), before = await fees();
  const prepared = await requests().prepare(fixture.scope, prepare), confirmed = await requests().confirm(fixture.scope, consent(prepared));
  const queue = createOpeningJobRepository(fixture.sql), job = (await queue.claim(confirmed.jobId!))!;
  if (change === "epoch") await fixture.sql`UPDATE workspaces SET privacy_epoch=privacy_epoch+1 WHERE id=${fixture.scope.workspaceId}`;
  if (change === "head") await reviseOpeningLearningObservation(fixture.sql, fixture.scope, { rootObservationId: original.id,
    revisesObservationId: original.id, expectedHead: original.id, revisionKind: "replace", reason: "manual",
    clientKey: randomUUID(), replacement: { answer: "changed", outcome: "unverified", assistance: original.assistance } });
  if (change === "photo") await fixture.sql`UPDATE opening_sources SET version=version+1 WHERE id=${workSource!.id}`;
  if (change === "payload") await fixture.sql`UPDATE opening_jobs SET payload=jsonb_set(payload,'{regrade,operationId}','"invented"') WHERE id=${job.id}`;
  if (change === "cancel") await queue.cancel(fixture.scope, job.id);
  const reserve = vi.fn(), call = vi.fn();
  const handler = createGradeObservationHandler({ repository: createOpeningAiGradingRepository(fixture.sql),
    gateway: { call }, budget: () => ({ reserve } as never), images: async () => [] });
  await expect(handler(job, job.payload)).rejects.toThrow();
  expect(reserve).not.toHaveBeenCalled(); expect(call).not.toHaveBeenCalled(); expect(await fees()).toEqual(before);
});


it("keeps a new unknown operation unretried/unreleased, inherits exactly one next version and fences both late predecessors", async () => {
  const { prepare, original } = await unknown();
  const first = await requests().confirm(fixture.scope, consent(await requests().prepare(fixture.scope, prepare)));
  const queue = createOpeningJobRepository(fixture.sql), jobs = createOpeningAiGradingJobRepository(fixture.sql);
  const claimed = (await queue.claim(first.jobId!))!, grades = createOpeningAiGradingRepository(fixture.sql);
  const scope = openingJobScope(claimed);
  expect((await grades.context(scope, { observationId: original.id })).operationId).toBe(first.operationId);
  await fixture.sql`INSERT INTO opening_budget_reservations(workspace_id,purpose,amount_cents,request_id,state,execution_claimed_at,outcome_unknown_at)
    VALUES(${fixture.scope.workspaceId},'grading',1,${first.operationId},'reserved',now(),now())`;
  const before = await fees();
  await fixture.sql`UPDATE opening_jobs SET updated_at=now()-interval '6 minutes' WHERE id=${first.jobId}`;
  await jobs.recoverExpired();
  expect(await requests().read(fixture.scope, first.requestId)).toMatchObject({ ledger: "unknown", status: "unknown_cost", jobState: "outcome_unknown" });
  expect(await requests().confirm(fixture.scope, consent(first))).toMatchObject({ jobId: first.jobId });
  expect(await requests().recoverConfirmed()).toBe(0);
  expect(await queue.claim(first.jobId!)).toBeNull();
  expect(await fixture.sql`SELECT id FROM opening_outbox WHERE job_id=${first.jobId}`).toHaveLength(1);
  const tabs = await Promise.all([1,2].map(() => requests().prepare(fixture.scope, {
    ...prepare, expectedGradingVersion: 1, clientKey: randomUUID(),
  })));
  const outcomes = await Promise.allSettled(tabs.map(tab => requests().confirm(fixture.scope, consent(tab))));
  expect(outcomes.filter(item => item.status === "fulfilled")).toHaveLength(1);
  const next = (outcomes.find(item => item.status === "fulfilled") as PromiseFulfilledResult<ExplicitRegradeRequest>).value;
  expect(next).toMatchObject({ gradingVersion: 2, previousOperationId: first.operationId });
  expect((await requests().read(fixture.scope, next.requestId))).toMatchObject({ ledger: "unsent", status: "queued" });
  await expect(requests().confirm(fixture.scope, consent(first))).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(grades.context(scope, { observationId: original.id })).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(grades.context(fixture.scope, { observationId: original.id })).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await fees()).toEqual(before);
  await expect(requests().read(fixture.otherScope, next.requestId)).rejects.toMatchObject({ code: "NOT_FOUND" });
});

it("rolls confirmation back when its persistent job identity conflicts", async () => {
  const { prepare } = await unknown(), prepared = await requests().prepare(fixture.scope, prepare), before = await fees();
  await createOpeningJobRepository(fixture.sql).createOnce(fixture.scope, { key: prepared.operationId,
    kind: "grade-observation", payload: { invalid: true }, privacyEpoch: prepared.privacyEpoch });
  await expect(requests().confirm(fixture.scope, consent(prepared))).rejects.toMatchObject({ code: "CONFLICT" });
  const status = await requests().read(fixture.scope, prepared.requestId);
  expect(status).toMatchObject({ status: "prepared", request: { confirmedAt: null, jobId: null } });
  expect(await fixture.sql`SELECT o.id FROM opening_outbox o JOIN opening_jobs j ON j.id=o.job_id WHERE j.key=${prepared.operationId}`).toHaveLength(0);
  expect(await fees()).toEqual(before);
});

it("fences an otherwise-live earlier regrade claim when a successor is confirmed, independently of settlement", async () => {
  const { prepare, original } = await unknown();
  const first = await requests().confirm(fixture.scope, consent(await requests().prepare(fixture.scope, prepare)));
  const queue = createOpeningJobRepository(fixture.sql), claimed = (await queue.claim(first.jobId!))!;
  const scope = openingJobScope(claimed), grades = createOpeningAiGradingRepository(fixture.sql);
  await grades.context(scope, { observationId: original.id });
  await fixture.sql`INSERT INTO opening_budget_reservations(workspace_id,purpose,amount_cents,request_id,state,execution_claimed_at,outcome_unknown_at)
    VALUES(${fixture.scope.workspaceId},'grading',1,${first.operationId},'reserved',now(),now())`;
  const second = await requests().prepare(fixture.scope, { ...prepare, expectedGradingVersion: 1, clientKey: randomUUID() });
  await requests().confirm(fixture.scope, consent(second));
  expect((await queue.get(fixture.scope, first.jobId!)).state).toBe("running");
  await expect(grades.apply(scope, { observationId: original.id }, { outcome: "correct", confidence: .95,
    questionMatch: true, feedback: "late", criteria: [{ label: "sum", verdict: "correct", feedback: "late" }] }, "synthetic"))
    .rejects.toMatchObject({ code: "CONFLICT" });
  await fixture.sql`UPDATE opening_budget_reservations SET state='completed',outcome_unknown_at=NULL WHERE request_id=${first.operationId}`;
  expect((await requests().read(fixture.scope, first.requestId)).ledger).toBe("completed");
  expect((await requests().read(fixture.scope, second.requestId)).ledger).toBe("unsent");
  expect(await fixture.sql`SELECT id FROM opening_learning_observations WHERE revises_observation_id=${original.id}`).toHaveLength(0);
});

it("honors the existing budget cap after consent without a provider call or touching historical fees", async () => {
  const { prepare } = await unknown(), confirmed = await requests().confirm(fixture.scope, consent(await requests().prepare(fixture.scope, prepare)));
  await fixture.sql`UPDATE opening_source_chunks SET image_object_key=NULL`;
  const before = await fees(), queue = createOpeningJobRepository(fixture.sql);
  const budget = createOpeningBudgetRepository(fixture.sql, { envCapCents: 1 });
  const complete = vi.fn();
  const gateway = createModelGateway({ resolve: async () => ({ provider: { complete },
    modelSnapshot: { id: "synthetic", providerId: "fixture", modelName: "synthetic", inputCentsPerMillion: 1000000, outputCentsPerMillion: 1000000 },
    inputCentsPerMillion: 1000000, outputCentsPerMillion: 1000000 }) });
  const handler = createGradeObservationHandler({ repository: createOpeningAiGradingRepository(fixture.sql), gateway,
    budget: scope => ({ reserve: input => budget.reserve(scope, input), release: (...args) => budget.release(scope, ...args),
      claimExecution: id => budget.claimExecution(scope, id), settle: (...args) => budget.settle(scope, ...args),
      markUnknown: id => budget.markUnknown(scope, id) }), images: async () => [] });
  await runJob(queue, confirmed.jobId!, handler);
  expect((await queue.get(fixture.scope, confirmed.jobId!)).state).toBe("failed");
  expect(complete).not.toHaveBeenCalled(); expect(await fees()).toEqual(before);
  expect(await requests().read(fixture.scope, confirmed.requestId)).toMatchObject({ ledger: "unsent", status: "needs_manual" });
});

it("retries transport delivery of the same confirmed job without another consent, job or reserve", async () => {
  const { prepare } = await unknown(), confirmed = await requests().confirm(fixture.scope, consent(await requests().prepare(fixture.scope, prepare)));
  const before = await fees(), queue = createOpeningJobRepository(fixture.sql);
  await queue.dispatchPending(async item => { if (item.jobId === confirmed.jobId) throw new Error("synthetic transport interruption"); });
  expect((await queue.get(fixture.scope, confirmed.jobId!)).state).toBe("queued");
  await fixture.sql`UPDATE opening_outbox SET next_attempt_at=now() WHERE job_id=${confirmed.jobId}`;
  const delivered: string[] = [];
  await queue.dispatchPending(async item => { delivered.push(item.jobId); });
  expect(delivered).toContain(confirmed.jobId);
  expect(await fixture.sql`SELECT id FROM opening_outbox WHERE job_id=${confirmed.jobId} AND state='published'`).toHaveLength(1);
  expect(await fixture.sql`SELECT id FROM opening_jobs WHERE key=${confirmed.operationId}`).toHaveLength(1);
  expect(await fees()).toEqual(before);
});

it("recovers only the new unsent job before reserve and retains its operation with a fresh claim", async () => {
  const { prepare, original } = await unknown(), before = await fees();
  const confirmed = await requests().confirm(fixture.scope, consent(await requests().prepare(fixture.scope, prepare)));
  const queue = createOpeningJobRepository(fixture.sql), jobs = createOpeningAiGradingJobRepository(fixture.sql);
  const first = (await queue.claim(confirmed.jobId!))!;
  await fixture.sql`UPDATE opening_jobs SET updated_at=now()-interval '6 minutes' WHERE id=${first.id}`;
  await jobs.recoverExpired();
  const next = (await queue.claim(first.id))!;
  expect(next.claimToken).not.toBe(first.claimToken);
  const grades = createOpeningAiGradingRepository(fixture.sql);
  await expect(grades.context(openingJobScope(first), { observationId: original.id })).rejects.toMatchObject({ code: "CONFLICT" });
  expect((await grades.context(openingJobScope(next), { observationId: original.id })).operationId).toBe(confirmed.operationId);
  expect(await fees()).toEqual(before);
});
