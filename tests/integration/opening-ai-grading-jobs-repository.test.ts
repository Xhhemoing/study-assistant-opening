import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { AiGradingProposal, LearningObservation, ObservationInput } from "@aistudy/contracts";
import { createOpeningAiGradingRepository, createOpeningJobRepository, openingJobScope, readOpeningCourseEvidence } from "@aistudy/database";
import { createOpeningAiGradingJobRepository } from "../../packages/database/src/repositories/opening-ai-grading-jobs";
import { insertOpeningLearningObservationInTx } from "../../packages/database/src/repositories/opening-learning-observations";
import { reviseOpeningLearningObservation } from "../../packages/database/src/repositories/opening-observation-revisions";
import { createOpeningAiGradingService } from "../../packages/ai/src/opening/ai-grading-service";
import type { OpeningAiGradingServiceDeps } from "../../packages/ai/src/opening/ai-grading-service";
import { createGradeObservationHandler } from "../../apps/worker/src/jobs/grade-observation";
import { runJob } from "../../apps/worker/src/runtime/run-job";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";
import { backupRows } from "./opening-backup-records-fixture";

let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => { await fixture.reset(); await fixture.sql`TRUNCATE opening_learning_sessions,opening_conversations CASCADE`; });
afterAll(async () => { await fixture?.close(); });
const jobs = () => createOpeningAiGradingJobRepository(fixture.sql);
const grades = () => createOpeningAiGradingRepository(fixture.sql);
const queue = () => createOpeningJobRepository(fixture.sql);
const proposal = (outcome: "correct" | "incorrect" = "correct"): AiGradingProposal => ({ outcome, confidence: .95, questionMatch: true, feedback: "检查计算结果。",
  criteria: [{ label: "计算", verdict: outcome, feedback: "分子相加。" }] });
async function jobFor(original: LearningObservation) {
  const status = await jobs().read(fixture.scope, { observationId: original.id });
  return queue().get(fixture.scope, status.jobId!);
}
async function revise(original: LearningObservation, head: LearningObservation, answer: string) {
  return reviseOpeningLearningObservation(fixture.sql, fixture.scope, { rootObservationId: original.id, revisesObservationId: head.id,
    expectedHead: head.id, revisionKind: "replace", reason: "纠正原答", clientKey: randomUUID(), replacement: { answer, outcome: "unverified", assistance: "independent" } });
}
async function reserve(operationId: string, patch: { claimed?: boolean; unknown?: boolean; state?: string; reason?: string } = {}) {
  await fixture.sql`INSERT INTO opening_budget_reservations(workspace_id,purpose,amount_cents,request_id,state,execution_claimed_at,outcome_unknown_at,release_reason)
    VALUES(${fixture.scope.workspaceId},'grading',1,${operationId},${patch.state ?? "reserved"},${patch.claimed ? new Date() : null},${patch.unknown ? new Date() : null},${patch.reason ?? null})`;
}
async function stale(jobId: string) { await fixture.sql`UPDATE opening_jobs SET updated_at=now()-interval '6 minutes' WHERE id=${jobId}`; }

it("commits one job/outbox with the saved answer; closed pages and repeated clicks require no frontend call", async () => {
  const f = await learningAttemptFixture(fixture), original = await f.submit(await f.start(), { outcome: "unverified" });
  const job = await jobFor(original);
  expect(job).toMatchObject({ key: `ai-grade:${fixture.scope.workspaceId}:${original.id}:1`, kind: "grade-observation", state: "queued",
    payload: { observationId: original.id, rootObservationId: original.id, answerRevision: 1 } });
  await Promise.all([jobs().enqueue(fixture.scope, { observationId: original.id }), jobs().enqueue(fixture.scope, { observationId: original.id })]);
  expect(await fixture.sql`SELECT id FROM opening_outbox WHERE job_id=${job.id}`).toHaveLength(1);
  const gateway = { call: vi.fn<OpeningAiGradingServiceDeps["gateway"]["call"]>(async (_scope, _task, options) => {
    await options.beforeSend?.();
    const output = { text: JSON.stringify(proposal()), inputTokens: 1, outputTokens: 1 };
    await options.persistResult?.(output, { reservationId: randomUUID(), settledCents: 1 }); return output;
  }) };
  const handler = createGradeObservationHandler({ repository: grades(), gateway, budget: () => ({} as never), images: async () => [] });
  await expect(runJob(queue(), job.id, handler)).resolves.toBe(true);
  await expect(runJob(queue(), job.id, handler)).resolves.toBe(false);
  expect(gateway.call).toHaveBeenCalledTimes(1);
  expect(await jobs().read(fixture.scope, { observationId: original.id })).toMatchObject({ status: "graded", answerRevision: 1, retryable: false });
});

