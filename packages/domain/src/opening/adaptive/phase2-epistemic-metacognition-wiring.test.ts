import { expect, it } from "vitest";
import type { PlannedBlock, TaskItem } from "@aistudy/contracts";
import {
  assembleLearnerState, buildLocalReplan, buildSkillBeliefTrajectory, compareLearnerShadowV2, createSkillBelief, evaluateWheelSpinningGuard, nextLearningStep,
  nextLearningStepWithExperimentalBkt, planAdaptiveBellmanShadow, predictLearnerShadowV2,
  type LearnerStateFeature, type NextLearningStepInput, type SnapshotObservation,
} from "../../index";
import { createCartridgeRegistry } from "../cartridges/registry";
import type { CartridgeEvidenceInput } from "../evidence-eligibility";
import type { CourseEvidence, ObservationEligibilityInput } from "../learning-summary";
import { learningObservation, qualifiedInput } from "../learning-summary-fixtures";
import { toSnapshotEvidence } from "./snapshot-evidence";

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

it("counts prior-version attempts when inferring first-submission provenance for calibration", () => {
  const old = head("old", 1, { problemId: "revised", usableForCurrentVersion: "no" });
  const retry = head("retry", 2, { problemId: "revised", preAnswerConfidence: "sure" });
  expect(nextLearningStep(decision([retry, old])).murphyBrier).toMatchObject({
    totalInputCount: 1, sampleCount: 0, excludedAssistedOrRepeatCount: 1,
  });
});

it("excludes conflicting explicit first-submission claims from calibration in either order", () => {
  const first = head("first", 1, { problemId: "shared", preAnswerConfidence: "sure", isFirstSubmission: true });
  const conflict = head("conflict", 2, { problemId: "shared", preAnswerConfidence: "guessing", isFirstSubmission: true });
  for (const observations of [[first, conflict], [conflict, first]]) {
    expect(nextLearningStep(decision(observations)).murphyBrier).toMatchObject({
      totalInputCount: 2, sampleCount: 0, excludedAssistedOrRepeatCount: 2,
    });
  }
});

it("requires an unambiguous earliest calibration attempt across version states", () => {
  const current = head("current", 2, { problemId: "revised", preAnswerConfidence: "sure", isFirstSubmission: true });
  const old = head("old", 1, { problemId: "revised", usableForCurrentVersion: "no", isFirstSubmission: true });
  expect(nextLearningStep(decision([current])).murphyBrier).toMatchObject({ sampleCount: 1 });
  for (const [scenario, historical] of [
    ["earlier explicit claim", old],
    ["later explicit claim", { ...old, attemptedAt: at(3) }],
    ["earlier unmarked attempt", { ...old, isFirstSubmission: undefined }],
    ["tied unmarked attempt", { ...old, attemptedAt: current.attemptedAt, isFirstSubmission: undefined }],
  ] as const) {
    expect(nextLearningStep(decision([current, historical])).murphyBrier, scenario).toMatchObject({
      totalInputCount: 1, sampleCount: 0, excludedAssistedOrRepeatCount: 1,
    });
  }
});

function feature(row: SnapshotObservation, fields: Partial<LearnerStateFeature> = {}): LearnerStateFeature {
  const views: LearnerStateFeature["views"] = row.independentAttempt === "yes" ? ["independent"] : [];
  if (row.assistance === "hinted" || row.assistance === "revealed") views.push("help");
  return { observationId: row.id, attemptId: row.id, courseId: "math", requirementKey: row.requirementKey!,
    itemVersionId: row.itemVersionId!, skillLabel: row.skillLabel, attemptedAt: row.attemptedAt, recordedAt: row.attemptedAt,
    availability: "available", views, ordinal: 0, outcome: row.verifiedCorrect === "yes" ? "correct" : "incorrect",
    eligibility: { verifiedCorrect: row.verifiedCorrect, independentAttempt: row.independentAttempt,
      usableForCurrentVersion: row.usableForCurrentVersion ?? "unknown", reasonCodes: [] } as LearnerStateFeature["eligibility"],
    sourceIds: [], sourceVersions: {}, transfer: {} as LearnerStateFeature["transfer"], gaps: [],
    retention: { protocolId: null, earliestAt: null, recordedIntervalSupportCount: null, intervalExposureComplete: null }, ...fields };
}
const scope = { workspaceId: "workspace", learnerId: "learner", courseId: "math", requirementKey: "integrate", confirmedSkillVersion: 1 };

type ProducedAttempt = SnapshotObservation & {
  startedAt?: number | null;
  context?: Partial<ObservationEligibilityInput["context"]>;
};

