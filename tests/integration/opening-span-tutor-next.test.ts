import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DEFAULT_OPENING_ADAPTIVE_PREFS } from "@aistudy/contracts";
import { createOpeningLearningRepository, createOpeningSpanSessionRepository, createWorkspacePreferencesRepository, createOpeningPlansRepository, createOpeningLearningAttemptRepository } from "@aistudy/database";
import { DEFAULT_STUDY_SESSION_INTENT, SPAN_SKILL_LABEL, nextLearningStep } from "@aistudy/domain";
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
it("does not create a reserved activity after the actual issuer exhausted every available family", async () => {
  const f = await seed(), origin = await f.create();
  const familyCount = new Set(listSpanReservedProblems().map(problem => problem.familyId)).size;
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
it("allocates the last unseen family atomically and restores the exact issued attempt", async () => {
  const f = await seed(), a = await f.create(), b = await f.create();
  const representatives = new Map(listSpanReservedProblems().map(problem => [problem.familyId, problem]));
  for (const [family, problem] of representatives) if (family !== "span:rational-3d") {
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
  expect(issued.spanExercise?.familyId).toBe("span:rational-3d");
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
