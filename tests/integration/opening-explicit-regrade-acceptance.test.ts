import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { type ExplicitRegradeRequest } from "@aistudy/contracts";
import {
  createOpeningAiGradingJobRepository, createOpeningAiGradingRepository, createOpeningBudgetRepository,
  createOpeningExplicitRegradeRequestRepository, createOpeningJobRepository, openingJobScope,
} from "@aistudy/database";
import { createModelGateway } from "../../packages/ai/src/opening/model-gateway";
import { createGradeObservationHandler } from "../../apps/worker/src/jobs/grade-observation";
import { runJob } from "../../apps/worker/src/runtime/run-job";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";

let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => {
  await fixture.reset();
  await fixture.sql`TRUNCATE opening_learning_sessions,opening_conversations CASCADE`;
});
afterAll(async () => { await fixture?.close(); });
const consent = (request: ExplicitRegradeRequest) => ({ requestId: request.requestId,
  confirmationVersion: request.confirmationVersion, acceptPossibleDoubleCharge: true });
async function snapshot() {
  return {
    jobs: [...await fixture.sql`SELECT * FROM opening_jobs ORDER BY id`],
    outbox: [...await fixture.sql`SELECT * FROM opening_outbox ORDER BY id`],
    fees: [...await fixture.sql`SELECT * FROM opening_budget_reservations ORDER BY request_id`],
    requests: [...await fixture.sql`SELECT * FROM opening_explicit_regrade_requests ORDER BY id`],
    observations: [...await fixture.sql`SELECT * FROM opening_learning_observations ORDER BY id`],
    sources: [...await fixture.sql`SELECT * FROM opening_source_versions ORDER BY source_id,version`],
  };
}

