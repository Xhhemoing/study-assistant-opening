import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createOpeningAttemptService } from "../../apps/web/src/features/opening/learning/attempt-service";
import * as autoGradePolicy from "../../apps/web/src/features/opening/learning/auto-grade-policy";
import { createOpeningObservationService } from "../../apps/web/src/features/opening/learning/observation-service";
import { createOpeningAiGradingJobRepository, createWorkspacePreferencesRepository, type OpeningAutoGradePolicy } from "@aistudy/database";
import { reviseOpeningLearningObservation } from "../../packages/database/src/repositories/opening-observation-revisions";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { buildAnswerGradingInput, reservationTerms } from "@aistudy/ai";
import { checkOpeningAutoGradeBudget } from "../../packages/database/src/repositories/opening-auto-grade-policy";
import * as admissionClock from "../../packages/database/src/repositories/opening-auto-grade-policy";

const model = { modelSnapshot: { id: "test", providerId: "test", modelName: "test", inputCentsPerMillion: 100, outputCentsPerMillion: 100 }, inputCentsPerMillion: 100, outputCentsPerMillion: 100 };

let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => { await fixture.reset(); await fixture.sql`TRUNCATE opening_learning_sessions CASCADE`;
  await fixture.sql`DELETE FROM workspace_preferences WHERE workspace_id=${fixture.scope.workspaceId}`;
});
afterAll(async () => { await fixture?.close(); });
const policy = (patch: Partial<OpeningAutoGradePolicy> = {}): OpeningAutoGradePolicy => ({ enabled: true, modelAvailable: true,
  dailyCap: 50, dayStart: new Date(Date.now() - 86400000), dayEnd: new Date(Date.now() + 86400000), primaryModel: model, budgetOptions: { envCapCents: 10000 }, ...patch });
async function setup() {
  const f = await learningAttemptFixture(fixture);
  const save = async (autoGrade?: OpeningAutoGradePolicy, clientKey = randomUUID(), attemptPromise = f.start()) => {
    const attempt = await attemptPromise;
    const input = { attemptId: attempt.id, sessionId: f.sessionId, courseId: f.courseId, skillLabel: "fractions",
      sourceIds: [f.sourceId], problemId: attempt.problemId, answer: "1", outcome: "unverified" as const, assistance: "independent" as const, clientKey };
    return f.learning.insertObservation(fixture.scope, input, autoGrade ? { autoGrade } : {});
  };
  return { ...f, save, jobs: createOpeningAiGradingJobRepository(fixture.sql) };
}
const count = async () => (await fixture.sql`SELECT id FROM opening_jobs WHERE workspace_id=${fixture.scope.workspaceId} AND kind='grade-observation'`).length;

it("real submit seals and estimates the answer: insufficient budget saves without job/outbox; replay never backfills", async () => {
  const f = await setup(), attempt = await f.start(), key = randomUUID();
  const spy = vi.spyOn(autoGradePolicy, "resolveAutoGradePolicy").mockResolvedValue(policy({ budgetOptions: { envCapCents: 0 } }));
  try {
    const service = createOpeningAttemptService(fixture.sql);
    const input = { answer: "1", outcome: "unverified" as const, assistance: "independent" as const, clientKey: key };
    const saved = await service.submit(fixture.scope, attempt.id, input);
    expect(saved.answer).toBe("1"); expect(await count()).toBe(0);
    expect(await fixture.sql`SELECT o.* FROM opening_outbox o JOIN opening_jobs j ON j.id=o.job_id WHERE j.kind='grade-observation'`).toHaveLength(0);
    const before = await fixture.sql`SELECT * FROM opening_source_versions ORDER BY source_id,version`;
    expect(await f.jobs.read(fixture.scope, { observationId: saved.id }, policy({ budgetOptions: { envCapCents: 0 } })))
      .toMatchObject({ autoGradeSkipped: "budget", retryable: true });
    expect(await fixture.sql`SELECT * FROM opening_source_versions ORDER BY source_id,version`).toEqual(before);
    expect(await fixture.sql`SELECT * FROM opening_budget_reservations`).toHaveLength(0);
    spy.mockResolvedValue(policy());
    expect((await service.submit(fixture.scope, attempt.id, input)).id).toBe(saved.id);
    expect(await count()).toBe(0);
    const admitted = await service.submit(fixture.scope, (await f.start()).id, { ...input, clientKey: randomUUID() });
    expect(await f.jobs.read(fixture.scope, { observationId: admitted.id })).toMatchObject({ status: "queued" });
    expect(await count()).toBe(1);
  } finally { spy.mockRestore(); }
}, 30000);

