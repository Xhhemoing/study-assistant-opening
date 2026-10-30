import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createOpeningLearningRepository, createOpeningSpanSessionRepository, createWorkspacePreferencesRepository } from "@aistudy/database";
import { DEFAULT_OPENING_ADAPTIVE_PREFS } from "@aistudy/contracts";
import { captureNextLearningStep, DEFAULT_STUDY_SESSION_INTENT, nextLearningStep, SPAN_SKILL_LABEL } from "@aistudy/domain";
import { createOpeningSpanTutorContextRepository } from "../../packages/database/src/repositories/opening-span-tutor-context";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { backupRows } from "./opening-backup-records-fixture";
import { createSpanReservedService } from "../../apps/web/src/features/opening/teaching/span/reserved-service";
import { createSpanPresentationService } from "../../apps/web/src/features/opening/teaching/span/presentation-service";
import { createSpanDelayedRetestService } from "../../apps/web/src/features/opening/teaching/span/delayed-retest-service";

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
it("prepares a real reserved question after worked teaching and preserves both identities on resume", async () => {
  const f = await seed(), lessons = createOpeningSpanSessionRepository(fixture.sql);
  const intent = { purpose: "self_study" as const, timeBudgetMinutes: 20, language: "zh" as const, pace: "normal" as const, continuous: true, selfReportedFatigue: "unknown" as const };
  const lesson = await lessons.create(fixture.scope, { courseId: f.courseId, sourceIds: [f.sourceId], intent, clientKey: randomUUID() });
  const presenter = createSpanPresentationService(fixture.sql);
  const workedRequest = { sessionId: lesson.sessionId, courseId: f.courseId, sourceId: f.sourceId, kind: "worked", clientKey: randomUUID() };
  const worked = await presenter.read(fixture.scope, workedRequest);
  await lessons.save(fixture.scope, lesson.activityId, { expectedRevision: lesson.revision, intent, moveId: "self_study-reserved", status: "active" });
  const context = (await f.repo.read(fixture.scope, f.request))!;
  expect(context.needsReservedIssue).toBe(true);
  const resumed = await f.repo.execute(fixture.scope, { context, decision: nextLearningStep(context.decisionInput), operationId: randomUUID() });
  expect(resumed.activityId).toBe(lesson.activityId);
  const attempts = await fixture.sql`SELECT create_intent FROM opening_learning_attempts WHERE session_id=${lesson.sessionId}`;
  expect(attempts).toHaveLength(2);
  expect(attempts.map(row => row.create_intent.spanExercise.problemId)).toContain(worked.problem.id);
  expect(attempts.some(row => row.create_intent.spanExercise.problemId === "span-reserved-fraction")).toBe(true);
  expect((await f.repo.read(fixture.scope, f.request))!.needsReservedIssue).not.toBe(true);
  expect(await presenter.read(fixture.scope, workedRequest)).toEqual(worked);
});
it("captures standard decisions before execution and replays the original operation without rewriting history", async () => {
  const f = await seed(), context = (await f.repo.read(fixture.scope, f.request))!;
  const originalInput = structuredClone(context.decisionInput);
  const state = await import("../../packages/database/src/repositories/opening-learner-state-read");
  const before = await state.createOpeningLearnerStateService(fixture.sql).read(fixture.scope, { courseId: f.courseId });
  const input = { context, decision: nextLearningStep(context.decisionInput), operationId: `tutor-next:${randomUUID()}` };
  const session = await f.repo.execute(fixture.scope, input);
  const { createOpeningLearningDecisionsRepository } = await import("@aistudy/database");
  const decisions = createOpeningLearningDecisionsRepository(fixture.sql);
  const receipts = await decisions.list(fixture.scope, { layer: "activity", targetId: session.activityId });
  expect(receipts).toHaveLength(1);
  const receipt = receipts[0]!;
  expect(await decisions.get(fixture.scope, receipt.id)).toEqual(receipt);
  expect(receipt.stateVersion).toBe(before.stateVersion);
  expect(receipt.policyVersion).toBe("next-learning-step-2/span-tutor-execution-2");
  expect(JSON.parse(receipt.intentVersion)).toMatchObject({ decisionInput: originalInput, ruleDecision: input.decision,
    execution: { kind: "create", moveId: "self_study-reserved", problemId: "span-reserved-fraction" } });
  expect(receipt.parentDecisionId).toBeTruthy();
  await createOpeningSpanSessionRepository(fixture.sql).save(fixture.scope, session.activityId,
    { expectedRevision: session.revision, intent: session.intent, moveId: session.moveId, status: "paused" });
  await createWorkspacePreferencesRepository(fixture.sql).setLearningPreferences(fixture.scope,
    { assessmentEnabled: false, retestSuggestionsEnabled: false, automaticRemindersEnabled: false });
  expect((await f.repo.execute(fixture.scope, input)).activityId).toBe(session.activityId);
  expect(await decisions.list(fixture.scope, { layer: "activity", targetId: session.activityId })).toEqual(receipts);
});
it("keeps source version zero and does not invent decisions for a legacy resume", async () => {
  const f = await seed();
  await fixture.sql`UPDATE opening_sources SET version=0 WHERE id=${f.sourceId}`;
  await fixture.sql`UPDATE opening_source_chunks SET source_version=0 WHERE source_id=${f.sourceId}`;
  const request = { ...f.request, sourceVersions: { [f.sourceId]: 0 } };
  const context = (await f.repo.read(fixture.scope, request))!;
  const operationId = `tutor-next:${randomUUID()}`;
  const session = await f.repo.execute(fixture.scope, { context, decision: nextLearningStep(context.decisionInput), operationId });
  const receipts = await fixture.sql`SELECT receipt FROM opening_learning_decisions WHERE target_id=${session.activityId}`;
  expect(receipts[0]!.receipt.sourceVersions[f.sourceId]).toEqual([0]);
  await fixture.sql`DELETE FROM opening_learning_decisions WHERE workspace_id=${fixture.scope.workspaceId}`;
  const resume = (await f.repo.read(fixture.scope, request))!;
  expect(resume.historicalDecision).toBeNull();
  await f.repo.execute(fixture.scope, { context: resume, decision: nextLearningStep(resume.decisionInput), operationId });
  expect(await fixture.sql`SELECT id FROM opening_learning_decisions WHERE workspace_id=${fixture.scope.workspaceId}`).toHaveLength(0);
});
it("rolls back the real session, attempt and budget if standard receipt persistence fails", async () => {
  const f = await seed(), context = (await f.repo.read(fixture.scope, f.request))!;
  const operationId = `tutor-next:${randomUUID()}`;
  // The activity creates successfully; only the canonical decision insert is faulted.
  const failing = new Proxy(fixture.sql, { get(target, key, receiver) {
    if (key === "begin") return (run: (tx: import("postgres").TransactionSql) => Promise<unknown>) => target.begin(async tx => {
      const wrapped = new Proxy(tx, { apply(query, thisArg, args: unknown[]) {
        const text = (args[0] as TemplateStringsArray).join("?");
        if (text.includes("INSERT INTO opening_learning_decisions")) throw new Error("receipt write failed");
        return Reflect.apply(query, thisArg, args);
      } });
      return run(wrapped);
    });
    return Reflect.get(target, key, receiver);
  } });
  await expect(createOpeningSpanTutorContextRepository(failing).execute(fixture.scope,
    { context, decision: nextLearningStep(context.decisionInput), operationId })).rejects.toThrow("receipt write failed");
  expect(await fixture.sql`SELECT id FROM opening_teaching_activities WHERE course_id=${f.courseId}`).toHaveLength(0);
  expect(await fixture.sql`SELECT id FROM opening_learning_sessions WHERE course_id=${f.courseId}`).toHaveLength(0);
  expect(await fixture.sql`SELECT id FROM opening_learning_attempts WHERE course_id=${f.courseId}`).toHaveLength(0);
  expect(await fixture.sql`SELECT id FROM opening_teaching_activities WHERE course_id=${f.courseId} AND goal_json ? 'tutorBudget'`).toHaveLength(0);
});
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
it("executes explicit new learning and replays the same phase, source and action", async () => {
  const f = await seed(), operationId = randomUUID();
  const request = { ...f.request, question: "完全不会，先学", operationId };
  const context = (await f.repo.read(fixture.scope, request))!;
  expect(context).not.toBeNull();
  await f.repo.assertCurrent(fixture.scope, context);
  const decision = nextLearningStep(context.decisionInput);
  expect(decision).toMatchObject({ phase: "new_learning", phaseSource: "explicit", activityKind: "full_explain" });
  const session = await f.repo.execute(fixture.scope, { context, decision, operationId });
  expect(session.moveId).toBe("self-example");
  const replay = (await f.repo.read(fixture.scope, request))!;
  expect(replay.historicalDecision).toEqual(decision);
  expect((await f.repo.execute(fixture.scope, { context: replay, decision, operationId })).activityId).toBe(session.activityId);
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
  expect(next.moveId).toBe(branch === "incorrect" ? "self-example" : branch === "assisted" ? "self-faded" : "self_study-reserved");
});
it.each(["先学", "先巩固", "继续学习"])("executes %s beside a legal due retest and preserves its real action on resume", async question => {
  const f = await seed(), lessons = createOpeningSpanSessionRepository(fixture.sql);
  const baseline = await lessons.create(fixture.scope, { courseId: f.courseId, sourceIds: [f.sourceId], intent: DEFAULT_STUDY_SESSION_INTENT, clientKey: randomUUID() });
  const attempt = await createSpanReservedService(fixture.sql).issue(fixture.scope, { sessionId: baseline.sessionId, sourceId: f.sourceId, mode: "self_study", clientKey: randomUUID() });
  const observation = await createOpeningLearningRepository(fixture.sql).insertObservation(fixture.scope, { sessionId: baseline.sessionId, courseId: f.courseId,
    skillLabel: SPAN_SKILL_LABEL, sourceIds: [f.sourceId], attemptId: attempt.id, problemId: attempt.problemId, clientKey: randomUUID(),
    answer: JSON.stringify({ membership: "not_in_span" }), assistance: "independent", outcome: "unverified", verdictSource: "self_report" });
  const due = await createSpanDelayedRetestService(fixture.sql).schedule(fixture.scope, { observationId: observation.id, clientKey: randomUUID() });
  await fixture.sql`UPDATE opening_retest_activities SET recommended_at=now()-interval '1 minute',not_before_at=now()-interval '1 minute',scheduled_start_at=now()-interval '1 minute' WHERE id=${due.activityId}`;
  await lessons.save(fixture.scope, baseline.activityId, { expectedRevision: baseline.revision, intent: baseline.intent, moveId: baseline.moveId, status: "completed" });
  const retestBefore = await fixture.sql`SELECT * FROM opening_retest_activities WHERE id=${due.activityId}`;
  const operationId = randomUUID(), context = (await f.repo.read(fixture.scope, { ...f.request, question }))!;
  await f.repo.assertCurrent(fixture.scope, context);
  const decision = nextLearningStep(context.decisionInput), capture = captureNextLearningStep(context.decisionInput);
  expect(capture.decision).toEqual(decision);
  const session = await f.repo.execute(fixture.scope, { context, decision, operationId });
  await f.repo.assertCurrent(fixture.scope, context);
  expect(session.moveId).toBe(question === "先学" ? "self-example" : question === "先巩固" ? "self-faded" : "self_study-reserved");
  expect(session.retestId).toBe(question === "继续学习" ? due.activityId : null);
  const issued = await fixture.sql`SELECT create_intent FROM opening_learning_attempts WHERE session_id=${session.sessionId}`;
  if (question === "继续学习") expect(issued[0]!.create_intent.spanExercise.problemId).toContain("generated-retest-");
  else { expect(issued).toHaveLength(0); expect(await fixture.sql`SELECT * FROM opening_retest_activities WHERE id=${due.activityId}`).toEqual(retestBefore); }
  const [receipt] = await fixture.sql`SELECT receipt FROM opening_learning_decisions WHERE target_id=${session.activityId}`;
  expect(JSON.parse(receipt!.receipt.intentVersion).ruleDecision).toEqual(decision);
  expect(receipt!.receipt.candidates.filter((candidate: { action: string }) => candidate.action.startsWith("rule:")))
    .toEqual(capture.candidates.map(candidate => ({ ...candidate, action: `rule:${candidate.action}`, eligible: false,
      reasonCodes: [...candidate.reasonCodes, candidate.eligible ? "rule_recommendation_mapped_to_execution" : "rule_branch_not_selected"] })));
  const before = await fixture.sql`SELECT * FROM opening_teaching_activities WHERE id=${session.activityId}`;
  const resume = (await f.repo.read(fixture.scope, f.request))!;
  await f.repo.assertCurrent(fixture.scope, resume);
  expect(await f.repo.execute(fixture.scope, { context: resume, decision: nextLearningStep(resume.decisionInput), operationId: randomUUID() })).toEqual(session);
  expect(await fixture.sql`SELECT * FROM opening_teaching_activities WHERE id=${session.activityId}`).toEqual(before);
});
it("applies explicit phases to an existing ordinary lesson without charging again", async () => {
  const f = await seed(), lessons = createOpeningSpanSessionRepository(fixture.sql);
  const session = await lessons.create(fixture.scope, { courseId: f.courseId, sourceIds: [f.sourceId], intent: DEFAULT_STUDY_SESSION_INTENT, clientKey: randomUUID() });
  for (const [question, moveId] of [["完全不会，先学", "self-example"], ["先巩固", "self-faded"]]) {
    const context = (await f.repo.read(fixture.scope, { ...f.request, question: question! }))!;
    expect(context.needsIntentUpdate).toBe(true);
    await f.repo.assertCurrent(fixture.scope, context);
    const updated = await f.repo.execute(fixture.scope, { context, decision: nextLearningStep(context.decisionInput), operationId: randomUUID() });
    expect(updated).toMatchObject({ activityId: session.activityId, moveId });
    await f.repo.assertCurrent(fixture.scope, context);
  }
  expect(await fixture.sql`SELECT id FROM opening_teaching_activities WHERE course_id=${f.courseId} AND goal_json ? 'tutorBudget'`).toHaveLength(0);
});
it("does not start or resume after the account is disabled between reading and executing", async () => {
  const f = await seed(), context = (await f.repo.read(fixture.scope, f.request))!;
  await createWorkspacePreferencesRepository(fixture.sql).setLearningPreferences(fixture.scope,
    { assessmentEnabled: false, retestSuggestionsEnabled: false, automaticRemindersEnabled: false });
  await expect(f.repo.execute(fixture.scope, { context, decision: nextLearningStep(context.decisionInput), operationId: `tutor-next:${randomUUID()}` })).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await f.repo.read(fixture.scope, f.request)).toBeNull();
  expect(await fixture.sql`SELECT id FROM opening_teaching_activities WHERE course_id=${f.courseId}`).toHaveLength(0);
});
it("rejects an unexecuted old grant revision while recovering a committed original receipt after withdrawal", async () => {
  const f = await seed(), context = (await f.repo.read(fixture.scope, f.request))!;
  const operationId = `tutor-next:${randomUUID()}`;
  const input = { context, decision: nextLearningStep(context.decisionInput), operationId };
  const saved = await f.repo.execute(fixture.scope, input);
  const { createOpeningAdaptivePrefsRepository } = await import("@aistudy/database");
  await createOpeningAdaptivePrefsRepository(fixture.sql).patch(fixture.scope, { spanTutorGrant: {
    courseId: f.courseId, enabled: false, dailyMinutes: 180, expiresOn: null, expectedRevision: 1,
  } });
  await expect(f.repo.execute(fixture.scope, { ...input, operationId: `tutor-next:${randomUUID()}` })).rejects.toMatchObject({ code: "CONFLICT" });
  expect((await f.repo.execute(fixture.scope, input)).activityId).toBe(saved.activityId);
  expect(await fixture.sql`SELECT id FROM opening_teaching_activities WHERE course_id=${f.courseId}`).toHaveLength(1);
  expect(await fixture.sql`SELECT id FROM opening_learning_decisions WHERE target_id=${saved.activityId}`).toHaveLength(1);
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
