import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DEFAULT_OPENING_ADAPTIVE_PREFS, type CourseRouteActionResult } from "@aistudy/contracts";
import { NEXT_LEARNING_STEP_VERSION, nextLearningStep, solveSpanProblem, SPAN_REQUIREMENT_KEY, SPAN_SKILL_LABEL } from "@aistudy/domain";
import { createOpeningLearningAttemptRepository, createOpeningLearningRepository, createOpeningLearningGoalRepository,
  createOpeningSpanTutorContextRepository, createWorkspacePreferencesRepository } from "@aistudy/database";
import { createOpeningCourseRouteRepository } from "../../packages/database/src/repositories/opening-course-route";
import { readOpeningLearningAgenda } from "../../packages/database/src/repositories/opening-learning-agenda";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { backupRows } from "./opening-backup-records-fixture";
import { createOpeningLearningDecisionsRepository } from "../../packages/database/src/repositories/opening-learning-decisions";

let f: OpeningFixture;
beforeEach(async () => { f = await createOpeningFixture(); });
afterEach(async () => { await f?.close(); });
const ready = (result: CourseRouteActionResult) => {
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw new Error(result.kind);
  return result;
};

async function routeWithSpanEvidence() {
  const { sql, scope } = f, rows = backupRows(sql, scope), courseId = randomUUID(), sourceId = await rows.source(), chunkId = await rows.chunk(sourceId);
  await sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES (${courseId},${scope.workspaceId},'规范输入一致性',${courseId})`;
  await sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility) VALUES (${scope.workspaceId},${courseId},'source',${sourceId},'core','course')`;
  await createWorkspacePreferencesRepository(sql).setLearningPreferences(scope, { assessmentEnabled: true, retestSuggestionsEnabled: true, automaticRemindersEnabled: false });
  const at = new Date().toISOString(), grant = { enabled: true, dailyMinutes: 180, revision: 1, confirmedAt: at, updatedAt: at, expiresOn: null };
  await sql`UPDATE workspace_preferences SET adaptive_planning=jsonb_set(COALESCE(adaptive_planning,${sql.json(DEFAULT_OPENING_ADAPTIVE_PREFS)}::jsonb),'{spanTutorGrants}',COALESCE(adaptive_planning->'spanTutorGrants','{}'::jsonb) || ${sql.json({ [courseId]: grant })}::jsonb) WHERE workspace_id=${scope.workspaceId}`;
  const goal = await createOpeningLearningGoalRepository(sql).create(scope, { clientKey: randomUUID(), courseIds: [courseId], title: "逐项验证", kind: "custom", targetDate: null,
    examDate: null, weeklyMinutes: 120, priority: 1, learningMode: "understand", successCriteria: "独立检查" });
  const requirementId = randomUUID(), stableSkillId = randomUUID(), route = createOpeningCourseRouteRepository(sql, { compilerEnabled: true });
  await route.confirm(scope, courseId, { expectedRevisions: [], confirmScope: true, requirements: [{ id: requirementId, stableSkillId, knowledgeNodeId: null,
    requirementKey: SPAN_REQUIREMENT_KEY, title: SPAN_SKILL_LABEL, position: 0, mandatory: true, goalIds: [goal.id], prerequisiteIds: [],
    sourceRefs: [{ sourceId, sourceVersion: 1, chunkId }], verification: { kind: "exact", status: "ready", exerciseKeys: ["span-reserved-fraction"], rubric: null, missingReasons: [] }, origin: "confirmed" }] });
  // Ready is a server-side fixture fact, never trusted from a confirmation request.
  await sql`UPDATE course_requirements SET verification=${sql.json({ kind: "exact", status: "ready", exerciseKeys: ["span-reserved-fraction"], rubric: null, missingReasons: [] })} WHERE id=${requirementId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
  const request = { goalId: goal.id, expectedGoalRevision: 1, requirementId, expectedRequirementRevision: 1, clientKey: randomUUID(), minutes: 20 };
  const initial = ready(await route.start(scope, courseId, request));
  const learning = createOpeningLearningRepository(sql), session = await learning.createSession(scope, { activityId: initial.activity.id, courseId, skillLabel: SPAN_SKILL_LABEL, sourceIds: [sourceId] });
  // The server-owned exact span evaluator remains intact; attach the route's
  // current requirement identity, as saved teaching questions do in production.
  const binding = { id: requirementId, revision: 1, stableSkillId, requirementKey: SPAN_REQUIREMENT_KEY };
  const observe = async (problemId: string, assistance: "independent" | "unknown" | "hinted") => {
    const attempt = await createOpeningLearningAttemptRepository(sql).create(scope, { sessionId: session.id, clientKey: randomUUID(), spanExercise: { sourceId, problemId, version: 1 } });
    await sql`UPDATE opening_learning_item_versions SET evaluation_spec=evaluation_spec || ${sql.json({ courseRequirement: binding })}::jsonb WHERE id=${attempt.itemVersionId!} AND workspace_id=${scope.workspaceId}`;
    const problem = attempt.spanExercise!, solution = solveSpanProblem(problem);
    if (solution.kind !== "unique") throw new Error("fixture requires unique exact span problem");
    const observation = await learning.insertObservation(scope, { sessionId: session.id, attemptId: attempt.id, courseId, skillLabel: SPAN_SKILL_LABEL, sourceIds: [sourceId], problemId: attempt.problemId,
      clientKey: randomUUID(), answer: JSON.stringify({ membership: "in_span", coefficients: solution.coefficients, equation: { vectors: problem.vectors, target: problem.target }, coordinateChecks: problem.target }),
      outcome: "unverified", assistance, verdictSource: "self_report" });
    expect(observation.eligibility?.verifiedCorrect).toBe("yes");
    return observation;
  };
  const canonical = async () => {
    const agenda = await sql.begin("isolation level repeatable read read only", tx => readOpeningLearningAgenda(tx, scope, courseId, initial.activity.id));
    const span = await createOpeningSpanTutorContextRepository(sql).read(scope, { courseId, sourceIds: [sourceId], sourceVersions: { [sourceId]: 1 }, question: "继续学习" });
    expect(span).not.toBeNull();
    return { agenda: agenda?.suggestion, span: nextLearningStep(span!.decisionInput) };
  };
  const next = async (observationId: string) => {
    const snapshot = await route.read(scope, courseId, initial.activity.id);
    return ready(await route.next(scope, courseId, { goalId: goal.id, expectedGoalRevision: 1, activityId: initial.activity.id,
      expectedPathVersion: snapshot.currentActivity!.pathVersion, observationId, clientKey: randomUUID(), minutes: 20 }));
  };
  return { route, scope, courseId, request, observe, canonical, next };
}

it.each(["independent", "unknown"] as const)("真实课程路线、恢复agenda和span对相同%s成功一致", async assistance => {
  const { route, scope, courseId, request, observe, canonical, next } = await routeWithSpanEvidence();
  const observation = await observe("span-reserved-fraction", assistance);
  const expected = { activityKind: "transfer_check", reasonCode: assistance === "independent" ? "independent" : "correct_needs_independent_check", focusObservationId: null };
  const shared = await canonical();
  expect(shared.agenda).toEqual(expected);
  expect(shared.span).toMatchObject(expected);
  const started = ready(await route.start(scope, courseId, { ...request, clientKey: randomUUID() }));
  expect(started.action).toBe("transfer_check");
  expect(started.activity.learnerFocus).toMatchObject(expected);
  const continued = await next(observation.id);
  expect(continued.activity.learnerFocus).toMatchObject(expected);
});

// Manual policy gold: the separate D5 restoration must pass the shared v3
// result at all entries, without the bridge's route-only correction override.
function assistedSuccessGold(policyVersion: string) {
  const majority = { activityKind: "reduced_help_practice", reasonCode: "assistance_dependent", focusObservationId: null } as const;
  const fallback = { activityKind: "diagnose", reasonCode: "needs_check", focusObservationId: null } as const;
  const correction = { activityKind: "reduced_help_practice", reasonCode: "route_assisted_correction", focusObservationId: null } as const;
  const shared = { activityKind: "reduced_help_practice", reasonCode: "assisted_success", focusObservationId: null } as const;
  switch (policyVersion) {
    case "next-learning-step-2": return [
      { canonical: majority, route: majority, override: false },
      { canonical: fallback, route: correction, override: true },
      { canonical: fallback, route: correction, override: true },
    ] as const;
    case "next-learning-step-3": return [
      { canonical: shared, route: shared, override: false },
      { canonical: shared, route: shared, override: false },
      { canonical: shared, route: shared, override: false },
    ] as const;
    default: throw new Error(`Unsupported assisted-success policy: ${policyVersion}`);
  }
}

it.each([0, 1, 2])("最新受助判对、之前%d次独立判对：按显式版本分别断言canonical和路线最终值", async priorChecks => {
  const { route, scope, courseId, request, observe, canonical, next } = await routeWithSpanEvidence();
  for (const problemId of ["span-reserved-20261021-q02", "span-reserved-20261021-q01"].slice(0, priorChecks)) await observe(problemId, "independent");
  const helped = await observe("span-reserved-fraction", "hinted");
  expect(helped.eligibility).toMatchObject({ verifiedCorrect: "yes", independentAttempt: "no", usableForCurrentVersion: "yes" });
  const expected = assistedSuccessGold(NEXT_LEARNING_STEP_VERSION)[priorChecks]!;
  const expectedCanonical = expected.canonical;
  const shared = await canonical();
  expect(shared.agenda).toEqual(expectedCanonical);
  expect(shared.span).toMatchObject(expectedCanonical);
  const routeFocus = expected.route;
  const decisions = createOpeningLearningDecisionsRepository(f.sql);
  for (const result of [ready(await route.start(scope, courseId, { ...request, clientKey: randomUUID() })), await next(helped.id)]) {
    expect(result.action).toBe("reduced_help_practice");
    expect(result.activity.learnerFocus).toMatchObject(routeFocus);
    const [receipt, ...extra] = await decisions.list(scope, { layer: "activity", targetId: result.activity.id });
    expect(extra).toHaveLength(0);
    expect(receipt!.reasonCodes).toContain(`teaching:${expectedCanonical.reasonCode}`);
    expect(receipt!.reasonCodes.some(code => code.includes("consolidate"))).toBe(false);
    expect(receipt!.reasonCodes.filter(code => code.startsWith("teaching_override:")))
      .toEqual(expected.override ? ["teaching_override:route_assisted_correction"] : []);
    const captured = JSON.parse(receipt!.intentVersion);
    expect(captured.decisionInput).not.toHaveProperty("learningPhase");
    expect(captured.teaching.decision).toEqual(expectedCanonical);
    if (expected.override) expect(captured.teachingOverride).toEqual({ rule: "route_assisted_correction",
      observationId: helped.id, from: expectedCanonical, to: routeFocus });
    else expect(captured).not.toHaveProperty("teachingOverride");
  }
});
