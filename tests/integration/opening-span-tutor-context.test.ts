import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createOpeningLearningRepository, createOpeningSpanSessionRepository, createWorkspacePreferencesRepository } from "@aistudy/database";
import { DEFAULT_OPENING_ADAPTIVE_PREFS } from "@aistudy/contracts";
import { captureNextLearningStep, DEFAULT_STUDY_SESSION_INTENT, nextLearningStep, SPAN_SKILL_LABEL, solveSpanProblem } from "@aistudy/domain";
import { createSpanTutorNextAction } from "../../apps/worker/src/runtime/span-tutor-next-action";
import { prepareTutorNextAction } from "../../apps/worker/src/jobs/tutor-next-action";
import { createOpeningLearningDecisionsRepository, createOpeningLearningAttemptRepository } from "@aistudy/database";
import { createSpanHintService } from "../../apps/web/src/features/opening/teaching/span/hint-service";
import { reserveSpanTutorActivityBudget } from "../../packages/database/src/repositories/opening-span-tutor-budget";
import { createOpeningSpanTutorContextRepository, spanTutorReceiptDecision, spanTutorQuestionInScope } from "../../packages/database/src/repositories/opening-span-tutor-context";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { backupRows } from "./opening-backup-records-fixture";
import { createSpanReservedService } from "../../apps/web/src/features/opening/teaching/span/reserved-service";
import { createSpanPresentationService } from "../../apps/web/src/features/opening/teaching/span/presentation-service";
import { createSpanDelayedRetestService } from "../../apps/web/src/features/opening/teaching/span/delayed-retest-service";

