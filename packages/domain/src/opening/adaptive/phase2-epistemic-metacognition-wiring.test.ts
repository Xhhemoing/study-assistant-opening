import { expect, it } from "vitest";
import type { PlannedBlock, TaskItem } from "@aistudy/contracts";
import {
  buildLocalReplan, buildSkillBeliefTrajectory, compareLearnerShadowV2, nextLearningStep,
  nextLearningStepWithExperimentalBkt, planAdaptiveBellmanShadow, predictLearnerShadowV2,
  type LearnerStateFeature, type NextLearningStepInput, type SnapshotObservation,
} from "../../index";

const at = (day: number) => `2026-10-${String(day).padStart(2, "0")}T10:00:00.000Z`;
function head(id: string, day: number, fields: Partial<SnapshotObservation> = {}): SnapshotObservation {
  return { id, skillLabel: "Integration", requirementKey: "integrate", problemId: id, familyKey: id,
    itemVersionId: `item-${id}`, attemptedAt: at(day), verifiedCorrect: "yes", independentAttempt: "yes",
    usableForCurrentVersion: "yes", assistance: "independent", ...fields };
}
const decision = (observations: readonly SnapshotObservation[]): NextLearningStepInput => ({
  observations, wantsFullExplanation: false, status: "observed_independent",
});

it("requires independent verification after a lucky guess while preserving the due-retest rule", () => {
  const input = decision([head("guess", 2, { preAnswerConfidence: "guessing" })]);
  expect(nextLearningStep(input)).toMatchObject({ activityKind: "transfer_check", reasonCode: "correct_needs_independent_check",
    metacognitiveRoute: "lucky_guess_verification_probe", allowMasteryAdvance: false,
    pedagogicalDirective: { requireJustificationProbe: true } });
  expect(nextLearningStep({ ...input, dueRetest: true }).reasonCode).toBe("due_retest");
  const unconfirmed = decision([{ ...input.observations[0]!, independentAttempt: "unknown" }]);
  expect(nextLearningStep(unconfirmed)).toMatchObject({ metacognitiveRoute: "lucky_guess_verification_probe",
    allowMasteryAdvance: false, murphyBrier: { sampleCount: 0 } });
});

it.each([
  ["sure", "hypercorrection_counterexample"], ["guessing", "faded_worked_example"], ["unsure", "targeted_subgoal_cue"],
] as const)("keeps error handling and routes %s confidence to %s", (preAnswerConfidence, metacognitiveRoute) => {
  const wrong = head("wrong", 3, { preAnswerConfidence, verifiedCorrect: "no", hasValidIntermediateSteps: true });
  const repeat = head("repeat", 2, { problemId: "wrong", verifiedCorrect: "no", preAnswerConfidence: "sure" });
  const old = head("old-version", 1, { usableForCurrentVersion: "no", preAnswerConfidence: "guessing" });
  expect(nextLearningStep(decision([wrong, repeat, old]))).toMatchObject({
    activityKind: "targeted_explain", focusObservationId: "wrong", metacognitiveRoute,
    productiveFailureRecognized: true, effectiveFrustrationStreak: 0,
    pedagogicalDirective: { acknowledgeValidIntermediateSteps: true }, murphyBrier: { sampleCount: 1 },
  });
});

it("keeps repeated assisted error priority and excludes assisted and later confidence from calibration", () => {
  const errors: SnapshotObservation["errors"] = [{ observationId: "latest", label: "substitution", feedback: "incorrect", source: "verified_steps" }];
  const latest = head("latest", 4, { verifiedCorrect: "no", assistance: "hinted", independentAttempt: "no", errors, preAnswerConfidence: "sure" });
  const previous = head("previous", 3, { verifiedCorrect: "no", assistance: "revealed", independentAttempt: "no", errors });
  const repeat = head("repeat", 2, { problemId: "first", preAnswerConfidence: "sure" });
  expect(nextLearningStep(decision([latest, previous, repeat, head("first", 1)]))).toMatchObject({
    activityKind: "full_explain", reasonCode: "repeated_assisted_error", metacognitiveRoute: "hypercorrection_counterexample",
    murphyBrier: { sampleCount: 0 },
  });
});

function feature(row: SnapshotObservation, fields: Partial<LearnerStateFeature> = {}): LearnerStateFeature {
  return { observationId: row.id, attemptId: row.id, courseId: "math", requirementKey: row.requirementKey!,
    itemVersionId: row.itemVersionId!, skillLabel: row.skillLabel, attemptedAt: row.attemptedAt, recordedAt: row.attemptedAt,
    availability: "available", views: ["independent"], ordinal: 0, outcome: row.verifiedCorrect === "yes" ? "correct" : "incorrect",
    eligibility: { verifiedCorrect: row.verifiedCorrect, independentAttempt: row.independentAttempt, usableForCurrentVersion: "yes", reasonCodes: [] } as LearnerStateFeature["eligibility"],
    sourceIds: [], sourceVersions: {}, transfer: {} as LearnerStateFeature["transfer"], gaps: [],
    retention: { protocolId: null, earliestAt: null, recordedIntervalSupportCount: null, intervalExposureComplete: null }, ...fields };
}
const scope = { workspaceId: "workspace", learnerId: "learner", courseId: "math", requirementKey: "integrate", confirmedSkillVersion: 1 };

