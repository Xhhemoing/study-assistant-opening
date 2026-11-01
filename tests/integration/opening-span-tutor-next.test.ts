import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createOpeningPrivacyRepository, createOpeningTutorJobsRepository } from "@aistudy/database";
import { readOpeningLearningCapacity } from "../../packages/database/src/repositories/opening-learning-capacity";
import { createSpanHintService } from "../../apps/web/src/features/opening/teaching/span/hint-service";
import { getTutorService } from "../../apps/web/src/features/opening/runtime";
import { createTutorTurnHandler } from "../../apps/worker/src/jobs/tutor-turn";
import { createDbSystemQueryService } from "../../apps/worker/src/runtime/system-query";
import { DEFAULT_OPENING_ADAPTIVE_PREFS } from "@aistudy/contracts";
import { createOpeningLearningRepository, createOpeningSpanSessionRepository, createWorkspacePreferencesRepository, createOpeningPlansRepository, createOpeningLearningAttemptRepository } from "@aistudy/database";
import { DEFAULT_STUDY_SESSION_INTENT, SPAN_SKILL_LABEL, nextLearningStep, solveSpanProblem } from "@aistudy/domain";
import { listSpanReservedProblems } from "@aistudy/domain/span-heldout-catalog";
import { createOpeningSpanTutorNextRepository } from "../../packages/database/src/repositories/opening-span-tutor-next";
import { createOpeningSpanTutorContextRepository } from "../../packages/database/src/repositories/opening-span-tutor-context";
import { readOpeningSpanTutorOriginChange } from "../../packages/database/src/repositories/opening-span-tutor-origin";
import { createSpanReservedService } from "../../apps/web/src/features/opening/teaching/span/reserved-service";
import { createSpanDelayedRetestService } from "../../apps/web/src/features/opening/teaching/span/delayed-retest-service";
import { createSpanLessonSessionService } from "../../apps/web/src/features/opening/teaching/span/lesson-session-service";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { backupRows } from "./opening-backup-records-fixture";
let fixture: OpeningFixture;
beforeEach(async () => { fixture = await createOpeningFixture(); });
afterEach(async () => { await fixture?.close(); });
async function seed() {
  const { sql, scope } = fixture, rows = backupRows(sql, scope), courseId = randomUUID(), sourceId = await rows.source();
  await rows.chunk(sourceId);
  await sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES (${courseId},${scope.workspaceId},'Span continuation',${courseId})`;
  await sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility)
    VALUES (${scope.workspaceId},${courseId},'source',${sourceId},'core','course')`;
  await createWorkspacePreferencesRepository(sql).setLearningPreferences(scope,
    { assessmentEnabled: true, retestSuggestionsEnabled: true, automaticRemindersEnabled: false });
  const now = new Date().toISOString();
  const preferences = { ...DEFAULT_OPENING_ADAPTIVE_PREFS, spanTutorGrants: { [courseId]: {
    enabled: true, dailyMinutes: 180, revision: 1, confirmedAt: now, updatedAt: now, expiresOn: null } } };
  await sql`UPDATE workspace_preferences SET adaptive_planning=${sql.json(preferences)} WHERE workspace_id=${scope.workspaceId}`;
  const lessons = createOpeningSpanSessionRepository(sql);
  const create = () => lessons.create(scope, { courseId, sourceIds: [sourceId], intent: DEFAULT_STUDY_SESSION_INTENT, clientKey: randomUUID() });
  return { courseId, sourceId, lessons, create, next: createOpeningSpanTutorNextRepository(sql) };
}
async function record(f: Awaited<ReturnType<typeof seed>>, sessionId: string, answer: unknown, assistance: "independent" | "hinted" = "independent") {
  const attempt = await createSpanReservedService(fixture.sql).issue(fixture.scope,
    { sessionId, sourceId: f.sourceId, clientKey: randomUUID(), mode: "self_study" });
  const problem = attempt.spanExercise!;
  const response = typeof answer === "function" ? answer(problem) : answer;
  return createOpeningLearningRepository(fixture.sql).insertObservation(fixture.scope,
    { sessionId, courseId: f.courseId, skillLabel: SPAN_SKILL_LABEL, sourceIds: [f.sourceId], attemptId: attempt.id, problemId: attempt.problemId,
      clientKey: randomUUID(), answer: JSON.stringify(response), outcome: "unverified", assistance, verdictSource: "self_report" });
}
it("keeps explicit next scoped to its origin despite two delivered hints and exact errors", async () => {
  const f = await seed(), { sql, scope } = fixture;
  const learning = createOpeningLearningRepository(sql);
  const submit = async () => {
    const session = await f.create();
    const attempt = await createSpanReservedService(sql).issue(scope, { sessionId: session.sessionId,
      sourceId: f.sourceId, clientKey: randomUUID(), mode: "self_study" });
    expect((await createSpanHintService(sql).read(scope, { attemptId: attempt.id, level: 1 })).exposureReceipt).toBeTruthy();
    const observed = await learning.insertObservation(scope, { sessionId: session.sessionId, courseId: f.courseId,
      skillLabel: SPAN_SKILL_LABEL, sourceIds: [f.sourceId], attemptId: attempt.id, problemId: attempt.problemId,
      clientKey: randomUUID(), answer: JSON.stringify({ membership: "in_span", coefficients: ["999", "999"] }),
      outcome: "unverified", assistance: "independent", verdictSource: "self_report" });
    expect(observed).toMatchObject({ outcome: "incorrect", serverEvaluation: { evaluatorVersion: "span-exact-v1", skills: { coefficients: "incorrect" } } });
    return { session, observed };
  };
  await submit();
  const latest = await submit();
  // Newer activity facts cannot replace the explicitly selected origin.
  const unrelated = await f.create();
  await record(f, unrelated.sessionId, { membership: "not_in_span" });
  const history = async () => ({
    observations: await sql`SELECT * FROM opening_learning_observations WHERE workspace_id=${scope.workspaceId} ORDER BY id`,
    help: await sql`SELECT * FROM opening_help_exposures WHERE workspace_id=${scope.workspaceId} ORDER BY id`,
  });
  const before = await history();
  const input = { activityId: latest.session.activityId, expectedRevision: latest.session.revision,
    observationId: latest.observed.id, clientKey: "same-error-next" };
  const result = await f.next.next(scope, input);
  expect(result).toMatchObject({ kind: "ready", replayed: false, decision: { activityKind: "targeted_explain",
    reasonCode: "verified_incorrect", focusObservationId: latest.observed.id }, session: { moveId: "self-example" } });
  if (result.kind !== "ready") throw new Error("expected same-error successor");
  const [activity] = await sql`SELECT goal_json FROM opening_teaching_activities WHERE id=${result.session.activityId}`;
  expect(activity!.goal_json.tutorNextAction.observationIds).toEqual([latest.observed.id]);
  const [receipt] = await sql`SELECT receipt FROM opening_learning_decisions WHERE target_id=${result.session.activityId} AND layer='activity'`;
  expect(receipt!.receipt.candidates).toContainEqual(expect.objectContaining({ reasonCodes: expect.arrayContaining(["verified_incorrect"]),
    evidenceRefs: [`observation:${latest.observed.id}`] }));
  const captured = JSON.parse(receipt!.receipt.intentVersion);
  expect(captured.decisionInput.observations.map((row: { id: string }) => row.id)).toEqual([latest.observed.id]);
  const capacity = await readOpeningLearningCapacity(sql, scope);
  expect(await f.next.next(scope, input)).toMatchObject({ kind: "ready", replayed: true,
    decision: result.decision, session: { activityId: result.session.activityId } });
  expect(await readOpeningLearningCapacity(sql, scope)).toEqual(capacity);
  expect(await history()).toEqual(before);
  const resumed = await createOpeningSpanTutorContextRepository(sql).read(scope,
    { courseId: f.courseId, sourceIds: [f.sourceId], sourceVersions: { [f.sourceId]: 1 }, question: "继续学习" });
  expect(resumed?.resumeSession?.activityId).toBe(result.session.activityId);
  expect(resumed?.historicalDecision).toEqual(result.decision);
  await learning.reviseObservation(scope, { rootObservationId: latest.observed.rootObservationId ?? latest.observed.id,
    revisesObservationId: latest.observed.id, expectedHead: latest.observed.id, revisionKind: "retract", reason: "撤回先前判断", clientKey: randomUUID() });
  expect(await f.next.next(scope, input)).toMatchObject({ kind: "choice", reason: "evidence_changed" });
});

