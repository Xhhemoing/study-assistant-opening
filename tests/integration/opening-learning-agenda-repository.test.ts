import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createOpeningLearningAgendaRepository, createOpeningSpanTutorContextRepository, createOpeningSpanSessionRepository, createWorkspacePreferencesRepository, createOpeningLongTermPlanningRepository, createOpeningLearningRepository } from "@aistudy/database";
import type { Sql } from "postgres";
import { readOpeningLearningAgenda } from "../../packages/database/src/repositories/opening-learning-agenda";
import { readOpeningCourseEvidence } from "../../packages/database/src/repositories/opening-learning-read";
import { createOpeningLearningAttemptRepository } from "@aistudy/database";
import { createSpanHintService } from "../../apps/web/src/features/opening/teaching/span/hint-service";
import { solveSpanProblem, toSnapshotEvidence } from "@aistudy/domain";
import { DEFAULT_OPENING_ADAPTIVE_PREFS } from "@aistudy/contracts";
import { nextLearningStep, SPAN_REQUIREMENT_KEY, SPAN_SKILL_LABEL } from "@aistudy/domain";
import { createStudyIntentService } from "../../apps/web/src/features/opening/teaching/span/intent-service";
import { createSpanTutorNextAction } from "../../apps/worker/src/runtime/span-tutor-next-action";
import { prepareTutorNextAction } from "../../apps/worker/src/jobs/tutor-next-action";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";
import { createSpanLessonSessionService } from "../../apps/web/src/features/opening/teaching/span/lesson-session-service";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { backupRows } from "./opening-backup-records-fixture";
import { createOpeningLearningGoalRepository } from "@aistudy/database";
import { createOpeningCourseRouteRepository } from "../../packages/database/src/repositories/opening-course-route";
import { readCourseRequirements, readCourseRouteObservations } from "../../packages/database/src/repositories/opening-course-route-read";
import { courseRouteDecisionInput } from "../../packages/database/src/repositories/opening-course-route-decision-input";
function sessionAgenda(result: Awaited<ReturnType<ReturnType<typeof createSpanLessonSessionService>["read"]>>) {
  return "agenda" in result ? result.agenda : undefined;
}
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
async function agendaEvidence(f: Awaited<ReturnType<typeof seed>>) {
  return fixture.sql.begin("isolation level repeatable read read only", async tx => {
    // The loader's nested transaction stays inside this exact snapshot.
    const db = new Proxy(tx, { get(target, key, receiver) {
      if (key === "begin") return (...args: unknown[]) => target.savepoint(nested =>
        (args.at(-1) as (value: typeof nested) => Promise<unknown>)(nested));
      return Reflect.get(target, key, receiver);
    } }) as unknown as Sql;
    const agenda = (await readOpeningLearningAgenda(tx, fixture.scope, f.courseId, f.lesson.activityId))!;
    const evidence = await readOpeningCourseEvidence(db, fixture.scope, f.courseId);
    const observations = toSnapshotEvidence(evidence, new Date(agenda.dataAsOf)).observations
      .filter(row => row.requirementKey === SPAN_REQUIREMENT_KEY)
      .sort((a, b) => Date.parse(b.attemptedAt) - Date.parse(a.attemptedAt) || b.id.localeCompare(a.id));
    const [source] = await tx`SELECT version FROM opening_sources WHERE id=${f.sourceId} AND workspace_id=${fixture.scope.workspaceId}`;
    const span = await createOpeningSpanTutorContextRepository(db).read(fixture.scope,
      { ...f.request, sourceVersions: { [f.sourceId]: Number(source!.version) } });
    return { agenda, observations, workerDecision: span ? nextLearningStep(span.decisionInput) : null };
  });
}
async function agendaAttempt(f: Awaited<ReturnType<typeof seed>>, options: { correct?: boolean; help?: boolean; assistance?: "independent" | "unknown" } = {}) {
  const { sql, scope } = fixture;
  const attempt = await createOpeningLearningAttemptRepository(sql).create(scope, { sessionId: f.lesson.sessionId, clientKey: randomUUID(),
    spanExercise: { sourceId: f.sourceId, problemId: options.correct ? "span-reserved-fraction" : "span-example-2d", version: 1 } });
  if (options.help) expect((await createSpanHintService(sql).read(scope, { attemptId: attempt.id, level: 1 })).exposureReceipt).toBeTruthy();
  let answer: unknown = { membership: "in_span", coefficients: ["999", "999"] };
  if (options.correct) {
    const problem = attempt.spanExercise!, solution = solveSpanProblem(problem);
    if (solution.kind !== "unique") throw new Error("fixture expects unique reserved problem");
    answer = { membership: "in_span", coefficients: solution.coefficients,
      equation: { vectors: problem.vectors, target: problem.target }, coordinateChecks: problem.target };
  }
  const observation = await createOpeningLearningRepository(sql).insertObservation(scope, { sessionId: f.lesson.sessionId,
    courseId: f.courseId, skillLabel: SPAN_SKILL_LABEL, sourceIds: [f.sourceId], attemptId: attempt.id, problemId: attempt.problemId,
    clientKey: randomUUID(), answer: JSON.stringify(answer), outcome: "unverified", assistance: options.assistance ?? "independent", verdictSource: "self_report" });
  expect(observation).toMatchObject({ outcome: options.correct ? "correct" : "incorrect", serverEvaluation: { evaluatorVersion: "span-exact-v1" } });
  return observation;
}
async function routeAgenda() {
  const f = await seed(), { sql, scope } = fixture;
  const goal = await createOpeningLearningGoalRepository(sql).create(scope, { clientKey: randomUUID(), courseIds: [f.courseId],
    title: "Agenda route", kind: "custom", targetDate: null, examDate: null, weeklyMinutes: 120, priority: 1,
    learningMode: "understand", successCriteria: "独立验证当前要求" });
  const binding = { id: randomUUID(), revision: 1, stableSkillId: randomUUID(), requirementKey: SPAN_REQUIREMENT_KEY };
  const route = createOpeningCourseRouteRepository(sql, { compilerEnabled: true });
  await route.confirm(scope, f.courseId, { expectedRevisions: [], confirmScope: true, requirements: [{ id: binding.id,
    stableSkillId: binding.stableSkillId, knowledgeNodeId: null, requirementKey: binding.requirementKey, title: SPAN_SKILL_LABEL,
    position: 0, mandatory: true, goalIds: [goal.id], prerequisiteIds: [], sourceRefs: [{ sourceId: f.sourceId, sourceVersion: 1 }],
    verification: { kind: "exact", status: "ready", exerciseKeys: ["span-reserved-fraction"], rubric: null, missingReasons: [] }, origin: "confirmed" }] });
  // Verification readiness is a server fixture fact, not trusted request input.
  await sql`UPDATE course_requirements SET verification=${sql.json({ kind: "exact", status: "ready", exerciseKeys: ["span-reserved-fraction"], rubric: null, missingReasons: [] })}
    WHERE id=${binding.id} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
  const result = await route.start(scope, f.courseId, { goalId: goal.id, expectedGoalRevision: 1, requirementId: binding.id,
    expectedRequirementRevision: 1, clientKey: randomUUID(), minutes: 20 });
  if (result.kind !== "ready") throw new Error(`route fixture: ${result.kind}`);
  const learning = createOpeningLearningRepository(sql), activityId = result.activity.id;
  const session = await learning.createSession(scope, { activityId, courseId: f.courseId, skillLabel: SPAN_SKILL_LABEL, sourceIds: [f.sourceId] });
  const observe = async (identity: typeof binding | null = binding, correct = true) => {
    const attempt = await createOpeningLearningAttemptRepository(sql).create(scope, { sessionId: session.id, clientKey: randomUUID(),
      spanExercise: { sourceId: f.sourceId, problemId: "span-reserved-fraction", version: 1 } });
    if (identity) await sql`UPDATE opening_learning_item_versions SET evaluation_spec=evaluation_spec || ${sql.json({ courseRequirement: identity })}::jsonb
      WHERE id=${attempt.itemVersionId!} AND workspace_id=${scope.workspaceId}`;
    const problem = attempt.spanExercise!, solution = solveSpanProblem(problem);
    if (solution.kind !== "unique") throw new Error("fixture requires unique span problem");
    return learning.insertObservation(scope, { sessionId: session.id, attemptId: attempt.id, courseId: f.courseId,
      skillLabel: SPAN_SKILL_LABEL, sourceIds: [f.sourceId], problemId: attempt.problemId, clientKey: randomUUID(),
      answer: JSON.stringify({ membership: "in_span", coefficients: correct ? solution.coefficients : ["999", "999"],
        equation: { vectors: problem.vectors, target: problem.target }, coordinateChecks: problem.target }),
      outcome: "unverified", assistance: "independent", verdictSource: "self_report" });
  };
  const read = () => sql.begin("isolation level repeatable read read only", async tx => {
    const agenda = await readOpeningLearningAgenda(tx, scope, f.courseId, activityId);
    const requirement = (await readCourseRequirements(tx, scope, f.courseId)).find(row => row.id === binding.id);
    const evidence = await readCourseRouteObservations(tx, scope, f.courseId, false);
    return { agenda, projected: evidence.projected, canonical: requirement ? nextLearningStep(courseRouteDecisionInput(requirement, evidence.projected)) : null };
  });
  return { ...f, activityId, binding, observe, read };
}
it.each(["id", "revision", "stableSkillId", "requirementKey", "unbound"] as const)("route agenda excludes %s mismatches despite the same observation key and preserves receipts", async field => {
  const f = await routeAgenda(), { sql, scope } = fixture;
  const identity = field === "unbound" ? null : { ...f.binding,
    ...(field === "revision" ? { revision: 2 } : { [field]: field === "requirementKey" ? "another-key" : randomUUID() }) };
  const observation = await f.observe(identity);
  expect(observation.eligibility?.verifiedCorrect).toBe("yes");
  const receipts = await sql`SELECT * FROM opening_learning_decisions WHERE target_id=${f.activityId}`;
  const activities = await sql`SELECT * FROM opening_teaching_activities WHERE id=${f.activityId}`;
  const result = await f.read();
  expect(result.projected.find(row => row.id === observation.id)?.requirementKey).toBe(SPAN_REQUIREMENT_KEY);
  expect(result.agenda).toMatchObject({ decisionCurrent: false, invalidationReasons: expect.arrayContaining(["state_changed"]),
    suggestion: { activityKind: "diagnose", reasonCode: "no_evidence", focusObservationId: null } });
  expect(result.agenda?.suggestion).toEqual(result.canonical);
  expect(await sql`SELECT * FROM opening_learning_decisions WHERE target_id=${f.activityId}`).toEqual(receipts);
  expect(await sql`SELECT * FROM opening_teaching_activities WHERE id=${f.activityId}`).toEqual(activities);
  expect(await createOpeningLearningAgendaRepository(sql).get(fixture.otherScope, f.courseId, f.activityId)).toBeNull();
  expect(await createOpeningLearningAgendaRepository(sql).get(scope, randomUUID(), f.activityId)).toBeNull();
});
it.each(["revision", "archived"] as const)("route agenda uses current requirement state (%s), not the persisted activity binding", async change => {
  const f = await routeAgenda(), { sql, scope } = fixture;
  await f.observe();
  expect((await f.read()).agenda?.suggestion).toMatchObject({ activityKind: "transfer_check", reasonCode: "independent" });
  const receipts = await sql`SELECT * FROM opening_learning_decisions WHERE target_id=${f.activityId}`;
  if (change === "revision") await sql`UPDATE course_requirements SET revision=revision+1 WHERE id=${f.binding.id} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
  else await sql`UPDATE course_requirements SET lifecycle='archived' WHERE id=${f.binding.id} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
  const result = await f.read();
  expect(result.agenda).toMatchObject({ resumable: false, invalidationReasons: expect.arrayContaining(["goal_requirement_or_source_changed"]),
    suggestion: { activityKind: "diagnose", reasonCode: "no_evidence", focusObservationId: null } });
  if (change === "revision") expect(result.agenda?.suggestion).toEqual(result.canonical);
  else expect(result.canonical).toBeNull();
  expect(await sql`SELECT * FROM opening_learning_decisions WHERE target_id=${f.activityId}`).toEqual(receipts);
});
it("route agenda keeps the matching local error and excludes newer foreign-course and unbound success", async () => {
  const f = await routeAgenda();
  const error = await f.observe(f.binding, false);
  await f.observe(null);
  const other = await routeAgenda();
  const foreign = await other.observe(f.binding);
  const result = await f.read();
  expect(result.agenda?.suggestion).toEqual({ activityKind: "targeted_explain", reasonCode: "verified_incorrect", focusObservationId: error.id });
  expect(result.agenda?.suggestion).toEqual(result.canonical);
  expect(result.projected.some(row => row.id === foreign.id)).toBe(false);
});
it("projects repeated real hinted errors into the recovered agenda and resolves them after independent success", async () => {
  const f = await seed();
  await agendaAttempt(f, { help: true });
  const latest = await agendaAttempt(f, { help: true });
  const repeated = await agendaEvidence(f);
  expect(repeated.observations.slice(0, 2)).toMatchObject([
    { assistance: "hinted", errors: expect.arrayContaining([expect.objectContaining({ label: "coefficients", source: "verified_steps" })]) },
    { assistance: "hinted", errors: expect.arrayContaining([expect.objectContaining({ label: "coefficients", source: "verified_steps" })]) },
  ]);
  const repeatedDecision = { activityKind: "full_explain", reasonCode: "repeated_assisted_error", focusObservationId: latest.id };
  expect(repeated.agenda).toMatchObject({ resumable: true, invalidationReasons: expect.arrayContaining(["state_changed"]), suggestion: repeatedDecision });
  expect(repeated.workerDecision).toMatchObject(repeatedDecision);
  const success = await agendaAttempt(f, { correct: true });
  const resolved = await agendaEvidence(f);
  expect(resolved.observations[0]).toMatchObject({ id: success.id, assistance: "independent", verifiedCorrect: "yes", independentAttempt: "yes" });
  // Two older hints still form the existing recent assisted majority; the error escalation is resolved.
  const resolvedDecision = { activityKind: "reduced_help_practice", reasonCode: "assistance_dependent", focusObservationId: null };
  expect(resolved.agenda.suggestion).toEqual(resolvedDecision);
  expect(resolved.workerDecision).toMatchObject(resolvedDecision);
});
it("keeps unknown assistance unknown in a real recovered agenda", async () => {
  const f = await seed();
  await agendaAttempt(f, { correct: true, assistance: "unknown" });
  const result = await agendaEvidence(f);
  expect(result.observations[0]).toMatchObject({ assistance: "unknown", independentAttempt: "unknown", verifiedCorrect: "yes" });
  const decision = { activityKind: "transfer_check", reasonCode: "correct_needs_independent_check", focusObservationId: null };
  expect(result.agenda.suggestion).toEqual(decision);
  expect(result.workerDecision).toMatchObject(decision);
  console.info("agenda unknown assistance", { assistance: result.observations[0]!.assistance, suggestion: result.agenda.suggestion });
});
it("does not escalate stale repeated errors in the real agenda consumer", async () => {
  const f = await seed();
  await agendaAttempt(f, { help: true }); await agendaAttempt(f, { help: true });
  await fixture.sql`UPDATE opening_sources SET version=version+1 WHERE id=${f.sourceId}`;
  const result = await agendaEvidence(f);
  expect(result.observations).toHaveLength(2);
  expect(result.observations.every(row => row.usableForCurrentVersion !== "yes" && !row.errors)).toBe(true);
  const decision = { activityKind: "diagnose", reasonCode: "no_evidence", focusObservationId: null };
  expect(result.agenda).toMatchObject({ resumable: false, suggestion: decision });
  expect(result.workerDecision).toMatchObject(decision);
  console.info("agenda stale errors", result.agenda.suggestion);
});
it("does not reuse withdrawn heads as independent success or repeated errors in either input consumer", async () => {
  const f = await seed(), learning = createOpeningLearningRepository(fixture.sql);
  const { createOpeningLearnerStateService } = await import("../../packages/database/src/repositories/opening-learner-state-read");
  const states = createOpeningLearnerStateService(fixture.sql);
  const initialState = await states.read(fixture.scope, { courseId: f.courseId });
  const receipts = await fixture.sql`SELECT * FROM opening_learning_decisions WHERE target_id=${f.lesson.activityId}`;
  expect(receipts).toHaveLength(1);
  expect(receipts[0]!.receipt.stateVersion).toBe(initialState.stateVersion);
  const observations = [await agendaAttempt(f, { help: true }), await agendaAttempt(f, { help: true })];
  expect((await states.read(fixture.scope, { courseId: f.courseId })).stateVersion).not.toBe(initialState.stateVersion);
  for (const observed of observations) await learning.reviseObservation(fixture.scope, {
    rootObservationId: observed.rootObservationId ?? observed.id, revisesObservationId: observed.id,
    expectedHead: observed.id, revisionKind: "retract", reason: "withdraw prior evidence", clientKey: randomUUID(),
  });
  const result = await agendaEvidence(f);
  expect(result.observations).toEqual([]);
  expect((await states.read(fixture.scope, { courseId: f.courseId })).stateVersion).toBe(initialState.stateVersion);
  expect(await fixture.sql`SELECT * FROM opening_learning_decisions WHERE target_id=${f.lesson.activityId}`).toEqual(receipts);
  // All effective heads were withdrawn: the original empty-state receipt is
  // current again, so agenda keeps its no-invalidation/no-new-suggestion contract.
  expect(result.agenda).toMatchObject({ decisionCurrent: true, invalidationReasons: [], suggestion: null });
  expect(result.workerDecision).toMatchObject({ activityKind: "diagnose", focusObservationId: null, reasonCode: "no_evidence" });
});
it("reconstructs the same activity, item, parent and original budget across real readers and retry keys without writes", async () => {
  const f = await seed(), { sql, scope } = fixture;
  const before = await sql`SELECT * FROM opening_teaching_activities WHERE id=${f.lesson.activityId}`;
  const agenda = (await createOpeningLearningAgendaRepository(sql).get(scope, f.courseId, f.lesson.activityId))!;
  expect(agenda).toMatchObject({ activityId: f.lesson.activityId, sessionId: f.lesson.sessionId, decisionCurrent: true, resumable: true, invalidationReasons: [], intent: f.lesson.intent });
  expect(agenda.itemVersionId).toBeTruthy(); expect(agenda.parentDecisionId).toBeTruthy();
  expect(agenda.budget).toEqual(before[0]!.goal_json.tutorBudget);
  const reopened = await createSpanLessonSessionService(sql).read(scope, f.courseId, f.lesson.activityId);
  expect(sessionAgenda(reopened)).toMatchObject({ activityId: agenda.activityId, itemVersionId: agenda.itemVersionId, parentDecisionId: agenda.parentDecisionId });
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
  expect(sessionAgenda(reopened)).toMatchObject({ resumable: true, decisionCurrent: false, itemVersionId: attempt!.item_version_id,
    invalidationReasons: expect.arrayContaining(["state_changed"]), suggestion: { activityKind: "targeted_explain" } });
  if (kind === "help") expect(sessionAgenda(reopened)?.help).toEqual({ delivered: true, level: "hinted" });
  expect((await createOpeningLongTermPlanningRepository(sql).read(scope)).recovery.agenda?.resumable).toBe(true);
  expect(await prepareTutorNextAction(createSpanTutorNextAction(sql), scope, { ...f.request, userTurnId: randomUUID(), operationId: randomUUID() }))
    .toMatchObject({ resumed: true, action: { activityId: f.lesson.activityId }, decision: { activityKind: "targeted_explain" } });
  expect(await sql`SELECT * FROM opening_teaching_activities WHERE id=${f.lesson.activityId}`).toEqual(before);
  expect(await sql`SELECT * FROM opening_learning_decisions WHERE target_id=${f.lesson.activityId}`).toEqual(receipts);
  expect(await sql`SELECT id FROM opening_learning_attempts WHERE activity_id=${f.lesson.activityId}`).toHaveLength(1);
});
it("connects a recovered agenda to controlled scheduling, cancellation and grant withdrawal without duplicate budget", async () => {
  const f = await seed(), { sql, scope } = fixture;
  const agendaRepo = createOpeningLearningAgendaRepository(sql), repo = createOpeningSpanTutorContextRepository(sql);
  const agenda = (await agendaRepo.get(scope, f.courseId, f.lesson.activityId))!;
  const context = (await repo.read(scope, { ...f.request, operationId: f.operationId }))!;
  expect((await repo.execute(scope, { context, decision: nextLearningStep(context.decisionInput), operationId: f.operationId })).activityId).toBe(agenda.activityId);
  const activities = await sql`SELECT * FROM opening_teaching_activities WHERE course_id=${f.courseId}`;
  const [attempt] = await sql`SELECT * FROM opening_learning_attempts WHERE id=(SELECT id FROM opening_learning_attempts WHERE activity_id=${agenda.activityId} LIMIT 1)`;
  const record = await createOpeningLearningRepository(sql).insertObservation(scope, {
    sessionId: f.lesson.sessionId, courseId: f.courseId, skillLabel: SPAN_SKILL_LABEL, sourceIds: [f.sourceId],
    attemptId: String(attempt!.id), problemId: String(attempt!.problem_id), clientKey: randomUUID(),
    answer: JSON.stringify({ membership: "not_in_span" }), assistance: "independent", outcome: "unverified", verdictSource: "self_report",
  });
  expect(sessionAgenda(await createSpanLessonSessionService(sql).read(scope, f.courseId, agenda.activityId)))
    .toMatchObject({ resumable: true, itemVersionId: agenda.itemVersionId, budget: agenda.budget });
  const { createSpanDelayedRetestService } = await import("../../apps/web/src/features/opening/teaching/span/delayed-retest-service");
  const { createOpeningAdaptivePrefsRepository } = await import("@aistudy/database");
  const service = createSpanDelayedRetestService(sql), request = { observationId: record.id, clientKey: randomUUID(), expectedGrantRevision: 1 };
  const scheduled = await service.scheduleAutomatic(scope, request);
  const [reservation] = await sql`SELECT learning_protocol FROM opening_retest_activities WHERE id=${scheduled.activityId}`;
  expect(reservation!.learning_protocol.tutorAutomation).toMatchObject({ minutes: 20, grantRevision: 1 });
  expect(await service.scheduleAutomatic(scope, request)).toEqual(scheduled);
  expect(await service.cancelAutomatic(scope, { activityId: scheduled.activityId }))
    .toEqual({ activityId: scheduled.activityId, cancelled: true, closedTaskIds: [scheduled.taskId] });
  await expect(service.scheduleAutomatic(scope, { ...request, clientKey: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT" });
  await createOpeningAdaptivePrefsRepository(sql).patch(scope, { spanTutorGrant: {
    courseId: f.courseId, enabled: false, dailyMinutes: 180, expiresOn: null, expectedRevision: 1,
  } });
  expect(await service.cancelAutomatic(scope, { activityId: scheduled.activityId })).toMatchObject({ cancelled: true, closedTaskIds: [] });
  expect(await service.scheduleAutomatic(scope, request)).toMatchObject({ ...scheduled, activityStatus: "cancelled", taskStatus: "skipped" });
  await expect(repo.execute(scope, { context, decision: nextLearningStep(context.decisionInput), operationId: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT" });
  expect((await repo.execute(scope, { context, decision: nextLearningStep(context.decisionInput), operationId: f.operationId })).activityId).toBe(agenda.activityId);
  expect(await agendaRepo.get(scope, f.courseId, agenda.activityId)).toMatchObject({ resumable: false, budget: agenda.budget, itemVersionId: agenda.itemVersionId });
  expect(await sql`SELECT * FROM opening_teaching_activities WHERE course_id=${f.courseId}`).toEqual(activities);
  expect(await sql`SELECT learning_protocol FROM opening_retest_activities WHERE id=${scheduled.activityId}`).toEqual([reservation]);
  expect(await sql`SELECT id FROM opening_tasks WHERE course_id=${f.courseId}`).toHaveLength(1);
  expect(await sql`SELECT id FROM opening_retest_activities WHERE course_id=${f.courseId}`).toHaveLength(1);
  expect(await sql`SELECT id FROM opening_learning_attempts WHERE activity_id=${agenda.activityId}`).toHaveLength(1);
});
it.each(["快一点", "没懂"])("revalidates real preference receipts for %s in their workspace scope", async text => {
  const f = await seed(), { sql, scope } = fixture;
  const other = await learningAttemptFixture(fixture), attempt = await other.start();
  await other.submit(attempt);
  const applied = await createStudyIntentService(sql).apply(scope, { sessionId: f.lesson.sessionId, clientKey: randomUUID(), change: { kind: "explicit_request", text } });
  expect(applied.activityDecision.policyVersion).toBe("span-teaching-v2");
  const receipts = await sql`SELECT * FROM opening_learning_decisions WHERE target_id=${f.lesson.activityId}`;
  expect(sessionAgenda(await createSpanLessonSessionService(sql).read(scope, f.courseId, f.lesson.activityId)))
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
  expect(sessionAgenda(await createSpanLessonSessionService(sql).read(scope, f.courseId, f.lesson.activityId)))
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
it.each(["new_learning", "consolidate"] as const)("keeps explicit %s in both recovered agenda and Worker input", async phase => {
  const f = await seed(), sessions = createOpeningSpanSessionRepository(fixture.sql);
  const current = (await sessions.get(fixture.scope, f.lesson.activityId))!;
  await sessions.save(fixture.scope, current.activityId, { expectedRevision: current.revision,
    intent: { ...current.intent, learningPhase: phase }, moveId: current.moveId, status: current.status });
  await agendaAttempt(f, { correct: true, assistance: "unknown" });
  const result = await agendaEvidence(f);
  const expected = phase === "new_learning"
    ? { activityKind: "full_explain", focusObservationId: null, reasonCode: "requested_full", phase: "new_learning", phaseSource: "explicit" }
    : { activityKind: "reduced_help_practice", focusObservationId: null, reasonCode: "requested_consolidate", phase: "consolidate", phaseSource: "explicit" };
  expect(result.agenda.suggestion).toEqual(expected);
  expect(result.workerDecision).toEqual(expected);
});
it("retains a due retest in the recovered canonical suggestion without creating a successor", async () => {
  const f = await seed(), { sql, scope } = fixture, retestId = randomUUID(), taskId = randomUUID();
  // Complete the validation observation before binding the lesson to a retest;
  // after binding, the attempt owner correctly requires retest-purpose items.
  await agendaAttempt(f, { correct: true, assistance: "unknown" });
  await sql`INSERT INTO opening_tasks(id,workspace_id,owner_user_id,course_id,title,minutes,origin)
    VALUES (${taskId},${scope.workspaceId},${scope.ownerUserId},${f.courseId},'Due check',20,'retest')`;
  await sql`INSERT INTO opening_retest_activities(id,workspace_id,owner_user_id,course_id,skill_label,requirement_key,evidence_cycle_id,status,version,task_id,recommended_at,not_before_at)
    VALUES (${retestId},${scope.workspaceId},${scope.ownerUserId},${f.courseId},${SPAN_SKILL_LABEL},${SPAN_REQUIREMENT_KEY},${randomUUID()},'accepted',1,${taskId},now()-interval '1 minute',now()-interval '1 minute')`;
  await sql`UPDATE opening_teaching_activities SET checkpoint_json=jsonb_set(checkpoint_json,'{spanLesson,retestId}',${sql.json(retestId)}::jsonb) WHERE id=${f.lesson.activityId}`;
  const [binding] = await sql`SELECT r.status,r.task_id,r.recommended_at <= now() AS due,r.not_before_at <= now() AS allowed,
    a.checkpoint_json->'spanLesson'->>'retestId' AS bound_id
    FROM opening_retest_activities r JOIN opening_teaching_activities a ON a.id=${f.lesson.activityId}
    WHERE r.id=${retestId} AND r.workspace_id=${scope.workspaceId} AND r.owner_user_id=${scope.ownerUserId}`;
  expect(binding).toMatchObject({ status: "accepted", task_id: taskId, due: true, allowed: true, bound_id: retestId });
  const agenda = await createOpeningLearningAgendaRepository(sql).get(scope, f.courseId, f.lesson.activityId);
  expect(agenda).toMatchObject({ pendingRetestId: retestId, suggestion: { activityKind: "transfer_check", focusObservationId: null,
    reasonCode: "due_retest", phase: "maintain", phaseSource: "automatic" } });
  expect(await sql`SELECT id FROM opening_teaching_activities WHERE course_id=${f.courseId}`).toHaveLength(1);
});
it.each(["cancelled", "deferred"])("keeps %s retests closed to recovery and creates nothing", async kind => {
  const f = await seed(), { sql, scope } = fixture, retestId = randomUUID();
  await sql`INSERT INTO opening_retest_activities(id,workspace_id,owner_user_id,course_id,skill_label,requirement_key,evidence_cycle_id,status,version,snoozed_until)
    VALUES (${retestId},${scope.workspaceId},${scope.ownerUserId},${f.courseId},${SPAN_SKILL_LABEL},${SPAN_REQUIREMENT_KEY},${randomUUID()},${kind === "cancelled" ? "cancelled" : "accepted"},2,${kind === "deferred" ? new Date(Date.now()+86400000) : null})`;
  await sql`UPDATE opening_teaching_activities SET checkpoint_json=jsonb_set(checkpoint_json,'{spanLesson,retestId}',${sql.json(retestId)}::jsonb) WHERE id=${f.lesson.activityId}`;
  const agenda = await createOpeningLearningAgendaRepository(sql).get(scope, f.courseId, f.lesson.activityId);
  expect(agenda).toMatchObject({ status: kind, resumable: false, pendingRetestId: retestId });
  expect(agenda?.suggestion?.reasonCode).not.toBe("due_retest");
  expect(await sql`SELECT id FROM opening_teaching_activities WHERE course_id=${f.courseId}`).toHaveLength(1);
  expect(await sql`SELECT id FROM opening_learning_attempts WHERE activity_id=${f.lesson.activityId}`).toHaveLength(1);
});