// Repository + real PG budget + normal worker runtime. Fake provider only; no HTTP/BullMQ claim.
it.each(["correct", "unverified"] as const)("publishes %s once across tab races, lost responses and late old publication", async outcome => {
  const f = await learningAttemptFixture(fixture), original = await f.submit(await f.start(), { outcome: "unverified" });
  const [root] = await fixture.sql`SELECT grading_operation_id FROM opening_learning_observations WHERE id=${original.id}`;
  const oldOperation = String(root!.grading_operation_id);
  for (const key of [oldOperation, `${oldOperation}:fallback`]) {
    await fixture.sql`INSERT INTO opening_budget_reservations
      (workspace_id,purpose,amount_cents,request_id,state,execution_claimed_at,outcome_unknown_at)
      VALUES(${fixture.scope.workspaceId},'grading',9,${key},'reserved',now(),now())`;
  }
  const requests = createOpeningExplicitRegradeRequestRepository(fixture.sql);
  const queue = createOpeningJobRepository(fixture.sql), grades = createOpeningAiGradingRepository(fixture.sql);
  const oldJob = await createOpeningAiGradingJobRepository(fixture.sql).read(fixture.scope, { observationId: original.id });
  const oldClaim = (await queue.claim(oldJob.jobId!))!;
  await grades.context(openingJobScope(oldClaim), { observationId: original.id });
  const before = await snapshot();
  const input = { observationId: original.id, expectedHead: original.id, expectedGradingVersion: 0, clientKey: randomUUID() };
  const tabs = await Promise.all([requests.prepare(fixture.scope, input), requests.prepare(fixture.scope, { ...input, clientKey: randomUUID() })]);
  const prepared = await snapshot();
  expect(prepared.jobs).toEqual(before.jobs);
  expect(prepared.outbox).toEqual(before.outbox);
  expect(prepared.fees).toEqual(before.fees);
  expect(prepared.observations).toEqual(before.observations);
  expect(prepared.requests).toHaveLength(2);
  // Reading a prepared request, including repeated refreshes, cannot enqueue or reserve.
  for (let i = 0; i < 2; i++) expect(await requests.read(fixture.scope, tabs[0]!.requestId))
    .toMatchObject({ status: "prepared", ledger: "unsent", request: { jobId: null } });
  expect(await snapshot()).toEqual(prepared);
  const confirmations = await Promise.allSettled(tabs.map(tab => requests.confirm(fixture.scope, consent(tab))));
  expect(confirmations.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(confirmations.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "CONFLICT" } });
  const winner = (confirmations.find(result => result.status === "fulfilled") as PromiseFulfilledResult<ExplicitRegradeRequest>).value;
  const admitted = await snapshot();
  expect(admitted.jobs).toHaveLength(before.jobs.length + 1);
  expect(admitted.outbox).toHaveLength(before.outbox.length + 1);
  expect(admitted.fees).toEqual(before.fees);
  expect(admitted.observations).toEqual(before.observations);
  const confirmedReads = await Promise.all([requests.read(fixture.scope, winner.requestId), requests.read(fixture.scope, winner.requestId)]);
  expect(confirmedReads[0]).toEqual(confirmedReads[1]);
  expect(confirmedReads[0]).toMatchObject({ status: "queued", ledger: "unsent", jobState: "queued" });
  expect(await snapshot()).toEqual(admitted);
  await expect(requests.read(fixture.otherScope, winner.requestId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await requests.confirm(fixture.scope, consent(winner))).toEqual(winner);
  expect(await snapshot()).toEqual(admitted);
  const dispatched: string[] = [];
  await queue.dispatchPending(async item => { dispatched.push(item.jobId); });
  expect(dispatched.filter(id => id === winner.jobId)).toHaveLength(1);
  const budget = createOpeningBudgetRepository(fixture.sql, { envCapCents: 100_000 });
  const complete = vi.fn(async () => ({ text: JSON.stringify({ outcome, confidence: .95, questionMatch: true,
    feedback: "synthetic acceptance", criteria: [{ label: "sum", verdict: "correct", feedback: "checked" }] }),
    inputTokens: 10, outputTokens: 10, citedChunkIds: [], requestId: null, candidates: [] }));
  const gateway = createModelGateway({ resolve: async () => ({ provider: { complete },
    modelSnapshot: { id: "synthetic", providerId: "fixture", modelName: "synthetic", inputCentsPerMillion: 100, outputCentsPerMillion: 100 },
    inputCentsPerMillion: 100, outputCentsPerMillion: 100, supportsVision: true }) });
  const handler = createGradeObservationHandler({ repository: grades, gateway,
    budget: scope => ({ reserve: input => budget.reserve(scope, input), release: (...args) => budget.release(scope, ...args),
      claimExecution: id => budget.claimExecution(scope, id), settle: (...args) => budget.settle(scope, ...args), markUnknown: id => budget.markUnknown(scope, id) }),
    images: async () => [] });
  expect(await runJob(queue, winner.jobId!, handler)).toBe(true);
  expect((await queue.get(fixture.scope, winner.jobId!)).state).toBe("succeeded");
  const published = await requests.read(fixture.scope, winner.requestId);
  expect(published).toMatchObject({ ledger: "completed", jobState: "succeeded", request: { gradingVersion: 1 } });
  expect(published.request.resultObservationId).not.toBeNull();
  const [head] = await fixture.sql`SELECT * FROM opening_learning_observations WHERE id=${published.request.resultObservationId}`;
  expect(head).toMatchObject({ answer: original.answer, answer_revision: 1, outcome,
    grading_operation_id: winner.operationId, client_key: winner.operationId });
  expect((await fixture.sql`SELECT effective_head_id FROM opening_learning_observations WHERE id=${original.id}`)[0]?.effective_head_id).toBe(head!.id);
  // A historical execution already in flight cannot replace the new head after publication.
  await expect(grades.apply(openingJobScope(oldClaim), { observationId: original.id }, {
    outcome: "incorrect", confidence: .95, questionMatch: true, feedback: "late historical result",
    criteria: [{ label: "sum", verdict: "incorrect", feedback: "late" }],
  }, "synthetic")).rejects.toMatchObject({ code: "CONFLICT" });
  const after = await snapshot();
  for (let i = 0; i < 2; i++) {
    expect(await requests.confirm(fixture.scope, consent(winner))).toEqual(published.request);
    expect(await requests.read(fixture.scope, winner.requestId)).toEqual(published);
    expect(await runJob(queue, winner.jobId!, handler)).toBe(false);
  }
  expect(await snapshot()).toEqual(after);
  expect(complete).toHaveBeenCalledTimes(1);
  expect(await fixture.sql`SELECT * FROM opening_budget_reservations WHERE request_id!=${winner.operationId} ORDER BY request_id`).toEqual(before.fees);
  expect(await fixture.sql`SELECT id FROM opening_budget_reservations WHERE request_id=${winner.operationId}`).toHaveLength(1);
  expect(await fixture.sql`SELECT id FROM opening_jobs WHERE key=${winner.operationId}`).toHaveLength(1);
  expect(await fixture.sql`SELECT id FROM opening_outbox WHERE job_id=${winner.jobId}`).toHaveLength(1);
  // Regression for the former 738a P2: an unverified publication requires manual review.
  expect(published.status).toBe(outcome === "unverified" ? "needs_manual" : "graded");
});