let fixture: OpeningFixture;
beforeEach(async () => { fixture = await createOpeningFixture(); });
afterEach(async () => { vi.restoreAllMocks(); await fixture?.close(); });
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
it("does not widen historical receipt compatibility to unknown policy/execution pairs", () => {
  const intentVersion = JSON.stringify({ ruleDecision: { activityKind: "diagnose", focusObservationId: null, reasonCode: "needs_check" } });
  for (const policyVersion of ["next-learning-step-7/span-tutor-execution-2", "next-learning-step-5/span-tutor-execution-1",
    "next-learning-step-1/span-tutor-execution-2", "next-learning-step-4/span-tutor-execution-3"]) {
    expect(spanTutorReceiptDecision({ policyVersion, intentVersion })).toBeNull();
  }
});
it.each(["next-learning-step-1/span-tutor-execution-1", "next-learning-step-2/span-tutor-execution-2", "next-learning-step-3/span-tutor-execution-2", "next-learning-step-4/span-tutor-execution-2", "next-learning-step-5/span-tutor-execution-2", "next-learning-step-6/span-tutor-execution-2"])(
  "restores and replays %s by the original key without recomputing or rewriting history", async policyVersion => {
  const f = await seed(), context = (await f.repo.read(fixture.scope, f.request))!;
  const originalInput = structuredClone(context.decisionInput);
  const state = await import("../../packages/database/src/repositories/opening-learner-state-read");
  const before = await state.createOpeningLearnerStateService(fixture.sql).read(fixture.scope, { courseId: f.courseId });
  const input = { context, decision: nextLearningStep(context.decisionInput), operationId: `tutor-next:${randomUUID()}` };
  const session = await f.repo.execute(fixture.scope, input);
  const { createOpeningLearningDecisionsRepository } = await import("@aistudy/database");
  const decisions = createOpeningLearningDecisionsRepository(fixture.sql);
  // New receipts are v6 (restored D5 + D4); archived labels remain explicit
  // compatibility fixtures, never authority to rewrite an old operation.
  const written = await decisions.list(fixture.scope, { layer: "activity", targetId: session.activityId });
  expect(written[0]!.policyVersion).toBe("next-learning-step-6/span-tutor-execution-2");
  const savedDecision = policyVersion.startsWith("next-learning-step-3/")
    ? { ...input.decision, activityKind: "reduced_help_practice", reasonCode: "assisted_success" } : input.decision;
  const captured = { ...JSON.parse(written[0]!.intentVersion), ruleDecision: savedDecision };
  await fixture.sql`UPDATE opening_learning_decisions SET receipt=receipt || ${fixture.sql.json({ policyVersion,
    intentVersion: JSON.stringify(captured), reasonCodes: [savedDecision.reasonCode] })}::jsonb
    WHERE target_id=${session.activityId} AND workspace_id=${fixture.scope.workspaceId}`;
  const receipts = await decisions.list(fixture.scope, { layer: "activity", targetId: session.activityId });
  expect(receipts).toHaveLength(1);
  const receipt = receipts[0]!;
  expect(await decisions.get(fixture.scope, receipt.id)).toEqual(receipt);
  expect(receipt.stateVersion).toBe(before.stateVersion);
  expect(receipt.policyVersion).toBe(policyVersion);
  expect(JSON.parse(receipt.intentVersion)).toMatchObject({ decisionInput: originalInput, ruleDecision: savedDecision,
    execution: { kind: "create", moveId: "self_study-reserved", problemId: "span-reserved-fraction" } });
  expect(receipt.parentDecisionId).toBeTruthy();
  await createOpeningSpanSessionRepository(fixture.sql).save(fixture.scope, session.activityId,
    { expectedRevision: session.revision, intent: session.intent, moveId: session.moveId, status: "paused" });
  await createWorkspacePreferencesRepository(fixture.sql).setLearningPreferences(fixture.scope,
    { assessmentEnabled: false, retestSuggestionsEnabled: false, automaticRemindersEnabled: false });
  const replay = (await f.repo.read(fixture.scope, { ...f.request, operationId: input.operationId }))!;
  expect(replay.historicalDecision).toEqual(savedDecision);
  expect(replay.decisionInput).toEqual(originalInput);
  // Today's rule would choose a different action for these later facts. The same
  // operation key must return its original activity, even after grant withdrawal.
  const changedInput = { ...originalInput, observations: [{ id: randomUUID(), skillLabel: SPAN_SKILL_LABEL,
    attemptedAt: new Date().toISOString(), assistance: "hinted" as const, verifiedCorrect: "yes" as const,
    independentAttempt: "no" as const, usableForCurrentVersion: "yes" as const, problemId: null }] };
  const changedDecision = nextLearningStep(changedInput);
  expect(changedDecision.reasonCode).toBe("assisted_success");
  expect((await f.repo.execute(fixture.scope, { ...input, context: { ...replay, decisionInput: changedInput }, decision: changedDecision })).activityId).toBe(session.activityId);
  expect(await decisions.list(fixture.scope, { layer: "activity", targetId: session.activityId })).toEqual(receipts);
});
it.each(["v2", "v3", "v6"] as const)("replays the exact %s operation across the combined v6 writer without cross-operation decisions", async version => {
  const f = await seed(), { sql, scope } = fixture, lessons = createOpeningSpanSessionRepository(sql);
  const learning = createOpeningLearningRepository(sql), attempts = createOpeningLearningAttemptRepository(sql);
  const answer = async (hinted: boolean) => {
    const lesson = await lessons.create(scope, { courseId: f.courseId, sourceIds: [f.sourceId],
      intent: DEFAULT_STUDY_SESSION_INTENT, clientKey: randomUUID() });
    const attempt = hinted ? await attempts.create(scope, { sessionId: lesson.sessionId, clientKey: randomUUID(),
      spanExercise: { sourceId: f.sourceId, problemId: "span-example-2d", version: 1 } })
      : await createSpanReservedService(sql).issue(scope, { sessionId: lesson.sessionId, sourceId: f.sourceId,
        clientKey: randomUUID(), mode: "self_study" });
    const problem = attempt.spanExercise!, solution = solveSpanProblem(problem);
    if (solution.kind !== "unique") throw new Error("fixture requires a unique canonical solution");
    if (hinted) await createSpanHintService(sql).read(scope, { attemptId: attempt.id, level: 1 });
    const observed = await learning.insertObservation(scope, { sessionId: lesson.sessionId, courseId: f.courseId,
      skillLabel: SPAN_SKILL_LABEL, sourceIds: [f.sourceId], attemptId: attempt.id, problemId: attempt.problemId,
      clientKey: randomUUID(), answer: JSON.stringify({ membership: "in_span", coefficients: solution.coefficients,
        equation: { vectors: problem.vectors, target: problem.target }, coordinateChecks: problem.target }),
      assistance: "independent", outcome: "unverified", verdictSource: "self_report" });
    expect(observed.eligibility).toMatchObject({ verifiedCorrect: "yes", independentAttempt: hinted ? "no" : "yes", usableForCurrentVersion: "yes" });
    await lessons.save(scope, lesson.activityId, { expectedRevision: lesson.revision, intent: lesson.intent,
      moveId: lesson.moveId, status: "completed" });
    return observed;
  };
  const older = await answer(false), latest = await answer(true);
  const context = (await f.repo.read(scope, f.request))!;
  expect(context.decisionInput.observations).toEqual([
    expect.objectContaining({ id: latest.id, assistance: "hinted", verifiedCorrect: "yes", independentAttempt: "no" }),
    expect.objectContaining({ id: older.id, assistance: "independent", verifiedCorrect: "yes", independentAttempt: "yes" }),
  ]);
  const gold = { activityKind: "reduced_help_practice", reasonCode: "assisted_success", focusObservationId: null };
  expect(nextLearningStep(context.decisionInput)).toMatchObject(gold);
  const operationId = `tutor-next:${randomUUID()}`;
  const adapter = createSpanTutorNextAction(sql);
  const request = { ...f.request, userTurnId: operationId.slice("tutor-next:".length), operationId, expectedPrivacyEpoch: context.privacyEpoch };
  const created = await prepareTutorNextAction(adapter, scope, request);
  expect(created).toMatchObject({ resumed: false, decision: gold });
  let successor = (await lessons.get(scope, created!.action!.activityId))!;
  expect(successor.moveId).toBe("self-faded");
  const decisions = createOpeningLearningDecisionsRepository(sql);
  const [written] = await decisions.list(scope, { layer: "activity", targetId: successor.activityId });
  expect(written!.policyVersion).toBe("next-learning-step-6/span-tutor-execution-2");
  expect(JSON.parse(written!.intentVersion)).toMatchObject({ ruleDecision: gold,
    execution: { kind: "create", moveId: "self-faded" } });
  const decision = version === "v2" ? { ...created!.decision!, activityKind: "diagnose" as const, reasonCode: "needs_check" as const } : created!.decision!;
  if (version === "v3") {
    // The historical v3 result agrees on D5 but predates the combined D4 policy.
    await sql`UPDATE opening_learning_decisions SET receipt=jsonb_set(receipt,'{policyVersion}',
      '"next-learning-step-3/span-tutor-execution-2"'::jsonb)
      WHERE target_id=ANY(${[successor.activityId, successor.sessionId]}::uuid[]) AND workspace_id=${scope.workspaceId}`;
  }
  if (version === "v2") {
    // Explicit old-v2 fixture: this same assisted/independent input used to fall
    // through the majority rule to diagnose. Never install a fake current writer.
    successor = await lessons.save(scope, successor.activityId, { expectedRevision: successor.revision,
      intent: successor.intent, moveId: "self_study-reserved", status: "active" });
    const issued = await createSpanReservedService(sql).issue(scope, { sessionId: successor.sessionId, sourceId: f.sourceId,
      clientKey: `archived-v2:${operationId}`, mode: "self_study" });
    const refs = context.decisionInput.observations.map(row => `observation:${row.id}`);
    const candidates = captureNextLearningStep(context.decisionInput).candidates.slice(0, -1).map(candidate => ({
      ...candidate, action: `rule:${candidate.action}`, eligible: false,
      reasonCodes: [...candidate.reasonCodes, "rule_branch_not_selected"],
    }));
    for (const [action, reason] of [["reduced_help_practice", "no_assisted_majority"], ["transfer_check", "not_observed_independent"],
      ["transfer_check", "no_unknown_independence_check"], ["diagnose", "needs_check"]] as const) candidates.push({
      action: `rule:${action}`, eligible: false, reasonCodes: [reason, reason === "needs_check" ? "rule_recommendation_mapped_to_execution" : "rule_branch_not_selected"], evidenceRefs: refs,
    });
    candidates.push({ action: "create:self_study-reserved", eligible: true,
      reasonCodes: ["entry:worker", "execution:create", "needs_check"], evidenceRefs: written!.evidenceRefs });
    const captured = JSON.parse(written!.intentVersion);
    const archived = { policyVersion: "next-learning-step-2/span-tutor-execution-2", selectedAction: "create:self_study-reserved",
      reasonCodes: ["entry:worker", "execution:create", "needs_check"], candidates,
      intentVersion: JSON.stringify({ ...captured, ruleDecision: decision, execution: { ...captured.execution, moveId: "self_study-reserved",
        problemId: issued.spanExercise!.id, problemVersion: Number(issued.spanExercise!.version) } }) };
    await sql`UPDATE opening_learning_decisions SET receipt=receipt || ${sql.json(archived)}::jsonb
      WHERE target_id=ANY(${[successor.activityId, successor.sessionId]}::uuid[]) AND workspace_id=${scope.workspaceId}`;
    await sql`UPDATE opening_teaching_activities SET goal_json=jsonb_set(goal_json,'{tutorNextAction,decision}',${sql.json(decision)}::jsonb)
      WHERE id=${successor.activityId}`;
  }
  const execute = vi.spyOn(adapter, "execute");
  const before = async () => ({
    activities: await sql`SELECT * FROM opening_teaching_activities WHERE course_id=${f.courseId} ORDER BY id`,
    attempts: await sql`SELECT * FROM opening_learning_attempts WHERE course_id=${f.courseId} ORDER BY id`,
    receipts: await sql`SELECT * FROM opening_learning_decisions WHERE workspace_id=${scope.workspaceId} ORDER BY id`,
    observations: await sql`SELECT * FROM opening_learning_observations WHERE course_id=${f.courseId} ORDER BY id`,
  });
  const saved = await before();
  const prepared = await prepareTutorNextAction(adapter, scope, request);
  expect(prepared).toMatchObject({ resumed: true, action: { activityId: successor.activityId, sessionId: successor.sessionId },
    decision, context: { agenda: { resumable: true } } });
  if (version !== "v6") {
    expect(prepared!.context.agenda!.decisionCurrent).toBe(false);
    expect(prepared!.context.agenda!.invalidationReasons).toContain("policy_changed");
  } else expect(prepared!.context.agenda!.invalidationReasons).not.toContain("policy_changed");
  expect(await before()).toEqual(saved);
  // A different operation selects the combined v6 suggestion, never the old v2 decision.
  const fresh = await prepareTutorNextAction(adapter, scope, { ...request, operationId: `tutor-next:${randomUUID()}` });
  expect(fresh).toMatchObject({ resumed: true, decision: gold });
  expect(await before()).toEqual(saved);
  expect(execute).not.toHaveBeenCalled();
  await expect(prepareTutorNextAction(adapter, scope, { ...request, expectedPrivacyEpoch: context.privacyEpoch + 1 })).rejects.toThrow();
  await expect(prepareTutorNextAction(adapter, fixture.otherScope, request)).rejects.toMatchObject({ code: "NOT_FOUND" });
  await createWorkspacePreferencesRepository(sql).setLearningPreferences(scope,
    { assessmentEnabled: false, retestSuggestionsEnabled: false, automaticRemindersEnabled: false });
  expect(await prepareTutorNextAction(adapter, scope, request)).toMatchObject({ resumed: false, action: null,
    context: { agenda: { resumable: false, invalidationReasons: expect.arrayContaining([expect.stringMatching(/^permission:/)]) } } });
  await createWorkspacePreferencesRepository(sql).setLearningPreferences(scope,
    { assessmentEnabled: true, retestSuggestionsEnabled: true, automaticRemindersEnabled: false });
  expect(await before()).toEqual(saved);
  // Immutable origin heads are still revalidated before exact-key replay.
  await learning.reviseObservation(scope, { rootObservationId: latest.id, revisesObservationId: latest.id, expectedHead: latest.id,
    revisionKind: "retract", reason: "withdraw consumed origin", clientKey: randomUUID() });
  await expect(prepareTutorNextAction(adapter, scope, request)).rejects.toMatchObject({ code: "CONFLICT" });
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
  expect(context).toMatchObject({ courseId: f.courseId, grantRevision: 1, decisionInput: {
    observations: [], status: "unobserved", wantsFullExplanation: false, phaseSource: "automatic", dueRetest: false,
  } });
  expect(nextLearningStep(context.decisionInput)).toEqual({ activityKind: "diagnose", focusObservationId: null,
    reasonCode: "no_evidence", phase: "explore", phaseSource: "automatic" });
  const input = { context, decision: nextLearningStep(context.decisionInput), operationId: `tutor-next:${randomUUID()}` };
  const one = await f.repo.execute(fixture.scope, input);
  await f.repo.assertCurrent(fixture.scope, context);
  expect(one).toMatchObject({ courseId: f.courseId, moveId: "self_study-reserved", status: "active" });
  const resumed = (await f.repo.read(fixture.scope, f.request))!;
  expect(resumed.resumeSession?.activityId).toBe(one.activityId);
  expect(resumed.decisionInput).toEqual(context.decisionInput);
  expect((await f.repo.execute(fixture.scope, { ...input, context: resumed })).activityId).toBe(one.activityId);
  const activities = await fixture.sql`SELECT id FROM opening_teaching_activities WHERE course_id=${f.courseId}`;
  expect(activities.map(row => row.id)).toEqual([one.activityId]);
});
it("executes explicit new learning and replays the same phase, source and action", async () => {
  const f = await seed(), operationId = randomUUID();
  const request = { ...f.request, question: "完全不会，先学", operationId };
  const context = (await f.repo.read(fixture.scope, request))!;
  expect(context).not.toBeNull();
  expect(context.decisionInput).toMatchObject({ observations: [], status: "unobserved", learningPhase: "new_learning", phaseSource: "explicit" });
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
  expect(context.decisionInput).toMatchObject({ dueRetest: question === "继续学习", phaseSource: question === "继续学习" ? "automatic" : "explicit" });
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
it("updates an ordinary lesson to explicit overview without issuing a question or charging, and preserves admission checks", async () => {
  expect(spanTutorQuestionInScope("串讲")).toBe(true);
  for (const question of ["为什么串讲", "例如串讲", "不要串讲", "请解释特征值"]) expect(spanTutorQuestionInScope(question)).toBe(false);
  const f = await seed(), { sql, scope } = fixture, lessons = createOpeningSpanSessionRepository(sql);
  const session = await lessons.create(scope, { courseId: f.courseId, sourceIds: [f.sourceId], intent: DEFAULT_STUDY_SESSION_INTENT, clientKey: randomUUID() });
  const context = (await f.repo.read(scope, { ...f.request, question: "串讲" }))!;
  const decision = nextLearningStep(context.decisionInput), operationId = randomUUID();
  expect(context).toMatchObject({ needsIntentUpdate: true, intent: { purpose: "overview" } });
  const before = await sql`SELECT * FROM opening_learning_attempts WHERE course_id=${f.courseId} ORDER BY id`;
  await expect(f.repo.execute({ ...scope, ownerUserId: randomUUID() }, { context, decision, operationId: randomUUID() })).rejects.toThrow();
  const updated = await f.repo.execute(scope, { context, decision, operationId });
  expect(updated).toMatchObject({ activityId: session.activityId, sessionId: session.sessionId, moveId: "overview-links", intent: { purpose: "overview" } });
  expect(await sql`SELECT * FROM opening_learning_attempts WHERE course_id=${f.courseId} ORDER BY id`).toEqual(before);
  expect(await sql`SELECT id FROM opening_teaching_activities WHERE course_id=${f.courseId}`).toHaveLength(1);
  expect(await sql`SELECT id FROM opening_teaching_activities WHERE course_id=${f.courseId} AND goal_json ? 'tutorBudget'`).toHaveLength(0);
  const replay = (await f.repo.read(scope, { ...f.request, question: "串讲", operationId }))!;
  expect((await f.repo.execute(scope, { context: replay, decision, operationId })).activityId).toBe(updated.activityId);
  const fresh = (await f.repo.read(scope, { ...f.request, question: "span 自学" }))!;
  await createWorkspacePreferencesRepository(sql).setLearningPreferences(scope,
    { assessmentEnabled: false, retestSuggestionsEnabled: false, automaticRemindersEnabled: false });
  await expect(f.repo.execute(scope, { context: fresh, decision: nextLearningStep(fresh.decisionInput), operationId: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await lessons.get(scope, session.activityId)).toEqual(updated);
});
it.each([
  ["self_study", "span 串讲", "overview-links"],
  ["self_study", "span 拔高", "challenge-predict"],
  ["overview", "span 拔高", "challenge-predict"],
  ["challenge", "span 串讲", "overview-links"],
  ["overview", "span 自学", "self-example"],
  ["challenge", "span 自学", "self-example"],
] as const)("normalizes an explicit %s mode change (%s) to a catalog move", async (purpose, question, moveId) => {
  const f = await seed(), { sql, scope } = fixture, lessons = createOpeningSpanSessionRepository(sql);
  const session = await lessons.create(scope, { courseId: f.courseId, sourceIds: [f.sourceId],
    intent: { ...DEFAULT_STUDY_SESSION_INTENT, purpose }, clientKey: randomUUID() });
  const context = (await f.repo.read(scope, { ...f.request, question }))!;
  const updated = await f.repo.execute(scope, { context, decision: nextLearningStep(context.decisionInput), operationId: randomUUID() });
  expect(updated).toMatchObject({ activityId: session.activityId, sessionId: session.sessionId, revision: session.revision + 1, moveId });
  expect(await sql`SELECT id FROM opening_learning_attempts WHERE course_id=${f.courseId}`).toHaveLength(0);
  expect(await sql`SELECT id FROM opening_teaching_activities WHERE course_id=${f.courseId}`).toHaveLength(1);
  expect(await sql`SELECT id FROM opening_teaching_activities WHERE course_id=${f.courseId} AND goal_json ? 'tutorBudget'`).toHaveLength(0);
});
async function preferenceState(courseId: string) {
  const { sql, scope } = fixture;
  return {
    activities: await sql`SELECT * FROM opening_teaching_activities WHERE course_id=${courseId} ORDER BY id`,
    attempts: await sql`SELECT * FROM opening_learning_attempts WHERE course_id=${courseId} ORDER BY id`,
    receipts: await sql`SELECT * FROM opening_learning_decisions WHERE workspace_id=${scope.workspaceId} ORDER BY id`,
    reservations: await sql`SELECT * FROM opening_budget_reservations WHERE workspace_id=${scope.workspaceId} ORDER BY id`,
    history: await sql`SELECT * FROM opening_workspace_history_revisions WHERE workspace_id=${scope.workspaceId}`,
  };
}
it.each(["paused", "reserved", "due_retest", "source", "privacy", "authorization", "expired", "cancelled", "revision"] as const)(
  "keeps %s admission authoritative for an overview preference update with no execution writes", async branch => {
  const f = await seed(), { sql, scope } = fixture, lessons = createOpeningSpanSessionRepository(sql);
  const intent = { ...DEFAULT_STUDY_SESSION_INTENT, purpose: "overview" as const, explanationStyle: "full" as const };
  let session = await lessons.create(scope, { courseId: f.courseId, sourceIds: [f.sourceId], intent, clientKey: randomUUID() });
  if (branch === "paused" || branch === "reserved") session = await lessons.save(scope, session.activityId,
    { expectedRevision: session.revision, intent, moveId: branch === "reserved" ? "overview-reserved" : session.moveId,
      status: branch === "paused" ? "paused" : "active" });
  if (branch === "due_retest") {
    const attempt = await createSpanReservedService(sql).issue(scope,
      { sessionId: session.sessionId, sourceId: f.sourceId, mode: "overview", clientKey: randomUUID() });
    const observed = await createOpeningLearningRepository(sql).insertObservation(scope, { sessionId: session.sessionId,
      courseId: f.courseId, skillLabel: SPAN_SKILL_LABEL, sourceIds: [f.sourceId], attemptId: attempt.id, problemId: attempt.problemId,
      clientKey: randomUUID(), answer: JSON.stringify({ membership: "not_in_span" }), assistance: "independent",
      outcome: "unverified", verdictSource: "self_report" });
    const due = await createSpanDelayedRetestService(sql).schedule(scope, { observationId: observed.id, clientKey: randomUUID() });
    await sql`UPDATE opening_retest_activities SET recommended_at=now()-interval '1 minute',not_before_at=now()-interval '1 minute',
      scheduled_start_at=now()-interval '1 minute' WHERE id=${due.activityId}`;
    await lessons.save(scope, session.activityId, { expectedRevision: session.revision, intent, moveId: session.moveId, status: "completed" });
    session = await lessons.create(scope, { courseId: f.courseId, sourceIds: [f.sourceId], intent, clientKey: randomUUID(), retestId: due.activityId });
  }
  const context = (await f.repo.read(scope, { ...f.request, question: "span 慢一点" }))!;
  expect(context.needsIntentUpdate).toBe(true);
  if (branch === "due_retest") expect(context).toMatchObject({ dueRetestId: session.retestId, intentChangeRequiresChoice: true });
  if (branch === "source") await sql`UPDATE opening_sources SET version=version+1 WHERE id=${f.sourceId}`;
  if (branch === "privacy") await sql`UPDATE workspaces SET privacy_epoch=privacy_epoch+1 WHERE id=${scope.workspaceId}`;
  if (branch === "authorization") await createWorkspacePreferencesRepository(sql).setLearningPreferences(scope,
    { assessmentEnabled: false, retestSuggestionsEnabled: false, automaticRemindersEnabled: false });
  if (branch === "expired") await sql`UPDATE workspace_preferences SET adaptive_planning=jsonb_set(adaptive_planning,
    ARRAY['spanTutorGrants',${f.courseId},'expiresOn'], '"2000-01-01"'::jsonb) WHERE workspace_id=${scope.workspaceId}`;
  if (branch === "revision") await lessons.save(scope, session.activityId,
    { expectedRevision: session.revision, intent: { ...intent, language: "en" }, moveId: session.moveId, status: "active" });
  const before = await preferenceState(f.courseId);
  await expect(f.repo.execute(scope, { context, decision: nextLearningStep(context.decisionInput), operationId: randomUUID(),
    ...(branch === "cancelled" ? { jobLease: { jobId: randomUUID(), claimToken: randomUUID() } } : {}) }))
    .rejects.toMatchObject({ code: "CONFLICT" });
  expect(await preferenceState(f.courseId)).toEqual(before);
});
it.each(["span 不要串讲", "span 不要加快", "span 为什么串讲", "span 如何拔高"])(
  "does not turn %s into a method or preference change", async question => {
  const f = await seed(), { sql, scope } = fixture, lessons = createOpeningSpanSessionRepository(sql);
  const intent = { ...DEFAULT_STUDY_SESSION_INTENT, purpose: "challenge" as const, explanationStyle: "full" as const };
  const session = await lessons.create(scope, { courseId: f.courseId, sourceIds: [f.sourceId], intent, clientKey: randomUUID() });
  const context = (await f.repo.read(scope, { ...f.request, question }))!;
  expect(context).toMatchObject({ needsIntentUpdate: false, intent });
  const before = await preferenceState(f.courseId);
  expect(await f.repo.execute(scope, { context, decision: nextLearningStep(context.decisionInput), operationId: randomUUID() })).toEqual(session);
  expect(await preferenceState(f.courseId)).toEqual(before);
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
it("uses the empty canonical fallback when the consumed material version changed, without reviving the activity", async () => {
  const f = await seed(), initial = (await f.repo.read(fixture.scope, f.request))!;
  const session = await f.repo.execute(fixture.scope, { context: initial, decision: nextLearningStep(initial.decisionInput), operationId: randomUUID() });
  await fixture.sql`UPDATE opening_sources SET version=version+1 WHERE id=${f.sourceId}`;
  const current = (await f.repo.read(fixture.scope, f.request))!;
  expect(current.originChange).toMatchObject({ reason: "source_unavailable" });
  expect(current.decisionInput).toEqual({ observations: [], status: "unobserved", wantsFullExplanation: false });
  expect(nextLearningStep(current.decisionInput)).toEqual({ activityKind: "diagnose", focusObservationId: null, reasonCode: "no_evidence" });
  await expect(f.repo.execute(fixture.scope, { context: current, decision: nextLearningStep(current.decisionInput), operationId: randomUUID() }))
    .rejects.toMatchObject({ code: "CONFLICT" });
  expect(await fixture.sql`SELECT id FROM opening_teaching_activities WHERE course_id=${f.courseId}`).toEqual([{ id: session.activityId }]);
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