it("real estimator exact balance, explicit fallback, media metadata and PDF conservative refusal", async () => {
  const context = { question: "sealed question", answer: "saved answer", referenceText: "reference" };
  const terms = reservationTerms(model, buildAnswerGradingInput({ ...context, imageParts: [] }));
  const check = (p: Partial<OpeningAutoGradePolicy>, c = context) => checkOpeningAutoGradeBudget(fixture.sql, fixture.scope, policy(p), c);
  expect(await check({ budgetOptions: { envCapCents: terms.reservedCents } })).toMatchObject({ allowed: true, requiredCents: terms.reservedCents });
  expect(await check({ budgetOptions: { envCapCents: terms.reservedCents - 1 } })).toMatchObject({ allowed: false, reason: "budget" });
  const free = { ...model, billing: "free_tier" as const, dailyRequestCap: 1 };
  expect(await check({ budgetOptions: { envCapCents: 0 }, fallbackModel: free })).toMatchObject({ allowed: true, requiredCents: 0 });
  const photo = { ...context, workSource: { mime: "image/png", bytes: 100 } };
  const vision = { ...model, modelSnapshot: { ...model.modelSnapshot, mediaInputTokenUpperBound: 10000, mediaMaxInputBytes: 100, mediaInputCentsPerMillion: 100 } };
  expect(await check({}, photo)).toMatchObject({ allowed: false, reason: "budget_unavailable" });
  expect(await check({ fallbackModel: vision }, photo)).toMatchObject({ allowed: true });
  expect(await check({ primaryModel: vision }, { ...photo, workSource: { mime: "image/png", bytes: 101 } })).toMatchObject({ reason: "budget_unavailable" });
  expect(await check({ primaryModel: vision }, { ...photo, workSource: { mime: "application/pdf", bytes: 1 } })).toMatchObject({ reason: "budget_unavailable" });
});

it("unpriceable but finite model rates preserve the answer and permit an explicit safe fallback", async () => {
  const f = await setup();
  const { openingModelSnapshotSchema } = await import("@aistudy/contracts");
  const snapshot = openingModelSnapshotSchema.parse({ ...model.modelSnapshot,
    inputCentsPerMillion: 1e308, outputCentsPerMillion: 1e308 });
  const extreme = { ...model, modelSnapshot: snapshot, inputCentsPerMillion: 1e308, outputCentsPerMillion: 1e308 };
  const spy = vi.spyOn(autoGradePolicy, "resolveAutoGradePolicy").mockResolvedValue(policy({ primaryModel: extreme }));
  const service = createOpeningAttemptService(fixture.sql);
  const input = { answer: "1", outcome: "unverified" as const, assistance: "independent" as const, clientKey: randomUUID() };
  try {
    const saved = await service.submit(fixture.scope, (await f.start()).id, input);
    expect(saved.answer).toBe("1");
    expect(await count()).toBe(0);
    expect(await f.jobs.read(fixture.scope, { observationId: saved.id }, policy({ primaryModel: extreme })))
      .toMatchObject({ autoGradeSkipped: "budget_unavailable", retryable: true });
    expect(await fixture.sql`SELECT * FROM opening_budget_reservations`).toHaveLength(0);
    spy.mockResolvedValue(policy({ primaryModel: extreme, fallbackModel: model }));
    const admitted = await service.submit(fixture.scope, (await f.start()).id, { ...input, clientKey: randomUUID() });
    expect(await f.jobs.read(fixture.scope, { observationId: admitted.id })).toMatchObject({ status: "queued" });
    expect(await count()).toBe(1);
    expect(await fixture.sql`SELECT * FROM opening_budget_reservations`).toHaveLength(0);
  } finally { spy.mockRestore(); }
}, 30000);