it("replays only comparable evidence known before the cutoff and leaves non-independent attempts at zero weight", () => {
  const first = head("first", 1), hinted = head("hinted", 2, { assistance: "hinted" });
  const repeated = head("repeated", 3, { problemId: "first" });
  const revealed = head("revealed", 4, { assistance: "revealed" });
  const ai = head("ai", 5), late = head("late", 6), impossible = head("reversed", 7), missing = head("missing", 8);
  const observations = [late, repeated, hinted, first, revealed, ai, impossible, missing];
  const features = [feature(first), feature(hinted), feature(repeated), feature(revealed),
    feature(ai, { eligibility: { ...feature(ai).eligibility, reasonCodes: ["ai_graded_correct"] } }),
    feature(late, { recordedAt: at(9) }), feature(impossible, { recordedAt: at(6) }), feature(missing, { recordedAt: null })];
  const result = buildSkillBeliefTrajectory({ scope, cutoff: at(9), observations, features });
  expect(result.steps.map(step => [step.observationId, step.omega])).toEqual([
    ["first", 1], ["hinted", 0], ["repeated", 0], ["revealed", 0], ["ai", 0],
  ]);
  expect(result.belief).toEqual(result.steps[0]?.belief);
  expect(result.belief.lastDirectRecallAtMs).toBe(Date.parse(at(1)));
});

it("produces a pre-attempt paired holdout and excludes target and propagated families from both sides", () => {
  const target = head("target", 1, { familyKey: "target-family" });
  const propagated = head("propagated", 2, { familyKey: "propagated-family" });
  const holdout = head("holdout", 3), later = head("later", 4, { familyKey: "holdout" });
  const lateGrade = head("late-grade", 2), unknownFamily = head("unknown-family", 2, { familyKey: null });
  const observations = [target, propagated, holdout, later, lateGrade, unknownFamily];
  const input = { scope, cutoff: at(5), observations, features: observations.map(row =>
    row === lateGrade ? feature(row, { recordedAt: at(5) }) : feature(row)),
    targetFamilyKeys: ["target-family"], propagatedFamilyKeys: ["propagated-family"] };
  const { rows, receipt } = compareLearnerShadowV2(input);
  expect(rows.map(row => row.observationId)).toEqual(["holdout", "later"]);
  expect(rows[0]?.predictions["smoothed-frequency"]).toBe(0.5);
  expect(rows[1]?.predictions["smoothed-frequency"]).toBe(0.5);
  expect(Object.keys(rows[0]!.predictions)).toEqual([
    "classical-bkt", "pfa", "smoothed-frequency", "ts-fsrs", "hsrs-fire-dcm-v1", "no-fire", "no-dcm",
  ]);
  expect(receipt).toMatchObject({ count: 2, excludedFamilyKeys: ["target-family", "propagated-family"] });
});

it("removes misconception signals from the no-DCM forecast and replays negative evidence", () => {
  const wrong = head("wrong", 1, { verifiedCorrect: "no", errors: [{ observationId: "wrong", label: "variable",
    feedback: "Incorrect substitution", source: "verified_steps", misconceptionId: "substitution" }] });
  const model = { itemId: "item", a: 1, b: 0, g: 0.25, l: 0.05, misconceptions: [{ id: "substitution", delta: 2 }] };
  const result = predictLearnerShadowV2({ scope, cutoff: at(2), features: [feature(wrong)], observations: [wrong],
    targetItemVersionId: "next-model", itemModelsByVersion: new Map([[wrong.itemVersionId!, model], ["next-model", model]]),
    misconceptionPrior: { misconceptionMass: [["substitution", 0.2]], otherMass: 0.8 }, targetFamilyKeys: [], propagatedFamilyKeys: [] });
  expect(result.belief.misconceptionMass[0]![1]).toBeGreaterThan(0.2);
  expect(result.predictions["hsrs-fire-dcm-v1"]).toBeLessThan(result.predictions["no-dcm"]);
});