it("rolls back the answer, attempt submission, job and outbox when the enclosing transaction fails", async () => {
  const f = await learningAttemptFixture(fixture), attempt = await f.start();
  const input: ObservationInput = { attemptId: attempt.id, sessionId: f.sessionId, courseId: f.courseId, skillLabel: "fractions", sourceIds: [f.sourceId],
    answer: "1", outcome: "unverified", assistance: "independent", clientKey: randomUUID() };
  await expect(fixture.sql.begin(async tx => {
    const saved = await insertOpeningLearningObservationInTx(tx, fixture.scope, input);
    expect(await tx`SELECT id FROM opening_jobs WHERE payload->>'observationId'=${saved.id} AND kind='grade-observation'`).toHaveLength(1);
    throw new Error("commit failed");
  })).rejects.toThrow("commit failed");
  expect(await fixture.sql`SELECT id FROM opening_learning_observations WHERE attempt_id=${attempt.id}`).toHaveLength(0);
  expect(await fixture.sql`SELECT id FROM opening_jobs WHERE kind='grade-observation'`).toHaveLength(0);
  expect(await fixture.sql`SELECT id FROM opening_outbox`).toHaveLength(0);
  expect((await fixture.sql`SELECT submitted_at FROM opening_learning_attempts WHERE id=${attempt.id}`)[0]?.submitted_at).toBeNull();
});

it("seals the original photo and its version with submission; retries cannot swap it and bad photos roll everything back", async () => {
  const f = await learningAttemptFixture(fixture), attempt = await f.start();
  const rows = backupRows(fixture.sql, fixture.scope), photoId = await rows.source();
  await fixture.sql`UPDATE opening_sources SET mime='image/png',parse_state='not_started' WHERE id=${photoId}`;
  const input: ObservationInput = { attemptId: attempt.id, sessionId: f.sessionId, courseId: f.courseId, skillLabel: "fractions", sourceIds: [f.sourceId],
    answer: "", outcome: "unverified", assistance: "independent", clientKey: randomUUID() };
  const workSource = { id: photoId, version: 1, physicalPage: 1 };
  const original = await f.learning.insertObservation(fixture.scope, input, { workSource });
  expect((await grades().context(fixture.scope, { observationId: original.id })).workSource).toEqual(workSource);
  expect(original.sourceIds).toContain(photoId);
  expect(await jobs().read(fixture.scope, { observationId: original.id })).toMatchObject({ status: "queued", workSource });
  expect((await f.learning.insertObservation(fixture.scope, input, { workSource })).id).toBe(original.id);
  await expect(f.learning.insertObservation(fixture.scope, input, { workSource: { ...workSource, version: 2 } })).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(jobs().enqueue(fixture.scope, { observationId: original.id, workSourceId: photoId, workSourceVersion: 2, physicalPage: 1 })).rejects.toMatchObject({ code: "CONFLICT" });
  const next = await f.start();
  await expect(f.learning.insertObservation(fixture.scope, { ...input, attemptId: next.id, clientKey: randomUUID() }, { workSource: { ...workSource, id: randomUUID() } })).rejects.toThrow();
  expect(await fixture.sql`SELECT id FROM opening_learning_observations WHERE attempt_id=${next.id}`).toHaveLength(0);
});