it("free request cap refuses queue admission even with zero money cost", async () => {
  const f = await setup();
  const free = { ...model, billing: "free_tier" as const, dailyRequestCap: 1 };
  const { createOpeningBudgetRepository } = await import("@aistudy/database");
  await createOpeningBudgetRepository(fixture.sql).reserve(fixture.scope, { purpose: "test", amountCents: 0, requestId: randomUUID(), modelSnapshot: model.modelSnapshot, requestCapPerDay: 1 });
  const saved = await f.save(policy({ primaryModel: free }));
  expect(await count()).toBe(0);
  expect(await f.jobs.read(fixture.scope, { observationId: saved.id }, policy({ primaryModel: free }))).toMatchObject({ autoGradeSkipped: "budget" });
});

it("controlled admission clock crosses midnight: stale windows neither oversubscribe nor block the new day", async () => {
  const f = await setup();
  await fixture.sql`INSERT INTO workspace_preferences(workspace_id,planning_settings) VALUES(${fixture.scope.workspaceId},'{"timeZone":"America/New_York"}'::jsonb)`;
  const beforeMidnight = new Date("2026-11-01T03:59:59Z"), afterMidnight = new Date("2026-11-01T04:00:01Z");
  const clock = vi.spyOn(admissionClock, "readOpeningAutoGradeAdmissionTime").mockResolvedValue(beforeMidnight);
  const stale = policy({ dailyCap: 1, dayStart: new Date("2026-10-31T04:00:00Z"), dayEnd: new Date("2026-11-01T04:00:00Z") });
  try {
    await f.save(stale);
    clock.mockResolvedValue(afterMidnight);
    const saved = await Promise.all([f.save(stale), f.save(stale)]);
    expect(await count()).toBe(2);
    expect(await fixture.sql`SELECT id FROM opening_learning_observations WHERE id=ANY(${saved.map(o => o.id)}::uuid[]) AND auto_grade_enqueued_at=${afterMidnight}`).toHaveLength(1);
    // Deliberately empty legacy window cannot bypass the current-day count.
    await f.save(policy({ dailyCap: 1, dayStart: new Date(0), dayEnd: new Date(1) }));
    expect(await count()).toBe(2);
  } finally { clock.mockRestore(); }
}, 30000);

it("blocks stale ON in the real submit service after OFF commits, using an explicit snapshot barrier", async () => {
  const f = await setup(), attempt = await f.start();
  const repo = createWorkspacePreferencesRepository(fixture.sql);
  let captured!: () => void, resume!: () => void;
  const snapshotCaptured = new Promise<void>(resolve => { captured = resolve; });
  const continueSubmit = new Promise<void>(resolve => { resume = resolve; });
  const spy = vi.spyOn(autoGradePolicy, "resolveAutoGradePolicy").mockImplementationOnce(async () => {
    const snapshot = policy({ enabled: (await repo.getLearningPreferences(fixture.scope)).autoGradeOnSave });
    expect(snapshot.enabled).toBe(true);
    captured();
    await continueSubmit;
    return snapshot;
  });
  const pending = createOpeningAttemptService(fixture.sql).submit(fixture.scope, attempt.id, {
    answer: "1", outcome: "unverified", assistance: "independent", clientKey: randomUUID(),
  });
  try {
    await snapshotCaptured;
    await repo.setLearningPreferences(fixture.scope, { assessmentEnabled: true,
      retestSuggestionsEnabled: false, automaticRemindersEnabled: false, autoGradeOnSave: false });
    expect((await repo.getLearningPreferences(fixture.scope)).autoGradeOnSave).toBe(false);
  } finally { resume(); }
  try {
    const saved = await pending;
    expect(saved.id).toBeTruthy();
    expect(await count()).toBe(0);
    expect(await f.jobs.read(fixture.scope, { observationId: saved.id }, policy())).toMatchObject({ autoGradeSkipped: "disabled" });
  } finally { spy.mockRestore(); }
}, 30000);