it("ends only the selected origin and replays the actual next activity after an unknown response", async () => {
  const f = await seed(), origin = await f.create();
  const observed = await record(f, origin.sessionId, { membership: "not_in_span" });
  expect(observed.outcome).toBe("incorrect");
  const input = { activityId: origin.activityId, expectedRevision: origin.revision, observationId: observed.id, clientKey: "origin-next-request" };
  const first = await f.next.next(fixture.scope, input);
  expect(first).toMatchObject({ kind: "ready", replayed: false, session: { moveId: "self-example", retestId: null } });
  expect((await f.lessons.get(fixture.scope, origin.activityId))?.status).toBe("completed");
  await createWorkspacePreferencesRepository(fixture.sql).setLearningPreferences(fixture.scope,
    { assessmentEnabled: false, retestSuggestionsEnabled: false, automaticRemindersEnabled: false });
  const replay = await f.next.next(fixture.scope, input);
  expect(replay).toMatchObject({ kind: "ready", replayed: true, decision: { activityKind: "targeted_explain", focusObservationId: observed.id } });
  if (first.kind === "ready" && replay.kind === "ready") expect(replay.session.activityId).toBe(first.session.activityId);
  const refreshedOrigin = (await f.lessons.get(fixture.scope, origin.activityId))!;
  expect(refreshedOrigin.revision).toBeGreaterThan(origin.revision);
  const afterRefresh = await f.next.next(fixture.scope, { ...input, expectedRevision: refreshedOrigin.revision, clientKey: "refreshed-origin-next" });
  expect(afterRefresh).toMatchObject({ kind: "ready", replayed: true });
  if (first.kind === "ready" && afterRefresh.kind === "ready") expect(afterRefresh.session.activityId).toBe(first.session.activityId);
  expect(await fixture.sql`SELECT id FROM opening_teaching_activities WHERE course_id=${f.courseId}`).toHaveLength(2);
});
it("uses origin A's error after a newer independent pass in B and keeps B active", async () => {
  const f = await seed(), a = await f.create(), wrong = await record(f, a.sessionId, { membership: "not_in_span" });
  const b = await f.create();
  const correct = await record(f, b.sessionId, (problem: { vectors: string[][]; target: string[] }) => ({ membership: "in_span", coefficients: ["-2", "0"],
    equation: { vectors: problem.vectors, target: problem.target }, coordinateChecks: problem.target }));
  expect(correct).toMatchObject({ outcome: "correct", assistance: "independent" });
  const result = await f.next.next(fixture.scope, { activityId: a.activityId, expectedRevision: a.revision, observationId: wrong.id, clientKey: "origin-a-not-b" });
  expect(result).toMatchObject({ kind: "ready", decision: { activityKind: "targeted_explain", focusObservationId: wrong.id }, session: { moveId: "self-example" } });
  expect((await f.lessons.get(fixture.scope, b.activityId))?.status).toBe("active");
});
it("leaves a refused answer as a correction choice without closing the origin or starting remediation", async () => {
  const f = await seed(), origin = await f.create(), unknown = await record(f, origin.sessionId, { recognition: "uncertain", membership: "in_span" });
  expect(unknown.serverEvaluation?.decision).toBe("abstain");
  expect(await f.next.next(fixture.scope, { activityId: origin.activityId, expectedRevision: origin.revision, observationId: unknown.id, clientKey: "unknown-origin-next" }))
    .toMatchObject({ kind: "choice", reason: "unknown_evidence" });
  expect((await f.lessons.get(fixture.scope, origin.activityId))?.status).toBe("active");
  expect(await fixture.sql`SELECT id FROM opening_teaching_activities WHERE course_id=${f.courseId}`).toHaveLength(1);
});
it("does not create a reserved activity after the actual issuer exhausted every available content", async () => {
  const f = await seed(), origin = await f.create();
  const familyCount = listSpanReservedProblems("validation").length;
  for (let index = 0; index < familyCount; index++) await createSpanReservedService(fixture.sql).issue(fixture.scope,
    { sessionId: origin.sessionId, sourceId: f.sourceId, clientKey: randomUUID(), mode: "self_study" });
  await expect(createSpanReservedService(fixture.sql).issue(fixture.scope,
    { sessionId: origin.sessionId, sourceId: f.sourceId, clientKey: randomUUID(), mode: "self_study" })).rejects.toMatchObject({ code: "CONFLICT" });
  const result = await f.next.next(fixture.scope, { activityId: origin.activityId, expectedRevision: origin.revision, observationId: null, clientKey: "exhausted-origin-next" });
  expect(result).toMatchObject({ kind: "choice", reason: "unseen_unavailable" });
  expect((await f.lessons.get(fixture.scope, origin.activityId))?.status).toBe("active");
  expect(await fixture.sql`SELECT id FROM opening_teaching_activities WHERE course_id=${f.courseId}`).toHaveLength(1);
});
it("does not intercept an unrelated teaching request under a span grant", async () => {
  const f = await seed();
  expect(await createOpeningSpanTutorContextRepository(fixture.sql).read(fixture.scope,
    { courseId: f.courseId, sourceIds: [f.sourceId], sourceVersions: { [f.sourceId]: 1 }, question: "请解释特征值" })).toBeNull();
});
it("rolls the origin completion back when the shared budget cannot admit its next activity", async () => {
  const f = await seed(), origin = await f.create(), observed = await record(f, origin.sessionId, { membership: "not_in_span" });
  await fixture.sql`UPDATE workspace_preferences SET adaptive_planning=jsonb_set(adaptive_planning,
    ${["spanTutorGrants", f.courseId, "dailyMinutes"]}::text[],'30'::jsonb) WHERE workspace_id=${fixture.scope.workspaceId}`;
  const before = (await f.lessons.get(fixture.scope, origin.activityId))!;
  await expect(f.next.next(fixture.scope, { activityId: origin.activityId, expectedRevision: before.revision,
    observationId: observed.id, clientKey: "insufficient-origin-budget" })).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await f.lessons.get(fixture.scope, origin.activityId)).toEqual(before);
  expect(await fixture.sql`SELECT id FROM opening_teaching_activities WHERE course_id=${f.courseId}`).toHaveLength(1);
});
it.each(["cancelled", "expired"] as const)("preserves a real %s retest as an explicit choice without reopening it", async reason => {
  const f = await seed(), baseline = await f.create(), observed = await record(f, baseline.sessionId, { membership: "not_in_span" });
  const scheduled = await createSpanDelayedRetestService(fixture.sql).schedule(fixture.scope, { observationId: observed.id, clientKey: randomUUID() });
  const origin = await f.lessons.create(fixture.scope, { courseId: f.courseId, sourceIds: [f.sourceId], intent: DEFAULT_STUDY_SESSION_INTENT,
    clientKey: randomUUID(), retestId: scheduled.activityId });
  if (reason === "cancelled") {
    const [task] = await fixture.sql`SELECT version FROM opening_tasks WHERE id=${scheduled.taskId}`;
    await createOpeningPlansRepository(fixture.sql).updateTaskStatus(fixture.scope, scheduled.taskId,
      { expectedVersion: Number(task!.version), status: "skipped", at: new Date().toISOString() });
  } else await fixture.sql`UPDATE opening_retest_activities SET deadline_at=now()-interval '1 minute' WHERE id=${scheduled.activityId}`;
  expect(await f.next.next(fixture.scope, { activityId: origin.activityId, expectedRevision: origin.revision, observationId: null, clientKey: `preserve-${reason}` }))
    .toMatchObject({ kind: "choice", reason });
  expect((await f.lessons.get(fixture.scope, origin.activityId))?.status).toBe("active");
  const [retest] = await fixture.sql`SELECT status FROM opening_retest_activities WHERE id=${scheduled.activityId}`;
  expect(retest!.status).toBe(reason === "cancelled" ? "cancelled" : "accepted");
  expect(await fixture.sql`SELECT id FROM opening_teaching_activities WHERE course_id=${f.courseId}`).toHaveLength(2);
});
it("starts an ordinary correction after a failed retest while preserving its completed task and original lesson", async () => {
  const f = await seed(), baseline = await f.create(), observed = await record(f, baseline.sessionId, { membership: "not_in_span" });
  const scheduled = await createSpanDelayedRetestService(fixture.sql).schedule(fixture.scope, { observationId: observed.id, clientKey: randomUUID() });
  // Synthetic time advances exercise the execution gate, not a claim of real three-day retention.
  await fixture.sql`UPDATE opening_retest_activities SET recommended_at=now()-interval '1 minute',not_before_at=now()-interval '1 minute'
    WHERE id=${scheduled.activityId}`;
  const origin = await f.lessons.create(fixture.scope, { courseId: f.courseId, sourceIds: [f.sourceId], intent: DEFAULT_STUDY_SESSION_INTENT,
    clientKey: randomUUID(), retestId: scheduled.activityId });
  const issued = await createSpanReservedService(fixture.sql).issue(fixture.scope, { sessionId: origin.sessionId,
    sourceId: f.sourceId, mode: "challenge", clientKey: randomUUID() });
  expect(issued.spanExercise?.id).toContain("generated-retest-");
  await expect(createOpeningLearningAttemptRepository(fixture.sql).create(fixture.scope, { sessionId: origin.sessionId,
    clientKey: randomUUID(), spanExercise: { sourceId: f.sourceId,
      problemId: issued.spanExercise!.id.replace("generated-retest", "generated-validation"), version: 1 } })).rejects.toMatchObject({ code: "VALIDATION" });
  await expect(createOpeningLearningAttemptRepository(fixture.sql).create(fixture.scope, { sessionId: origin.sessionId,
    clientKey: randomUUID(), spanExercise: { sourceId: f.sourceId, problemId: "span-reserved-fraction", version: 1 } })).rejects.toMatchObject({ code: "VALIDATION" });
  const failed = await record(f, origin.sessionId, { membership: "not_in_span" });
  expect(failed.outcome).toBe("incorrect");
  const result = await f.next.next(fixture.scope, { activityId: origin.activityId, expectedRevision: origin.revision,
    observationId: failed.id, clientKey: "failed-retest-correction" });
  expect(result).toMatchObject({ kind: "ready", decision: { activityKind: "targeted_explain" }, session: { retestId: null, moveId: "self-example" } });
  const [prior] = await fixture.sql`SELECT r.status AS retest_status,t.status AS task_status FROM opening_retest_activities r
    JOIN opening_tasks t ON t.id=r.task_id WHERE r.id=${scheduled.activityId}`;
  expect(prior).toMatchObject({ retest_status: "completed", task_status: "done" });
  expect((await f.lessons.get(fixture.scope, baseline.activityId))?.status).toBe("active");
});
it("allocates the last unseen content atomically and restores the exact issued attempt", async () => {
  const f = await seed(), a = await f.create(), b = await f.create();
  const candidates = listSpanReservedProblems("validation");
  for (const problem of candidates.slice(0, -1)) {
    await createOpeningLearningAttemptRepository(fixture.sql).create(fixture.scope, { sessionId: a.sessionId, clientKey: randomUUID(),
      spanExercise: { sourceId: f.sourceId, problemId: problem.id, version: Number(problem.version) } });
  }
  const inputs = [a, b].map(origin => ({ activityId: origin.activityId, expectedRevision: origin.revision, observationId: null, clientKey: `compete-${origin.activityId}` }));
  const results = await Promise.all(inputs.map(input => f.next.next(fixture.scope, input)));
  expect(results.filter(result => result.kind === "ready")).toHaveLength(1);
  expect(results.filter(result => result.kind === "choice")).toMatchObject([{ reason: "unseen_unavailable" }]);
  const winnerIndex = results.findIndex(result => result.kind === "ready"), result = results[winnerIndex]!;
  if (result.kind !== "ready") throw new Error("the last actual candidate was not allocated");
  const restored = await createSpanLessonSessionService(fixture.sql).read(fixture.scope, f.courseId, result.session.activityId);
  expect(restored.attempts).toHaveLength(1);
  const issued = restored.attempts[0]!;
  expect(issued.spanExercise).toEqual(candidates.at(-1));
  const replayed = await createSpanReservedService(fixture.sql).issue(fixture.scope, { sessionId: result.session.sessionId,
    sourceId: f.sourceId, mode: "self_study", clientKey: `span-tutor-issue:span-next:${inputs[winnerIndex]!.activityId}:none` });
  expect(replayed.id).toBe(issued.id);
  expect(replayed.spanExercise).toEqual(issued.spanExercise);
  expect(await createOpeningLearningAttemptRepository(fixture.sql).listByActivity(fixture.scope, result.session.activityId)).toHaveLength(1);
  expect(await fixture.sql`SELECT id FROM opening_teaching_activities WHERE course_id=${f.courseId}`).toHaveLength(3);
});
it("ignores the origin completion revision and unrelated C, but rejects execution after the consumed A head changes", async () => {
  const f = await seed(), a = await f.create(), observed = await record(f, a.sessionId, { membership: "not_in_span" });
  const input = { activityId: a.activityId, expectedRevision: a.revision, observationId: observed.id, clientKey: "origin-change-race" };
  const next = await f.next.next(fixture.scope, input);
  if (next.kind !== "ready") throw new Error("fixture did not create a real derived activity");
  const b = next.session;
  expect((await f.lessons.get(fixture.scope, a.activityId))!.revision).toBeGreaterThan(a.revision);
  expect(await readOpeningSpanTutorOriginChange(fixture.sql, fixture.scope, b.activityId)).toBeUndefined();
  const c = await f.create(); await record(f, c.sessionId, { membership: "not_in_span" });
  await f.lessons.save(fixture.scope, c.activityId, { expectedRevision: c.revision, intent: c.intent, moveId: c.moveId, status: "completed" });
  expect(await readOpeningSpanTutorOriginChange(fixture.sql, fixture.scope, b.activityId)).toBeUndefined();
  const repository = createOpeningSpanTutorContextRepository(fixture.sql);
  const context = (await repository.read(fixture.scope, { courseId: f.courseId, sourceIds: [f.sourceId], sourceVersions: { [f.sourceId]: 1 }, question: "继续学习" }))!;
  expect(context.resumeSession?.activityId).toBe(b.activityId);
  const [before] = await fixture.sql`SELECT status,path_version,goal_json FROM opening_teaching_activities WHERE id=${b.activityId}`;
  await createOpeningLearningRepository(fixture.sql).reviseObservation(fixture.scope, { rootObservationId: observed.rootObservationId ?? observed.id,
    revisesObservationId: observed.id, expectedHead: observed.id, revisionKind: "retract", reason: "撤回原判断", clientKey: randomUUID() });
  expect(await readOpeningSpanTutorOriginChange(fixture.sql, fixture.scope, b.activityId)).toMatchObject({ reason: "evidence_changed",
    originSession: { activityId: a.activityId, revision: a.revision + 1 }, observationId: null });
  await expect(repository.execute(fixture.scope, { context, decision: nextLearningStep(context.decisionInput), operationId: `tutor-next:${randomUUID()}` }))
    .rejects.toMatchObject({ code: "CONFLICT", originChange: { reason: "evidence_changed" } });
  const current = (await repository.read(fixture.scope, { courseId: f.courseId, sourceIds: [f.sourceId], sourceVersions: { [f.sourceId]: 1 }, question: "继续学习" }))!;
  expect(current.originChange?.originSession?.activityId).toBe(a.activityId);
  expect(await f.next.next(fixture.scope, input)).toMatchObject({ kind: "choice", reason: "evidence_changed", originSession: { activityId: a.activityId } });
  const [after] = await fixture.sql`SELECT status,path_version,goal_json FROM opening_teaching_activities WHERE id=${b.activityId}`;
  expect(after).toEqual(before);
  expect(await fixture.sql`SELECT id FROM opening_teaching_activities WHERE course_id=${f.courseId}`).toHaveLength(3);
});
it("detects a consumed source version change and leaves metadata-free manual lessons usable", async () => {
  const f = await seed(), a = await f.create(), observed = await record(f, a.sessionId, { membership: "not_in_span" });
  const next = await f.next.next(fixture.scope, { activityId: a.activityId, expectedRevision: a.revision, observationId: observed.id, clientKey: "derived-material-change" });
  if (next.kind !== "ready") throw new Error("fixture did not create a real derived activity");
  const manual = await f.create();
  await fixture.sql`UPDATE opening_sources SET version=2 WHERE id=${f.sourceId}`;
  await backupRows(fixture.sql, fixture.scope).chunk(f.sourceId, 2);
  expect(await readOpeningSpanTutorOriginChange(fixture.sql, fixture.scope, next.session.activityId)).toMatchObject({
    reason: "source_unavailable", originSession: { activityId: a.activityId }, observationId: observed.id });
  expect(await readOpeningSpanTutorOriginChange(fixture.sql, fixture.scope, manual.activityId)).toBeUndefined();
  const attempt = await createOpeningLearningAttemptRepository(fixture.sql).create(fixture.scope, { sessionId: manual.sessionId, clientKey: randomUUID(),
    spanExercise: { sourceId: f.sourceId, problemId: "span-example-2d", version: 1 } });
  expect(attempt.sourceVersions[f.sourceId]).toBe(2);
});
it("keeps one learner's real help, evaluation, retest, saved query and cancellation replay on the same facts", async () => {
  // Synthetic learner + exact solver; real services/transactions, no model, queue or retention claim.
  const f = await seed(), origin = await f.create(), { sql, scope } = fixture;
  const forbidden = vi.fn(async (): Promise<never> => { throw new Error("unexpected model/RAG/budget call"); });
  vi.stubEnv("OPENING_SYSTEM_QUERY", "1");
  vi.stubEnv("OPENING_MODEL_API_KEY", "");
  vi.stubEnv("OPENING_MODEL_CATALOG", "invalid model catalog");
  vi.stubGlobal("fetch", forbidden);
  try {
    const issuer = createSpanReservedService(sql), learning = createOpeningLearningRepository(sql);
    const issueInput = { sessionId: origin.sessionId, sourceId: f.sourceId, clientKey: "chain-first-issue", mode: "self_study" };
    const attempt = await issuer.issue(scope, issueInput), problem = attempt.spanExercise!;
    const help = await createSpanHintService(sql).read(scope, { attemptId: attempt.id, level: 1 });
    expect(help.text).toContain("αv+βw=u"); expect(help.exposureReceipt).toBeTruthy();
    const solution = solveSpanProblem(problem);
    if (solution.kind !== "unique") throw new Error("first canonical validation must have a unique solution");
    const submitInput = { sessionId: origin.sessionId, courseId: f.courseId, skillLabel: SPAN_SKILL_LABEL,
      sourceIds: [f.sourceId], attemptId: attempt.id, problemId: attempt.problemId, clientKey: "chain-first-submit",
      answer: JSON.stringify({ membership: "in_span", coefficients: solution.coefficients,
        equation: { vectors: problem.vectors, target: problem.target }, coordinateChecks: problem.target }),
      outcome: "unverified" as const, assistance: "independent" as const, verdictSource: "self_report" as const };
    const observed = await learning.insertObservation(scope, submitInput);
    expect(observed).toMatchObject({ outcome: "correct", assistance: "independent", serverEvaluation: { evaluatorVersion: "span-exact-v1" } });
    // The original self-report stays immutable; delivered help owns effective eligibility.
    const restored = await createSpanLessonSessionService(sql).read(scope, f.courseId, origin.activityId);
    expect(restored.assistance[attempt.id]).toBe("hinted");
    expect(restored.observations.map(row => row.id)).toContain(observed.id);
    const nextInput = { activityId: origin.activityId, expectedRevision: origin.revision, observationId: observed.id, clientKey: "chain-next" };
    const next = await f.next.next(scope, nextInput);
    expect(next).toMatchObject({ kind: "ready", replayed: false, decision: { activityKind: "reduced_help_practice", reasonCode: "assistance_dependent" } });
    if (next.kind !== "ready") throw new Error("expected a real reduced-help successor");

    const oldHelp = await sql`SELECT * FROM opening_help_exposures WHERE workspace_id=${scope.workspaceId} ORDER BY id`;
    const oldObservation = await sql`SELECT * FROM opening_learning_observations WHERE id=${observed.id}`;
    expect(oldHelp).toHaveLength(1); expect(oldObservation).toHaveLength(1);
    const scheduler = createSpanDelayedRetestService(sql);
    const due = await scheduler.schedule(scope, { observationId: observed.id, clientKey: "chain-completed-retest-schedule" });
    expect(due).toMatchObject({ courseId: f.courseId, taskStatus: "pending", activityStatus: "accepted" });
    expect(Date.parse(due.notBeforeAt)).toBeGreaterThanOrEqual(Date.parse(observed.submittedAt!) + 72 * 60 * 60 * 1000);
    const dueLesson = await f.lessons.create(scope, { courseId: f.courseId, sourceIds: [f.sourceId],
      intent: DEFAULT_STUDY_SESSION_INTENT, clientKey: "chain-due-retest-lesson", retestId: due.activityId });
    const dueIssueInput = { sessionId: dueLesson.sessionId, sourceId: f.sourceId, mode: "challenge", clientKey: "chain-due-retest-issue" };
    await expect(issuer.issue(scope, dueIssueInput)).rejects.toMatchObject({ businessCode: "RETEST_SUBMIT_TOO_EARLY" });
    // Only this synthetic retest's time fields advance; no claim of real 72h retention or mastery.
    await sql`UPDATE opening_retest_activities SET recommended_at=now()-interval '1 minute',
      not_before_at=now()-interval '1 minute',scheduled_start_at=now()-interval '1 minute' WHERE id=${due.activityId}`;
    const retestAttempt = await issuer.issue(scope, dueIssueInput), retestProblem = retestAttempt.spanExercise!;
    expect(retestProblem.id).toContain("generated-retest-");
    expect(retestAttempt).toMatchObject({ courseId: f.courseId, sourceIds: [f.sourceId], sessionId: dueLesson.sessionId });
    const retestSolution = solveSpanProblem(retestProblem);
    if (retestSolution.kind !== "unique") throw new Error("issued retest must have a unique exact solution");
    const retestSubmitInput = { ...submitInput, sessionId: dueLesson.sessionId, attemptId: retestAttempt.id,
      problemId: retestAttempt.problemId, retestId: due.activityId, clientKey: "chain-due-retest-submit",
      answer: JSON.stringify({ membership: "in_span", coefficients: retestSolution.coefficients,
        equation: { vectors: retestProblem.vectors, target: retestProblem.target }, coordinateChecks: retestProblem.target }) };
    const retestObserved = await learning.insertObservation(scope, retestSubmitInput);
    expect(retestObserved).toMatchObject({ outcome: "correct", assistance: "independent", retestId: due.activityId,
      serverEvaluation: { evaluatorVersion: "span-exact-v1" } });
    const dueNextInput = { activityId: dueLesson.activityId, expectedRevision: dueLesson.revision,
      observationId: retestObserved.id, clientKey: "chain-due-retest-next" };
    const dueNext = await f.next.next(scope, dueNextInput);
    expect(dueNext).toMatchObject({ kind: "ready", replayed: false, session: { retestId: null, courseId: f.courseId } });
    if (dueNext.kind !== "ready") throw new Error("expected a real successor after successful retest");
    const completedRetest = await sql`SELECT * FROM opening_retest_activities WHERE id=${due.activityId}`;
    const doneTask = await sql`SELECT * FROM opening_tasks WHERE id=${due.taskId}`;
    expect(completedRetest).toMatchObject([{ status: "completed" }]);
    expect(doneTask).toMatchObject([{ status: "done" }]);
    // A second, still-future acceptance uses the real new answer, never cancels the completed cycle.
    const scheduleInput = { observationId: retestObserved.id, clientKey: "chain-retest-schedule" };
    const scheduled = await scheduler.schedule(scope, scheduleInput);
    expect(scheduled).toMatchObject({ courseId: f.courseId, taskStatus: "pending", activityStatus: "accepted" });
    const retestLesson = await f.lessons.create(scope, { courseId: f.courseId, sourceIds: [f.sourceId],
      intent: DEFAULT_STUDY_SESSION_INTENT, clientKey: "chain-retest-lesson", retestId: scheduled.activityId });
    const retestNext = { activityId: retestLesson.activityId, expectedRevision: retestLesson.revision,
      observationId: null, clientKey: "chain-retest-next" };
    expect(Date.parse(scheduled.notBeforeAt)).toBeGreaterThanOrEqual(Date.parse(retestObserved.submittedAt!) + 72 * 60 * 60 * 1000);
    expect(scheduled.activityId).not.toBe(due.activityId);
    expect(scheduled.taskId).not.toBe(due.taskId);
    const snapshot = async () => ({
      observations: await sql`SELECT * FROM opening_learning_observations WHERE workspace_id=${scope.workspaceId} ORDER BY id`,
      help: await sql`SELECT * FROM opening_help_exposures WHERE workspace_id=${scope.workspaceId} ORDER BY id`,
      attempts: await sql`SELECT * FROM opening_learning_attempts WHERE workspace_id=${scope.workspaceId} ORDER BY id`,
      tasks: await sql`SELECT * FROM opening_tasks WHERE workspace_id=${scope.workspaceId} ORDER BY id`,
      activities: await sql`SELECT * FROM opening_teaching_activities WHERE workspace_id=${scope.workspaceId} ORDER BY id`,
      retests: await sql`SELECT * FROM opening_retest_activities WHERE workspace_id=${scope.workspaceId} ORDER BY id`,
      money: await sql`SELECT * FROM opening_budget_reservations WHERE workspace_id=${scope.workspaceId} ORDER BY id`,
      todayMinutes: (await readOpeningLearningCapacity(sql, scope)).usedMinutes,
      retestDayMinutes: (await readOpeningLearningCapacity(sql, scope, new Date(scheduled.notBeforeAt))).usedMinutes,
    });
    const tutor = getTutorService(sql), conversation = await tutor.createConversation(scope, { title: "Synthetic M1 chain", courseId: f.courseId });
    const process = createTutorTurnHandler({ systemQuery: createDbSystemQueryService(sql, "worker"),
      tutorJobs: createOpeningTutorJobsRepository(sql), privacy: createOpeningPrivacyRepository(sql),
      chunks: { listForSources: forbidden, listChunksAtVersion: forbidden }, provider: { complete: forbidden }, resolveModel: forbidden,
      budget: { reserve: forbidden, release: forbidden, claimExecution: forbidden, settle: forbidden, markUnknown: forbidden },
      config: { maxContextCharacters: 12000, reservedCents: 1, maxOutputTokens: 100, inputCentsPerMillion: 1, outputCentsPerMillion: 1 } });
    const queryInput = { conversationId: conversation.id, querySystem: true, text: "我的作答核验了吗", sourceIds: [], mode: "explain", privacy: "saved", clientKey: "chain-query-before" };
    const beforeQuery = await snapshot();
    const queued = await tutor.submitTurn(scope, queryInput);
    expect(await process(queued.jobId)).toEqual({ skipped: false });
    const turns = await tutor.listTurns(scope, conversation.id), saved = turns.find(turn => turn.role === "assistant")!;
    expect(saved.status).toBe("complete");
    expect(saved.systemQuery?.results.find(row => row.name === "learning")?.data).toContainEqual(expect.objectContaining({
      id: observed.id, attemptId: attempt.id, effectiveAssistance: "hinted", outcome: "correct",
      eligibility: expect.objectContaining({ independentAttempt: "no" }) }));
    expect(await snapshot()).toEqual(beforeQuery);
    expect(beforeQuery.todayMinutes).toBeGreaterThan(0); expect(beforeQuery.retestDayMinutes).toBe(20);
    expect(beforeQuery.money).toEqual([]);

    const [task] = await sql`SELECT version FROM opening_tasks WHERE id=${scheduled.taskId}`;
    await createOpeningPlansRepository(sql).updateTaskStatus(scope, scheduled.taskId,
      { expectedVersion: Number(task!.version), status: "skipped", at: new Date().toISOString() });
    const cancelled = await snapshot();
    expect(cancelled.tasks).toContainEqual(expect.objectContaining({ id: scheduled.taskId, status: "skipped" }));
    expect(cancelled.retests).toContainEqual(expect.objectContaining({ id: scheduled.activityId, status: "cancelled" }));
    expect(cancelled.retestDayMinutes).toBe(0);
    expect(cancelled.todayMinutes).toBe(beforeQuery.todayMinutes);
    expect(cancelled.attempts.filter(row => row.session_id === retestLesson.sessionId)).toEqual([]);
    expect(await sql`SELECT * FROM opening_retest_activities WHERE id=${due.activityId}`).toEqual(completedRetest);
    expect(await sql`SELECT * FROM opening_tasks WHERE id=${due.taskId}`).toEqual(doneTask);
    expect(await issuer.issue(scope, dueIssueInput)).toMatchObject({ id: retestAttempt.id, observationId: retestObserved.id });
    expect((await learning.insertObservation(scope, retestSubmitInput)).id).toBe(retestObserved.id);
    expect(await f.next.next(scope, dueNextInput)).toMatchObject({ kind: "ready", replayed: true,
      session: { activityId: dueNext.session.activityId } });
    expect(await f.next.next(scope, retestNext)).toMatchObject({ kind: "choice", reason: "cancelled" });
    await expect(issuer.issue(scope, { sessionId: retestLesson.sessionId, sourceId: f.sourceId,
      mode: "challenge", clientKey: "chain-cancelled-new-issue" })).rejects.toMatchObject({ code: "VALIDATION", message: "延迟复测不属于本课程、尚未接受或已结束。" });
    expect(await scheduler.schedule(scope, scheduleInput)).toMatchObject({ activityId: scheduled.activityId,
      taskId: scheduled.taskId, activityStatus: "cancelled", taskStatus: "skipped" });
    expect(await issuer.issue(scope, issueInput)).toMatchObject({ id: attempt.id, observationId: observed.id });
    expect((await learning.insertObservation(scope, submitInput)).id).toBe(observed.id);
    expect(await createSpanHintService(sql).read(scope, { attemptId: attempt.id, level: 1 })).toEqual(help);
    expect(await f.next.next(scope, nextInput)).toMatchObject({ kind: "ready", replayed: true, session: { activityId: next.session.activityId } });
    expect(await tutor.submitTurn(scope, queryInput)).toEqual({ ...queued, replayed: true });
    expect(await process(queued.jobId)).toEqual({ skipped: true });
    expect((await tutor.listTurns(scope, conversation.id)).find(turn => turn.id === saved.id)).toEqual(saved);
    const fresh = await tutor.submitTurn(scope, { ...queryInput, clientKey: "chain-query-after" });
    expect(await process(fresh.jobId)).toEqual({ skipped: false });
    const afterTurns = await tutor.listTurns(scope, conversation.id);
    expect(afterTurns).toHaveLength(4);
    expect(afterTurns.filter(turn => turn.role === "assistant").every(turn => turn.systemQuery?.results.some(result =>
      result.name === "learning" && result.data.some(row => row.id === observed.id && row.effectiveAssistance === "hinted")))).toBe(true);
    expect(await snapshot()).toEqual(cancelled);
    expect(await sql`SELECT * FROM opening_help_exposures WHERE workspace_id=${scope.workspaceId} ORDER BY id`).toEqual(oldHelp);
    expect(await sql`SELECT * FROM opening_learning_observations WHERE id=${observed.id}`).toEqual(oldObservation);
    expect(forbidden).not.toHaveBeenCalled();
  } finally { vi.unstubAllEnvs(); vi.unstubAllGlobals(); }
// The full persistent lifecycle spans several real transactions; keep its timeout local to this new case.
}, 45_000);

it("invalidates a stored no-evidence origin only when A itself gains a head", async () => {
  const f = await seed(), a = await f.create(), b = await f.create();
  const reference = { activityId: a.activityId, expectedRevision: a.revision, observationId: null };
  await fixture.sql`UPDATE opening_teaching_activities SET goal_json=goal_json || ${fixture.sql.json({ tutorNextAction: {
    originReference: reference, observationIds: [], sourceRefs: [{ sourceId: f.sourceId, sourceVersion: 1 }] } })}::jsonb WHERE id=${b.activityId}`;
  const c = await f.create(); await record(f, c.sessionId, { membership: "not_in_span" });
  expect(await readOpeningSpanTutorOriginChange(fixture.sql, fixture.scope, b.activityId)).toBeUndefined();
  const first = await record(f, a.sessionId, { membership: "not_in_span" });
  expect(await readOpeningSpanTutorOriginChange(fixture.sql, fixture.scope, b.activityId)).toMatchObject({ reason: "evidence_changed",
    originSession: { activityId: a.activityId, revision: a.revision }, observationId: first.id });
});