function projectProducedAttempts(rows: readonly ProducedAttempt[], cutoff: string, {
  untimestamped = true, cartridgeEvidence,
}: { untimestamped?: boolean; cartridgeEvidence?: CartridgeEvidenceInput } = {}) {
  const evidence: CourseEvidence = { observations: [], evidenceContexts: {} };
  const { context } = qualifiedInput;
  for (const row of rows) {
    const { id, skillLabel, attemptedAt, assistance } = row;
    const attemptId = `attempt-${id}`, problemId = row.problemId!, itemVersionId = row.itemVersionId ?? null;
    const submittedAt = Date.parse(attemptedAt);
    const { startedAt = submittedAt - 60_000 } = row;
    evidence.observations.push({ ...learningObservation, id, courseId: scope.courseId, skillLabel, attemptId, problemId,
      itemVersionId, assistance, occurredAt: attemptedAt, recordedAt: row.recordedAt ?? attemptedAt });
    evidence.evidenceContexts[id] = {
      observation: { ...qualifiedInput.observation, observationId: id, courseId: scope.courseId, requirementKey: row.requirementKey ?? null,
        attemptId, problemId, itemVersionId, assistance, submittedAt, startedAt },
      context: { helpHistory: { complete: true, exposures: [] }, referenceCheckAuthority: context.referenceCheckAuthority,
        referenceCheck: { ...context.referenceCheck!, attemptId, problemId, itemVersionId },
        version: { applicability: "exact", currentItemVersionId: itemVersionId }, ...row.context },
    };
  }
  const familyKeys = new Map(rows.map(row => [row.id, row.familyKey]));
  const observations = toSnapshotEvidence(evidence, new Date(cutoff)).observations
    .map(({ recordedAt, ...observation }) => ({
      ...observation, ...(!untimestamped && recordedAt !== undefined ? { recordedAt } : {}), familyKey: familyKeys.get(observation.id),
    }));
  const { features } = assembleLearnerState({ evidence, dataAsOf: cutoff, stateVersion: "test", cartridgeEvidence });
  return { scope, cutoff, observations, features };
}

it("replays both producer attempts when the display label uses different casing and whitespace", () => {
  const input = projectProducedAttempts([head("first", 1), head("second", 2, { skillLabel: " integration " })], at(3));
  expect(input.observations.map(row => row.skillLabel)).toEqual(["Integration", "Integration"]);
  expect(input.features.map(row => row.skillLabel)).toEqual(["Integration", " integration "]);
  expect(buildSkillBeliefTrajectory(input).steps.map(step => [step.observationId, step.omega])).toEqual([
    ["first", 1], ["second", 1],
  ]);
});

it.each([
  ["a retry of the same problem", "shared-problem", 0],
  ["a different problem in the same family", "new-problem", 1],
] as const)("retains a declared hint without delivered help before %s", (_scenario, problemId, expectedWeight) => {
  const first = head("hint", 1, { problemId: "shared-problem", familyKey: "shared-family", assistance: "hinted" });
  const second = head("independent", 2, { problemId, familyKey: "shared-family" });
  const input = projectProducedAttempts([first, second], at(3));
  expect(input.observations[0]).toMatchObject({ assistance: "hinted", independentAttempt: "no" });
  expect(input.features[0]).toMatchObject({ views: [], eligibility: { reasonCodes: expect.arrayContaining(["declared_help"]) } });
  const result = buildSkillBeliefTrajectory(input);
  expect(result.steps.map(step => [step.observationId, step.omega])).toEqual([["hint", 0], ["independent", expectedWeight]]);
  expect(result.belief.lastDirectRecallAtMs).toBeNull();
});

it.each([
  { projection: "timestamped", untimestamped: false },
  { projection: "untimestamped", untimestamped: true },
])("preserves the first hinted exposure across a later $projection correction", ({ untimestamped }) => {
  const first = head("first", 1, { problemId: "shared-problem", familyKey: "shared-family", assistance: "hinted" });
  const retry = head("retry", 2, { problemId: first.problemId, familyKey: first.familyKey });
  const input = { ...projectProducedAttempts([first, retry], at(3), { untimestamped }), targetFamilyKeys: [], propagatedFamilyKeys: [] };
  // The producer has one context per ID, so project the historical head and its correction separately.
  const correction = projectProducedAttempts([{ ...first, assistance: "revealed", recordedAt: at(4) }], at(5), { untimestamped });
  expect(input.observations[0]).toMatchObject({ assistance: "hinted", independentAttempt: "no" });
  expect(input.features[1]?.eligibility).toMatchObject({ independentAttempt: "yes", verifiedCorrect: "yes" });
  expect(correction.observations[0]).toMatchObject({ assistance: "revealed", independentAttempt: "no" });
  expect(correction.features[0]?.recordedAt).toBe(at(4));
  const appended = { ...input, observations: [...input.observations, ...correction.observations],
    features: [...input.features, ...correction.features] };

  expect(predictLearnerShadowV2(appended)).toEqual(predictLearnerShadowV2(input));
  expect(buildSkillBeliefTrajectory(appended)).toEqual(buildSkillBeliefTrajectory(input));
  expect(compareLearnerShadowV2(appended)).toEqual(compareLearnerShadowV2(input));
  for (const prefix of [input, appended, { ...appended, cutoff: at(5) }]) {
    expect(buildSkillBeliefTrajectory(prefix).steps.map(step => [step.observationId, step.omega])).toEqual([
      ["first", 0], ["retry", 0],
    ]);
    expect(compareLearnerShadowV2(prefix).rows).toEqual([]);
  }
  if (untimestamped) expect(correction.observations[0]).not.toHaveProperty("recordedAt");
  else expect(correction.observations[0]).toHaveProperty("recordedAt", at(4));
});

