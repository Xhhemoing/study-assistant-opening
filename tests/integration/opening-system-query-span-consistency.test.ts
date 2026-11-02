import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DEFAULT_OPENING_ADAPTIVE_PREFS, systemQueryRequestSchema } from "@aistudy/contracts";
import { createOpeningSpanSessionRepository, createScopedOpeningSystemQueryReader, createWorkspacePreferencesRepository } from "@aistudy/database";
import { DEFAULT_STUDY_SESSION_INTENT, nextLearningStep, solveSpanProblem } from "@aistudy/domain";
import { createOpeningSpanTutorContextRepository } from "../../packages/database/src/repositories/opening-span-tutor-context";
import { createOpeningAttemptService } from "../../apps/web/src/features/opening/learning/attempt-service";
import { createSpanHintService } from "../../apps/web/src/features/opening/teaching/span/hint-service";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { backupRows } from "./opening-backup-records-fixture";

let fixture: OpeningFixture;
beforeEach(async () => { fixture = await createOpeningFixture(); });
afterEach(async () => { await fixture?.close(); });

it.each([
  { kind: "unique", errors: ["span-reserved-20261021-q01", "span-reserved-fraction"], success: "span-reserved-20261021-q02" },
  { kind: "none", errors: ["span-reserved-transfer", "span-reserved-20261021-q07"], success: "span-reserved-20261021-q03" },
])("aligns same-scope recommendations after real assisted errors and an independent $kind success", async scenario => {
  const { sql, scope } = fixture, sourceId = await backupRows(sql, scope).source(), courseId = randomUUID();
  await backupRows(sql, scope).chunk(sourceId);
  await sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES (${courseId},${scope.workspaceId},'Same-scope span',${courseId})`;
  await sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility)
    VALUES (${scope.workspaceId},${courseId},'source',${sourceId},'core','course')`;
  await createWorkspacePreferencesRepository(sql).setLearningPreferences(scope,
    { assessmentEnabled: true, retestSuggestionsEnabled: true, automaticRemindersEnabled: false });
  const now = new Date().toISOString();
  await sql`UPDATE workspace_preferences SET adaptive_planning=${sql.json({ ...DEFAULT_OPENING_ADAPTIVE_PREFS,
    spanTutorGrants: { [courseId]: { enabled: true, dailyMinutes: 180, revision: 1, confirmedAt: now, updatedAt: now, expiresOn: null } } })}
    WHERE workspace_id=${scope.workspaceId}`;
  const lesson = await createOpeningSpanSessionRepository(sql).create(scope,
    { courseId, sourceIds: [sourceId], intent: DEFAULT_STUDY_SESSION_INTENT, clientKey: randomUUID() });
  const attempts = createOpeningAttemptService(sql);
  const create = (problemId: string) => attempts.create(scope, { sessionId: lesson.sessionId, clientKey: randomUUID(),
    spanExercise: { sourceId, problemId, version: 1 } });
  const submit = (id: string, answer: unknown) => attempts.submit(scope, id, { clientKey: randomUUID(),
    answer: JSON.stringify(answer), outcome: "unverified", assistance: "independent" });
  const ids: string[] = [];
  for (const problemId of scenario.errors) {
    const attempt = await create(problemId);
    expect(solveSpanProblem(attempt.spanExercise!).kind).toBe(scenario.kind);
    expect((await createSpanHintService(sql).read(scope, { attemptId: attempt.id, level: 1 })).exposureReceipt).toBeTruthy();
    const observation = await submit(attempt.id, { membership: "in_span", coefficients: ["999", "999"] });
    expect(observation).toMatchObject({ outcome: "incorrect", assistance: "hinted",
      serverEvaluation: { evaluatorVersion: "span-exact-v1", skills: { coefficients: "incorrect" } } });
    ids.push(observation.id);
  }
  const reader = createScopedOpeningSystemQueryReader(sql, scope);
  const query = () => reader(systemQueryRequestSchema.parse({ name: "recommendation", arguments: { courseId } }), new AbortController().signal);
  const teaching = async () => {
    const context = await createOpeningSpanTutorContextRepository(sql).read(scope,
      { courseId, sourceIds: [sourceId], sourceVersions: { [sourceId]: 1 }, question: "继续学习" });
    if (!context) throw new Error("expected real span context");
    return context.decisionInput;
  };
  const input = await teaching(), result = await query();
  expect(input.observations.map(row => row.id).sort()).toEqual([...ids].sort());
  expect(input.observations.every(row => row.errors?.some(error => error.source === "verified_steps" && error.label === "coefficients"))).toBe(true);
  const step = nextLearningStep(input);
  expect(step).toMatchObject({ activityKind: "full_explain", reasonCode: "repeated_assisted_error", focusObservationId: ids[1] });
  expect(result.data).toHaveLength(1);
  expect(result.data[0]?.evidenceIds).toEqual(input.observations.map(row => row.id));
  expect(nextLearningStep({ ...input, observations: input.observations.map(({ errors: _errors, ...row }) => row) }))
    .toMatchObject({ activityKind: "targeted_explain", reasonCode: "verified_incorrect" });
  // The system-query contract exposes the activity decision, not teaching phase metadata.
  const activityDecision = ({ activityKind, reasonCode, focusObservationId }: ReturnType<typeof nextLearningStep>) =>
    ({ activityKind, reasonCode, focusObservationId });
  expect(result.data[0]?.step).toEqual(activityDecision(step));
  expect(result.data[0]?.summary).toContain("获得帮助后仍多次在同一步骤出错");

  // A later real independent success resolves this segment; it must not keep recommending repeated-error remediation.
  const fresh = await create(scenario.success), problem = fresh.spanExercise!, solution = solveSpanProblem(problem);
  expect(solution.kind).toBe(scenario.kind);
  const answer = solution.kind === "none"
    ? { membership: "not_in_span", equation: problem, noSolutionWitness: ["-2", "1", "1"] }
    : { membership: "in_span", equation: problem, coefficients: solution.kind === "unique" ? solution.coefficients : [], coordinateChecks: problem.target };
  const success = await submit(fresh.id, answer);
  expect(success).toMatchObject({ outcome: "correct", assistance: "independent", eligibility: { verifiedCorrect: "yes", independentAttempt: "yes" } });
  const after = await teaching(), afterQuery = await query(), afterStep = nextLearningStep(after);
  expect(after.observations[0]?.id).toBe(success.id);
  expect(afterStep.reasonCode).not.toBe("repeated_assisted_error");
  expect(afterQuery.data[0]?.step).toEqual(activityDecision(afterStep));
}, 30_000);
