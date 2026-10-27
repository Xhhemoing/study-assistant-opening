import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createOpeningLearningRepository, createOpeningSpanSessionRepository, createWorkspacePreferencesRepository } from "@aistudy/database";
import { DEFAULT_OPENING_ADAPTIVE_PREFS } from "@aistudy/contracts";
import { nextLearningStep, SPAN_SKILL_LABEL } from "@aistudy/domain";
import { createOpeningSpanTutorContextRepository } from "../../packages/database/src/repositories/opening-span-tutor-context";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { backupRows } from "./opening-backup-records-fixture";
import { createSpanReservedService } from "../../apps/web/src/features/opening/teaching/span/reserved-service";

let fixture: OpeningFixture;
beforeEach(async () => { fixture = await createOpeningFixture(); });
afterEach(async () => { await fixture?.close(); });
async function seed() {
  const { sql, scope } = fixture, rows = backupRows(sql, scope), courseId = randomUUID(), sourceId = await rows.source();
  await rows.chunk(sourceId);
  await sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES (${courseId},${scope.workspaceId},'Span tutor',${courseId})`;
  await sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility)
    VALUES (${scope.workspaceId},${courseId},'source',${sourceId},'core','course')`;
  await createWorkspacePreferencesRepository(sql).setLearningPreferences(scope,
    { assessmentEnabled: true, retestSuggestionsEnabled: true, automaticRemindersEnabled: false });
  const at = new Date().toISOString(), grant = { enabled: true, dailyMinutes: 180, revision: 1, confirmedAt: at, updatedAt: at, expiresOn: null };
  await sql`UPDATE workspace_preferences SET adaptive_planning=jsonb_set(COALESCE(adaptive_planning,${sql.json(DEFAULT_OPENING_ADAPTIVE_PREFS)}::jsonb),
    '{spanTutorGrants}',COALESCE(adaptive_planning->'spanTutorGrants','{}'::jsonb) || ${sql.json({ [courseId]: grant })}::jsonb)
    WHERE workspace_id=${scope.workspaceId}`;
  const request = { courseId, sourceIds: [sourceId], sourceVersions: { [sourceId]: 1 }, question: "继续学习" };
  return { courseId, sourceId, request, repo: createOpeningSpanTutorContextRepository(sql) };
}
it("creates a real span activity and resumes it without charging or creating another", async () => {
  const f = await seed(), context = (await f.repo.read(fixture.scope, f.request))!;
  expect(context).toMatchObject({ courseId: f.courseId, grantRevision: 1, decisionInput: { status: "unobserved" } });
  const input = { context, decision: nextLearningStep(context.decisionInput), operationId: `tutor-next:${randomUUID()}` };
  const one = await f.repo.execute(fixture.scope, input);
  await f.repo.assertCurrent(fixture.scope, context);
  expect(one).toMatchObject({ courseId: f.courseId, moveId: "self_study-reserved", status: "active" });
  const resumed = (await f.repo.read(fixture.scope, f.request))!;
  expect(resumed.resumeSession?.activityId).toBe(one.activityId);
  expect((await f.repo.execute(fixture.scope, { ...input, context: resumed })).activityId).toBe(one.activityId);
  const activities = await fixture.sql`SELECT id FROM opening_teaching_activities WHERE course_id=${f.courseId}`;
  expect(activities.map(row => row.id)).toEqual([one.activityId]);
});
it.each(["incorrect", "assisted", "independent"] as const)("uses real %s evidence to choose correction or an unseen follow-up", async branch => {
  const f = await seed(), lessons = createOpeningSpanSessionRepository(fixture.sql);
  const intent = { purpose: "self_study" as const, timeBudgetMinutes: 20, language: "zh" as const, pace: "normal" as const, continuous: true, selfReportedFatigue: "unknown" as const };
  const lesson = await lessons.create(fixture.scope, { courseId: f.courseId, sourceIds: [f.sourceId], intent, clientKey: randomUUID() });
  const attempt = await createSpanReservedService(fixture.sql).issue(fixture.scope,
    { sessionId: lesson.sessionId, sourceId: f.sourceId, clientKey: randomUUID(), mode: "self_study" });
  const problem = attempt.spanExercise!;
  expect(problem.id).toBe("span-reserved-fraction");
  const answer = branch === "incorrect" ? JSON.stringify({ membership: "not_in_span" }) : JSON.stringify({ membership: "in_span", coefficients: ["1/2", "-2/3"],
    equation: { vectors: problem.vectors, target: problem.target }, coordinateChecks: problem.target });
  await createOpeningLearningRepository(fixture.sql).insertObservation(fixture.scope, { sessionId: lesson.sessionId, courseId: f.courseId,
    skillLabel: SPAN_SKILL_LABEL, sourceIds: [f.sourceId], attemptId: attempt.id, problemId: attempt.problemId, clientKey: randomUUID(),
    answer, assistance: branch === "assisted" ? "hinted" : "independent", outcome: "unverified", verdictSource: "self_report" });
  await lessons.save(fixture.scope, lesson.activityId, { expectedRevision: lesson.revision, intent, moveId: "self-independent", status: "completed" });
  const context = (await f.repo.read(fixture.scope, f.request))!, decision = nextLearningStep(context.decisionInput);
  expect(decision.activityKind).toBe(branch === "incorrect" ? "targeted_explain" : branch === "assisted" ? "reduced_help_practice" : "transfer_check");
  const next = await f.repo.execute(fixture.scope, { context, decision, operationId: `tutor-next:${randomUUID()}` });
  expect(next.activityId).not.toBe(lesson.activityId);
  expect(next.moveId).toBe(branch === "incorrect" ? "self-example" : "self_study-reserved");
});
it("does not start or resume after the account is disabled between reading and executing", async () => {
  const f = await seed(), context = (await f.repo.read(fixture.scope, f.request))!;
  await createWorkspacePreferencesRepository(fixture.sql).setLearningPreferences(fixture.scope,
    { assessmentEnabled: false, retestSuggestionsEnabled: false, automaticRemindersEnabled: false });
  await expect(f.repo.execute(fixture.scope, { context, decision: nextLearningStep(context.decisionInput), operationId: `tutor-next:${randomUUID()}` })).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await f.repo.read(fixture.scope, f.request)).toBeNull();
  expect(await fixture.sql`SELECT id FROM opening_teaching_activities WHERE course_id=${f.courseId}`).toHaveLength(0);
});
it("rejects a source version change before creating the selected activity", async () => {
  const f = await seed(), context = (await f.repo.read(fixture.scope, f.request))!;
  await fixture.sql`UPDATE opening_sources SET version=version+1 WHERE id=${f.sourceId}`;
  await expect(f.repo.execute(fixture.scope, { context, decision: nextLearningStep(context.decisionInput), operationId: `tutor-next:${randomUUID()}` })).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await fixture.sql`SELECT id FROM opening_teaching_activities WHERE course_id=${f.courseId}`).toHaveLength(0);
});
it("rejects an old resume projection after another page changed the activity", async () => {
  const f = await seed(), initial = (await f.repo.read(fixture.scope, f.request))!;
  const session = await f.repo.execute(fixture.scope, { context: initial, decision: nextLearningStep(initial.decisionInput), operationId: `tutor-next:${randomUUID()}` });
  const context = (await f.repo.read(fixture.scope, f.request))!;
  await createOpeningSpanSessionRepository(fixture.sql).save(fixture.scope, session.activityId,
    { expectedRevision: session.revision, intent: session.intent, moveId: session.moveId, status: "paused" });
  await expect(f.repo.assertCurrent(fixture.scope, context)).rejects.toMatchObject({ code: "CONFLICT" });
});
it("returns a paused reserved lesson without issuing an attempt or overriding the pause", async () => {
  const f = await seed(), lessons = createOpeningSpanSessionRepository(fixture.sql);
  const intent = { purpose: "self_study" as const, timeBudgetMinutes: 20, language: "zh" as const, pace: "normal" as const, continuous: true, selfReportedFatigue: "unknown" as const };
  const started = await lessons.create(fixture.scope, { courseId: f.courseId, sourceIds: [f.sourceId], intent, clientKey: randomUUID() });
  const paused = await lessons.save(fixture.scope, started.activityId,
    { expectedRevision: started.revision, intent, moveId: "self_study-reserved", status: "paused" });
  const context = (await f.repo.read(fixture.scope, f.request))!;
  expect(context.resumeSession).toEqual(paused);
  expect(context.needsReservedIssue).not.toBe(true);
  expect(await f.repo.execute(fixture.scope, { context, decision: nextLearningStep(context.decisionInput), operationId: `tutor-next:${randomUUID()}` })).toEqual(paused);
  expect(await fixture.sql`SELECT id FROM opening_learning_attempts WHERE activity_id=${paused.activityId}`).toHaveLength(0);
});
