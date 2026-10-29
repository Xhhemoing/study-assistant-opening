import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { readOpeningLearningEvidenceContext, createOpeningStudyIntentRepository, createOpeningLearningAttemptRepository, createOpeningLearningRepository, createOpeningLearnerStateService, createWorkspacePreferencesRepository } from "@aistudy/database";
import { evaluateEvidenceEligibility, getSpanProblem, SPAN_SKILL_LABEL, SPAN_REQUIREMENT_KEY } from "@aistudy/domain";
import { createSpanPresentationService } from "../../apps/web/src/features/opening/teaching/span/presentation-service";
import { createSpanHintService } from "../../apps/web/src/features/opening/teaching/span/hint-service";
import { createSpanFeedbackService } from "../../apps/web/src/features/opening/teaching/span/feedback-service";
import { createSpanDelayedRetestService } from "../../apps/web/src/features/opening/teaching/span/delayed-retest-service";
import { createOpeningAttemptService } from "../../apps/web/src/features/opening/learning/attempt-service";
import { createStudyIntentService } from "../../apps/web/src/features/opening/teaching/span/intent-service";
import { createSpanSessionService } from "../../apps/web/src/features/opening/teaching/span/session-service";
import { createSpanReservedService } from "../../apps/web/src/features/opening/teaching/span/reserved-service";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { backupRows } from "./opening-backup-records-fixture";
let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => { await fixture.reset(); await fixture.sql`TRUNCATE opening_learning_sessions,opening_conversations CASCADE`; });
afterAll(async () => { await fixture?.close(); });
async function start(problemId: string) {
  const rows = backupRows(fixture.sql, fixture.scope);
  const sourceId = await rows.source(), courseId = randomUUID();
  await rows.chunk(sourceId);
  await fixture.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES (${courseId},${fixture.scope.workspaceId},'Span flow',${courseId})`;
  const learning = createOpeningLearningRepository(fixture.sql), attempts = createOpeningLearningAttemptRepository(fixture.sql);
  const session = await learning.createSession(fixture.scope, { courseId, skillLabel: SPAN_SKILL_LABEL, sourceIds: [sourceId] });
  const input = { sessionId: session.id, clientKey: randomUUID(), spanExercise: { sourceId, problemId, version: 1 } };
  const attempt = await attempts.create(fixture.scope, input);
  const submit = (answer: unknown, clientKey = randomUUID()) => learning.insertObservation(fixture.scope, { sessionId: session.id, courseId, skillLabel: SPAN_SKILL_LABEL, sourceIds: [sourceId], attemptId: attempt.id, problemId: attempt.problemId,
    clientKey, answer: JSON.stringify(answer), outcome: "unverified", assistance: "independent", verdictSource: "self_report" });
  return { sourceId, courseId, learning, attempts, session, input, attempt, submit };
}
it("uses the original attempt chain for exact first-answer storage, replay and shared learner state", async () => {
  const f = await start("span-example-2d"), problem = getSpanProblem("span-example-2d")!;
  const answer = { membership: "in_span", coefficients: ["3", "-1/2"], equation: { vectors: problem.vectors, target: problem.target }, coordinateChecks: ["3", "-1"], representations: { system: "unique", geometry: "plane" } };
  const key = randomUUID(), record = await f.submit(answer, key);
  expect(record).toMatchObject({ attemptId: f.attempt.id, itemVersionId: f.attempt.itemVersionId, outcome: "correct", verdictSource: "deterministic", serverEvaluation: { evaluatorVersion: "span-exact-v1", coreEvidenceComplete: true } });
  expect(record.eligibility?.verifiedCorrect).toBe("yes");
  expect((await f.submit(answer, key)).id).toBe(record.id);
  await expect(f.submit({ ...answer, coefficients: ["0", "0"] }, key)).rejects.toMatchObject({ code: "CONFLICT" });
  const state = await createOpeningLearnerStateService(fixture.sql).read(fixture.scope, { courseId: f.courseId });
  expect(state.summary).toEqual(expect.arrayContaining([expect.objectContaining({ requirementKey: SPAN_REQUIREMENT_KEY, sampleCount: 1 })]));
  expect(state.features).toEqual(expect.arrayContaining([expect.objectContaining({ attemptId: f.attempt.id, outcome: "correct" })]));
});
it("keeps uncertain input unverified and fades assisted rather than independent", async () => {
  const f = await start("span-faded-3d");
  const record = await f.submit({ membership: "in_span", recognition: "uncertain" });
  expect(record).toMatchObject({ outcome: "unverified", assistance: "hinted", serverEvaluation: { decision: "abstain" } });
});
it("records both decision layers atomically and issues reserved identities outside the teaching bank", async () => {
  const f = await start("span-faded-3d");
  const intent = { purpose: "self_study", timeBudgetMinutes: 15, language: "zh", pace: "normal", continuous: true, selfReportedFatigue: "unknown" };
  const service = createSpanSessionService(fixture.sql), input = { sessionId: f.session.id, intent, clientKey: randomUUID(), moveId: "self-faded" };
  const first = await service.prepare(fixture.scope, input), replay = await service.prepare(fixture.scope, input);
  expect(replay.sessionDecision.id).toBe(first.sessionDecision.id);
  const decisions = await fixture.sql`SELECT layer,parent_decision_id FROM opening_learning_decisions WHERE workspace_id=${fixture.scope.workspaceId} AND owner_user_id=${fixture.scope.ownerUserId}`;
  expect(decisions).toEqual(expect.arrayContaining([expect.objectContaining({ layer: "activity", parent_decision_id: first.sessionDecision.id })]));
  const issuer = createSpanReservedService(fixture.sql);
  const issueInput = { sessionId: f.session.id, sourceId: f.sourceId, clientKey: randomUUID(), mode: "self_study" };
  const reserved = await issuer.issue(fixture.scope, issueInput);
  expect(getSpanProblem(reserved.spanExercise!.id)).toBeNull();
  expect(reserved).not.toHaveProperty("solution");
  expect((await issuer.issue(fixture.scope, issueInput)).id).toBe(reserved.id);
  const next = await Promise.all([issuer.issue(fixture.scope, { ...issueInput, clientKey: randomUUID() }), issuer.issue(fixture.scope, { ...issueInput, clientKey: randomUUID() })]);
  expect(new Set([reserved.spanExercise!.familyId, ...next.map(attempt => attempt.spanExercise!.familyId)]).size).toBe(3);

});

it("creates a formal delayed task, replays its acceptance and rejects early issue and submission", async () => {
  await createWorkspacePreferencesRepository(fixture.sql).setLearningPreferences(fixture.scope, { assessmentEnabled: true, retestSuggestionsEnabled: true, automaticRemindersEnabled: false });
  const f = await start("span-example-2d"), problem = getSpanProblem("span-example-2d")!;
  const record = await f.submit({ membership: "in_span", coefficients: ["3", "-1/2"], equation: { vectors: problem.vectors, target: problem.target }, coordinateChecks: ["3", "-1"] });
  const service = createSpanDelayedRetestService(fixture.sql), request = { observationId: record.id, clientKey: `span-delayed:${record.id}` };
  const first = await service.schedule(fixture.scope, request), replay = await service.schedule(fixture.scope, request);
  expect(replay.taskId).toBe(first.taskId);
  expect(Date.parse(first.notBeforeAt)).toBeGreaterThan(Date.parse(record.recordedAt!) + 71 * 3600000);
  const [task] = await fixture.sql`SELECT status FROM opening_tasks WHERE id=${first.taskId}`;
  expect(task?.status).toBe("pending");
  const session = await f.learning.createSession(fixture.scope, { courseId: f.courseId, skillLabel: SPAN_SKILL_LABEL, sourceIds: [f.sourceId] });
  await expect(createSpanSessionService(fixture.sql).prepare(fixture.scope, { sessionId: session.id, intent: { purpose: "self_study", timeBudgetMinutes: 15, language: "zh", pace: "normal", continuous: true, selfReportedFatigue: "unknown" }, clientKey: randomUUID(), moveId: "self-independent", retestId: first.candidateId })).rejects.toThrow();
  const earlyAttempt = await f.attempts.create(fixture.scope, { sessionId: session.id, clientKey: randomUUID(), spanExercise: { sourceId: f.sourceId, problemId: "span-independent-3d", version: 1 } });
  await expect(createOpeningAttemptService(fixture.sql).submit(fixture.scope, earlyAttempt.id, { clientKey: randomUUID(), answer: JSON.stringify({ membership: "not_in_span" }), outcome: "unverified", assistance: "independent", retestId: first.candidateId })).rejects.toThrow();
  const [persisted] = await fixture.sql`SELECT submitted_at FROM opening_learning_attempts WHERE id=${earlyAttempt.id}`;
  expect(persisted?.submitted_at).toBeNull();
});

it("releases actual worked/simulation/faded content and excludes demonstrated families from reserved issuance", async () => {
  const f = await start("span-faded-3d"), presenter = createSpanPresentationService(fixture.sql);
  const request = { courseId: f.courseId, sourceId: f.sourceId, kind: "simulation", clientKey: randomUUID() };
  const content = await presenter.read(fixture.scope, request), replay = await presenter.read(fixture.scope, request);
  expect(content.problem.id).toBe("span-simulation-dependent");
  expect(replay.exposureReceipt.id).toBe(content.exposureReceipt.id);
  expect(content.exposureReceipt.releasedAt).not.toBeNull();
  const hint = await createSpanHintService(fixture.sql).read(fixture.scope, { attemptId: f.attempt.id });
  expect(hint.exposureReceipt).toMatchObject({ hintStage: 1, initiatedBy: null });
  expect(hint.text).toContain("αv+βw=u");
  const reserved = await createSpanReservedService(fixture.sql).issue(fixture.scope, { sessionId: f.session.id, sourceId: f.sourceId, clientKey: randomUUID(), mode: "overview" });
  expect(reserved.spanExercise!.familyId).not.toBe(content.problem.familyId);
});
it("does not release a solution before the original answer and keeps later feedback distinct", async () => {
  const f = await start("span-example-2d"), problem = getSpanProblem("span-example-2d")!;
  const feedback = createSpanFeedbackService(fixture.sql);
  await expect(feedback.read(fixture.scope, { attemptId: f.attempt.id })).rejects.toMatchObject({ code: "VALIDATION" });
  const record = await f.submit({ membership: "in_span", coefficients: ["3", "-1/2"], equation: { vectors: problem.vectors, target: problem.target }, coordinateChecks: ["3", "-1"] });
  const released = await feedback.read(fixture.scope, { attemptId: f.attempt.id });
  expect(released.exposureReceipt).toMatchObject({ hintStage: 4, initiatedBy: null });
  expect(released.result.solution).toEqual({ kind: "unique", coefficients: ["3", "-1/2"] });
  expect(Date.parse(released.exposureReceipt.releasedAt!)).toBeGreaterThanOrEqual(Date.parse(record.recordedAt!));
});

const baseIntent = { purpose: "self_study" as const, timeBudgetMinutes: 20, language: "zh" as const, pace: "normal" as const, continuous: true, selfReportedFatigue: "unknown" as const };
it("persists explicit instructions and preserves current intent when old requests replay", async () => {
  const f = await start("span-example-2d"), service = createStudyIntentService(fixture.sql);
  const preparer = createSpanSessionService(fixture.sql);
  const prepareInput = { sessionId: f.session.id, intent: baseIntent, clientKey: randomUUID(), moveId: "self-independent" };
  const initial = await preparer.prepare(fixture.scope, prepareInput);
  const [original] = await fixture.sql`SELECT create_intent FROM opening_learning_attempts WHERE id=${f.attempt.id}`;
  const request = { sessionId: f.session.id, attemptId: f.attempt.id, clientKey: randomUUID(), change: { kind: "explicit_request", text: "快速串讲，直接给关键步骤" } };
  const fast = await service.apply(fixture.scope, request);
  expect(fast.event.intent).toMatchObject({ purpose: "overview", pace: "fast", explanationStyle: "key_steps" });
  expect(fast.sessionDecision.intentVersion).toBe(`${fast.event.id}:v${fast.event.version}`);
  const confused = await service.apply(fixture.scope, { ...request, clientKey: randomUUID(), change: { kind: "signal", signal: "confused" } });
  expect(confused.event.action).toBe("diagnose");
  expect(confused.event.version).toBe(fast.event.version + 1);
  const replay = await service.apply(fixture.scope, request);
  expect(replay.event.id).toBe(fast.event.id);
  expect(replay.currentVersion).toBe(confused.event.version);
  expect(replay.currentIntent).toEqual(confused.event.intent);
  expect((await preparer.prepare(fixture.scope, prepareInput)).sessionDecision.id).toBe(initial.sessionDecision.id);
  expect((await createOpeningStudyIntentRepository(fixture.sql).latest(fixture.scope, f.session.id))?.id).toBe(confused.event.id);
  await expect(service.apply(fixture.scope, { ...request, change: { kind: "signal", signal: "too_easy" } })).rejects.toMatchObject({ code: "CONFLICT" });
  const [after] = await fixture.sql`SELECT create_intent FROM opening_learning_attempts WHERE id=${f.attempt.id}`;
  expect(after?.create_intent).toEqual(original?.create_intent);
  const ambiguous = await service.apply(fixture.scope, { ...request, clientKey: randomUUID(), change: { kind: "explicit_request", text: "不要用英文，不要快速串讲" } });
  expect(ambiguous.event).toMatchObject({ action: "clarify_intent", intent: confused.event.intent, signals: [] });
  expect(ambiguous.move.id).toBe("clarify_intent");
});
it("restores legacy decision receipts without re-signing or reverting later intent", async () => {
  const f = await start("span-example-2d"), preparer = createSpanSessionService(fixture.sql);
  const input = { sessionId: f.session.id, intent: baseIntent, clientKey: randomUUID(), moveId: "self-independent" };
  const old = await preparer.prepare(fixture.scope, input);
  await fixture.sql`UPDATE opening_learning_decisions SET receipt=receipt || ${fixture.sql.json({intentVersion: JSON.stringify(baseIntent),policyVersion: "span-teaching-v1"})}::jsonb
    WHERE id IN (${old.sessionDecision.id},${old.activityDecision.id})`;
  const later = await createStudyIntentService(fixture.sql).apply(fixture.scope, { sessionId: f.session.id, attemptId: f.attempt.id, clientKey: randomUUID(), change: { kind: "signal", signal: "too_easy" } });
  const replay = await preparer.prepare(fixture.scope, input);
  expect(replay.sessionDecision.id).toBe(old.sessionDecision.id);
  expect(replay.sessionDecision.intentVersion).toBe(JSON.stringify(baseIntent));
  expect((await createOpeningStudyIntentRepository(fixture.sql).latest(fixture.scope, f.session.id))?.id).toBe(later.event.id);
});
it("invalidates late guessed/copied conditions without changing deterministic correctness", async () => {
  const f = await start("span-example-2d"), problem = getSpanProblem("span-example-2d")!;
  const answer = { membership: "in_span", coefficients: ["3", "-1/2"], equation: { vectors: problem.vectors, target: problem.target }, coordinateChecks: ["3", "-1"] };
  const record = await f.submit(answer), service = createStudyIntentService(fixture.sql);
  const declaration = { sessionId: f.session.id, attemptId: f.attempt.id, clientKey: randomUUID(), change: { kind: "signal", signal: "guessed" } };
  const declared = await service.apply(fixture.scope, declaration);
  expect(declared.move.id).toBe("self_study-reserved");
  const guessed = await f.learning.listObservationsForCourse(fixture.scope, f.courseId);
  const guessedRecord = guessed.find(value => value.id === record.id)!;
  const guessedEvidence = await readOpeningLearningEvidenceContext(fixture.sql, fixture.scope, guessedRecord);
  expect(guessedRecord.outcome).toBe("correct");
  expect(evaluateEvidenceEligibility(guessedEvidence.observation, guessedEvidence.context)).toMatchObject({ verifiedCorrect: "yes", independentAttempt: "unknown" });
  await service.apply(fixture.scope, { ...declaration, clientKey: randomUUID(), change: { kind: "explicit_request", text: "这次抄了答案" } });
  const copied = await f.learning.listObservationsForCourse(fixture.scope, f.courseId);
  const copiedRecord = copied.find(value => value.id === record.id)!;
  const copiedEvidence = await readOpeningLearningEvidenceContext(fixture.sql, fixture.scope, copiedRecord);
  expect(copiedRecord.outcome).toBe("correct");
  expect(evaluateEvidenceEligibility(copiedEvidence.observation, copiedEvidence.context)).toMatchObject({ verifiedCorrect: "yes", independentAttempt: "no" });
});

it.each([true, false])("uses the formal three-day protocol without inventing no-review retention (baseline correct=%s)", async correct => {
  await createWorkspacePreferencesRepository(fixture.sql).setLearningPreferences(fixture.scope, { assessmentEnabled: true, retestSuggestionsEnabled: true, automaticRemindersEnabled: false });
  const f = await start("span-example-2d"), problem = getSpanProblem("span-example-2d")!;
  const baseline = await f.submit({ membership: "in_span", coefficients: correct ? ["3", "-1/2"] : ["0", "0"], equation: { vectors: problem.vectors, target: problem.target }, coordinateChecks: correct ? ["3", "-1"] : ["0", "0"] });
  const scheduled = await createSpanDelayedRetestService(fixture.sql).schedule(fixture.scope, { observationId: baseline.id, clientKey: randomUUID() });
  await fixture.sql`UPDATE opening_learning_observations SET started_at=now()-interval '4 days 1 minute',recorded_at=now()-interval '4 days',submitted_at=now()-interval '4 days',occurred_at=now()-interval '4 days' WHERE id=${baseline.id}`;
  await fixture.sql`UPDATE opening_learning_attempts SET started_at=now()-interval '4 days 1 minute',submitted_at=now()-interval '4 days' WHERE id=${f.attempt.id}`;
  await fixture.sql`UPDATE opening_retest_activities SET not_before_at=now()-interval '1 hour',recommended_at=now()-interval '1 hour',scheduled_start_at=now()-interval '1 hour' WHERE candidate_id=${scheduled.candidateId}`;
  const session = await f.learning.createSession(fixture.scope, { courseId: f.courseId, skillLabel: SPAN_SKILL_LABEL, sourceIds: [f.sourceId] });
  const attempt = await f.attempts.create(fixture.scope, { sessionId: session.id, clientKey: randomUUID(), spanExercise: { sourceId: f.sourceId, problemId: "span-independent-3d", version: 1 } });
  const p = attempt.spanExercise!;
  const record = await createOpeningAttemptService(fixture.sql).submit(fixture.scope, attempt.id, { clientKey: randomUUID(), answer: JSON.stringify({ membership: "not_in_span", equation: { vectors: p.vectors, target: p.target }, coefficients: ["2", "2"], coordinateChecks: ["2", "4", "2"], coefficientDerivationCoordinates: [0, 2] }), outcome: "unverified", assistance: "independent", retestId: scheduled.candidateId });
  const evidence = await readOpeningLearningEvidenceContext(fixture.sql, fixture.scope, record);
  expect(evidence.context.delayedCheck?.intervalExposure?.complete).toBe(false);
  const eligibility = evaluateEvidenceEligibility(evidence.observation, evidence.context);
  expect(eligibility.usableForDelayedCheck).toBe(correct ? "yes" : "unknown");
  if (!correct) expect(eligibility.reasonCodes).toContain("delayed_baseline_not_established");
});