it("keeps a cartridge-withheld grade and the later retry out of the holdout", () => {
  const first = head("first", 1);
  const retry = head("retry", 2, { problemId: first.problemId, familyKey: first.familyKey });
  const input = { ...projectProducedAttempts([first, retry], at(3), {
    cartridgeEvidence: { registry: createCartridgeRegistry(), emissions: {
      first: { cartridgeId: "unregistered", cartridgeVersion: "1", probeId: "probe", response: "correct" },
    } },
  }), targetFamilyKeys: [], propagatedFamilyKeys: [] };

  expect(input.observations[0]).toMatchObject({ verifiedCorrect: "yes", independentAttempt: "yes" });
  expect(input.features[0]?.eligibility.verifiedCorrect).toBe("unknown");
  expect(input.features[0]?.gaps).toContain("cartridge_evidence_not_qualified");
  expect(input.features[1]?.eligibility).toMatchObject({ verifiedCorrect: "yes", independentAttempt: "yes" });
  expect(buildSkillBeliefTrajectory(input).steps.map(step => [step.observationId, step.omega])).toEqual([
    ["first", 0], ["retry", 0],
  ]);
  expect(compareLearnerShadowV2(input).rows).toEqual([]);
});

it.each(["independent", "hinted"] as const)("blocks a cross-requirement retry after a cartridge-withheld %s attempt", assistance => {
  const first = head("first", 1, { requirementKey: "A", assistance });
  const retry = head("retry", 2, { requirementKey: "B", problemId: first.problemId, familyKey: first.familyKey });
  const input = { ...projectProducedAttempts([first, retry], at(3), {
    cartridgeEvidence: { registry: createCartridgeRegistry(), emissions: {
      first: { cartridgeId: "unregistered", cartridgeVersion: "1", probeId: "probe", response: "correct" },
    } },
  }), scope: { ...scope, requirementKey: "B" }, targetFamilyKeys: [], propagatedFamilyKeys: [] };

  expect(input.observations[0]).toMatchObject({ requirementKey: "A", assistance, verifiedCorrect: "yes" });
  expect(input.features[0]).toMatchObject({ requirementKey: "A", eligibility: { verifiedCorrect: "unknown" },
    gaps: expect.arrayContaining(["cartridge_evidence_not_qualified"]) });
  expect(input.features[1]).toMatchObject({ requirementKey: "B", eligibility: { verifiedCorrect: "yes", independentAttempt: "yes" } });
  expect(buildSkillBeliefTrajectory(input).steps).toMatchObject([{ observationId: retry.id, omega: 0 }]);
  expect(compareLearnerShadowV2(input).rows).toEqual([]);
});

it.each([
  { scenario: "a missing requirement", requirementKey: null, revisionRequirementKey: null },
  { scenario: "conflicting requirements", requirementKey: "A", revisionRequirementKey: "B" },
])("retains prior problem exposure with $scenario", ({ requirementKey, revisionRequirementKey }) => {
  const first = head("first", 1, { recordedAt: at(1), requirementKey });
  const revision = { ...first, requirementKey: revisionRequirementKey };
  const retry = head("retry", 2, { problemId: first.problemId, familyKey: first.familyKey });
  const input = { scope, cutoff: at(3), observations: [first, revision, retry], features: [feature(first), feature(retry)],
    targetFamilyKeys: [], propagatedFamilyKeys: [] };

  expect(buildSkillBeliefTrajectory(input).steps).toMatchObject([{ observationId: retry.id, omega: 0 }]);
  expect(compareLearnerShadowV2(input).rows).toEqual([]);
});