it("manual first drafts consume no automatic allowance; automatic manual retry keeps one admission", async () => {
  const f = await setup();
  const manual = await f.save();
  await f.jobs.enqueue(fixture.scope, { observationId: manual.id });
  const automatic = await f.save(policy({ dailyCap: 1 }));
  expect(await count()).toBe(2);
  const [before] = await fixture.sql`SELECT auto_grade_enqueued_at FROM opening_learning_observations WHERE id=${automatic.id}`;
  expect(before!.auto_grade_enqueued_at).not.toBeNull();
  await fixture.sql`UPDATE opening_jobs SET state='failed' WHERE payload->>'observationId'=${automatic.id}`;
  await Promise.all([f.jobs.enqueue(fixture.scope, { observationId: automatic.id }), f.jobs.enqueue(fixture.scope, { observationId: automatic.id })]);
  const [after] = await fixture.sql`SELECT auto_grade_enqueued_at FROM opening_learning_observations WHERE id=${automatic.id}`;
  expect(after).toEqual(before);
  await f.save(policy({ dailyCap: 1 }));
  expect(await count()).toBe(2);
  expect(await fixture.sql`SELECT auto_grade_enqueued_at FROM opening_learning_observations WHERE id=${manual.id}`)
    .toEqual([{ auto_grade_enqueued_at: null }]);
});

it("serializes the real 50/51 boundary and excludes previous local-day admissions", async () => {
  const f = await setup();
  for (let i = 0; i < 49; i++) await f.save(policy());
  const attempts = await Promise.all([f.start(), f.start()]);
  const observations = await Promise.all(attempts.map(a => f.save(policy(), randomUUID(), Promise.resolve(a))));
  expect(await count()).toBe(50);
  const statuses = await Promise.all(observations.map(o => f.jobs.read(fixture.scope, { observationId: o.id }, policy())));
  expect(statuses.filter(s => s.status === "queued")).toHaveLength(1);
  expect(statuses.filter(s => s.autoGradeSkipped === "daily_cap")).toHaveLength(1);
  // Admission timestamp, not revision, job state or retry time, defines the day.
  await fixture.sql`UPDATE opening_learning_observations SET auto_grade_enqueued_at=${new Date(Date.now() - 3 * 86400000)}
    WHERE workspace_id=${fixture.scope.workspaceId} AND auto_grade_enqueued_at IS NOT NULL`;
  await f.save(policy());
  expect(await count()).toBe(51);
}, 60000);