it("fences a late grade after answer revision and keeps error-card/weakness evidence in sync", async () => {
  const f = await learningAttemptFixture(fixture), original = await f.submit(await f.start(), { answer: "2", outcome: "unverified" });
  const job = await jobFor(original), claimed = (await queue().claim(job.id))!;
  const context = await grades().context(openingJobScope(claimed), { observationId: original.id });
  const first = await grades().apply(openingJobScope(claimed), { observationId: original.id }, proposal("incorrect"), "fixture");
  expect(await fixture.sql`SELECT id FROM cards WHERE origin_observation_root_id=${original.id} AND auto_paused=false`).toHaveLength(1);
  const corrected = (await revise(original, first, "1")).observation!;
  await expect(grades().apply(openingJobScope(claimed), { observationId: context.observation.id }, proposal(), "late")).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await jobs().read(fixture.scope, { observationId: original.id })).toMatchObject({ headObservationId: corrected.id, answerRevision: 2, status: "queued" });
  const next = await grades().apply(fixture.scope, { observationId: corrected.id }, proposal(), "fixture");
  expect((await readOpeningCourseEvidence(fixture.sql, fixture.scope, f.courseId)).observations.map(row => row.id)).toEqual([next.id]);
  expect(await fixture.sql`SELECT id FROM cards WHERE origin_observation_root_id=${original.id} AND auto_paused=false`).toHaveLength(0);
  expect((await jobs().read(fixture.scope, { observationId: original.id })).answerRevision).toBe(2);
});

it.each(["cancel", "expired", "epoch"] as const)("rejects late publication after %s without creating an assessment", async action => {
  const f = await learningAttemptFixture(fixture), original = await f.submit(await f.start());
  const job = await jobFor(original), claimed = (await queue().claim(job.id))!;
  const scope = openingJobScope(claimed);
  await grades().context(scope, { observationId: original.id });
  if (action === "cancel") await queue().cancel(fixture.scope, job.id);
  if (action === "expired") { await stale(job.id); await jobs().recoverExpired(); }
  if (action === "epoch") await fixture.sql`UPDATE workspaces SET privacy_epoch=privacy_epoch+1 WHERE id=${fixture.scope.workspaceId}`;
  await expect(grades().apply(scope, { observationId: original.id }, proposal(), "late")).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await fixture.sql`SELECT id FROM opening_learning_observations WHERE revises_observation_id=${original.id}`).toHaveLength(0);
});

it("recovers a pre-send crash, changes the lease, and never reuses a cancelled execution token", async () => {
  const f = await learningAttemptFixture(fixture), original = await f.submit(await f.start());
  const job = await jobFor(original), first = (await queue().claim(job.id))!;
  await stale(job.id); expect(await jobs().recoverExpired()).toBe(1);
  const next = (await queue().claim(job.id))!; expect(next.claimToken).not.toBe(first.claimToken);
  await expect(grades().context(openingJobScope(first), { observationId: original.id })).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await fixture.sql`SELECT id FROM opening_outbox WHERE job_id=${job.id}`).toHaveLength(2);
});

it.each(["unknown", "in_flight", "fallback", "legacy"] as const)("reads %s ledger and never requeues or calls a provider", async kind => {
  const f = await learningAttemptFixture(fixture), original = await f.submit(await f.start());
  const job = await jobFor(original); await queue().claim(job.id);
  let operationId = job.key;
  if (kind === "legacy") { operationId = `ai-grade:${fixture.scope.workspaceId}:${original.id}`;
    await fixture.sql`UPDATE opening_learning_observations SET grading_operation_id=${operationId} WHERE id=${original.id}`; }
  if (kind === "fallback") {
    await reserve(operationId, { state: "released", reason: "not_sent" });
    await reserve(`${operationId}:fallback`, { claimed: true, unknown: true });
  } else await reserve(operationId, { claimed: true, unknown: kind !== "in_flight" });
  await stale(job.id); await jobs().recoverExpired();
  expect(await jobs().enqueue(fixture.scope, { observationId: original.id })).toMatchObject({ status: "unknown_cost", retryable: false });
  expect((await queue().get(fixture.scope, job.id)).state).toBe("outcome_unknown");
  const call = vi.fn();
  const service = createOpeningAiGradingService({ repository: grades(), gateway: { call }, budget: () => ({} as never), images: async () => [] });
  await expect(service.grade(fixture.scope, { observationId: original.id })).rejects.toMatchObject({ code: "GRADING_UNKNOWN_COST" });
  expect(call).not.toHaveBeenCalled();
  expect(await fixture.sql`SELECT id FROM opening_outbox WHERE job_id=${job.id}`).toHaveLength(1);
});