it.each([
  { scenario: "share one attempt with A sorting first", ids: ["a", "z"], attemptIds: ["shared", "shared"], omega: 1 },
  { scenario: "share one attempt with B sorting first", ids: ["z", "a"], attemptIds: ["shared", "shared"], omega: 1 },
  { scenario: "have distinct attempts", ids: ["a", "z"], attemptIds: ["one", "two"], omega: 0 },
  { scenario: "have no attempt IDs", ids: ["a", "z"], attemptIds: [null, null], omega: 0 },
] as const)("credits simultaneous requirement heads only when they $scenario", ({ ids, attemptIds, omega }) => {
  const shared = { problemId: "shared-problem", familyKey: "shared-family" };
  const skillA = head(ids[0], 1, { ...shared, requirementKey: "A" });
  const skillB = head(ids[1], 1, { ...shared, requirementKey: "B" });
  const retry = head("retry", 2, { ...shared, requirementKey: "B" });
  const input = { scope, cutoff: at(3), observations: [retry, skillB, skillA],
    features: [feature(skillA, { attemptId: attemptIds[0] }), feature(skillB, { attemptId: attemptIds[1] }), feature(retry)],
    targetFamilyKeys: [], propagatedFamilyKeys: [] };

  for (const observation of [skillA, skillB]) {
    const perSkill = { ...input, scope: { ...scope, requirementKey: observation.requirementKey! } };
    const result = buildSkillBeliefTrajectory(perSkill);
    const expectedSteps = [{ observationId: observation.id, omega }];
    if (observation === skillB) expectedSteps.push({ observationId: retry.id, omega: 0 });
    expect(result.steps).toMatchObject(expectedSteps);
    expect(result.belief.lastDirectRecallAtMs, observation.requirementKey!).toBe(omega === 1 ? Date.parse(at(1)) : null);
    expect(compareLearnerShadowV2(perSkill).rows.map(row => row.observationId)).toEqual(omega === 1 ? [observation.id] : []);
  }
});

it("excludes duplicate requirement heads from replay and holdout in a shared submission", () => {
  const shared = { problemId: "shared-problem", familyKey: "shared-family" };
  const firstA = head("first-a", 1, { ...shared, requirementKey: "A" });
  const secondA = head("second-a", 1, { ...shared, requirementKey: "A" });
  const skillB = head("skill-b", 1, { ...shared, requirementKey: "B" });
  const observations = [firstA, skillB, secondA];
  const input = { scope: { ...scope, requirementKey: "A" }, cutoff: at(2), observations,
    features: observations.map(row => feature(row, { attemptId: "shared" })), targetFamilyKeys: [], propagatedFamilyKeys: [] };

  expect(buildSkillBeliefTrajectory(input).steps).toMatchObject([
    { observationId: firstA.id, omega: 0 }, { observationId: secondA.id, omega: 0 },
  ]);
  expect(compareLearnerShadowV2(input).rows).toEqual([]);
  const otherSkill = { ...input, scope: { ...scope, requirementKey: "B" } };
  const result = buildSkillBeliefTrajectory(otherSkill);
  expect(result.steps).toMatchObject([{ observationId: skillB.id, omega: 1 }]);
  expect(result.belief.lastDirectRecallAtMs).toBe(Date.parse(at(1)));
  expect(compareLearnerShadowV2(otherSkill).rows.map(row => row.observationId)).toEqual([skillB.id]);
});

it.each([
  { kind: "conflicting", exposureId: "a", answerId: "z" },
  { kind: "conflicting", exposureId: "z", answerId: "a" },
  { kind: "hinted", exposureId: "a", answerId: "z" },
  { kind: "hinted", exposureId: "z", answerId: "a" },
] as const)("counts a tied $kind exposure ($exposureId) before a separate submission ($answerId)", ({
  kind, exposureId, answerId,
}) => {
  const exposure = head(exposureId, 1, { requirementKey: "A", familyKey: "shared-family",
    ...(kind === "hinted" ? { assistance: "hinted", independentAttempt: "no" } : {}) });
  const answer = head(answerId, 1, { familyKey: "shared-family" });
  const observations = kind === "conflicting" ? [answer, exposure, { ...exposure, problemId: "conflicting-problem" }] : [answer, exposure];
  const result = buildSkillBeliefTrajectory({ scope, cutoff: at(2), observations, features: [feature(answer), feature(exposure)] });

  expect(result.steps).toMatchObject([{ observationId: answer.id, omega: 1 }]);
  expect(result.belief.lastDirectRecallAtMs).toBeNull();
});

const priorAnswerHelp = { complete: true, exposures: [{ attemptId: "earlier-attempt", problemId: "shared-problem",
  level: "revealed", delivered: true, deliveredAt: Date.parse(at(1)) - 120_000 }] } as const;

it.each([
  { scenario: "a prior answer exposure with a seen exam family", attempt: { context: {
    helpHistory: priorAnswerHelp, examAttempt: { firstFamilyExposure: false, lessonAssistance: false, partialExample: false, answerUnchanged: true },
  } }, independence: "no", reasons: ["prior_answer_exposure", "exam_family_already_seen"] },
  { scenario: "a prior answer exposure with a current hint", attempt: { assistance: "hinted", context: { helpHistory: priorAnswerHelp } },
    independence: "no", reasons: ["prior_answer_exposure", "declared_help"] },
  { scenario: "server-ordered help with missing start time", attempt: { startedAt: null, context: {
    helpHistory: { complete: true, exposures: [{ attemptId: "attempt-first", problemId: "shared-problem",
      level: "hinted", delivered: true, serverOrder: "before_answer" }] },
  } }, independence: "no", reasons: ["help_before_submission", "attempt_timing_unknown"] },
  { scenario: "a hint with an incomplete observation identity", attempt: { itemVersionId: null, assistance: "hinted" },
    independence: "unknown", reasons: ["observation_identity_incomplete"] },
] as const)("retains first-submission history for $scenario", ({ attempt, independence, reasons }) => {
  const first = { ...head("first", 1, { problemId: "shared-problem", familyKey: "shared-family" }), ...attempt };
  const retry = head("retry", 2, { problemId: first.problemId, familyKey: first.familyKey });
  const input = projectProducedAttempts([first, retry], at(3));

  expect(input.observations[0]).toMatchObject({ assistance: first.assistance, itemVersionId: first.itemVersionId, independentAttempt: independence });
  expect(input.features[0]?.eligibility.reasonCodes).toEqual(expect.arrayContaining(reasons));
  const result = buildSkillBeliefTrajectory(input);
  expect(result.steps.map(step => [step.observationId, step.omega])).toEqual([["first", 0], ["retry", 0]]);
  expect(result.belief.lastDirectRecallAtMs).toBeNull();
});