it("first save enqueues once, and an identical retry never enqueues twice", async () => {
  const f = await setup(), attempt = f.start(), key = randomUUID();
  const a = await f.save(policy(), key, attempt), b = await f.save(policy(), key, attempt);
  expect(a.id).toBe(b.id); expect(await count()).toBe(1);
});
it.each([
  ["disabled", { enabled: false }], ["no_model", { modelAvailable: false }], ["daily_cap", { dailyCap: 0 }],
] as const)("saves successfully without queueing: %s", async (reason, patch) => {
  const f = await setup(), p = policy(patch), observation = await f.save(p);
  expect(await count()).toBe(0);
  expect(await f.jobs.read(fixture.scope, { observationId: observation.id }, p)).toMatchObject({ autoGradeSkipped: reason, retryable: true });
});
it("serializes concurrent saves under the small workspace cap; manual requests remain unlimited and idempotent", async () => {
  const f = await setup(), p = policy({ dailyCap: 1 });
  const observations = await Promise.all(Array.from({ length: 3 }, () => f.save(p)));
  expect(await count()).toBe(1);
  const statuses = await Promise.all(observations.map(o => f.jobs.read(fixture.scope, { observationId: o.id }, p)));
  expect(statuses.filter(s => s.autoGradeSkipped === "daily_cap")).toHaveLength(2);
  const skipped = statuses.find(s => !s.jobId)!;
  await Promise.all([f.jobs.enqueue(fixture.scope, { observationId: skipped.headObservationId }), f.jobs.enqueue(fixture.scope, { observationId: skipped.headObservationId })]);
  expect(await count()).toBe(2);
}, 30000);
it("changed answers require manual regrading with one job for the new revision", async () => {
  const f = await setup(), original = await f.save(policy());
  const revision = await reviseOpeningLearningObservation(fixture.sql, fixture.scope, {
    rootObservationId: original.id, revisesObservationId: original.id, expectedHead: original.id,
    revisionKind: "replace", reason: "改答案", clientKey: randomUUID(), replacement: { answer: "2", outcome: "unverified", assistance: "independent" },
  });
  expect(await count()).toBe(1);
  const input = { observationId: revision.headObservationId };
  expect(await f.jobs.read(fixture.scope, input, policy({ enabled: false }))).toMatchObject({ answerRevision: 2, autoGradeSkipped: "answer_changed" });
  await f.jobs.enqueue(fixture.scope, input); await f.jobs.enqueue(fixture.scope, input);
  expect(await count()).toBe(2);
  expect(await f.jobs.read(fixture.scope, input)).toMatchObject({ status: "queued", autoGradeSkipped: null });
});
it("direct observation saves without an explicit attempt policy never auto-enqueue", async () => {
  const f = await setup(), attempt = await f.start();
  await createOpeningObservationService(f.learning).submitObservation(fixture.scope, {
    attemptId: attempt.id, sessionId: f.sessionId, courseId: f.courseId, skillLabel: "fractions", sourceIds: [f.sourceId],
    problemId: attempt.problemId, answer: "1", outcome: "unverified", assistance: "independent", clientKey: randomUUID(),
  });
  expect(await count()).toBe(0);
});
it("manual revision 2 grading does not consume the first-submission daily allowance", async () => {
  const f = await setup(), original = await f.save(policy());
  const revision = await reviseOpeningLearningObservation(fixture.sql, fixture.scope, {
    rootObservationId: original.id, revisesObservationId: original.id, expectedHead: original.id,
    revisionKind: "replace", reason: "改答案", clientKey: randomUUID(),
    replacement: { answer: "2", outcome: "unverified", assistance: "independent" },
  });
  await f.jobs.enqueue(fixture.scope, { observationId: revision.headObservationId });
  const next = await f.save(policy({ dailyCap: 2 }));
  expect(await count()).toBe(3);
  expect(await f.jobs.read(fixture.scope, { observationId: next.id })).toMatchObject({ status: "queued" });
});
it("workspace preference defaults true and persists false/true without affecting course overrides", async () => {
  const repo = createWorkspacePreferencesRepository(fixture.sql);
  expect((await repo.getLearningPreferences(fixture.scope)).autoGradeOnSave).toBe(true);
  const current = await repo.getLearningPreferences(fixture.scope);
  await repo.setLearningPreferences(fixture.scope, { ...current, autoGradeOnSave: false });
  expect((await repo.getLearningPreferences(fixture.scope)).autoGradeOnSave).toBe(false);
  await repo.setLearningPreferences(fixture.scope, { ...current, autoGradeOnSave: true });
  expect((await repo.getLearningPreferences(fixture.scope)).autoGradeOnSave).toBe(true);
});