it("recovers a committed result after crash but continues to show unknown cost until ledger settlement", async () => {
  const f = await learningAttemptFixture(fixture), original = await f.submit(await f.start());
  const job = await jobFor(original), claimed = (await queue().claim(job.id))!;
  const saved = await grades().apply(openingJobScope(claimed), { observationId: original.id }, proposal(), "fixture");
  await reserve(job.key, { claimed: true, unknown: true }); await stale(job.id);
  await jobs().recoverExpired(); expect((await queue().get(fixture.scope, job.id)).state).toBe("succeeded");
  expect(await jobs().read(fixture.scope, { observationId: original.id })).toMatchObject({ headObservationId: saved.id, status: "unknown_cost", retryable: false });
  await fixture.sql`UPDATE opening_budget_reservations SET state='completed',outcome_unknown_at=NULL WHERE request_id=${job.key}`;
  expect((await jobs().read(fixture.scope, { observationId: original.id })).status).toBe("graded");
});

it("read-only status does not enqueue and checks owner, privacy exclusions and disabled accounts", async () => {
  const f = await learningAttemptFixture(fixture), original = await f.submit(await f.start());
  await expect(jobs().read(fixture.otherScope, { observationId: original.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await jobs().read(fixture.scope, { observationId: original.id }); await jobs().read(fixture.scope, { observationId: original.id });
  expect(await fixture.sql`SELECT id FROM opening_jobs WHERE kind='grade-observation'`).toHaveLength(1);
  expect(await fixture.sql`SELECT id FROM opening_budget_reservations`).toHaveLength(0);
  await fixture.sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id) VALUES(${fixture.scope.workspaceId},${f.sourceId})`;
  await expect(jobs().read(fixture.scope, { observationId: original.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await fixture.sql`DELETE FROM opening_privacy_exclusions WHERE workspace_id=${fixture.scope.workspaceId}`;
  await fixture.sql`UPDATE users SET disabled_at=now() WHERE id=${fixture.scope.ownerUserId}`;
  try {
    await expect(jobs().read(fixture.scope, { observationId: original.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(grades().context(fixture.scope, { observationId: original.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  } finally { await fixture.sql`UPDATE users SET disabled_at=NULL WHERE id=${fixture.scope.ownerUserId}`; }
});

it.each(["judgement", "attribution", "assistance"] as const)("retains the legacy unknown ledger and sealed photo after a %s-only correction", async change => {
  const f = await learningAttemptFixture(fixture), attempt = await f.start();
  const photoId = await backupRows(fixture.sql, fixture.scope).source();
  await fixture.sql`UPDATE opening_sources SET mime='image/png',parse_state='not_started' WHERE id=${photoId}`;
  const workSource = { id: photoId, version: 1, physicalPage: 1 };
  const original = await f.learning.insertObservation(fixture.scope, { attemptId: attempt.id, sessionId: f.sessionId,
    courseId: f.courseId, skillLabel: "fractions", sourceIds: [f.sourceId], answer: "", outcome: "unverified",
    assistance: "independent", clientKey: randomUUID() }, { workSource });
  const job = await jobFor(original), claimed = (await queue().claim(job.id))!;
  const operationId = `ai-grade:${fixture.scope.workspaceId}:${original.id}`;
  await fixture.sql`UPDATE opening_learning_observations SET grading_operation_id=${operationId} WHERE id=${original.id}`;
  await reserve(operationId, { state: "released", reason: "not_sent" });
  await reserve(`${operationId}:fallback`, { claimed: true, unknown: true });
  const otherCourseId = randomUUID();
  await fixture.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${otherCourseId},${fixture.scope.workspaceId},'Attribution',${otherCourseId})`;
  const correction = { rootObservationId: original.id, revisesObservationId: original.id, expectedHead: original.id,
    revisionKind: "replace" as const, reason: "仅修正记录", clientKey: randomUUID(), replacement: {
      answer: original.answer, outcome: change === "judgement" ? "correct" as const : original.outcome,
      assistance: change === "assistance" ? "hinted" as const : original.assistance,
      ...(change === "attribution" ? { courseId: otherCourseId, skillLabel: "修正归属", requirementKey: "manual-attribution" } : {}),
    } };
  const manual = (await reviseOpeningLearningObservation(fixture.sql, fixture.scope, correction)).observation!;
  expect((await reviseOpeningLearningObservation(fixture.sql, fixture.scope, correction)).headObservationId).toBe(manual.id);
  const [stored] = await fixture.sql`SELECT answer_revision,grading_operation_id,grading_work_source FROM opening_learning_observations WHERE id=${manual.id}`;
  expect(stored).toEqual({ answer_revision: 1, grading_operation_id: operationId, grading_work_source: workSource });
  expect(manual.sourceIds).toContain(photoId);
  expect(manual.sourceVersions?.[photoId]).toBe(1);
  expect(await jobs().enqueue(fixture.scope, { observationId: manual.id })).toMatchObject({
    headObservationId: manual.id, answerRevision: 1, status: "unknown_cost", retryable: false, workSource,
  });
  await expect(grades().apply(openingJobScope(claimed), { observationId: original.id }, proposal(), "late")).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(grades().apply(fixture.scope, { observationId: manual.id }, proposal(), "manual enqueue")).rejects.toMatchObject({ code: "CONFLICT" });
  const call = vi.fn();
  const service = createOpeningAiGradingService({ repository: grades(), gateway: { call }, budget: () => ({} as never), images: async () => [] });
  await expect(service.grade(fixture.scope, { observationId: manual.id })).rejects.toMatchObject({ code: "CONFLICT" });
  expect(call).not.toHaveBeenCalled();
  await stale(job.id); await jobs().recoverExpired();
  expect((await queue().get(fixture.scope, job.id)).state).toBe("outcome_unknown");
  expect(await fixture.sql`SELECT id FROM opening_jobs WHERE kind='grade-observation'`).toHaveLength(1);
  expect(await fixture.sql`SELECT id FROM opening_outbox WHERE job_id=${job.id}`).toHaveLength(1);
  expect(await fixture.sql`SELECT id FROM opening_budget_reservations`).toHaveLength(2);
  expect((await fixture.sql`SELECT outcome,ai_evaluation FROM opening_learning_observations WHERE id=${manual.id}`)[0])
    .toMatchObject({ outcome: correction.replacement.outcome, ai_evaluation: null });
});

it.each(["queued", "absent"] as const)("does not overwrite an unsent manual judgement when its old job is %s", async state => {
  const f = await learningAttemptFixture(fixture), original = await f.submit(await f.start(), { outcome: "unverified" });
  const job = await jobFor(original);
  if (state === "absent") {
    await fixture.sql`DELETE FROM opening_outbox WHERE job_id=${job.id}`;
    await fixture.sql`DELETE FROM opening_jobs WHERE id=${job.id}`;
  }
  const manual = (await reviseOpeningLearningObservation(fixture.sql, fixture.scope, { rootObservationId: original.id,
    revisesObservationId: original.id, expectedHead: original.id, revisionKind: "replace", reason: "手动确认", clientKey: randomUUID(),
    replacement: { answer: original.answer, outcome: "correct", assistance: original.assistance } })).observation!;
  expect(await jobs().read(fixture.scope, { observationId: original.id })).toMatchObject({ status: "needs_manual", answerRevision: 1, retryable: false });
  await jobs().enqueue(fixture.scope, { observationId: manual.id });
  await expect(grades().context(fixture.scope, { observationId: manual.id })).rejects.toMatchObject({ code: "CONFLICT" });
  const call = vi.fn(), handler = createGradeObservationHandler({ repository: grades(), gateway: { call }, budget: () => ({} as never), images: async () => [] });
  if (state === "queued") {
    await runJob(queue(), job.id, handler);
    expect((await queue().get(fixture.scope, job.id)).state).toBe("failed");
    await jobs().enqueue(fixture.scope, { observationId: manual.id });
    expect(await fixture.sql`SELECT id FROM opening_outbox WHERE job_id=${job.id}`).toHaveLength(1);
  }
  expect(call).not.toHaveBeenCalled();
  expect(await fixture.sql`SELECT id FROM opening_jobs WHERE kind='grade-observation'`).toHaveLength(state === "queued" ? 1 : 0);
  expect(await fixture.sql`SELECT id FROM opening_budget_reservations`).toHaveLength(0);
  expect((await fixture.sql`SELECT effective_head_id FROM opening_learning_observations WHERE id=${original.id}`)[0]?.effective_head_id).toBe(manual.id);
});

it("does not recover a pre-send job against a newer manual head with the same answer revision", async () => {
  const f = await learningAttemptFixture(fixture), original = await f.submit(await f.start());
  const job = await jobFor(original); await queue().claim(job.id);
  const manual = (await revise(original, original, original.answer)).observation!;
  await stale(job.id); expect(await jobs().recoverExpired()).toBe(1);
  expect((await queue().get(fixture.scope, job.id)).state).toBe("failed");
  expect(await jobs().enqueue(fixture.scope, { observationId: manual.id })).toMatchObject({ status: "needs_manual", answerRevision: 1, retryable: false });
  expect(await fixture.sql`SELECT id FROM opening_outbox WHERE job_id=${job.id}`).toHaveLength(1);
});

it("does not count AI feedback, manual re-evaluation or retraction as a new answer, but still queues a changed answer", async () => {
  const f = await learningAttemptFixture(fixture), original = await f.submit(await f.start());
  const operationId = `ai-grade:${fixture.scope.workspaceId}:${original.id}:1`;
  const graded = await grades().apply(fixture.scope, { observationId: original.id }, proposal(), "fixture");
  const manual = (await revise(original, graded, graded.answer)).observation!;
  const retracted = await reviseOpeningLearningObservation(fixture.sql, fixture.scope, { rootObservationId: original.id,
    revisesObservationId: manual.id, expectedHead: manual.id, revisionKind: "retract", reason: "撤回", clientKey: randomUUID() });
  const rows = await fixture.sql`SELECT answer_revision,grading_operation_id FROM opening_learning_observations WHERE COALESCE(root_observation_id,id)=${original.id}`;
  expect(rows).toHaveLength(4);
  expect(rows.every(row => row.answer_revision === 1 && row.grading_operation_id === operationId)).toBe(true);
  expect(await jobs().enqueue(fixture.scope, { observationId: retracted.headObservationId })).toMatchObject({ retryable: false, answerRevision: 1 });
  expect(await fixture.sql`SELECT id FROM opening_jobs WHERE kind='grade-observation'`).toHaveLength(1);
  const changed = await reviseOpeningLearningObservation(fixture.sql, fixture.scope, { rootObservationId: original.id,
    revisesObservationId: retracted.headObservationId, expectedHead: retracted.headObservationId, revisionKind: "replace", reason: "重写作答", clientKey: randomUUID(),
    replacement: { answer: "2", outcome: "unverified", assistance: "hinted" } });
  expect(await jobs().read(fixture.scope, { observationId: original.id })).toMatchObject({ answerRevision: 2, status: "queued", headObservationId: changed.headObservationId });
  expect((await grades().context(fixture.scope, { observationId: changed.headObservationId })).operationId).toBe(`ai-grade:${fixture.scope.workspaceId}:${original.id}:2`);
});