it("copies only misconception mass from a structurally compatible prior belief", () => {
  const misconceptionPrior = createSkillBelief({ workspaceId: "other-workspace", learnerId: "other-learner",
    courseId: "other-course", confirmedSkillVersion: 7, abilityMean: 2, logStability: 4, lastDirectRecallAtMs: Date.parse(at(1)),
    misconceptionMass: [["substitution", 0.25]], otherMass: 0.75 });
  const { belief } = buildSkillBeliefTrajectory({ scope, cutoff: at(2), observations: [], features: [], misconceptionPrior });
  expect(belief).toMatchObject({ workspaceId: scope.workspaceId, learnerId: scope.learnerId, courseId: scope.courseId,
    confirmedSkillVersion: 1, abilityMean: 0, logStability: Math.log(10), lastDirectRecallAtMs: null,
    misconceptionMass: [["substitution", 0.25]], otherMass: 0.75 });
});

it("projects scope identity without carrying saved belief state into forecasts or FIRE replay", () => {
  const savedBelief = createSkillBelief({ ...scope, abilityMean: 2, abilityVariance: 3, logStability: 4,
    lastDirectRecallAtMs: Date.parse(at(9)), implicitLogCredit: 0.1, misconceptionMass: [["substitution", 0.8]], otherMass: 0.2 });
  const savedScope = { ...savedBelief, requirementKey: scope.requirementKey };
  const own = head("own", 1), source = head("source", 4, { requirementKey: "apply-integrals" });
  const input = { scope, cutoff: at(5), observations: [own, source], features: [feature(own), feature(source)],
    targetFamilyKeys: [], propagatedFamilyKeys: [], misconceptionPrior: { misconceptionMass: [], otherMass: 1 },
    fireEdgesByObservationId: new Map([[source.id, { sourceSkillVersion: 2, edgeWeight: 1, covered: true, stepPassed: true }]]) };
  const empty = { ...input, observations: [], features: [] };
  const fresh = predictLearnerShadowV2(empty);
  expect(fresh.belief.lastDirectRecallAtMs).toBeNull();
  expect(predictLearnerShadowV2({ ...empty, scope: savedScope })).toEqual(fresh);
  const credited = predictLearnerShadowV2(input);
  expect(credited.belief.implicitLogCredit).toBeGreaterThan(0);
  expect(predictLearnerShadowV2({ ...input, scope: savedScope })).toEqual(credited);
});

it("deduplicates records only once they are visible at a forecast cutoff", () => {
  const original = head("original", 2), featureOnly = head("feature-only", 2), problem = head("problem", 2);
  const replacement = { ...head("original", 3), recordedAt: at(3) };
  const backdated = head("backdated", 1, { problemId: problem.problemId });
  const observations = [original, featureOnly, problem];
  const input = { scope, cutoff: at(3), observations, features: observations.map(row => feature(row)),
    targetFamilyKeys: [], propagatedFamilyKeys: [] };
  const appended = { ...input, observations: [...observations, replacement, backdated], features: [...input.features,
    feature(replacement), feature(featureOnly, { recordedAt: at(4) }), feature(backdated, { recordedAt: at(4) })] };

  expect(predictLearnerShadowV2(input).evidenceObservationIds).toEqual(["feature-only", "original", "problem"]);
  expect(predictLearnerShadowV2(appended)).toEqual(predictLearnerShadowV2(input));
  expect(predictLearnerShadowV2({ ...appended, cutoff: at(5) }).evidenceObservationIds).toEqual(["backdated"]);
});

