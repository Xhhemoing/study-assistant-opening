import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createOpeningSpanSessionRepository, createOpeningLearningAttemptRepository, createOpeningLearningRepository, createOpeningStudyExposureRepository,
  type OpeningStudyExposureInput } from "@aistudy/database";
import type { LearningAttempt, ObservationInput, SpanLessonCreateInput, SpanLessonSnapshot } from "@aistudy/contracts";
import { SPAN_REQUIREMENT_KEY, SPAN_SKILL_LABEL } from "@aistudy/domain";
import { listSpanReservedProblems } from "@aistudy/domain/span-heldout-catalog";
import { createSpanReservedService } from "../../apps/web/src/features/opening/teaching/span/reserved-service";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { backupRows } from "./opening-backup-records-fixture";
let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
afterAll(async () => { await fixture?.close(); });
const intent: SpanLessonCreateInput["intent"] = { purpose: "self_study", timeBudgetMinutes: 15, language: "bilingual", pace: "normal", continuous: true, selfReportedFatigue: "unknown" };
const runFile = promisify(execFile);
async function seed() {
  const courseId = randomUUID(), rows = backupRows(fixture.sql, fixture.scope), sourceId = await rows.source();
  await rows.chunk(sourceId);
  await fixture.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES (${courseId},${fixture.scope.workspaceId},'Span session',${courseId})`;
  await fixture.sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility)
    VALUES (${fixture.scope.workspaceId},${courseId},'source',${sourceId},'core','course')`;
  const input: SpanLessonCreateInput = { courseId, sourceIds: [sourceId], intent, clientKey: randomUUID() };
  return { courseId, sourceId, input, repo: createOpeningSpanSessionRepository(fixture.sql) };
}
function patch(state: SpanLessonSnapshot, values: Partial<{ moveId: SpanLessonSnapshot["moveId"]; status: SpanLessonSnapshot["status"]; intent: SpanLessonCreateInput["intent"] }> = {}) {
  return { expectedRevision: state.revision, intent: state.intent, moveId: state.moveId, status: state.status, ...values };
}
it("creates one activity/session under concurrent retries and keeps the original create identity", async () => {
  const f = await seed(), [one, two] = await Promise.all([f.repo.create(fixture.scope, f.input), f.repo.create(fixture.scope, f.input)]);
  expect(two).toEqual(one);
  expect(one).toMatchObject({ courseId: f.courseId, sourceIds: [f.sourceId], status: "active", moveId: "self-example", revision: 1 });
  const sessions = await fixture.sql`SELECT id FROM opening_learning_sessions WHERE activity_id=${one.activityId}`;
  expect(sessions.map(row => row.id)).toEqual([one.sessionId]);
  await expect(f.repo.create(fixture.scope, { ...f.input, intent: { ...intent, language: "en" } })).rejects.toMatchObject({ code: "CONFLICT" });
});
it("restores a paused session and reuses its attempt identity after reopening", async () => {
  const f = await seed(), started = await f.repo.create(fixture.scope, f.input);
  const attempts = createOpeningLearningAttemptRepository(fixture.sql);
  const attemptInput = { sessionId: started.sessionId, clientKey: randomUUID(), spanExercise: { sourceId: f.sourceId, problemId: "span-independent-3d", version: 1 } };
  const attempt = await attempts.create(fixture.scope, attemptInput);
  const paused = await f.repo.save(fixture.scope, started.activityId, patch(started, { moveId: "self-independent", status: "paused" }));
  const reopened = createOpeningSpanSessionRepository(fixture.sql);
  expect(await reopened.latest(fixture.scope, f.courseId)).toEqual(paused);
  expect(await reopened.get(fixture.scope, started.activityId)).toEqual(paused);
  expect((await attempts.create(fixture.scope, attemptInput)).id).toBe(attempt.id);
  await expect(attempts.create(fixture.scope, { ...attemptInput, clientKey: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(reopened.save(fixture.scope, started.activityId, patch(started, { status: "active" }))).rejects.toMatchObject({ code: "CONFLICT" });
  const continued = await reopened.save(fixture.scope, started.activityId, patch(paused, { status: "active" }));
  expect(continued.sessionId).toBe(started.sessionId);
  expect((await attempts.create(fixture.scope, attemptInput)).id).toBe(attempt.id);
  const next = await attempts.create(fixture.scope, { ...attemptInput, clientKey: randomUUID() });
  expect(next.id).not.toBe(attempt.id);
});
it("rejects stale competing progress and replays the acknowledged change without another revision", async () => {
  const f = await seed(), started = await f.repo.create(fixture.scope, f.input);
  const input = patch(started, { moveId: "self-faded" });
  const changed = await f.repo.save(fixture.scope, started.activityId, input);
  expect((await f.repo.save(fixture.scope, started.activityId, input)).revision).toBe(changed.revision);
  await expect(f.repo.save(fixture.scope, started.activityId, patch(started, { moveId: "self-independent" }))).rejects.toMatchObject({ code: "CONFLICT" });
  expect((await f.repo.get(fixture.scope, started.activityId))?.moveId).toBe("self-faded");
});
it("preserves sealed answers while pause and completion reject new submissions until resume", async () => {
  const f = await seed(), started = await f.repo.create(fixture.scope, f.input);
  const attempts = createOpeningLearningAttemptRepository(fixture.sql), learning = createOpeningLearningRepository(fixture.sql);
  const issue = () => attempts.create(fixture.scope, { sessionId: started.sessionId, clientKey: randomUUID(), spanExercise: { sourceId: f.sourceId, problemId: "span-independent-3d", version: 1 } });
  const first = await issue(), second = await issue();
  const input: ObservationInput = { sessionId: started.sessionId, courseId: f.courseId, skillLabel: SPAN_SKILL_LABEL,
    sourceIds: [f.sourceId], attemptId: first.id, problemId: first.problemId, clientKey: randomUUID(),
    answer: JSON.stringify({ membership: "not_in_span" }), outcome: "unverified", assistance: "independent", verdictSource: "self_report" };
  const sealed = await learning.insertObservation(fixture.scope, input);
  const paused = await f.repo.save(fixture.scope, started.activityId, patch(started, { status: "paused" }));
  // A fresh Node/tsx process opens its own guarded connection. No repository or
  // client-side state survives into this read, as after an application restart.
  const restarted = await runFile(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
    import { assertOpeningTestDatabase } from "@aistudy/config";
    import { createSqlClient, createOpeningSpanSessionRepository, createOpeningLearningAttemptRepository, createOpeningLearningRepository } from "@aistudy/database";
    const request = JSON.parse(process.env.SPAN_SESSION_RESTART);
    const url = assertOpeningTestDatabase(process.env.OPENING_TEST_DATABASE_URL ?? "", process.env.OPENING_TEST_DB);
    const sql = createSqlClient(url.toString());
    try {
      const session = await createOpeningSpanSessionRepository(sql).get(request.scope, request.activityId);
      const attempt = await createOpeningLearningAttemptRepository(sql).get(request.scope, request.attemptId);
      const observations = await createOpeningLearningRepository(sql).listObservationsForCourse(request.scope, request.courseId);
      process.stdout.write(JSON.stringify({ session, attempt, observations }));
    } finally { await sql.end({ timeout: 5 }); }
  `], { cwd: fileURLToPath(new URL("../../", import.meta.url)), timeout: 30_000,
    env: { ...process.env, SPAN_SESSION_RESTART: JSON.stringify({ scope: fixture.scope, activityId: started.activityId, attemptId: first.id, courseId: f.courseId }) } });
  expect(JSON.parse(restarted.stdout)).toMatchObject({ session: paused,
    attempt: { id: first.id, sessionId: started.sessionId, observationId: sealed.id },
    observations: [expect.objectContaining({ id: sealed.id, answer: input.answer, attemptId: first.id })] });
  expect(await learning.insertObservation(fixture.scope, input)).toMatchObject({ id: sealed.id, answer: input.answer });
  const pending = { ...input, attemptId: second.id, problemId: second.problemId, clientKey: randomUUID() };
  const inactiveError = { code: "CONFLICT", message: "paused or completed span lesson cannot accept an answer" };
  await expect(learning.insertObservation(fixture.scope, pending)).rejects.toMatchObject(inactiveError);
  await expect(learning.insertObservation(fixture.scope, { ...input, clientKey: randomUUID() })).rejects.toMatchObject(inactiveError);
  const resumed = await f.repo.save(fixture.scope, started.activityId, patch(paused, { status: "active" }));
  expect((await learning.insertObservation(fixture.scope, pending)).attemptId).toBe(second.id);
  const third = await issue();
  await f.repo.save(fixture.scope, started.activityId, patch(resumed, { status: "completed" }));
  expect(await learning.insertObservation(fixture.scope, input)).toMatchObject({ id: sealed.id, answer: input.answer });
  await expect(learning.insertObservation(fixture.scope, { ...input, attemptId: third.id, problemId: third.problemId, clientKey: randomUUID() })).rejects.toMatchObject(inactiveError);
  expect((await attempts.get(fixture.scope, third.id))?.submittedAt).toBeNull();
}, 45_000);
it("isolates owners, courses, and delayed-check identities", async () => {
  const f = await seed(), started = await f.repo.create(fixture.scope, f.input);
  expect(await f.repo.get(fixture.otherScope, started.activityId)).toBeNull();
  expect(await f.repo.latest(fixture.otherScope, f.courseId)).toBeNull();
  expect(await f.repo.latest(fixture.scope, f.courseId, randomUUID())).toBeNull();
  await expect(f.repo.save(fixture.otherScope, started.activityId, patch(started))).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(f.repo.create(fixture.scope, { ...f.input, clientKey: randomUUID(), retestId: randomUUID() })).rejects.toMatchObject({ code: "VALIDATION" });
  const retestId = randomUUID();
  await fixture.sql`INSERT INTO opening_retest_activities
    (id,workspace_id,owner_user_id,course_id,skill_label,requirement_key,evidence_cycle_id,status,version)
    VALUES (${retestId},${fixture.scope.workspaceId},${fixture.scope.ownerUserId},${f.courseId},${SPAN_SKILL_LABEL},${SPAN_REQUIREMENT_KEY},${randomUUID()},'accepted',2)`;
  const delayed = await f.repo.create(fixture.scope, { ...f.input, clientKey: randomUUID(), retestId });
  expect(delayed).toMatchObject({ retestId, moveId: "self_study-reserved" });
  expect(await f.repo.latest(fixture.scope, f.courseId)).toEqual(started);
  expect(await f.repo.latest(fixture.scope, f.courseId, retestId)).toEqual(delayed);
  await expect(f.repo.save(fixture.scope, delayed.activityId, patch(delayed, { moveId: "self-faded" }))).rejects.toMatchObject({ code: "VALIDATION" });
  const other = await seed();
  await expect(f.repo.create(fixture.scope, { ...f.input, clientKey: randomUUID(), sourceIds: [other.sourceId] })).rejects.toMatchObject({ code: "VALIDATION" });
});
it("preserves unrelated checkpoint data and refuses moves from a different mode", async () => {
  const f = await seed(), started = await f.repo.create(fixture.scope, f.input);
  await fixture.sql`UPDATE opening_teaching_activities SET checkpoint_json=checkpoint_json || '{"unrelated":{"keep":true}}'::jsonb WHERE id=${started.activityId}`;
  await expect(f.repo.save(fixture.scope, started.activityId, patch(started, { moveId: "overview-mixed" }))).rejects.toMatchObject({ code: "VALIDATION" });
  await f.repo.save(fixture.scope, started.activityId, patch(started, { moveId: "self-faded" }));
  const [row] = await fixture.sql`SELECT checkpoint_json FROM opening_teaching_activities WHERE id=${started.activityId}`;
  expect(row?.checkpoint_json.unrelated).toEqual({ keep: true });
});
it("enforces persisted retest timing on direct and reserved issuance while preserving exact old receipts", async () => {
  const f = await seed(), retestId = randomUUID();
  await fixture.sql`INSERT INTO opening_retest_activities
    (id,workspace_id,owner_user_id,course_id,skill_label,requirement_key,evidence_cycle_id,status,version,not_before_at)
    VALUES (${retestId},${fixture.scope.workspaceId},${fixture.scope.ownerUserId},${f.courseId},${SPAN_SKILL_LABEL},${SPAN_REQUIREMENT_KEY},${randomUUID()},'accepted',2,clock_timestamp()+interval '2 days')`;
  const lesson = await f.repo.create(fixture.scope, { ...f.input, retestId });
  const attempts = createOpeningLearningAttemptRepository(fixture.sql), reserved = createSpanReservedService(fixture.sql);
  const problem = listSpanReservedProblems()[0]!;
  const direct = { sessionId: lesson.sessionId, clientKey: randomUUID(), spanExercise: { sourceId: f.sourceId, problemId: problem.id, version: Number(problem.version) } };
  const issue = { sessionId: lesson.sessionId, sourceId: f.sourceId, clientKey: randomUUID(), mode: "self_study" };
  const tooEarly = { code: "VALIDATION", businessCode: "RETEST_SUBMIT_TOO_EARLY" };
  await expect(attempts.create(fixture.scope, direct)).rejects.toMatchObject(tooEarly);
  await expect(reserved.issue(fixture.scope, issue)).rejects.toMatchObject(tooEarly);
  expect(await attempts.listByActivity(fixture.scope, lesson.activityId)).toEqual([]);
  await fixture.sql`UPDATE opening_retest_activities SET not_before_at=clock_timestamp()-interval '1 day',recommended_at=clock_timestamp()+interval '1 day' WHERE id=${retestId}`;
  await expect(attempts.create(fixture.scope, direct)).rejects.toMatchObject(tooEarly);
  await fixture.sql`UPDATE opening_retest_activities SET recommended_at=clock_timestamp()-interval '1 day',scheduled_start_at=clock_timestamp()+interval '1 hour' WHERE id=${retestId}`;
  await expect(attempts.create(fixture.scope, direct)).rejects.toMatchObject(tooEarly);
  await fixture.sql`UPDATE opening_retest_activities SET scheduled_start_at=clock_timestamp()-interval '1 minute' WHERE id=${retestId}`;
  const first = await attempts.create(fixture.scope, direct), second = await reserved.issue(fixture.scope, issue);
  expect(first.sessionId).toBe(lesson.sessionId);
  expect(second.sessionId).toBe(lesson.sessionId);
  await fixture.sql`UPDATE opening_retest_activities SET status='cancelled',not_before_at=clock_timestamp()+interval '2 days' WHERE id=${retestId}`;
  expect((await attempts.create(fixture.scope, direct)).id).toBe(first.id);
  expect((await reserved.issue(fixture.scope, issue)).id).toBe(second.id);
  await expect(attempts.create(fixture.scope, { ...direct, clientKey: randomUUID() })).rejects.toMatchObject({ code: "VALIDATION", message: "延迟复测不属于本课程、尚未接受或已结束。" });
  await expect(reserved.issue(fixture.scope, { ...issue, clientKey: randomUUID() })).rejects.toMatchObject({ code: "VALIDATION" });
}, 45_000);
it("binds new submissions to the persisted retest while omitted IDs, replacement tasks and rescheduling cannot bypass it", async () => {
  const f = await seed(), retestId = randomUUID(), otherRetestId = randomUUID();
  for (const id of [retestId, otherRetestId]) {
    await fixture.sql`INSERT INTO opening_retest_activities
      (id,workspace_id,owner_user_id,course_id,skill_label,requirement_key,evidence_cycle_id,status,version,not_before_at)
      VALUES (${id},${fixture.scope.workspaceId},${fixture.scope.ownerUserId},${f.courseId},${SPAN_SKILL_LABEL},${SPAN_REQUIREMENT_KEY},${randomUUID()},'accepted',2,clock_timestamp()-interval '1 day')`;
  }
  const lesson = await f.repo.create(fixture.scope, { ...f.input, retestId });
  const attempts = createOpeningLearningAttemptRepository(fixture.sql), learning = createOpeningLearningRepository(fixture.sql);
  const issue = () => attempts.create(fixture.scope, { sessionId: lesson.sessionId, clientKey: randomUUID(), spanExercise: { sourceId: f.sourceId, problemId: "span-independent-3d", version: 1 } });
  const first = await issue(), pending = await issue();
  const input: ObservationInput = { sessionId: lesson.sessionId, courseId: f.courseId, skillLabel: SPAN_SKILL_LABEL,
    sourceIds: [f.sourceId], attemptId: first.id, problemId: first.problemId, clientKey: randomUUID(),
    answer: JSON.stringify({ membership: "not_in_span" }), outcome: "unverified", assistance: "independent", verdictSource: "self_report" };
  await fixture.sql`UPDATE opening_retest_activities SET not_before_at=clock_timestamp()+interval '1 day' WHERE id=${retestId}`;
  await expect(learning.insertObservation(fixture.scope, input)).rejects.toMatchObject({ code: "VALIDATION", businessCode: "RETEST_SUBMIT_TOO_EARLY" });
  await expect(learning.insertObservation(fixture.scope, { ...input, retestId: otherRetestId })).rejects.toMatchObject({ code: "VALIDATION", message: "提交的延迟复测与当前学习会话不一致。" });
  expect((await attempts.get(fixture.scope, first.id))?.submittedAt).toBeNull();
  await fixture.sql`UPDATE opening_retest_activities SET not_before_at=clock_timestamp()-interval '1 minute' WHERE id=${retestId}`;
  const saved = await learning.insertObservation(fixture.scope, input);
  expect(saved).toMatchObject({ retestId, answer: input.answer, attemptId: first.id });
  const [stored] = await fixture.sql`SELECT retest_id,submitted_intent FROM opening_learning_observations WHERE id=${saved.id}`;
  expect(stored).toMatchObject({ retest_id: retestId, submitted_intent: { retestId: null } });
  expect(await fixture.sql`SELECT id FROM opening_jobs WHERE workspace_id=${fixture.scope.workspaceId} AND key=${`retest-scan:${f.courseId}:${saved.id}`}`).toHaveLength(0);
  await fixture.sql`UPDATE opening_retest_activities SET status='cancelled',not_before_at=clock_timestamp()+interval '1 day' WHERE id=${retestId}`;
  expect(await learning.insertObservation(fixture.scope, input)).toMatchObject({ id: saved.id, retestId, answer: input.answer });
  await expect(learning.insertObservation(fixture.scope, { ...input, retestId })).rejects.toMatchObject({ code: "CONFLICT", message: "observation clientKey payload conflict" });
  await expect(learning.insertObservation(fixture.scope, { ...input, attemptId: pending.id, problemId: pending.problemId, clientKey: randomUUID() })).rejects.toMatchObject({ code: "VALIDATION", message: "延迟复测不属于本课程、尚未接受或已结束。" });
});
it("replays the original submitted assistance after later help strengthens the effective exposure", async () => {
  const f = await seed(), lesson = await f.repo.create(fixture.scope, f.input);
  const attempts = createOpeningLearningAttemptRepository(fixture.sql), learning = createOpeningLearningRepository(fixture.sql);
  const attempt = await attempts.create(fixture.scope, { sessionId: lesson.sessionId, clientKey: randomUUID(), spanExercise: { sourceId: f.sourceId, problemId: "span-independent-3d", version: 1 } });
  const input: ObservationInput = { sessionId: lesson.sessionId, courseId: f.courseId, skillLabel: SPAN_SKILL_LABEL,
    sourceIds: [f.sourceId], attemptId: attempt.id, problemId: attempt.problemId, clientKey: randomUUID(),
    answer: JSON.stringify({ membership: "not_in_span" }), outcome: "unverified", assistance: "hinted", verdictSource: "self_report" };
  const saved = await learning.insertObservation(fixture.scope, input, { submittedAssistance: "hinted" });
  const strongerExposure = { ...input, assistance: "revealed" as const };
  expect(await learning.insertObservation(fixture.scope, strongerExposure, { submittedAssistance: "hinted" })).toMatchObject({ id: saved.id, assistance: saved.assistance, answer: input.answer });
  await expect(learning.insertObservation(fixture.scope, strongerExposure, { submittedAssistance: "revealed" })).rejects.toMatchObject({ code: "CONFLICT", message: "observation clientKey payload conflict" });
  await expect(learning.insertObservation(fixture.scope, { ...strongerExposure, answer: "changed original answer" }, { submittedAssistance: "hinted" })).rejects.toMatchObject({ code: "CONFLICT", message: "observation clientKey payload conflict" });
  const assistedAttempt = await attempts.create(fixture.scope, { sessionId: lesson.sessionId, clientKey: randomUUID(), spanExercise: { sourceId: f.sourceId, problemId: "span-independent-3d", version: 1 } });
  const assisted = await learning.insertObservation(fixture.scope, { ...strongerExposure, attemptId: assistedAttempt.id, problemId: assistedAttempt.problemId, clientKey: randomUUID() }, { submittedAssistance: "hinted" });
  expect(assisted.assistance).toBe("revealed");
  const [stored] = await fixture.sql`SELECT submitted_intent FROM opening_learning_observations WHERE id=${assisted.id}`;
  expect(stored?.submitted_intent.assistance).toBe("hinted");
});
it("keeps legacy span receipts on effective-assistance replay semantics across the lesson protocol upgrade", async () => {
  const f = await seed(), learning = createOpeningLearningRepository(fixture.sql), attempts = createOpeningLearningAttemptRepository(fixture.sql);
  const session = await learning.createSession(fixture.scope, { courseId: f.courseId, sourceIds: [f.sourceId], skillLabel: SPAN_SKILL_LABEL });
  const attempt = await attempts.create(fixture.scope, { sessionId: session.id, clientKey: randomUUID(), spanExercise: { sourceId: f.sourceId, problemId: "span-independent-3d", version: 1 } });
  const input: ObservationInput = { sessionId: session.id, courseId: f.courseId, skillLabel: SPAN_SKILL_LABEL,
    sourceIds: [f.sourceId], attemptId: attempt.id, problemId: attempt.problemId, clientKey: randomUUID(),
    answer: JSON.stringify({ membership: "not_in_span" }), outcome: "unverified", assistance: "hinted", verdictSource: "self_report" };
  // The old service stored its effective help, even if the user's original
  // choice was independent. The new optional raw choice cannot reinterpret it.
  const saved = await learning.insertObservation(fixture.scope, input);
  expect(await learning.insertObservation(fixture.scope, input, { submittedAssistance: "independent" })).toMatchObject({ id: saved.id, answer: input.answer, assistance: "hinted" });
  await expect(learning.insertObservation(fixture.scope, { ...input, answer: "changed answer" }, { submittedAssistance: "independent" })).rejects.toMatchObject({ code: "CONFLICT", message: "observation clientKey payload conflict" });
  await expect(learning.insertObservation(fixture.scope, { ...input, outcome: "correct" }, { submittedAssistance: "independent" })).rejects.toMatchObject({ code: "CONFLICT", message: "observation clientKey payload conflict" });
});
it("keeps completed activities readable while requiring a new request to start again", async () => {
  const f = await seed(), started = await f.repo.create(fixture.scope, f.input);
  const attempts = createOpeningLearningAttemptRepository(fixture.sql);
  const attemptInput = { sessionId: started.sessionId, clientKey: randomUUID(), spanExercise: { sourceId: f.sourceId, problemId: "span-independent-3d", version: 1 } };
  const attempt = await attempts.create(fixture.scope, attemptInput);
  const completed = await f.repo.save(fixture.scope, started.activityId, patch(started, { status: "completed" }));
  expect(await f.repo.latest(fixture.scope, f.courseId)).toBeNull();
  expect(await f.repo.create(fixture.scope, f.input)).toEqual(completed);
  expect((await attempts.create(fixture.scope, attemptInput)).id).toBe(attempt.id);
  expect((await attempts.get(fixture.scope, attempt.id))?.id).toBe(attempt.id);
  await expect(attempts.create(fixture.scope, { ...attemptInput, clientKey: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(f.repo.save(fixture.scope, completed.activityId, patch(started, { status: "active" }))).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(f.repo.save(fixture.scope, completed.activityId, patch(completed, { status: "active" }))).rejects.toMatchObject({ code: "CONFLICT" });
  const next = await f.repo.create(fixture.scope, { ...f.input, clientKey: randomUUID() });
  expect(next.activityId).not.toBe(completed.activityId);
  expect(await f.repo.get(fixture.scope, completed.activityId)).toEqual(completed);
});
it("restores only precise delivered hint levels from the owned shared session without releasing help", async () => {
  const f = await seed(), started = await f.repo.create(fixture.scope, f.input);
  const other = await f.repo.create(fixture.scope, { ...f.input, clientKey: randomUUID() });
  const attempts = createOpeningLearningAttemptRepository(fixture.sql), exposures = createOpeningStudyExposureRepository(fixture.sql);
  const issue = (sessionId = started.sessionId) => attempts.create(fixture.scope, { sessionId, clientKey: randomUUID(), spanExercise: { sourceId: f.sourceId, problemId: "span-independent-3d", version: 1 } });
  const first = await issue(), wrongPolicy = await issue(), mismatched = await issue(), anotherSession = await issue(other.sessionId);
  const hint = (attempt: LearningAttempt, level: number, overrides: Partial<OpeningStudyExposureInput> = {}): OpeningStudyExposureInput => ({
    releaseKey: `span-hint-v1:${attempt.id}:${level}`, sessionId: attempt.sessionId,
    contextAnchor: { attemptId: attempt.id, itemVersionId: attempt.itemVersionId, courseId: f.courseId, purpose: "learning_help" },
    origin: "assistant", supportDomain: "math", kind: "hint", level: "hinted", ...overrides,
  });
  const feedback = (attempt: LearningAttempt, supportDomain: OpeningStudyExposureInput["supportDomain"] = "unknown") => hint(attempt, 4, {
    releaseKey: `span-feedback:${attempt.id}`, origin: "history_solution", supportDomain, kind: "solution", level: "revealed",
    contextAnchor: { attemptId: attempt.id, itemVersionId: attempt.itemVersionId, courseId: f.courseId, purpose: "history_solution" },
  });
  await exposures.deliver(fixture.scope, hint(first, 3));
  await exposures.deliver(fixture.scope, hint(first, 1));
  await exposures.deliver(fixture.scope, hint(first, 1));
  await exposures.generate(fixture.scope, hint(first, 2));
  await exposures.deliver(fixture.scope, feedback(first));
  await exposures.deliver(fixture.scope, hint(first, 3, { releaseKey: `span-hint-v1:${first.id}:3:retry` }));
  await exposures.deliver(fixture.scope, hint(wrongPolicy, 1, { supportDomain: "language" }));
  await exposures.deliver(fixture.scope, hint(wrongPolicy, 2, { origin: "material_excerpt" }));
  await exposures.deliver(fixture.scope, hint(wrongPolicy, 3, { supportDomain: "unknown" }));
  await exposures.deliver(fixture.scope, feedback(wrongPolicy, "language"));
  const badCourse = await exposures.deliver(fixture.scope, hint(mismatched, 1));
  const badSession = await exposures.deliver(fixture.scope, hint(mismatched, 2));
  const badOwner = await exposures.deliver(fixture.scope, hint(mismatched, 3));
  const badActivity = await exposures.deliver(fixture.scope, feedback(mismatched));
  await fixture.sql`UPDATE opening_help_exposures SET course_id=${randomUUID()} WHERE id=${badCourse.id}`;
  await fixture.sql`UPDATE opening_help_exposures SET session_id=${other.sessionId} WHERE id=${badSession.id}`;
  await fixture.sql`UPDATE opening_help_exposures SET owner_user_id=${fixture.otherScope.ownerUserId} WHERE id=${badOwner.id}`;
  await fixture.sql`UPDATE opening_help_exposures SET activity_id=${other.activityId} WHERE id=${badActivity.id}`;
  await exposures.deliver(fixture.scope, hint(anotherSession, 2));
  await f.repo.save(fixture.scope, started.activityId, patch(started, { status: "paused" }));
  const before = await fixture.sql`SELECT id,delivered,released_at FROM opening_help_exposures WHERE workspace_id=${fixture.scope.workspaceId} ORDER BY id`;
  expect(await f.repo.deliveredHintLevels(fixture.scope, started.activityId)).toEqual({ [first.id]: [1, 3, 4] });
  expect(await f.repo.deliveredHintLevels(fixture.scope, other.activityId)).toEqual({ [anotherSession.id]: [2] });
  expect(await f.repo.deliveredHintLevels(fixture.otherScope, started.activityId)).toEqual({});
  expect(await f.repo.deliveredHintLevels(fixture.scope, randomUUID())).toEqual({});
  expect(await fixture.sql`SELECT id,delivered,released_at FROM opening_help_exposures WHERE workspace_id=${fixture.scope.workspaceId} ORDER BY id`).toEqual(before);
}, 45_000);