it("bridges qualified FIRE credit into forecasts without moving the direct recall clock", () => {
  const own = head("own", 1), source = head("source", 20, { requirementKey: "apply-integrals" });
  const observations = [own, source];
  const input = { scope, cutoff: at(25), observations, features: observations.map(row => feature(row)),
    targetFamilyKeys: [], propagatedFamilyKeys: [] };
  const baseline = predictLearnerShadowV2(input);
  const credited = predictLearnerShadowV2({ ...input, fireEdgesByObservationId: new Map([[source.id,
    { sourceSkillVersion: 1, edgeWeight: 1, covered: true, stepPassed: true }]]) });
  expect(credited.belief.implicitLogCredit).toBeGreaterThan(0);
  expect(credited.belief.implicitLogCredit).toBeLessThanOrEqual(Math.log(1.2));
  expect(credited.belief.lastDirectRecallAtMs).toBe(baseline.belief.lastDirectRecallAtMs);
  expect(credited.directRetrievability).toBe(baseline.directRetrievability);
  expect(credited.effectiveRetrievability).toBeGreaterThan(baseline.effectiveRetrievability);
  expect(credited.predictions["no-fire"]).toBe(baseline.predictions["hsrs-fire-dcm-v1"]);
});

it("keeps the shadow advisory inside slot budgets and availability gates", () => {
  const result = planAdaptiveBellmanShadow({ horizonMinutes: 35, slotMinutes: 10, candidates: [
    { id: "long", durationMinutes: 21, utility: 0.6 }, { id: "short", durationMinutes: 10, utility: 1 },
    { id: "blocked", durationMinutes: 5, utility: 8, prerequisiteSatisfied: false },
    { id: "not-due", durationMinutes: 5, utility: 8, retestWindowOpen: false },
  ] });
  expect(result).toMatchObject({ actionIds: ["short"], deadlineHours: 72, explorationWeight: 0 });
});

it("offers opt-in shadow comparison without replacing the ordinary decision or an explicit request", () => {
  const row = head("sample", 1), input = decision([row]);
  const experiment = { enabled: true, cutoff: at(3), features: [feature(row)], excludedProblemIds: [],
    target: { courseId: scope.courseId, requirementKey: scope.requirementKey, problemId: "next", itemVersionId: "next-version" },
    epistemic: { workspaceId: scope.workspaceId, learnerId: scope.learnerId, confirmedSkillVersion: 1,
      targetFamilyKeys: ["next-family"], propagatedFamilyKeys: [] },
  };
  expect(nextLearningStepWithExperimentalBkt(input, experiment)).toMatchObject({ ruleDecision: nextLearningStep(input),
    experimentalAdvice: null, epistemicShadowComparison: { holdout: { count: 1 } } });
  expect(nextLearningStepWithExperimentalBkt({ ...input, wantsFullExplanation: true }, experiment)).not.toHaveProperty("epistemicShadowComparison");
});

const taskId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const time = (clock: string) => `2026-10-16T${clock}:00.000Z`;
const block = (n: number, start: string, end: string): PlannedBlock => ({ taskId: taskId(n), start: time(start), end: time(end), reason: "accepted" });
const task = (n: number): TaskItem => ({ id: taskId(n), version: 1, title: `Task ${n}`, minutes: 20, status: "pending", priority: 0, dueAt: null });

it("wraps a spinning task, preserves history and exact-start blocks, and reuses only freed future time", () => {
  const now = new Date(time("10:00"));
  const past = block(1, "09:00", "09:20"), active = block(1, "09:45", "10:35");
  const exactStart = block(3, "10:00", "10:15"), future = block(1, "10:35", "11:00");
  const events = ["09:50", "09:55", "10:00"].map(clock => ({ timestampMs: Date.parse(time(clock)),
    isCorrect: false, assisted: true, hasValidIntermediateSteps: false, dwellMs: 5 * 60_000, hintEscalations: 1 }));
  const input = { acceptedBlocks: [past, active, exactStart, future], tasks: [task(1), task(2), task(3)], now,
    constraints: [{ kind: "free" as const, start: time("08:00"), end: time("11:00") }], options: { localDate: "2026-10-16", timeZone: "UTC" } };
  const result = buildLocalReplan({ ...input, wheelSpinningGuard: { taskId: taskId(1), events } });
  expect(result.fixedBlocks).toEqual([past, { ...active, end: now.toISOString() }, exactStart]);
  expect(result.releasedTaskVersions).toEqual([{ id: taskId(1), version: 1, status: "pending" }]);
  expect(result.blocks.find(row => row.taskId === taskId(2))?.start).toBe(time("10:15"));
  expect(result).toMatchObject({ wheelSpinningCarryOverTaskIds: [taskId(1)], microConsolidationPlan: { durationMinMinutes: 2, durationMaxMinutes: 3 } });
  expect(buildLocalReplan({ ...input, wheelSpinningGuard: { taskId: taskId(1),
    events: events.map((event, index) => ({ ...event, hasValidIntermediateSteps: index === 2 })) } })).toEqual(buildLocalReplan(input));
});