it("binds untimestamped heads to matching visible versions and outcomes before resolving duplicates", () => {
  const evidence = head("evidence", 1, { errors: [{ observationId: "evidence", label: "variable", feedback: "Use the original variable",
    source: "verified_steps" }] });
  const holdout = head("holdout", 3);
  const { familyKey, ...fields } = evidence;
  const copy = { familyKey, ...fields, errors: evidence.errors?.map(error => ({ ...error })) };
  const input = { scope, cutoff: at(3), observations: [evidence, holdout], features: [feature(evidence), feature(holdout)],
    targetFamilyKeys: [], propagatedFamilyKeys: [] };
  const forecast = predictLearnerShadowV2(input);
  expect(forecast.evidenceObservationIds).toEqual([evidence.id]);
  expect(predictLearnerShadowV2({ ...input, observations: [...input.observations, copy] })).toEqual(forecast);
  const conflict = { ...evidence, familyKey: "other-family" };
  expect(predictLearnerShadowV2({ ...input, observations: [...input.observations, conflict] }).evidenceObservationIds).toEqual([]);
  const holdoutForecast = compareLearnerShadowV2({ ...input, cutoff: at(4) }).rows.find(row => row.observationId === holdout.id);
  expect(holdoutForecast?.predictions["smoothed-frequency"]).toBeCloseTo(2 / 3);
  for (const revision of [{ ...evidence, itemVersionId: "revised-version" }, { ...evidence, verifiedCorrect: "no" as const }]) {
    const appended = { ...input, observations: [...input.observations, revision],
      features: [...input.features, feature(revision, { recordedAt: at(3) })] };
    expect(predictLearnerShadowV2(appended)).toEqual(forecast);
    expect(compareLearnerShadowV2({ ...appended, cutoff: at(4) }).rows).toEqual([holdoutForecast]);
  }
});

it.each([
  ["independence", { independentAttempt: "no" }],
  ["hint exposure", { assistance: "hinted" }],
  ["solution exposure", { assistance: "revealed" }],
  ["unknown assistance", { assistance: "unknown" }],
  ["version usability", { usableForCurrentVersion: "no" }],
  ["requirement", { requirementKey: "apply-integrals" }],
  ["skill label", { skillLabel: "Integral applications" }],
] as const)("preserves the day-2 forecast when an untimestamped %s correction is recorded on day 3", (_label, correction) => {
  const evidence = head("evidence", 1);
  const revision = { ...evidence, ...correction };
  const input = { scope, cutoff: at(2), observations: [evidence], features: [feature(evidence)],
    targetFamilyKeys: [], propagatedFamilyKeys: [] };
  const forecast = predictLearnerShadowV2(input);
  expect(forecast.evidenceObservationIds).toEqual([evidence.id]);
  expect(predictLearnerShadowV2({ ...input, observations: [evidence, revision],
    features: [...input.features, feature(revision, { recordedAt: at(3) })] })).toEqual(forecast);
});

it("preserves verified day-1 evidence when a day-3 untimestamped head omits version usability", () => {
  const evidence = head("evidence", 1);
  const { usableForCurrentVersion, ...revision } = evidence;
  expect(usableForCurrentVersion).toBe("yes");
  const input = { scope, cutoff: at(2), observations: [evidence, revision],
    features: [feature(evidence), feature(revision, { recordedAt: at(3) })], targetFamilyKeys: [], propagatedFamilyKeys: [] };
  expect(predictLearnerShadowV2(input).evidenceObservationIds).toEqual([evidence.id]);
  expect(buildSkillBeliefTrajectory({ ...input, cutoff: at(4), features: [input.features[1]!] }).steps)
    .toMatchObject([{ observationId: evidence.id, omega: 0 }]);
});

it.each([
  ["declared_help", "hinted", "independent"],
  ["declared_help", "hinted", "unknown"],
  ["help_before_submission", "hinted", "independent"],
  ["prior_evaluation_feedback", "hinted", "independent"],
  ["exam_lesson_assistance", "hinted", "independent"],
  ["exam_partial_example_exposure", "hinted", "independent"],
  ["self_reported_copied_answer", "revealed", "hinted"],
] as const)("uses %s to keep an incompatible untimestamped head from erasing exposure history", (reason, assistance, incompatible) => {
  const exposure = head("exposure", 1, { assistance, independentAttempt: "no" });
  const otherHead = { ...exposure, assistance: incompatible, problemId: "different-problem", familyKey: "different-family" };
  const visible = feature(exposure);
  visible.eligibility.reasonCodes = [reason];
  const retry = head("retry", 2, { problemId: exposure.problemId, familyKey: exposure.familyKey });
  const result = buildSkillBeliefTrajectory({ scope, cutoff: at(3), observations: [exposure, otherHead, retry],
    features: [visible, feature(retry)] });
  expect(result.steps.map(step => [step.observationId, step.omega])).toEqual([["exposure", 0], ["retry", 0]]);
});

it("retains independent attempt history when the help view reflects post-answer feedback", () => {
  const first = head("first", 1);
  const retry = head("retry", 2, { problemId: first.problemId, familyKey: first.familyKey });
  const result = buildSkillBeliefTrajectory({ scope, cutoff: at(3), observations: [first, retry],
    features: [feature(first, { views: ["independent", "help"] }), feature(retry)] });
  expect(result.steps.map(step => [step.observationId, step.omega])).toEqual([["first", 0], ["retry", 0]]);
});

