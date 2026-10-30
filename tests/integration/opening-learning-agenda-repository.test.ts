import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createOpeningLearningAgendaRepository, createOpeningSpanTutorContextRepository, createOpeningSpanSessionRepository, createWorkspacePreferencesRepository, createOpeningLongTermPlanningRepository, createOpeningLearningRepository } from "@aistudy/database";
import { DEFAULT_OPENING_ADAPTIVE_PREFS } from "@aistudy/contracts";
import { nextLearningStep, SPAN_REQUIREMENT_KEY, SPAN_SKILL_LABEL } from "@aistudy/domain";
import { createStudyIntentService } from "../../apps/web/src/features/opening/teaching/span/intent-service";
import { createSpanTutorNextAction } from "../../apps/worker/src/runtime/span-tutor-next-action";
import { prepareTutorNextAction } from "../../apps/worker/src/jobs/tutor-next-action";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";
import { createSpanLessonSessionService } from "../../apps/web/src/features/opening/teaching/span/lesson-session-service";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { backupRows } from "./opening-backup-records-fixture";
let fixture: OpeningFixture;
beforeEach(async () => { fixture = await createOpeningFixture(); });
afterEach(async () => { await fixture?.close(); });
async function seed() {
  const { sql, scope } = fixture, rows = backupRows(sql, scope), courseId = randomUUID(), sourceId = await rows.source();
  await rows.chunk(sourceId);
  await sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES (${courseId},${scope.workspaceId},'Agenda',${courseId})`;
  await sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility) VALUES (${scope.workspaceId},${courseId},'source',${sourceId},'core','course')`;
  await createWorkspacePreferencesRepository(sql).setLearningPreferences(scope, { assessmentEnabled: true, retestSuggestionsEnabled: true, automaticRemindersEnabled: false });
  const at = new Date().toISOString(), grant = { enabled: true, dailyMinutes: 180, revision: 1, confirmedAt: at, updatedAt: at, expiresOn: null };
  await sql`UPDATE workspace_preferences SET adaptive_planning=jsonb_set(COALESCE(adaptive_planning,${sql.json(DEFAULT_OPENING_ADAPTIVE_PREFS)}::jsonb),'{spanTutorGrants}',COALESCE(adaptive_planning->'spanTutorGrants','{}'::jsonb) || ${sql.json({ [courseId]: grant })}::jsonb) WHERE workspace_id=${scope.workspaceId}`;
  const request = { courseId, sourceIds: [sourceId], sourceVersions: { [sourceId]: 1 }, question: "继续学习" };
  const repo = createOpeningSpanTutorContextRepository(sql), context = (await repo.read(scope, request))!;
  const operationId = `agenda:${randomUUID()}`;
  const lesson = await repo.execute(scope, { context, decision: nextLearningStep(context.decisionInput), operationId });
  return { courseId, sourceId, lesson, request, operationId };
}
it("reconstructs the same activity, item, parent and original budget across real readers and retry keys without writes", async () => {
  const f = await seed(), { sql, scope } = fixture;
  const before = await sql`SELECT * FROM opening_teaching_activities WHERE id=${f.lesson.activityId}`;
  const agenda = (await createOpeningLearningAgendaRepository(sql).get(scope, f.courseId, f.lesson.activityId))!;
  expect(agenda).toMatchObject({ activityId: f.lesson.activityId, sessionId: f.lesson.sessionId, decisionCurrent: true, resumable: true, invalidationReasons: [], intent: f.lesson.intent });
  expect(agenda.itemVersionId).toBeTruthy(); expect(agenda.parentDecisionId).toBeTruthy();
  expect(agenda.budget).toEqual(before[0]!.goal_json.tutorBudget);
  const reopened = await createSpanLessonSessionService(sql).read(scope, f.courseId, f.lesson.activityId);
  expect(reopened?.agenda).toMatchObject({ activityId: agenda.activityId, itemVersionId: agenda.itemVersionId, parentDecisionId: agenda.parentDecisionId });
  const today = await createOpeningLongTermPlanningRepository(sql).read(scope);
  expect(today.recovery.agenda?.activityId).toBe(agenda.activityId);
  const retried = await createOpeningSpanTutorContextRepository(sql).read(scope, { ...f.request, operationId: f.operationId });
  expect(retried?.resumeSession?.activityId).toBe(agenda.activityId);
  expect(await sql`SELECT * FROM opening_teaching_activities WHERE id=${f.lesson.activityId}`).toEqual(before);
  expect(await sql`SELECT id FROM opening_learning_attempts WHERE activity_id=${f.lesson.activityId}`).toHaveLength(1);
});
it.each(["answer", "help"])("resumes the same question after normal %s without changing receipts or budget", async kind => {
  const f = await seed(), { sql, scope } = fixture;
  const [attempt] = await sql`SELECT * FROM opening_learning_attempts WHERE activity_id=${f.lesson.activityId}`;
  const learning = createOpeningLearningRepository(sql), rows = backupRows(sql, scope);
  await learning.insertObservation(scope, { sessionId: f.lesson.sessionId, courseId: f.courseId, skillLabel: SPAN_SKILL_LABEL,
    sourceIds: [f.sourceId], attemptId: String(attempt!.id), problemId: String(attempt!.problem_id), clientKey: randomUUID(),
    answer: JSON.stringify({ membership: "not_in_span" }), assistance: "independent", outcome: "unverified", verdictSource: "self_report" });
  if (kind === "help") {
    const turnId = await rows.turn(await rows.conversation(), [f.sourceId]);
    await sql`UPDATE opening_turns SET learning_session_id=${f.lesson.sessionId},attempt_id=${attempt!.id} WHERE id=${turnId}`;
    await learning.insertHelpExposure(scope, { id: randomUUID(), attemptId: String(attempt!.id), sessionId: f.lesson.sessionId,
      problemId: String(attempt!.problem_id), turnId, kind: "hint", level: "hinted", delivered: true });
  }
  const before = await sql`SELECT * FROM opening_teaching_activities WHERE id=${f.lesson.activityId}`;
  const receipts = await sql`SELECT * FROM opening_learning_decisions WHERE target_id=${f.lesson.activityId}`;
  const reopened = await createSpanLessonSessionService(sql).read(scope, f.courseId, f.lesson.activityId);
  expect(reopened.agenda).toMatchObject({ resumable: true, decisionCurrent: false, itemVersionId: attempt!.item_version_id,
    invalidationReasons: expect.arrayContaining(["state_changed"]), suggestion: { activityKind: "targeted_explain" } });
  if (kind === "help") expect(reopened.agenda?.help).toEqual({ delivered: true, level: "hinted" });
  expect((await createOpeningLongTermPlanningRepository(sql).read(scope)).recovery.agenda?.resumable).toBe(true);
  expect(await prepareTutorNextAction(createSpanTutorNextAction(sql), scope, { ...f.request, userTurnId: randomUUID(), operationId: randomUUID() }))
    .toMatchObject({ resumed: true, action: { activityId: f.lesson.activityId }, decision: { activityKind: "targeted_explain" } });
  expect(await sql`SELECT * FROM opening_teaching_activities WHERE id=${f.lesson.activityId}`).toEqual(before);
  expect(await sql`SELECT * FROM opening_learning_decisions WHERE target_id=${f.lesson.activityId}`).toEqual(receipts);
  expect(await sql`SELECT id FROM opening_learning_attempts WHERE activity_id=${f.lesson.activityId}`).toHaveLength(1);
});
it.each(["快一点", "没懂"])("revalidates real preference receipts for %s in their workspace scope", async text => {
  const f = await seed(), { sql, scope } = fixture;
  const other = await learningAttemptFixture(fixture), attempt = await other.start();
  await other.submit(attempt);
  const applied = await createStudyIntentService(sql).apply(scope, { sessionId: f.lesson.sessionId, clientKey: randomUUID(), change: { kind: "explicit_request", text } });
  expect(applied.activityDecision.policyVersion).toBe("span-teaching-v2");
  const receipts = await sql`SELECT * FROM opening_learning_decisions WHERE target_id=${f.lesson.activityId}`;
  expect((await createSpanLessonSessionService(sql).read(scope, f.courseId, f.lesson.activityId)).agenda)
    .toMatchObject({ resumable: true, decisionCurrent: true, invalidationReasons: [], intent: applied.event.intent });
  expect(await sql`SELECT * FROM opening_learning_decisions WHERE target_id=${f.lesson.activityId}`).toEqual(receipts);
});
it("prefers A3's current phase over the older intent event", async () => {
  const f = await seed(), { sql, scope } = fixture;
  const applied = await createStudyIntentService(sql).apply(scope, { sessionId: f.lesson.sessionId, clientKey: randomUUID(), change: { kind: "explicit_request", text: "快一点" } });
  const sessions = createOpeningSpanSessionRepository(sql), current = (await sessions.get(scope, f.lesson.activityId))!;
  await sessions.save(scope, current.activityId, { expectedRevision: current.revision, intent: current.intent, moveId: "self-example", status: "active" });
  const repo = createOpeningSpanTutorContextRepository(sql), context = (await repo.read(scope, { ...f.request, question: "先巩固" }))!;
  await repo.execute(scope, { context, decision: nextLearningStep(context.decisionInput), operationId: randomUUID() });
  expect((await createSpanLessonSessionService(sql).read(scope, f.courseId, f.lesson.activityId)).agenda)
    .toMatchObject({ resumable: true, decisionCurrent: true, intent: { learningPhase: "consolidate" } });
  expect(applied.event.intent.learningPhase).not.toBe("consolidate");
});
it("reads a legacy 1/1 receipt without rewriting it", async () => {
  const f = await seed(), { sql, scope } = fixture;
  await sql`UPDATE opening_learning_decisions SET receipt=jsonb_set(receipt,'{policyVersion}','"next-learning-step-1/span-tutor-execution-1"'::jsonb) WHERE target_id=${f.lesson.activityId}`;
  const before = await sql`SELECT * FROM opening_learning_decisions WHERE target_id=${f.lesson.activityId}`;
  expect(await createOpeningLearningAgendaRepository(sql).get(scope, f.courseId, f.lesson.activityId))
    .toMatchObject({ resumable: true, decisionCurrent: false, invalidationReasons: ["policy_changed"] });
  expect(await sql`SELECT * FROM opening_learning_decisions WHERE target_id=${f.lesson.activityId}`).toEqual(before);
});
it.each(["permission", "source", "completed"])("keeps the %s hard boundary closed", async kind => {
  const f = await seed(), { sql, scope } = fixture;
  if (kind === "permission") await createWorkspacePreferencesRepository(sql).setLearningPreferences(scope, { assessmentEnabled: false, retestSuggestionsEnabled: false, automaticRemindersEnabled: false });
  if (kind === "source") await sql`DELETE FROM course_asset_memberships WHERE course_id=${f.courseId}`;
  if (kind === "completed") await createOpeningSpanSessionRepository(sql).save(scope, f.lesson.activityId,
    { expectedRevision: f.lesson.revision, intent: f.lesson.intent, moveId: f.lesson.moveId, status: "completed" });
  expect(await createOpeningLearningAgendaRepository(sql).get(scope, f.courseId, f.lesson.activityId)).toMatchObject({ resumable: false });
});
it("isolates workspaces, courses, and two exact sessions", async () => {
  const f = await seed(), other = await seed(), repo = createOpeningLearningAgendaRepository(fixture.sql);
  expect(await repo.get(fixture.otherScope, f.courseId, f.lesson.activityId)).toBeNull();
  expect(await repo.get(fixture.scope, other.courseId, f.lesson.activityId)).toBeNull();
  const sessions = createOpeningSpanSessionRepository(fixture.sql);
  const second = await sessions.create(fixture.scope, { courseId: f.courseId, sourceIds: [f.sourceId], intent: f.lesson.intent, clientKey: randomUUID() });
  const first = await repo.get(fixture.scope, f.courseId, f.lesson.activityId);
  const next = await repo.get(fixture.scope, f.courseId, second.activityId);
  expect(first?.sessionId).toBe(f.lesson.sessionId); expect(next?.sessionId).toBe(second.sessionId);
  expect(first?.decisionId).toBeTruthy(); expect(next?.decisionId).toBeNull();
});
it.each(["source", "goal", "intent", "policy"])("invalidates %s changes with a fresh suggestion, preserving the receipt", async kind => {
  const f = await seed(), { sql, scope } = fixture;
  const receipts = await sql`SELECT * FROM opening_learning_decisions WHERE target_id=${f.lesson.activityId}`;
  if (kind === "source") await sql`UPDATE opening_sources SET version=version+1 WHERE id=${f.sourceId}`;
  if (kind === "goal") await sql`UPDATE workspace_preferences SET adaptive_planning=jsonb_set(adaptive_planning,ARRAY['spanTutorGrants',${f.courseId},'revision'],'2'::jsonb) WHERE workspace_id=${scope.workspaceId}`;
  if (kind === "intent") await sql`UPDATE opening_teaching_activities SET goal_json=jsonb_set(goal_json,'{sessionIntent,explanationStyle}','"full"'::jsonb) WHERE id=${f.lesson.activityId}`;
  if (kind === "policy") await sql`UPDATE opening_learning_decisions SET receipt=jsonb_set(receipt,'{policyVersion}','"old/span-tutor-execution-0"'::jsonb) WHERE target_id=${f.lesson.activityId}`;
  const agenda = await createOpeningLearningAgendaRepository(sql).get(scope, f.courseId, f.lesson.activityId);
  expect(agenda).toMatchObject({ decisionCurrent: false, resumable: ["intent", "policy"].includes(kind), suggestion: { activityKind: expect.any(String) } });
  expect(agenda?.invalidationReasons).toContain(`${kind}_changed`);
  if (kind !== "policy") expect(await sql`SELECT * FROM opening_learning_decisions WHERE target_id=${f.lesson.activityId}`).toEqual(receipts);
});
it.each(["cancelled", "deferred"])("keeps %s retests closed to recovery and creates nothing", async kind => {
  const f = await seed(), { sql, scope } = fixture, retestId = randomUUID();
  await sql`INSERT INTO opening_retest_activities(id,workspace_id,owner_user_id,course_id,skill_label,requirement_key,evidence_cycle_id,status,version,snoozed_until)
    VALUES (${retestId},${scope.workspaceId},${scope.ownerUserId},${f.courseId},${SPAN_SKILL_LABEL},${SPAN_REQUIREMENT_KEY},${randomUUID()},${kind === "cancelled" ? "cancelled" : "accepted"},2,${kind === "deferred" ? new Date(Date.now()+86400000) : null})`;
  await sql`UPDATE opening_teaching_activities SET checkpoint_json=jsonb_set(checkpoint_json,'{spanLesson,retestId}',${sql.json(retestId)}::jsonb) WHERE id=${f.lesson.activityId}`;
  const agenda = await createOpeningLearningAgendaRepository(sql).get(scope, f.courseId, f.lesson.activityId);
  expect(agenda).toMatchObject({ status: kind, resumable: false, pendingRetestId: retestId });
  expect(await sql`SELECT id FROM opening_teaching_activities WHERE course_id=${f.courseId}`).toHaveLength(1);
  expect(await sql`SELECT id FROM opening_learning_attempts WHERE activity_id=${f.lesson.activityId}`).toHaveLength(1);
});