it("preserves walk-forward prefixes when a duplicate head becomes visible at the held-out attempt", () => {
  const evidence = head("evidence", 1), holdout = head("holdout", 3);
  const replacement = { ...evidence, recordedAt: at(3), verifiedCorrect: "no" as const };
  const observations = [evidence, holdout];
  const input = { scope, cutoff: at(4), observations, features: observations.map(row => feature(row)),
    targetFamilyKeys: [], propagatedFamilyKeys: [] };
  const { rows } = compareLearnerShadowV2(input);
  expect(rows.find(row => row.observationId === holdout.id)?.predictions["smoothed-frequency"]).toBeCloseTo(2 / 3);
  const appended = compareLearnerShadowV2({ ...input, observations: [...observations, replacement],
    features: [...input.features, feature(replacement, { recordedAt: at(3) })] });
  expect(appended.rows).toEqual(rows.filter(row => row.observationId === holdout.id));
});

it("records visible family exposures without problem IDs before evaluating direct recall", () => {
  const exposure = head("hint", 1, { familyKey: "shared", problemId: null, assistance: "hinted", independentAttempt: "no" });
  const independent = head("independent", 2, { familyKey: "shared" });
  const input = { scope, cutoff: at(3), observations: [independent, exposure], features: [feature(independent), feature(exposure)] };
  const visible = buildSkillBeliefTrajectory(input);
  expect(visible.steps.map(step => [step.observationId, step.omega])).toEqual([[independent.id, 1]]);
  expect(visible.belief.lastDirectRecallAtMs).toBeNull();
  const late = buildSkillBeliefTrajectory({ ...input, features: [feature(independent), feature(exposure, { recordedAt: at(3) })] });
  expect(late.belief.lastDirectRecallAtMs).toBe(Date.parse(at(2)));
});

it.each([
  { identity: "problem", revision: { familyKey: "other-family" }, weight: 0, lastRecallAtMs: null },
  { identity: "family", revision: { problemId: "other-problem" }, weight: 1, lastRecallAtMs: null },
  { identity: "neither", revision: { problemId: "other-problem", familyKey: "other-family" }, weight: 1,
    lastRecallAtMs: Date.parse(at(2)) },
])("tracks only the agreed $identity identity when observation heads conflict", ({ revision, weight, lastRecallAtMs }) => {
  const first = head("first", 1);
  const retry = head("retry", 2, { problemId: first.problemId, familyKey: first.familyKey });
  const result = buildSkillBeliefTrajectory({ scope, cutoff: at(3), observations: [first, { ...first, ...revision }, retry],
    features: [feature(first), feature(retry)] });
  expect(result.steps.map(step => [step.observationId, step.omega])).toEqual(
    weight === 0 ? [["first", 0], ["retry", 0]] : [["retry", 1]],
  );
  expect(result.belief.lastDirectRecallAtMs).toBe(lastRecallAtMs);
});

it.each([
  { scenario: "both records of the revision are visible", revisionFeature: true, revisionObservation: true },
  { scenario: "only the revision observation is visible", revisionFeature: false, revisionObservation: true },
  { scenario: "only the revision feature is visible", revisionFeature: true, revisionObservation: false },
])("retains problem and family exposure at the later conflicting attempt time when $scenario", ({ revisionFeature, revisionObservation }) => {
  const first = head("first", 1, { recordedAt: at(1) });
  const revision = { ...first, attemptedAt: at(2), recordedAt: at(2) };
  const retry = head("retry", 3, { problemId: first.problemId, familyKey: first.familyKey });
  const priorFeatures = revisionFeature ? [feature(first), feature(revision)] : [feature(first)];
  const priorObservations = revisionObservation ? [first, revision] : [first];
  const input = { scope, cutoff: at(4), observations: [...priorObservations, retry], features: [...priorFeatures, feature(retry)],
    targetFamilyKeys: [], propagatedFamilyKeys: [] };
  const result = buildSkillBeliefTrajectory(input);
  expect(result.steps).toMatchObject([{ observationId: first.id, omega: 0 }, { observationId: retry.id, omega: 0 }]);
  expect(result.belief.lastDirectRecallAtMs).toBeNull();
  expect(compareLearnerShadowV2(input).rows).toEqual([]);

  const tiedRetry = { ...retry, attemptedAt: at(2) };
  const tie = { ...input, observations: [...priorObservations, tiedRetry], features: [...priorFeatures, feature(tiedRetry)] };
  expect(buildSkillBeliefTrajectory(tie).steps).toMatchObject([{ observationId: first.id, omega: 0 }, { observationId: retry.id, omega: 0 }]);
  expect(compareLearnerShadowV2(tie).rows).toEqual([]);

  const between = { ...retry, attemptedAt: "2026-10-01T11:00:00.000Z" };
  const betweenResult = buildSkillBeliefTrajectory({ ...input, observations: [...priorObservations, between],
    features: [...priorFeatures, feature(between)] });
  expect(betweenResult.steps).toMatchObject([{ observationId: retry.id, omega: 1 }, { observationId: first.id, omega: 0 }]);

  const sameFamily = head("same-family", 3, { familyKey: first.familyKey });
  const familyResult = buildSkillBeliefTrajectory({ ...input, observations: [...input.observations, sameFamily],
    features: [...input.features, feature(sameFamily)] });
  expect(familyResult.steps.at(-1)).toMatchObject({ observationId: sameFamily.id, omega: 1 });
  expect(familyResult.belief.lastDirectRecallAtMs).toBeNull();
});

it.each([undefined, null, "", "   "])("does not refresh direct recall for a missing or blank family (%s)", familyKey => {
  const row = head("attempt", 1, { familyKey });
  const result = buildSkillBeliefTrajectory({ scope, cutoff: at(2), observations: [row], features: [feature(row)] });
  expect(result.steps[0]?.omega).toBe(1);
  expect(result.belief.lastDirectRecallAtMs).toBeNull();
  expect(result.belief.logStability).toBe(Math.log(10));
});

it.each([
  { assistance: "hinted", independentAttempt: "no" }, { assistance: "revealed", independentAttempt: "no" }, { usableForCurrentVersion: "no" },
] as const)("tracks an earlier family exposure even when it cannot update the belief (%j)", fields => {
  const exposure = head("exposure", 1, { ...fields, familyKey: "shared" });
  const independent = head("independent", 2, { familyKey: "shared" });
  const result = buildSkillBeliefTrajectory({ scope, cutoff: at(3), observations: [independent, exposure],
    features: [feature(independent), feature(exposure)] });
  expect(result.steps.map(step => step.omega)).toEqual([0, 1]);
  expect(result.belief.lastDirectRecallAtMs).toBeNull();
});

it("replays only comparable evidence known before the cutoff and leaves non-independent attempts at zero weight", () => {
  const first = head("first", 1), hinted = head("hinted", 2, { assistance: "hinted", independentAttempt: "no" });
  const repeated = head("repeated", 3, { problemId: "first" });
  const revealed = head("revealed", 4, { assistance: "revealed", independentAttempt: "no" });
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
const stalledEvents = (clocks: readonly string[]) => clocks.map(clock => ({ timestampMs: Date.parse(time(clock)),
  isCorrect: false, assisted: true, hasValidIntermediateSteps: false, dwellMs: 5 * 60_000, hintEscalations: 1 }));

it("keeps the 20-minute wheel-spinning window when the input carries extra runtime properties", () => {
  const now = new Date(time("10:00"));
  const input = { taskId: taskId(1), events: stalledEvents(["09:30", "09:35", "09:39"]), thresholds: { windowMs: 60 * 60_000 } };
  expect(evaluateWheelSpinningGuard(input, now)).toMatchObject({ triggered: false,
    metrics: { windowStartMs: Date.parse(time("09:40")), inWindowEventCount: 0, expiredEventCount: 3 } });
});

it("keeps a future-only reservation until the task has an active block or a confirmed session", () => {
  const now = new Date(time("10:00"));
  const past = block(1, "09:40", "10:00"), future = block(1, "11:00", "11:20");
  const input = { acceptedBlocks: [past, future], tasks: [task(1)], now, constraints: [],
    options: { localDate: "2026-10-16", timeZone: "UTC" } };
  const guard = { taskId: taskId(1), events: stalledEvents(["09:50", "09:55", "10:00"]) };
  expect(buildLocalReplan({ ...input, wheelSpinningGuard: guard })).toEqual(buildLocalReplan(input));

  const activeGuard = { ...guard, activeSession: true };
  expect(buildLocalReplan({ ...input, wheelSpinningGuard: activeGuard })).toMatchObject({ fixedBlocks: [past],
    releasedTaskVersions: [{ id: taskId(1), version: 1, status: "pending" }], wheelSpinningCarryOverTaskIds: [taskId(1)] });
});

it("releases an active reservation that starts exactly now and preserves other tasks' reservations", () => {
  const now = new Date(time("10:00"));
  const past = block(1, "09:40", "10:00"), exactStart = block(1, "10:00", "10:20");
  const other = block(2, "10:20", "10:40");
  const result = buildLocalReplan({ acceptedBlocks: [past, exactStart, other], tasks: [task(1), task(2)], now, constraints: [],
    options: { localDate: "2026-10-16", timeZone: "UTC" },
    wheelSpinningGuard: { taskId: taskId(1), events: stalledEvents(["09:50", "09:55", "10:00"]) } });
  expect(result).toMatchObject({ fixedBlocks: [past, other],
    releasedTaskVersions: [{ id: taskId(1), version: 1, status: "pending" }], wheelSpinningCarryOverTaskIds: [taskId(1)] });
});

it("wraps a spinning task, preserves history and other tasks' blocks, and reuses freed future time", () => {
  const now = new Date(time("10:00"));
  const past = block(1, "09:00", "09:20"), active = block(1, "09:45", "10:35");
  const exactStart = block(3, "10:00", "10:15"), future = block(1, "10:35", "11:00");
  const events = stalledEvents(["09:50", "09:55", "10:00"]);
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
