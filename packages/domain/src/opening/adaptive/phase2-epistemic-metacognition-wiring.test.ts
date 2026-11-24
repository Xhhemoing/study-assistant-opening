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
import { buildDecisionInput } from "./decision-input";
import { courseFeatureRevisions, visibleObservationRevisions } from "./metacognitive-epistemic-bridge";
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
    const outcome = row.verifiedCorrect === "no" ? "incorrect" : "correct";
    evidence.observations.push({ ...learningObservation, id, courseId: scope.courseId, skillLabel, attemptId, problemId, outcome,
      itemVersionId, assistance, occurredAt: attemptedAt, recordedAt: row.recordedAt ?? attemptedAt });
    evidence.evidenceContexts[id] = {
      observation: { ...qualifiedInput.observation, observationId: id, courseId: scope.courseId, requirementKey: row.requirementKey ?? null,
        attemptId, problemId, itemVersionId, assistance, submittedAt, startedAt, outcome },
      context: { helpHistory: { complete: true, exposures: [] }, referenceCheckAuthority: context.referenceCheckAuthority,
        referenceCheck: { ...context.referenceCheck!, attemptId, problemId, itemVersionId, outcome },
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

it.each([false, true])("preserves a cartridge-withheld exposure before an overlapping legacy revision (revision first: %s)", revisionFirst => {
  const first = head("first", 2);
  const retry = head("retry", 2, { problemId: first.problemId, familyKey: first.familyKey,
    attemptedAt: "2026-10-02T12:00:00.000Z" });
  const input = { ...projectProducedAttempts([first, retry], at(3), {
    cartridgeEvidence: { registry: createCartridgeRegistry(), emissions: {
      first: { cartridgeId: "unregistered", cartridgeVersion: "1", probeId: "probe", response: "correct" },
    } },
  }), targetFamilyKeys: [], propagatedFamilyKeys: [] };
  const revision = projectProducedAttempts([{ ...first, problemId: "other-problem", familyKey: "other-family",
    recordedAt: at(4), context: { referenceCheck: null } }], at(5));
  expect(input.observations[0]).toMatchObject({ id: first.id, verifiedCorrect: "yes" });
  expect(input.features[0]).toMatchObject({ recordedAt: at(2), eligibility: { verifiedCorrect: "unknown" },
    gaps: expect.arrayContaining(["cartridge_evidence_not_qualified"]) });
  expect(revision.observations[0]).toMatchObject({ id: first.id, problemId: "other-problem", verifiedCorrect: "unknown" });
  expect(revision.features[0]).toMatchObject({ recordedAt: at(4), eligibility: { verifiedCorrect: "unknown" } });
  expect(revision.features[0]?.gaps).not.toContain("cartridge_evidence_not_qualified");
  const appended = { ...input, observations: revisionFirst ? [...revision.observations, ...input.observations]
    : [...input.observations, ...revision.observations], features: [...input.features, ...revision.features] };

  const before = buildSkillBeliefTrajectory(input);
  const holdout = compareLearnerShadowV2(input);
  expect(before.steps.map(step => [step.observationId, step.omega])).toEqual([[first.id, 0], [retry.id, 0]]);
  expect(before.belief.lastDirectRecallAtMs).toBeNull();
  expect(holdout.rows).toEqual([]);
  for (const cutoff of [at(3), at(4)]) {
    const baseline = { ...input, cutoff };
    expect(buildSkillBeliefTrajectory({ ...appended, cutoff })).toEqual(buildSkillBeliefTrajectory(baseline));
    expect(compareLearnerShadowV2({ ...appended, cutoff })).toEqual(compareLearnerShadowV2(baseline));
  }

  const afterRevision = { ...appended, cutoff: "2026-10-04T22:00:00.000Z" };
  const after = buildSkillBeliefTrajectory(afterRevision);
  expect(after.steps).toMatchObject([{ observationId: retry.id, omega: 1 }]);
  expect(after.belief.lastDirectRecallAtMs).toBe(Date.parse(retry.attemptedAt));
  expect(compareLearnerShadowV2(afterRevision).rows.map(row => row.observationId)).toEqual([retry.id]);
});

const withheldFirstGrade: CartridgeEvidenceInput = {
  registry: createCartridgeRegistry(),
  emissions: { first: { cartridgeId: "unregistered", cartridgeVersion: "1", probeId: "probe", response: "correct" } },
};

function expectFastVisibleRevisions(
  observations: readonly SnapshotObservation[], features: readonly LearnerStateFeature[], cutoff: string,
) {
  const slots = courseFeatureRevisions(features, scope.courseId);
  const cutoffMs = Date.parse(cutoff);
  visibleObservationRevisions(observations, slots, cutoffMs);
  const start = performance.now();
  visibleObservationRevisions(observations, slots, cutoffMs);
  const elapsedMs = performance.now() - start;
  expect.soft(elapsedMs, cutoff).toBeLessThan(50);
}

function replayEvidence(input: Parameters<typeof compareLearnerShadowV2>[0]) {
  const { steps, belief } = buildSkillBeliefTrajectory(input);
  return {
    weights: steps.map(step => [step.observationId, step.omega]),
    lastDirectRecallAtMs: belief.lastDirectRecallAtMs,
    holdout: compareLearnerShadowV2(input).rows.map(row => row.observationId),
  };
}

it("keeps a legacy copy at the explicit revision's recording time", () => {
  const first = head("first", 2);
  const retry = head("retry", 2, { problemId: first.problemId, familyKey: first.familyKey,
    attemptedAt: "2026-10-02T12:00:00.000Z" });
  const original = projectProducedAttempts([first, retry], at(3));
  const moved = { ...first, problemId: "corrected-problem", familyKey: "corrected-family" };
  const correction = projectProducedAttempts([{ ...moved, recordedAt: at(4) }], at(6), { untimestamped: false });
  const withheld = projectProducedAttempts([{ ...moved, recordedAt: at(5), context: { referenceCheck: null } }], at(6),
    { cartridgeEvidence: withheldFirstGrade });
  const { recordedAt, ...legacyCopy } = correction.observations[0]!;
  expect(recordedAt).toBe(at(4));
  expect(withheld.features[0]).toMatchObject({ recordedAt: at(5), eligibility: { verifiedCorrect: "unknown" },
    gaps: expect.arrayContaining(["cartridge_evidence_not_qualified"]) });
  const input = { ...original, observations: [...original.observations, ...correction.observations, ...withheld.observations],
    features: [...original.features, ...correction.features, ...withheld.features], targetFamilyKeys: [], propagatedFamilyKeys: [] };
  const withCopy = { ...input, observations: [...input.observations, legacyCopy] };
  const historical = { weights: [[first.id, 1], [retry.id, 0]], lastDirectRecallAtMs: Date.parse(first.attemptedAt), holdout: [first.id] };

  const cutoffs = [at(3), at(4), "2026-10-04T22:00:00.000Z"];
  const originalReplay = cutoffs.map(cutoff => replayEvidence({ ...input, cutoff }));
  expect(originalReplay.slice(0, 2)).toEqual([historical, historical]);
  expect(cutoffs.map(cutoff => replayEvidence({ ...withCopy, cutoff }))).toEqual(originalReplay);
});

it("retains a matching legacy head when it alone can establish the earlier recording", () => {
  const first = head("first", 2);
  const original = projectProducedAttempts([first], at(3));
  const correction = projectProducedAttempts([{ ...first, recordedAt: at(4) }], at(5), { untimestamped: false });
  const input = { ...original, targetFamilyKeys: [], propagatedFamilyKeys: [] };
  const appended = { ...input, features: [...original.features, ...correction.features],
    observations: [...correction.observations, ...original.observations] };
  const historical = { weights: [[first.id, 1]], lastDirectRecallAtMs: Date.parse(first.attemptedAt), holdout: [first.id] };

  expect(replayEvidence(appended)).toEqual(historical);
  expect(replayEvidence({ ...appended, cutoff: at(4) })).toEqual(historical);
  expect(replayEvidence({ ...appended, cutoff: at(5) })).toEqual({
    weights: [[first.id, 0]], lastDirectRecallAtMs: null, holdout: [],
  });
});

it("R16 preserves multiple identical legacy recordings beside a later explicit copy", () => {
  const first = head("first", 1);
  const retry = head("retry", 2, { problemId: first.problemId, familyKey: first.familyKey });
  const producer = { cartridgeEvidence: withheldFirstGrade };
  const original = projectProducedAttempts([first, retry], at(3), producer);
  const duplicate = projectProducedAttempts([{ ...first, recordedAt: at(2) }], at(3), producer);
  const explicit = projectProducedAttempts([{ ...first, recordedAt: at(6) }], at(7), { ...producer, untimestamped: false });
  const historical = { ...original, observations: [...original.observations, ...duplicate.observations],
    features: [...original.features, ...duplicate.features], targetFamilyKeys: [], propagatedFamilyKeys: [] };
  const appended = { ...historical, observations: [...historical.observations, ...explicit.observations],
    features: [...historical.features, ...explicit.features] };
  const expected = { weights: [[first.id, 0], [retry.id, 0]], lastDirectRecallAtMs: null, holdout: [] };

  expect(replayEvidence(historical)).toEqual(expected);
  expect([at(3), at(6), at(7)].map(cutoff => replayEvidence({ ...appended, cutoff }))).toEqual([expected, expected, expected]);
});

it.each(["plain", "duplicate", "explicit echo", "both"] as const)("assigns the first yes projection to the exclusive slot (%s)", variant => {
  const first = head("first", 1);
  const retry = head("retry", 2, { problemId: first.problemId, familyKey: first.familyKey });
  const original = projectProducedAttempts([first, retry], at(3));
  const moved = { ...first, problemId: "corrected-problem", familyKey: "corrected-family" };
  const producer = { cartridgeEvidence: withheldFirstGrade };
  const yes = projectProducedAttempts([{ ...moved, recordedAt: at(4) }], at(7), producer);
  const unknown = projectProducedAttempts([{ ...moved, recordedAt: at(5), context: { referenceCheck: null } }], at(7), producer);
  const no = projectProducedAttempts([{ ...moved, recordedAt: at(6), verifiedCorrect: "no" }], at(7), producer);
  expect([yes, unknown, no].map(rows => rows.observations[0]?.verifiedCorrect)).toEqual(["yes", "unknown", "no"]);
  expect([yes, unknown, no].map(rows => rows.features[0]?.eligibility.verifiedCorrect)).toEqual(["unknown", "unknown", "unknown"]);
  const echo = projectProducedAttempts([{ ...first, recordedAt: at(7) }], at(8), { ...producer, untimestamped: false });
  const withEcho = variant === "explicit echo" || variant === "both";
  const withDuplicate = variant === "duplicate" || variant === "both";
  const input = { ...original, features: [...original.features, ...yes.features, ...unknown.features, ...no.features,
    ...(withEcho ? echo.features : [])],
    targetFamilyKeys: [], propagatedFamilyKeys: [] };
  const buckets = [[...original.observations, ...yes.observations],
    withDuplicate ? [...unknown.observations, ...unknown.observations] : unknown.observations, no.observations];
  const permutations = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const expected = { weights: [[first.id, 1], [retry.id, 0]], lastDirectRecallAtMs: Date.parse(first.attemptedAt), holdout: [first.id] };

  expect(replayEvidence({ ...input, features: original.features })).toEqual(expected);
  const results = permutations.map(order => [at(3), at(4)].map(cutoff =>
    replayEvidence({ ...input, cutoff, observations: [...order.flatMap(index => buckets[index]!), ...(withEcho ? echo.observations : [])] })));
  expect(results).toEqual(permutations.map(() => [expected, expected]));
});

it("R16 grants explicit evidence weight only when its feature records the same revision", () => {
  const first = head("first", 1);
  const original = projectProducedAttempts([first], at(3));
  const corrected = { ...first, problemId: "corrected-problem", familyKey: "corrected-family", recordedAt: at(4) };
  const retry = head("retry", 4, { problemId: corrected.problemId, familyKey: corrected.familyKey,
    attemptedAt: "2026-10-04T12:00:00.000Z" });
  const revision = projectProducedAttempts([corrected, retry], at(5), { untimestamped: false });
  const input = { ...revision, targetFamilyKeys: [], propagatedFamilyKeys: [] };
  const mismatched = { ...input, features: [...original.features, revision.features[1]!] };

  expect(replayEvidence(input)).toEqual({
    weights: [[first.id, 1], [retry.id, 0]], lastDirectRecallAtMs: Date.parse(first.attemptedAt), holdout: [first.id],
  });
  expect(replayEvidence(mismatched)).toEqual({ weights: [[first.id, 0], [retry.id, 0]], lastDirectRecallAtMs: null, holdout: [] });
});

it("R16 excludes future explicit heads before counting experimental BKT samples", () => {
  const evidence = [1, 2, 3, 4, 5].map(index => head(`sample-${index}`, 2));
  const produced = projectProducedAttempts(evidence, at(3));
  const [fifth, ...earlier] = produced.observations;
  const lateHead = { ...fifth!, recordedAt: at(4) };
  const lateDuplicate = { ...earlier[0]!, recordedAt: at(4) };
  const target = { courseId: scope.courseId, requirementKey: scope.requirementKey, problemId: "target", itemVersionId: "target-v1" };
  const experiment = { enabled: true, features: produced.features, target, excludedProblemIds: [] };
  const compare = (observations: SnapshotObservation[], cutoff: string) =>
    nextLearningStepWithExperimentalBkt(decision(observations), { ...experiment, cutoff }).comparison;
  const insufficient = { status: "fallback", reason: "insufficient_samples", sampleCount: 4 };

  expect(compare(earlier, at(3))).toMatchObject(insufficient);
  expect(compare([...earlier, lateHead], at(5))).toMatchObject({ status: "compared", sampleCount: 5 });
  const beforeRecording = [at(3), at(4)].flatMap(cutoff => [
    compare([...earlier, lateHead], cutoff), compare([...earlier, lateHead, lateDuplicate], cutoff),
  ]);
  expect(beforeRecording).toMatchObject([insufficient, insufficient, insufficient, insufficient]);
});

it.each([2, 3])("R17 preserves two withheld slots with %i identical legacy projections", copies => {
  const first = head("first", 1);
  const retry = head("retry", 2, { problemId: first.problemId, familyKey: first.familyKey });
  const original = projectProducedAttempts([first, retry], at(3), { cartridgeEvidence: withheldFirstGrade });
  const later = projectProducedAttempts([{ ...first, recordedAt: at(6) }], at(7),
    { cartridgeEvidence: withheldFirstGrade, untimestamped: false });
  const [legacy, retryHead] = original.observations;
  const observations = [...Array<SnapshotObservation>(copies).fill(legacy!), retryHead!, ...later.observations];
  const features = [...original.features, { ...original.features[0]!, recordedAt: at(2) }, ...later.features];
  const input = { ...original, observations, features, targetFamilyKeys: [], propagatedFamilyKeys: [] };
  const expected = { weights: [[first.id, 0], [retry.id, 0]], lastDirectRecallAtMs: null, holdout: [] };

  expect([at(3), at(6), at(7)].map(cutoff => replayEvidence({ ...input, cutoff }))).toEqual([expected, expected, expected]);
});

const legacyMatrix = [0, 1, 2, 3, 4].flatMap(legacyCopies =>
  [0, 1, 2, 3].flatMap(explicitFutureCopies =>
    [0, 1, 2, 3].map(earlierSlots => ({ legacyCopies, explicitFutureCopies, earlierSlots }))));

it.each(legacyMatrix)("R17 preserves replay with $legacyCopies legacy copies, $explicitFutureCopies future copies and $earlierSlots historical slots",
  ({ legacyCopies, explicitFutureCopies, earlierSlots }) => {
    const first = head("first", 1);
    const retry = head("retry", 4, { problemId: first.problemId, familyKey: first.familyKey });
    const original = projectProducedAttempts([first, retry], at(5), { cartridgeEvidence: withheldFirstGrade });
    const [legacy, retryHead] = original.observations;
    const [legacyFeature, retryFeature] = original.features;
    const future = Array.from({ length: explicitFutureCopies }, (_, index) => at(6 + index));
    const input = { ...original, targetFamilyKeys: [], propagatedFamilyKeys: [],
      observations: [...Array<SnapshotObservation>(legacyCopies).fill(legacy!), retryHead!,
        ...future.map(recordedAt => ({ ...legacy!, recordedAt }))],
      features: [...Array.from({ length: earlierSlots }, (_, index) => ({ ...legacyFeature!, recordedAt: at(1 + index) })), retryFeature!,
        ...future.map(recordedAt => ({ ...legacyFeature!, recordedAt }))] };

    for (const cutoff of [at(5), at(6), at(9)]) {
      const hasExposure = legacyCopies > 0 && earlierSlots > 0 || cutoff === at(9) && explicitFutureCopies > 0;
      expect(replayEvidence({ ...input, cutoff }), cutoff).toEqual(hasExposure
        ? { weights: [[first.id, 0], [retry.id, 0]], lastDirectRecallAtMs: null, holdout: [] }
        : { weights: [[retry.id, 1]], lastDirectRecallAtMs: Date.parse(retry.attemptedAt), holdout: [retry.id] });
    }
  });

it("R17 excludes a future revision feature before counting BKT duplicates", () => {
  const evidence = [1, 2, 3, 4, 5].map(index => head(`sample-${index}`, 2));
  const original = projectProducedAttempts(evidence, at(3));
  const revision = projectProducedAttempts([{ ...evidence[0]!, recordedAt: at(4) }], at(5), { untimestamped: false });
  const target = { courseId: scope.courseId, requirementKey: scope.requirementKey, problemId: "target", itemVersionId: "target-v1" };
  const experiment = { enabled: true, target, excludedProblemIds: [] };
  const input = decision([...original.observations, ...revision.observations]);
  const features = [...original.features, ...revision.features];
  const compare = (cutoff: string) => nextLearningStepWithExperimentalBkt(input, { ...experiment, cutoff, features }).comparison;

  expect(compare(at(5))).toMatchObject({ status: "fallback", reason: "insufficient_samples", sampleCount: 4 });
  expect([at(3), at(4)].map(compare)).toMatchObject([
    { status: "compared", sampleCount: 5 }, { status: "compared", sampleCount: 5 },
  ]);
});

it("R17 gates historical BKT on visible corrections and returns the live rule decision", () => {
  const evidence = [1, 2, 3, 4, 5].map(index => head(`sample-${index}`, 2));
  const original = projectProducedAttempts(evidence, at(3));
  const future = projectProducedAttempts([head("future", 3, { recordedAt: at(4), verifiedCorrect: "no" })],
    at(5), { untimestamped: false });
  const live = buildDecisionInput({ observations: [...original.observations, ...future.observations], wantsFullExplanation: false });
  const target = { courseId: scope.courseId, requirementKey: scope.requirementKey, problemId: "target", itemVersionId: "target-v1" };
  const features = [...original.features, ...future.features];
  const compare = (cutoff: string) => nextLearningStepWithExperimentalBkt(live, { enabled: true, target, excludedProblemIds: [], features, cutoff });

  expect(nextLearningStep(live).reasonCode).toBe("verified_incorrect");
  expect(compare(at(5)).comparison).toMatchObject({ status: "fallback", reason: "priority_rule", sampleCount: 0 });
  expect([at(3), at(4)].map(compare)).toMatchObject([0, 1].map(() => ({
    ruleDecision: nextLearningStep(live), comparison: { status: "compared", sampleCount: 5, differsFromRule: false },
  })));
});

it("R18 keeps a claimed graded feature from splitting two earlier legacy projections", () => {
  const first = head("first", 1);
  const retry = head("retry", 2, { problemId: first.problemId, familyKey: first.familyKey });
  const original = projectProducedAttempts([first, retry], at(3), { cartridgeEvidence: withheldFirstGrade });
  const withdrawn = projectProducedAttempts([{ ...first, problemId: "corrected", familyKey: "corrected-family",
    context: { referenceCheck: null }, recordedAt: at(4) }], at(7), { cartridgeEvidence: withheldFirstGrade });
  const echo = projectProducedAttempts([{ ...first, recordedAt: at(6) }], at(7), { untimestamped: false });
  const baseline = { ...original, observations: [...original.observations, ...withdrawn.observations],
    features: [...original.features, ...withdrawn.features], targetFamilyKeys: [], propagatedFamilyKeys: [] };
  const appended = { ...baseline, observations: [...baseline.observations, ...echo.observations],
    features: [...baseline.features, ...echo.features] };
  const expected = { weights: [[first.id, 0], [retry.id, 0]], lastDirectRecallAtMs: null, holdout: [] };

  for (const cutoff of [at(3), at(4)]) {
    expect(replayEvidence({ ...baseline, cutoff })).toEqual(expected);
    expect(replayEvidence({ ...appended, cutoff })).toEqual(expected);
  }
});

it.each([false, true])("R18 keeps a surplus duplicate from reordering producer identities (anchored: %s)", anchored => {
  const first = head("first", 1);
  const retry = head("retry", 2, { problemId: first.problemId, familyKey: first.familyKey });
  const moved = { ...first, problemId: "corrected", familyKey: "corrected-family" };
  const original = projectProducedAttempts([first, retry], at(3));
  const revision = projectProducedAttempts([{ ...moved, recordedAt: at(4) }], at(7));
  const echo = projectProducedAttempts([{ ...first, recordedAt: at(6) }], at(7), { untimestamped: false });
  const base = { ...original, observations: [...original.observations, ...revision.observations],
    features: [...original.features, ...revision.features], targetFamilyKeys: [], propagatedFamilyKeys: [] };
  const input = anchored ? { ...base, observations: [...base.observations, ...echo.observations],
    features: [...base.features, ...echo.features] } : base;
  const expected = { weights: [[first.id, 1], [retry.id, 0]], lastDirectRecallAtMs: Date.parse(first.attemptedAt), holdout: [first.id] };
  expect(replayEvidence(input)).toEqual(expected);
  expect(replayEvidence({ ...input, observations: [...input.observations, original.observations[0]!] })).toEqual(expected);
  expect(replayEvidence({ ...input, observations: [original.observations[0]!, ...input.observations] })).toEqual(expected);

  const threeSlots = { ...base, observations: [...base.observations, original.observations[0]!],
    features: [...base.features, ...echo.features] };
  expect(replayEvidence({ ...threeSlots, cutoff: at(4) })).toEqual(expected);
  expect(replayEvidence({ ...threeSlots, cutoff: at(7) }).holdout).toEqual([retry.id]);
});

it("R18 replays revisions by recording time regardless of feature input order", () => {
  const first = head("first", 1);
  const retry = head("retry", 2, { problemId: first.problemId, familyKey: first.familyKey });
  const original = projectProducedAttempts([first, retry], at(3));
  const moved = projectProducedAttempts([{ ...first, problemId: "corrected", familyKey: "corrected-family", recordedAt: at(4) }], at(6));
  const input = { ...original, observations: [...original.observations, ...moved.observations],
    targetFamilyKeys: [], propagatedFamilyKeys: [] };
  const [originalSlot, retrySlot] = original.features;
  const futureSlot = moved.features[0]!;
  const expected = { weights: [[first.id, 1], [retry.id, 0]], lastDirectRecallAtMs: Date.parse(first.attemptedAt), holdout: [first.id] };

  const cutoff = at(4);
  expect(replayEvidence({ ...input, cutoff, features: [originalSlot!, retrySlot!, futureSlot] })).toEqual(expected);
  expect(replayEvidence({ ...input, cutoff, features: [futureSlot, retrySlot!, originalSlot!] })).toEqual(expected);
  const tiedSlot = { ...futureSlot, recordedAt: at(1), views: [] as LearnerStateFeature["views"] };
  const tied = { ...input, cutoff, features: [originalSlot!, retrySlot!, tiedSlot] };
  expect(replayEvidence({ ...tied, features: [...tied.features].reverse() })).toEqual(replayEvidence(tied));
});

it("R18 keeps a legacy BKT correction invisible until its matching feature is recorded", () => {
  const original = projectProducedAttempts([1, 2, 3, 4, 5].map(index => head(`sample-${index}`, 2)), at(3));
  const correction = projectProducedAttempts([head("future", 3, { verifiedCorrect: "no", recordedAt: at(4) })], at(5));
  const input = buildDecisionInput({ observations: [...original.observations, ...correction.observations], wantsFullExplanation: false });
  const target = { courseId: scope.courseId, requirementKey: scope.requirementKey, problemId: "target", itemVersionId: "target-v1" };
  const features = [...original.features, ...correction.features];
  const compare = (cutoff: string) => nextLearningStepWithExperimentalBkt(input, { enabled: true, target, excludedProblemIds: [], features, cutoff });

  expect(compare(at(5))).toMatchObject({ ruleDecision: { reasonCode: "verified_incorrect" }, comparison: { reason: "priority_rule" } });
  expect([at(3), at(4)].map(compare).map(result => result.comparison)).toMatchObject([
    { status: "compared", sampleCount: 5 }, { status: "compared", sampleCount: 5 },
  ]);
});

it("R18 selects the latest visible BKT revision regardless of observation order", () => {
  const first = head("latest", 2, { recordedAt: at(3) });
  const others = projectProducedAttempts([1, 2, 3, 4].map(index => head(`sample-${index}`, 1)), at(3));
  const correct = projectProducedAttempts([first], at(5), { untimestamped: false });
  const wrong = projectProducedAttempts([{ ...first, verifiedCorrect: "no", recordedAt: at(4) }], at(5), { untimestamped: false });
  const target = { courseId: scope.courseId, requirementKey: scope.requirementKey, problemId: "target", itemVersionId: "target-v1" };
  const features = [...others.features, ...correct.features, ...wrong.features];
  const orders = [[...correct.observations, ...wrong.observations], [...wrong.observations, ...correct.observations]];
  const results = orders.map(revisions => {
    const input = buildDecisionInput({ observations: [...others.observations, ...revisions], wantsFullExplanation: false });
    return [at(3), at(4), at(5)].map(cutoff => {
      const result = nextLearningStepWithExperimentalBkt(input, { enabled: true, target, excludedProblemIds: [], features, cutoff });
      expect(result.ruleDecision).toEqual(nextLearningStep(input));
      return result.comparison;
    });
  });
  const expected = [{ reason: "insufficient_samples", sampleCount: 4 }, { status: "compared", sampleCount: 5 },
    { reason: "priority_rule", sampleCount: 0 }];
  expect(results).toMatchObject([expected, expected]);

  const wrongEarlier = projectProducedAttempts([{ ...first, verifiedCorrect: "no" }], at(5), { untimestamped: false });
  const correctLater = projectProducedAttempts([{ ...first, recordedAt: at(4) }], at(5), { untimestamped: false });
  const experiment = { enabled: true, target, excludedProblemIds: [], cutoff: at(5),
    features: [...others.features, ...wrongEarlier.features, ...correctLater.features] };
  for (const revisions of [[...wrongEarlier.observations, ...correctLater.observations],
    [...correctLater.observations, ...wrongEarlier.observations]]) {
    const input = buildDecisionInput({ observations: [...others.observations, ...revisions], wantsFullExplanation: false });
    expect(nextLearningStepWithExperimentalBkt(input, experiment).comparison).toMatchObject({ status: "compared", sampleCount: 5 });
  }

  const sameTime = { ...experiment, features: [...others.features, ...correctLater.features, ...wrong.features] };
  for (const revisions of [[...correctLater.observations, ...wrong.observations], [...wrong.observations, ...correctLater.observations]]) {
    const input = buildDecisionInput({ observations: [...others.observations, ...revisions], wantsFullExplanation: false });
    expect(nextLearningStepWithExperimentalBkt(input, sameTime).comparison).toMatchObject({ reason: "priority_rule", sampleCount: 0 });
  }
});

const bktTarget = { courseId: scope.courseId, requirementKey: scope.requirementKey, problemId: "target", itemVersionId: "target-v1" };
const bktSamples = (count: number) => Array.from({ length: count }, (_, index) => head(`sample-${index + 1}`, 1));

it("R19 preserves the original withheld exposure when two legacy projections have explicit anchors", () => {
  const first = head("first", 1);
  const retry = head("retry", 2, { problemId: first.problemId, familyKey: first.familyKey });
  const original = projectProducedAttempts([first, retry], at(3), { cartridgeEvidence: withheldFirstGrade });
  const correction = projectProducedAttempts([{ ...first, problemId: "corrected", familyKey: "corrected-family",
    context: { referenceCheck: null }, recordedAt: at(4) }], at(7), { untimestamped: false });
  const corrected = correction.observations[0]!;
  const echo = projectProducedAttempts([{ ...first, recordedAt: at(6) }], at(7), { untimestamped: false });
  const baseline = { ...original, observations: [...original.observations, corrected, { ...corrected, recordedAt: undefined }],
    features: [...original.features, ...correction.features], targetFamilyKeys: [], propagatedFamilyKeys: [] };
  const appended = { ...baseline, observations: [...baseline.observations, ...echo.observations],
    features: [...baseline.features, ...echo.features] };
  const expected = { weights: [[first.id, 0], [retry.id, 0]], lastDirectRecallAtMs: null, holdout: [] };

  for (const cutoff of [at(3), at(4)]) {
    expect(replayEvidence({ ...baseline, cutoff })).toEqual(expected);
    expect(replayEvidence({ ...appended, cutoff })).toEqual(expected);
  }
});

it("R19 keeps a future legacy BKT correction off an explicitly claimed historical slot", () => {
  const samples = bktSamples(5);
  const original = projectProducedAttempts(samples, at(3), { untimestamped: false });
  const future = projectProducedAttempts([{ ...samples[0]!, problemId: "corrected", familyKey: "corrected-family", recordedAt: at(6) }], at(7));
  const input = buildDecisionInput({ observations: [...original.observations, ...future.observations], wantsFullExplanation: false });
  const features = [...original.features, ...future.features];

  for (const cutoff of [at(3), at(6), at(7)]) {
    const result = nextLearningStepWithExperimentalBkt(input, { enabled: true, target: bktTarget, excludedProblemIds: [], features, cutoff });
    expect.soft(result.comparison, cutoff).toMatchObject({ status: "compared", sampleCount: 5 });
  }
});

it("R19 retains the known recording time of a legacy BKT head beside a future explicit copy", () => {
  const wrong = head("revised", 1, { verifiedCorrect: "no" });
  const original = projectProducedAttempts([...bktSamples(4), wrong], at(3));
  const correction = projectProducedAttempts([{ ...wrong, verifiedCorrect: "yes", recordedAt: at(2) }], at(3), { untimestamped: false });
  const echo = projectProducedAttempts([{ ...wrong, recordedAt: at(6) }], at(7), { untimestamped: false });
  const compare = (cutoff: string, withEcho: boolean) => {
    const input = buildDecisionInput({ observations: [...original.observations, ...correction.observations,
      ...(withEcho ? echo.observations : [])], wantsFullExplanation: false });
    return nextLearningStepWithExperimentalBkt(input, { enabled: true, target: bktTarget, excludedProblemIds: [], cutoff,
      features: [...original.features, ...correction.features, ...(withEcho ? echo.features : [])] }).comparison;
  };

  for (const cutoff of [at(3), at(6)]) {
    expect(compare(cutoff, false)).toMatchObject({ status: "compared", sampleCount: 5 });
    expect.soft(compare(cutoff, true), cutoff).toMatchObject({ status: "compared", sampleCount: 5 });
  }
  expect(compare(at(7), true)).toMatchObject({ reason: "priority_rule", sampleCount: 0 });
});

it("R19 excludes an untimestamped rule-only attempt at and before its attempt time", () => {
  const original = projectProducedAttempts(bktSamples(5), at(4));
  const future = head("rule-only", 8, { verifiedCorrect: "no" });
  const input = buildDecisionInput({ observations: [...original.observations, future], wantsFullExplanation: false });

  for (const cutoff of [at(4), at(8), at(9)]) {
    const result = nextLearningStepWithExperimentalBkt(input, {
      enabled: true, target: bktTarget, excludedProblemIds: [], features: original.features, cutoff,
    });
    expect(result.ruleDecision).toMatchObject({ reasonCode: "verified_incorrect", focusObservationId: future.id });
    expect.soft(result.comparison, cutoff).toMatchObject(cutoff === at(9)
      ? { reason: "priority_rule", sampleCount: 0 } : { status: "compared", sampleCount: 5 });
  }
});

it("R19 handles conflicting verified-step labels on tied BKT revisions in either order", () => {
  const original = projectProducedAttempts(bktSamples(5), at(8));
  const hintedError = (id: string, day: number, label: string) => head(id, day, { recordedAt: at(day),
    verifiedCorrect: "no", assistance: "hinted", independentAttempt: "no",
    errors: [{ observationId: id, label, feedback: "incorrect", source: "verified_steps" }] });
  const previous = hintedError("previous", 2, "substitution");
  const repeated = hintedError("tied", 3, "substitution");
  const distinct = hintedError("tied", 3, "sign");
  const newer = [4, 5, 6].map(day => head(`ungraded-${day}`, day, { verifiedCorrect: "unknown" }));
  const compare = (revisions: SnapshotObservation[]) => {
    const input = buildDecisionInput({ observations: [...original.observations, previous, ...revisions, ...newer], wantsFullExplanation: false });
    const result = nextLearningStepWithExperimentalBkt(input, {
      enabled: true, target: bktTarget, excludedProblemIds: [], features: original.features, cutoff: at(8),
    });
    expect(result.ruleDecision).toEqual(nextLearningStep(input));
    return result.comparison;
  };

  expect(compare([distinct])).toMatchObject({ status: "compared", sampleCount: 5 });
  expect(compare([repeated])).toMatchObject({ reason: "priority_rule", sampleCount: 0 });
  for (const revisions of [[repeated, distinct], [distinct, repeated]]) {
    expect.soft(compare(revisions)).toMatchObject({ reason: "priority_rule", sampleCount: 0 });
  }
});

it("R20 keeps producer precedence when an anchor removes a later compatible slot", () => {
  const first = head("first", 1);
  const retry = head("retry", 2, { problemId: first.problemId, familyKey: first.familyKey });
  const original = projectProducedAttempts([first, retry], at(3), { cartridgeEvidence: withheldFirstGrade });
  const corrected = { ...first, problemId: "corrected", familyKey: "corrected-family", context: { referenceCheck: null } };
  const correction = projectProducedAttempts([{ ...corrected, recordedAt: at(4) }], at(7), { untimestamped: false });
  const laterLegacy = projectProducedAttempts([{ ...corrected, recordedAt: at(5) }], at(7));
  const echo = projectProducedAttempts([{ ...first, recordedAt: at(6) }], at(7), { untimestamped: false });
  const historical = { ...original, observations: [...original.observations, ...correction.observations, ...laterLegacy.observations],
    features: [...original.features, ...correction.features, ...laterLegacy.features], targetFamilyKeys: [], propagatedFamilyKeys: [] };
  const appended = { ...historical, observations: [...historical.observations, ...echo.observations],
    features: [...historical.features, ...echo.features] };
  const withheld = { weights: [[first.id, 0], [retry.id, 0]], lastDirectRecallAtMs: null, holdout: [] };

  for (const cutoff of [at(3), at(4), at(5), at(6), at(7)]) {
    const before = replayEvidence({ ...historical, cutoff });
    if (cutoff === at(3) || cutoff === at(4)) expect(before).toEqual(withheld);
    expect.soft(replayEvidence({ ...appended, cutoff }), cutoff).toEqual(before);
  }
});

it("R20 counts only legacy BKT copies attributable to the historical cutoff", () => {
  const samples = bktSamples(5);
  const original = projectProducedAttempts(samples, at(3));
  const future = projectProducedAttempts([{ ...samples[0]!, recordedAt: at(6) }], at(7));
  const input = buildDecisionInput({ observations: [...original.observations, ...future.observations], wantsFullExplanation: false });
  const compare = (cutoff: string, features: readonly LearnerStateFeature[]) =>
    nextLearningStepWithExperimentalBkt(input, { enabled: true, target: bktTarget, excludedProblemIds: [], features, cutoff }).comparison;
  const features = [...original.features, ...future.features];
  const duplicate = { reason: "insufficient_samples", sampleCount: 4 };

  expect(compare(at(3), original.features)).toMatchObject(duplicate);
  expect(compare(at(7), features)).toMatchObject(duplicate);
  for (const cutoff of [at(3), at(6)]) {
    expect.soft(compare(cutoff, features), cutoff).toMatchObject({ status: "compared", sampleCount: 5 });
  }
});

it("R20 supersedes two older legacy BKT error recordings with a newer explicit correction", () => {
  const wrong = head("revised", 2, { verifiedCorrect: "no" });
  const original = projectProducedAttempts([...bktSamples(4), wrong], at(3));
  const repeat = projectProducedAttempts([{ ...wrong, recordedAt: at(3) }], at(5));
  const correction = projectProducedAttempts([{ ...wrong, verifiedCorrect: "yes", recordedAt: at(4) }], at(5), { untimestamped: false });
  const input = buildDecisionInput({ observations: [...original.observations, ...repeat.observations, ...correction.observations],
    wantsFullExplanation: false });
  const features = [...original.features, ...repeat.features, ...correction.features];
  const compare = (cutoff: string) =>
    nextLearningStepWithExperimentalBkt(input, { enabled: true, target: bktTarget, excludedProblemIds: [], features, cutoff });

  expect(compare(at(4)).comparison).toMatchObject({ reason: "priority_rule", sampleCount: 0 });
  expect(compare(at(5))).toMatchObject({ ruleDecision: nextLearningStep(input), comparison: { status: "compared", sampleCount: 5 } });
});

it("R20 retains a rule-only legacy error beside an incompatible future recording for the same ID", () => {
  const original = projectProducedAttempts(bktSamples(5), at(3));
  const wrong = head("rule-only", 2, { verifiedCorrect: "no" });
  const correction = projectProducedAttempts([{ ...wrong, verifiedCorrect: "yes", recordedAt: at(6) }], at(7), { untimestamped: false });
  const compare = (cutoff: string, withCorrection: boolean) => {
    const input = buildDecisionInput({ observations: [...original.observations, wrong, ...(withCorrection ? correction.observations : [])],
      wantsFullExplanation: false });
    return nextLearningStepWithExperimentalBkt(input, { enabled: true, target: bktTarget, excludedProblemIds: [], cutoff,
      features: [...original.features, ...(withCorrection ? correction.features : [])] }).comparison;
  };

  for (const cutoff of [at(3), at(6)]) {
    expect(compare(cutoff, false)).toMatchObject({ reason: "priority_rule", sampleCount: 0 });
    expect.soft(compare(cutoff, true), cutoff).toMatchObject({ reason: "priority_rule", sampleCount: 0 });
  }
});

it.each([null, "bad", at(1)])("R21 retains a rule-only error when its feature recording is %s", recordedAt => {
  const original = projectProducedAttempts(bktSamples(5), at(3));
  const wrong = head("wrong", 2, { verifiedCorrect: "no" });
  const features = [...original.features, feature(wrong, { recordedAt })];
  const input = buildDecisionInput({ observations: [...original.observations, wrong], wantsFullExplanation: false });
  const result = nextLearningStepWithExperimentalBkt(input, { enabled: true, target: bktTarget, excludedProblemIds: [], features, cutoff: at(3) });
  expect(result.comparison).toMatchObject({ reason: "priority_rule", sampleCount: 0 });
});

it("R21 treats a null observation recording as legacy in replay and BKT", () => {
  const original = projectProducedAttempts(bktSamples(5), at(3));
  const observations = original.observations.map(row => ({ ...row, recordedAt: null }));
  const input = buildDecisionInput({ observations, wantsFullExplanation: false });
  const result = nextLearningStepWithExperimentalBkt(input, { enabled: true, target: bktTarget, excludedProblemIds: [],
    features: original.features, cutoff: at(3) });

  expect.soft(result.comparison).toMatchObject({ status: "compared", sampleCount: 5 });
  const replay = replayEvidence({ ...original, observations, targetFamilyKeys: [], propagatedFamilyKeys: [] });
  expect(replay.holdout).toEqual(original.observations.map(row => row.id).sort());
});

it.each([null, "bad", at(1)])("R21 keeps a rule-only error alongside a sibling recording of %s", recordedAt => {
  const original = projectProducedAttempts(bktSamples(5), at(3));
  const wrong = head("wrong", 2, { verifiedCorrect: "no" });
  const future = projectProducedAttempts([{ ...wrong, verifiedCorrect: "yes", recordedAt: at(6) }], at(7), { untimestamped: false });
  const input = buildDecisionInput({ observations: [...original.observations, wrong, { ...wrong, recordedAt }, ...future.observations],
    wantsFullExplanation: false });
  const result = nextLearningStepWithExperimentalBkt(input, { enabled: true, target: bktTarget, excludedProblemIds: [],
    features: [...original.features, ...future.features], cutoff: at(3) });

  expect(result.comparison).toMatchObject({ reason: "priority_rule", sampleCount: 0 });
});

it("R21 uses a legacy correction recorded after identical explicit evidence", () => {
  const wrong = head("revised", 2, { verifiedCorrect: "no" });
  const original = projectProducedAttempts([...bktSamples(5), wrong], at(3), { untimestamped: false });
  const corrected = projectProducedAttempts([{ ...wrong, verifiedCorrect: "yes", recordedAt: at(4) }], at(8), { untimestamped: false });
  const reverted = projectProducedAttempts([{ ...wrong, recordedAt: at(6) }], at(8));
  const input = buildDecisionInput({ observations: [...original.observations, ...corrected.observations, ...reverted.observations],
    wantsFullExplanation: false });
  const features = [...original.features, ...corrected.features, ...reverted.features];
  const compare = (cutoff: string) =>
    nextLearningStepWithExperimentalBkt(input, { enabled: true, target: bktTarget, excludedProblemIds: [], features, cutoff }).comparison;

  expect(compare(at(6))).toMatchObject({ status: "compared", sampleCount: 6 });
  expect(compare(at(8))).toMatchObject({ reason: "priority_rule", sampleCount: 0 });
});

it("R21 keeps a future legacy copy from disqualifying its explicit BKT predecessor", () => {
  const samples = bktSamples(5);
  const original = projectProducedAttempts(samples, at(3), { untimestamped: false });
  const future = projectProducedAttempts([{ ...samples[0]!, recordedAt: at(6) }], at(8));
  const input = buildDecisionInput({ observations: [...original.observations, ...future.observations], wantsFullExplanation: false });
  const features = [...original.features, ...future.features];
  const compare = (cutoff: string) =>
    nextLearningStepWithExperimentalBkt(input, { enabled: true, target: bktTarget, excludedProblemIds: [], features, cutoff });

  for (const cutoff of [at(3), at(6)]) {
    expect.soft(compare(cutoff).comparison, cutoff).toMatchObject({ status: "compared", sampleCount: 5 });
  }
  expect(compare(at(8)).comparison).toMatchObject({ reason: "insufficient_samples", sampleCount: 4 });
});

it("R21 supersedes an explicit error only when all optimal assignments have a later correction", () => {
  const right = head("revised", 2);
  const samples = projectProducedAttempts(bktSamples(5), at(3));
  const wrong = projectProducedAttempts([{ ...right, verifiedCorrect: "no", recordedAt: at(4) }], at(8), { untimestamped: false });
  const early = projectProducedAttempts([right], at(8));
  const late = projectProducedAttempts([{ ...right, recordedAt: at(6) }], at(8));
  const compare = (copies: readonly SnapshotObservation[], slots: readonly LearnerStateFeature[]) => {
    const input = buildDecisionInput({ observations: [...samples.observations, ...wrong.observations, ...copies], wantsFullExplanation: false });
    return nextLearningStepWithExperimentalBkt(input, { enabled: true, target: bktTarget, excludedProblemIds: [], cutoff: at(8),
      features: [...samples.features, ...wrong.features, ...slots] }).comparison;
  };

  const slots = [...early.features, ...late.features];
  expect(compare(late.observations, slots)).toMatchObject({ reason: "priority_rule", sampleCount: 0 });
  expect(compare([...early.observations, ...late.observations], slots)).toMatchObject({ status: "compared", sampleCount: 5 });
});

it.each([false, true])("R22 preserves producer order after a future slot splits the legacy bucket (reversed: %s)", reversed => {
  const first = head("first", 1);
  const retry = head("retry", 2, { problemId: first.problemId, familyKey: first.familyKey });
  const original = projectProducedAttempts([first, retry], at(3), { cartridgeEvidence: withheldFirstGrade });
  const correction = projectProducedAttempts([{ ...first, problemId: "moved", familyKey: "moved-family", verifiedCorrect: "no",
    recordedAt: at(4) }], at(8), { cartridgeEvidence: withheldFirstGrade });
  const later = projectProducedAttempts([{ ...first, recordedAt: at(6) }], at(8));
  const latest = projectProducedAttempts([{ ...first, recordedAt: at(7) }], at(8));
  const [firstHead, retryHead] = original.observations;
  const [moved] = correction.observations;
  const projections = reversed ? [moved!, firstHead!] : [firstHead!, moved!];
  const input = { ...original, observations: [...projections, retryHead!], features: [...original.features, ...correction.features],
    targetFamilyKeys: [], propagatedFamilyKeys: [] };
  const historical = replayEvidence(input);
  const expected = reversed
    ? { weights: [[first.id, 0], [retry.id, 1]], lastDirectRecallAtMs: Date.parse(retry.attemptedAt), holdout: [retry.id] }
    : { weights: [[first.id, 0], [retry.id, 0]], lastDirectRecallAtMs: null, holdout: [] };
  expect(historical).toEqual(expected);

  for (const future of [[later], [later, latest]]) {
    const appended = { ...input, observations: [...input.observations, ...future.flatMap(rows => rows.observations)],
      features: [...input.features, ...future.flatMap(rows => rows.features)] };
    for (const cutoff of [at(3), at(4)]) {
      expect.soft(replayEvidence({ ...appended, cutoff }), cutoff).toEqual(expected);
    }
  }
});

it.each([
  [null, false], [null, true], ["bad", false], ["bad", true],
] as const)("R22 retains a rule-only error with feature time %s and future explicit revision %s", (recordedAt, explicit) => {
  const original = projectProducedAttempts(bktSamples(5), at(3));
  const wrong = head("wrong", 2, { verifiedCorrect: "no" });
  const future = projectProducedAttempts([{ ...wrong, problemId: "different", familyKey: "different-family", recordedAt: at(6) }],
    at(7), { untimestamped: !explicit });
  const baseline = [...original.features, feature(wrong, { recordedAt })];
  for (const append of [false, true]) {
    const input = buildDecisionInput({ observations: [...original.observations, wrong, ...(append ? future.observations : [])],
      wantsFullExplanation: false });
    const features = [...baseline, ...(append ? future.features : [])];
    for (const cutoff of [at(3), at(6)]) {
      const result = nextLearningStepWithExperimentalBkt(input, { enabled: true, target: bktTarget, excludedProblemIds: [], features, cutoff });
      expect(result.ruleDecision.reasonCode).toBe("verified_incorrect");
      expect.soft(result.comparison, cutoff).toMatchObject({ reason: "priority_rule", sampleCount: 0 });
    }
  }
});

it("R22 does not use a feasible future legacy revision as a rule-only error before its recording", () => {
  const original = projectProducedAttempts(bktSamples(5), at(3));
  const first = head("first", 2);
  const initial = projectProducedAttempts([first], at(7), { cartridgeEvidence: withheldFirstGrade });
  const future = projectProducedAttempts([{ ...first, problemId: "different", familyKey: "different-family", verifiedCorrect: "no",
    recordedAt: at(6) }], at(7), { cartridgeEvidence: withheldFirstGrade });
  const input = buildDecisionInput({ observations: [...original.observations, ...initial.observations, ...future.observations],
    wantsFullExplanation: false });
  const features = [...original.features, ...initial.features, ...future.features];
  const compare = (cutoff: string) =>
    nextLearningStepWithExperimentalBkt(input, { enabled: true, target: bktTarget, excludedProblemIds: [], features, cutoff }).comparison;

  expect(compare(at(6))).toMatchObject({ status: "compared", sampleCount: 5 });
  expect(compare(at(7))).toMatchObject({ reason: "priority_rule", sampleCount: 0 });
});

it("R23 preserves earlier producer exposure when a legacy copy follows its explicit anchor", () => {
  const first = head("first", 1);
  const retry = head("retry", 2, { problemId: first.problemId, familyKey: first.familyKey });
  const moved = { ...first, problemId: "moved", familyKey: "moved-family" };
  const wrong = { ...moved, verifiedCorrect: "no" as const };
  const initial = projectProducedAttempts([first, retry], at(3), { cartridgeEvidence: withheldFirstGrade });
  const graded = projectProducedAttempts([{ ...moved, recordedAt: at(3) }], at(8));
  const explicit = projectProducedAttempts([{ ...wrong, recordedAt: at(5) }], at(8), { untimestamped: false });
  const future = projectProducedAttempts([{ ...wrong, recordedAt: at(7) }], at(8), { cartridgeEvidence: withheldFirstGrade });
  const input = { ...initial, observations: [...initial.observations, ...graded.observations, ...explicit.observations],
    features: [...initial.features, ...graded.features, ...explicit.features], targetFamilyKeys: [], propagatedFamilyKeys: [] };
  const expected = { weights: [[first.id, 0], [retry.id, 0]], lastDirectRecallAtMs: null, holdout: [] };

  expect(replayEvidence(input)).toEqual(expected);
  expect(replayEvidence({ ...input, observations: [...input.observations, ...future.observations],
    features: [...input.features, ...future.features] })).toEqual(expected);
});

it.each(["rule-only error", "possibly absent error", "possibly absent guess", "no error"] as const)(
  "R23 checks historical BKT when an optional success accompanies %s", scenario => {
    const samples = projectProducedAttempts(bktSamples(5), at(3));
    const success = head("success", 4);
    const wrong = head("wrong", 3, { verifiedCorrect: "no" });
    const optional = (row: SnapshotObservation) => [feature(row), feature(row, { recordedAt: at(7) })];
    const additional = scenario === "possibly absent guess" ? [head("guess", 3, { preAnswerConfidence: "guessing" })]
      : scenario === "no error" ? [] : [wrong];
    const features = [...samples.features, ...optional(success),
      ...(scenario.startsWith("possibly absent") ? optional(additional[0]!) : [])];
    const input = buildDecisionInput({ observations: [...samples.observations, success, ...additional], wantsFullExplanation: false });
    const result = nextLearningStepWithExperimentalBkt(input,
      { enabled: true, target: bktTarget, excludedProblemIds: [], features, cutoff: at(5) });

    expect(result.ruleDecision).toEqual(nextLearningStep(input));
    expect(result.comparison).toMatchObject(scenario === "no error"
      ? { status: "compared", sampleCount: 5 } : { reason: "priority_rule", sampleCount: 0 });
  },
);

it("R23 resolves 20 alternating legacy projections within 50 ms", () => {
  const first = head("first", 1);
  const wrong = { ...first, problemId: "moved", familyKey: "moved-family", verifiedCorrect: "no" as const };
  const observations = Array.from({ length: 20 }, (_, index) => index % 2 ? wrong : first);
  const features = observations.map((_, index) => index === 0 ? feature(first) : feature(first, {
    recordedAt: at(index + 1), eligibility: { ...feature(first).eligibility, verifiedCorrect: "unknown" },
    gaps: ["cartridge_evidence_not_qualified"],
  }));
  const start = performance.now();
  const result = buildSkillBeliefTrajectory({ scope, cutoff: at(2), observations, features });
  const elapsedMs = performance.now() - start;

  expect(result.steps).toMatchObject([{ observationId: first.id }]);
  expect(elapsedMs).toBeLessThan(50);
});

it.each([
  ["ungraded masks error", 3, "no", "independent", "unknown", false],
  ["independent success masks assisted success", 3, "yes", "hinted", "yes", false],
  ["independent success masks assisted majority", 3, "yes", "revealed", "yes", true],
] as const)("R24 checks optional BKT priority when %s", (_, day, verifiedCorrect, assistance, laterGrade, majority) => {
  const samples = projectProducedAttempts(bktSamples(5), at(3));
  const first = head("optional-priority", day, { verifiedCorrect, assistance, independentAttempt: assistance === "independent" ? "yes" : "no" });
  const later = head("optional-later", 4, { verifiedCorrect: laterGrade });
  const optional = majority ? [first, later, head("optional-second-assisted", 2, {
    assistance: "hinted", independentAttempt: "no",
  })] : [first, later];
  const guaranteed = majority ? [head("guaranteed-ungraded", 5, { verifiedCorrect: "unknown" })] : [];
  const observations = [...samples.observations, ...optional, ...guaranteed];
  const features = [...samples.features, ...optional.flatMap(row => [feature(row), feature(row, { recordedAt: at(8) })])];
  const input = buildDecisionInput({ observations, wantsFullExplanation: false });
  const result = nextLearningStepWithExperimentalBkt(input,
    { enabled: true, target: bktTarget, excludedProblemIds: [], features, cutoff: at(majority ? 6 : 5) });

  expect(result.ruleDecision).toEqual(nextLearningStep(input));
  expect(result.comparison).toMatchObject({ reason: "priority_rule", sampleCount: 0 });
});

it.each([false, true])("R24 checks repeated assisted errors across an intervening error (guaranteed: %s)", guaranteedMiddle => {
  const samples = projectProducedAttempts(bktSamples(5), at(3));
  const errors = [6, 5, 4].map(day => head(`error-${day}`, day, {
    assistance: "hinted", independentAttempt: "no", verifiedCorrect: "no",
    errors: [{ observationId: `error-${day}`, label: day === 5 ? "sign" : "substitution", feedback: "incorrect", source: "verified_steps" }],
  }));
  const ungraded = [8, 7].map(day => head(`ungraded-${day}`, day, { verifiedCorrect: "unknown" }));
  const features = [...samples.features, ...errors.filter((_, index) => !guaranteedMiddle || index !== 1)
    .flatMap(row => [feature(row), feature(row, { recordedAt: at(10) })])];
  const input = buildDecisionInput({ observations: [...samples.observations, ...errors, ...ungraded], wantsFullExplanation: false });
  const result = nextLearningStepWithExperimentalBkt(input,
    { enabled: true, target: bktTarget, excludedProblemIds: [], features, cutoff: at(9) });

  expect(result.comparison).toMatchObject(guaranteedMiddle
    ? { status: "compared", sampleCount: 5 } : { reason: "priority_rule", sampleCount: 0 });
});

it("R24 checks drilldown when an optional attempt ID can leave an item-level error unresolved", () => {
  const samples = projectProducedAttempts(bktSamples(5), at(3));
  const revised = head("original-attempt", 4, { problemId: "revised-item", verifiedCorrect: "no" });
  const itemError = head("item-error", 3, { problemId: "original-item", verifiedCorrect: "no" });
  const solved = head("solved", 5, { problemId: "revised-item" });
  const input = buildDecisionInput({ observations: [...samples.observations, revised, itemError, solved], wantsFullExplanation: false,
    drilldownSnapshot: { status: "restore_original_attempt", rootCause: "integration_step_coordination",
      targetSkillId: "integrate", maxTotalProbes: 3, probesAdministered: 2, confirmedDeficitSkillIds: [],
      posteriors: [], repairPlan: [], restoreContext: { originalAttemptId: revised.id, originalItemId: "original-item",
        frozenDraftText: "", frozenCursorOffset: 0, startedAtMs: Date.parse(itemError.attemptedAt) } } });
  const features = [...samples.features, ...[revised, itemError].flatMap(row => [feature(row), feature(row, { recordedAt: at(8) })])];

  expect(nextLearningStep(input).reasonCode).toBe("independent");
  const result = nextLearningStepWithExperimentalBkt(input,
    { enabled: true, target: bktTarget, excludedProblemIds: [], features, cutoff: at(6) });
  expect(result.comparison).toMatchObject({ reason: "priority_rule", sampleCount: 0 });
});

it.each([
  [9, false], [9, true], [12, false], [12, true],
] as const)("R24 resolves %i alternating projections with twice as many slots (graded first: %s)", (copies, gradedFirst) => {
  const first = head("first", 1);
  const moved = { ...first, problemId: "moved", familyKey: "moved-family", verifiedCorrect: gradedFirst ? "no" as const : "yes" as const };
  const retry = head("retry", 2, { problemId: first.problemId, familyKey: first.familyKey, attemptedAt: "2026-10-01T22:00:00.000Z" });
  const observations = [...Array.from({ length: copies }, (_, index) => index % 2 ? moved : first), retry];
  const graded = feature(first);
  const features = [...Array.from({ length: copies * 2 }, (_, index) => index === 0 && gradedFirst ? graded : {
    ...graded, recordedAt: at(index + 1), eligibility: { ...graded.eligibility, verifiedCorrect: "unknown" as const },
    gaps: ["cartridge_evidence_not_qualified" as const],
  }), feature(retry)];
  const input = { scope, cutoff: at(2), observations, features, targetFamilyKeys: [], propagatedFamilyKeys: [] };
  const start = performance.now();
  const result = replayEvidence(input);
  const elapsedMs = performance.now() - start;

  expect(result).toEqual({ weights: [[first.id, 0], [retry.id, 0]], lastDirectRecallAtMs: null, holdout: [] });
  expect(elapsedMs).toBeLessThan(50);
});

it("R25 keeps an unassigned historical BKT duplicate when a different projection gains a future slot", () => {
  const samples = projectProducedAttempts(bktSamples(4), at(3));
  const first = head("revision", 2);
  const moved = { ...first, problemId: "moved", familyKey: "moved-family" };
  const rows = [first, first, moved];
  const slots = [feature(first), feature(moved, { recordedAt: at(3) })];
  const compare = (observations: readonly SnapshotObservation[], features: readonly LearnerStateFeature[]) =>
    nextLearningStepWithExperimentalBkt(buildDecisionInput({ observations: [...samples.observations, ...observations],
      wantsFullExplanation: false }), { enabled: true, target: bktTarget, excludedProblemIds: [], cutoff: at(3),
      features: [...samples.features, ...features] }).comparison;
  const expected = { reason: "insufficient_samples", sampleCount: 4 };

  expect(compare(rows, slots)).toMatchObject(expected);
  expect(compare([...rows, moved], [...slots, feature(moved, { recordedAt: at(14) })])).toMatchObject(expected);
});

it("R25 retains a historical rule-only error beside a future explicit echo without a slot", () => {
  const samples = projectProducedAttempts(bktSamples(5), at(3));
  const wrong = head("wrong", 2, { verifiedCorrect: "no" });
  const echo = { ...wrong, recordedAt: at(7) };
  const compare = (rows: readonly SnapshotObservation[], features: readonly LearnerStateFeature[] = []) =>
    nextLearningStepWithExperimentalBkt(buildDecisionInput({ observations: [...samples.observations, ...rows],
      wantsFullExplanation: false }), { enabled: true, target: bktTarget, excludedProblemIds: [], cutoff: at(4),
      features: [...samples.features, ...features] }).comparison;
  const expected = { reason: "priority_rule", sampleCount: 0 };

  expect(compare([wrong])).toMatchObject(expected);
  expect.soft(compare([wrong, echo])).toMatchObject(expected);
  expect(compare([wrong, { ...echo, recordedAt: at(3) }])).toMatchObject(expected);
  expect(compare([wrong, echo], [feature(echo, { recordedAt: at(7) })])).toMatchObject({ status: "compared", sampleCount: 5 });
});

it.each([8, 12])("R25 resolves %i projections across alternating graded and withheld slots", copies => {
  const first = head("first", 1);
  const moved = { ...first, problemId: "moved", familyKey: "moved-family", verifiedCorrect: "no" as const };
  const retry = head("retry", 2, { problemId: first.problemId, familyKey: first.familyKey, attemptedAt: "2026-10-01T22:00:00.000Z" });
  const graded = feature(first);
  const observations = [...Array.from({ length: copies }, (_, index) => index % 2 ? moved : first), retry];
  const features = [...Array.from({ length: 2 * copies }, (_, index) => index % 2 ? {
    ...graded, recordedAt: at(index + 1), eligibility: { ...graded.eligibility, verifiedCorrect: "unknown" as const },
    gaps: ["cartridge_evidence_not_qualified" as const],
  } : { ...graded, recordedAt: at(index + 1) }), feature(retry)];

  for (const cutoff of [at(2), at(2 * copies + 1)]) {
    expectFastVisibleRevisions(observations.slice(0, -1), features.slice(0, -1), cutoff);
    const result = replayEvidence({ scope, cutoff, observations, features, targetFamilyKeys: [], propagatedFamilyKeys: [] });
    expect(result).toEqual(cutoff === at(2)
      ? { weights: [[first.id, 0], [retry.id, 0]], lastDirectRecallAtMs: null, holdout: [] }
      : { weights: [[retry.id, 1]], lastDirectRecallAtMs: Date.parse(retry.attemptedAt), holdout: [retry.id] });
  }
});

it.each([1, 2])("R27 keeps %i uncertain legacy copies out of direct replay and holdout", copies => {
  const first = head("first", 1);
  const retry = head("retry", 2, { problemId: first.problemId, familyKey: first.familyKey });
  const otherComponent = { ...first, verifiedCorrect: "no" as const };
  const legacyCopies = Array.from({ length: copies }, () => first);
  const features = [feature(first), feature(retry), feature(first, { recordedAt: at(7) })];
  if (copies > 1) features.push(feature(first, { recordedAt: at(8) }));
  // This future component shares the ID but none of the compatible slots.
  features.push(feature(otherComponent, { recordedAt: at(9) }));
  const input = { scope, cutoff: at(3), observations: [...legacyCopies, retry, otherComponent], features,
    targetFamilyKeys: [], propagatedFamilyKeys: [] };
  const resolved = visibleObservationRevisions([...legacyCopies, otherComponent],
    courseFeatureRevisions(features.filter(row => row.observationId === first.id), scope.courseId), Date.parse(input.cutoff));
  expect(resolved.canBeAbsent).toBe(true);
  expect(resolved.revisions.map(row => row.recorded)).toEqual([Date.parse(at(1))]);
  expect(replayEvidence(input)).toEqual({
    weights: [[first.id, 0], [retry.id, 0]], lastDirectRecallAtMs: null, holdout: [],
  });

  const own = head("own", 1);
  const source = head("source", 2, { requirementKey: "apply-integrals" });
  const fireInput = { scope, cutoff: at(3), observations: [own, source], targetFamilyKeys: [], propagatedFamilyKeys: [],
    features: [feature(own), feature(source), feature(source, { recordedAt: at(7) })],
    fireEdgesByObservationId: new Map([[source.id, { sourceSkillVersion: 1, edgeWeight: 1, covered: true, stepPassed: true }]]) };
  expect(predictLearnerShadowV2(fireInput).belief.implicitLogCredit).toBe(0);
  expect(predictLearnerShadowV2({ ...fireInput, observations: [own, { ...source, recordedAt: at(2) }] })
    .belief.implicitLogCredit).toBeGreaterThan(0);
});

type SlotGrade = SnapshotObservation["verifiedCorrect"] | "withheld";

function gradeSlot(row: SnapshotObservation, grade: SlotGrade, recordedAt: string) {
  const slot = feature({ ...row, verifiedCorrect: grade === "withheld" ? "unknown" : grade }, { recordedAt });
  if (grade === "withheld") slot.gaps = ["cartridge_evidence_not_qualified"];
  return slot;
}

it.each([
  { buckets: 2, copies: 10 }, { buckets: 2, copies: 12 }, { buckets: 3, copies: 12 }, { buckets: 3, copies: 15 },
])("R26 resolves $copies copies across $buckets overlapping buckets", ({ buckets, copies }) => {
  const first = head("first", 1);
  const wrong = { ...first, problemId: "wrong", familyKey: "wrong-family", verifiedCorrect: "no" as const };
  const unknown = { ...first, problemId: "unknown", familyKey: "unknown-family", verifiedCorrect: "unknown" as const };
  const projections = [first, wrong, unknown].slice(0, buckets);
  const retry = head("retry", 2, { problemId: first.problemId, familyKey: first.familyKey, attemptedAt: "2026-10-01T22:00:00.000Z" });
  const observations = Array.from({ length: copies }, (_, index) => projections[index % buckets]!);
  const grades: SlotGrade[] = ["yes", "withheld", "no"];
  if (buckets === 3) grades.push("unknown");
  const features = Array.from({ length: 2 * copies }, (_, index) => gradeSlot(first, grades[index % grades.length]!, at(index + 1)));

  for (const cutoff of [at(2), at(2 * copies + 1)]) {
    expectFastVisibleRevisions(observations, features, cutoff);
    expect(replayEvidence({ scope, cutoff, observations: [...observations, retry], features: [...features, feature(retry)],
      targetFamilyKeys: [], propagatedFamilyKeys: [] })).toEqual(cutoff === at(2)
      ? { weights: [[first.id, 0], [retry.id, 0]], lastDirectRecallAtMs: null, holdout: [] }
      : { weights: [[retry.id, 1]], lastDirectRecallAtMs: Date.parse(retry.attemptedAt), holdout: [retry.id] });
  }
});

it.each([
  { grades: ["withheld", "yes", "no", "withheld", "yes", "no"] as const, includeUnknown: false },
  { grades: ["withheld", "yes", "unknown", "no", "withheld", "yes", "unknown", "no"] as const, includeUnknown: true },
])("R26 agrees with exhaustive assignments for slots $grades", ({ grades, includeUnknown }) => {
  const first = head("first", 1);
  const wrong = { ...first, problemId: "wrong", verifiedCorrect: "no" as const };
  const unknown = { ...first, problemId: "unknown", verifiedCorrect: "unknown" as const };
  const corrected = { ...first, problemId: "corrected" };
  const observations = includeUnknown ? [wrong, first, unknown, corrected, unknown] : [wrong, first, corrected, wrong];
  const recordings = grades.map((_, slot) => Date.parse(at(2 + Math.floor(slot / 2))));
  const slots = courseFeatureRevisions(grades.map((grade, index) =>
    gradeSlot(first, grade, new Date(recordings[index]!).toISOString())), scope.courseId);
  const gradeAtSlot = slots.map(({ feature: row }) => row.gaps.length ? "withheld" : row.eligibility.verifiedCorrect);
  const occupiedSubsets = new Map<string, { slot: number; producer: number }[]>();
  const placement: { slot: number; producer: number }[] = [];
  const placed = new Set<number>();
  function enumerate(slot: number) {
    if (slot === slots.length) {
      // The fixture has enough slots for every copy. For each occupied subset,
      // retain the lexicographically earliest valid sequence of producer indices.
      if (placement.length !== observations.length) return;
      const key = placement.map(row => row.slot).join(",");
      const previous = occupiedSubsets.get(key);
      const firstDifference = previous?.findIndex((row, index) => row.producer !== placement[index]!.producer);
      if (!previous || (firstDifference !== undefined && firstDifference >= 0
        && placement[firstDifference]!.producer < previous[firstDifference]!.producer)) occupiedSubsets.set(key, [...placement]);
      return;
    }
    enumerate(slot + 1);
    const gradesSeen = new Set<SlotGrade>();
    observations.forEach((row, producer) => {
      if (placed.has(producer) || gradesSeen.has(row.verifiedCorrect)) return;
      gradesSeen.add(row.verifiedCorrect);
      if (gradeAtSlot[slot] !== "withheld" && gradeAtSlot[slot] !== row.verifiedCorrect) return;
      placed.add(producer);
      placement.push({ slot, producer });
      enumerate(slot + 1);
      placement.pop();
      placed.delete(producer);
    });
  }
  enumerate(0);
  expect(occupiedSubsets.size).toBeGreaterThan(1);

  for (const cutoff of [...new Set(recordings), recordings.at(-1)! + 1]) {
    const revisions = new Map<string, number>();
    const latest = new Map<string, number>();
    let canBeAbsent = false;
    for (const assignment of occupiedSubsets.values()) {
      const visible = assignment.filter(({ slot }) => slots[slot]!.recorded < cutoff);
      canBeAbsent ||= visible.length === 0;
      visible.forEach(({ slot, producer }) => {
        const row = observations[producer]!;
        const recorded = slots[slot]!.recorded;
        const key = JSON.stringify([row.problemId, recorded]);
        const copies = visible.filter(other => observations[other.producer] === row).length;
        revisions.set(key, Math.max(revisions.get(key) ?? 0, copies));
        if (recorded === slots[visible.at(-1)!.slot]!.recorded) latest.set(key, 0);
      });
    }
    const actual = visibleObservationRevisions(observations, slots, cutoff);
    const summarize = (rows: typeof actual.revisions, latestOnly = false) => {
      const result = new Map<string, number>();
      for (const { observation, recorded, legacyCopies } of rows) {
        const key = JSON.stringify([observation.problemId, recorded]);
        result.set(key, latestOnly ? 0 : Math.max(result.get(key) ?? 0, legacyCopies!));
      }
      return result;
    };
    expect(summarize(actual.revisions)).toEqual(revisions);
    expect(summarize(actual.latest, true)).toEqual(latest);
    expect(actual.canBeAbsent).toBe(canBeAbsent);
    expect(actual.unplaced).toEqual([]);
  }
});

it("holds overlapping legacy revisions until their forced recording slot", () => {
  const first = head("first", 2);
  const retry = head("retry", 2, { problemId: first.problemId, familyKey: first.familyKey,
    attemptedAt: "2026-10-02T12:00:00.000Z" });
  const original = projectProducedAttempts([first, retry], at(3), { cartridgeEvidence: withheldFirstGrade });
  const moved = { ...first, problemId: "corrected-problem", familyKey: "corrected-family" };
  const unverified = projectProducedAttempts([{ ...moved, recordedAt: at(4), context: { referenceCheck: null } }], at(6));
  const verified = projectProducedAttempts([{ ...moved, recordedAt: at(5) }], at(6));
  const features = [...original.features, ...unverified.features, ...verified.features];
  expect(features.filter(row => row.observationId === first.id).map(row => [
    row.recordedAt, row.eligibility.verifiedCorrect, row.gaps.includes("cartridge_evidence_not_qualified"),
  ])).toEqual([[at(2), "unknown", true], [at(4), "unknown", false], [at(5), "yes", false]]);
  const input = { ...original, features, targetFamilyKeys: [], propagatedFamilyKeys: [] };
  const orders = [
    [...original.observations, ...unverified.observations, ...verified.observations],
    [...unverified.observations, ...original.observations, ...verified.observations],
  ];
  const historical = { weights: [[first.id, 0], [retry.id, 0]], lastDirectRecallAtMs: null, holdout: [] };
  const afterRevision = { weights: [[retry.id, 1]], lastDirectRecallAtMs: Date.parse(retry.attemptedAt), holdout: [retry.id] };
  const cutoffs = [at(3), "2026-10-04T22:00:00.000Z"];

  expect(orders.map(observations => cutoffs.map(cutoff => replayEvidence({ ...input, observations, cutoff }))))
    .toEqual([[historical, afterRevision], [historical, afterRevision]]);
});

it("keeps overlapping full legacy buckets disputed in either order", () => {
  const first = head("first", 2);
  const original = projectProducedAttempts([first], at(3), { cartridgeEvidence: withheldFirstGrade });
  const verified = projectProducedAttempts([{ ...first, recordedAt: at(5) }], at(6));
  const unverified = projectProducedAttempts([{ ...first, problemId: "corrected-problem", familyKey: "corrected-family",
    recordedAt: at(4), context: { referenceCheck: null } }], at(6));
  const yes = [...original.observations, ...verified.observations];
  const unknown = [...unverified.observations, ...unverified.observations];
  const input = { ...original, features: [...original.features, ...unverified.features, ...verified.features],
    targetFamilyKeys: [], propagatedFamilyKeys: [] };

  // Neither full bucket can exclusively claim the shared October 2 slot.
  for (const observations of [[...yes, ...unknown], [...unknown, ...yes]]) {
    expect(replayEvidence({ ...input, observations })).toEqual({ weights: [], lastDirectRecallAtMs: null, holdout: [] });
  }
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

it.each([
  { revisionKey: "A", source: "feature", siblingWeight: 1 },
  { revisionKey: "C", source: "both", siblingWeight: 1 },
  { revisionKey: "B", source: "feature", siblingWeight: 0 },
  { revisionKey: "B", source: "observation", siblingWeight: 0 },
])("replays a shared submission when a $source revision of A claims $revisionKey", ({ revisionKey, source, siblingWeight }) => {
  const shared = { problemId: "shared-problem", familyKey: "shared-family", recordedAt: at(1) };
  const skillA = head("skill-a", 1, { ...shared, requirementKey: "A" });
  const skillB = head("skill-b", 1, { ...shared, requirementKey: "B" });
  const revision = { ...skillA, requirementKey: revisionKey, recordedAt: at(2) };
  const observations = [skillA, skillB];
  const features = observations.map(row => feature(row, { attemptId: "shared" }));
  if (source !== "feature") observations.push(revision);
  if (source !== "observation") features.push(feature(revision, { attemptId: "shared", recordedAt: at(2) }));
  const input = { observations, features, targetFamilyKeys: [], propagatedFamilyKeys: [] };
  const beforeA = { ...input, scope: { ...scope, requirementKey: "A" }, cutoff: at(2) };
  const afterA = { ...beforeA, cutoff: at(3) };
  const beforeB = { ...beforeA, scope: { ...scope, requirementKey: "B" } };
  const afterB = { ...beforeB, cutoff: at(3) };

  expect(buildSkillBeliefTrajectory(beforeA).steps).toMatchObject([{ observationId: skillA.id, omega: 1 }]);
  expect(compareLearnerShadowV2(beforeA).rows.map(row => row.observationId)).toEqual([skillA.id]);
  const revised = buildSkillBeliefTrajectory(afterA);
  expect(revised.steps).toMatchObject(revisionKey === "A" ? [{ observationId: skillA.id, omega: 0 }] : []);
  expect(revised.belief.lastDirectRecallAtMs).toBeNull();
  expect(compareLearnerShadowV2(afterA).rows).toEqual([]);

  const originalSibling = buildSkillBeliefTrajectory(beforeB);
  const originalHoldout = compareLearnerShadowV2(beforeB).rows;
  expect(originalSibling.steps).toMatchObject([{ observationId: skillB.id, omega: 1 }]);
  expect(originalSibling.belief.lastDirectRecallAtMs).toBe(Date.parse(at(1)));
  expect(originalHoldout.map(row => row.observationId)).toEqual([skillB.id]);
  const sibling = buildSkillBeliefTrajectory(afterB);
  expect(sibling.steps).toMatchObject([{ observationId: skillB.id, omega: siblingWeight }]);
  expect(sibling.belief.lastDirectRecallAtMs).toBe(siblingWeight === 1 ? Date.parse(at(1)) : null);
  expect(compareLearnerShadowV2(afterB).rows).toEqual(siblingWeight === 1 ? originalHoldout : []);
});

it.each([
  { revisionKey: "B", changesFamily: true, siblingWeight: 0 },
  { revisionKey: "B", changesFamily: false, siblingWeight: 0 },
  { revisionKey: "C", changesFamily: true, siblingWeight: 1 },
])("checks the sibling's claim when A moves problems and claims $revisionKey (changes family: $changesFamily)", ({
  revisionKey, changesFamily, siblingWeight,
}) => {
  const prior = head("prior-b", 1, { requirementKey: "B" });
  const shared = { problemId: "shared-problem", familyKey: "shared-family", recordedAt: at(2) };
  const skillA = head("skill-a", 2, { ...shared, requirementKey: "A" });
  const skillB = head("skill-b", 2, { ...shared, requirementKey: "B" });
  const revision = { ...skillA, requirementKey: revisionKey, problemId: "other-problem", recordedAt: at(4),
    familyKey: changesFamily ? "other-family" : skillA.familyKey };
  const input = { scope: { ...scope, requirementKey: "B" }, cutoff: at(4),
    observations: [prior, skillA, skillB, revision],
    features: [feature(prior), feature(skillA, { attemptId: "shared" }), feature(skillB, { attemptId: "shared" }),
      feature(revision, { attemptId: "shared", recordedAt: at(4) })],
    targetFamilyKeys: [], propagatedFamilyKeys: [] };

  const before = buildSkillBeliefTrajectory(input);
  expect(before.steps.at(-1)).toMatchObject({ observationId: skillB.id, omega: 1 });
  expect(before.belief.lastDirectRecallAtMs).toBe(Date.parse(at(2)));
  expect(compareLearnerShadowV2(input).rows.map(row => row.observationId)).toEqual([prior.id, skillB.id]);

  const afterRevision = { ...input, cutoff: at(5) };
  const after = buildSkillBeliefTrajectory(afterRevision);
  expect(after.steps.map(step => [step.observationId, step.omega])).toEqual([[prior.id, 1], [skillB.id, siblingWeight]]);
  expect(after.belief.lastDirectRecallAtMs).toBe(Date.parse(at(siblingWeight ? 2 : 1)));
  expect(compareLearnerShadowV2(afterRevision).rows.map(row => row.observationId))
    .toEqual(siblingWeight ? [prior.id, skillB.id] : [prior.id]);
});

it.each([
  { scenario: "feature moves earlier", source: "feature", day: 1 },
  { scenario: "feature moves later", source: "feature", day: 3 },
  { scenario: "observation moves earlier", source: "observation", day: 1 },
  { scenario: "observation moves later", source: "observation", day: 3 },
  { scenario: "both move earlier", source: "both", day: 1 },
  { scenario: "both move later", source: "both", day: 3 },
  { scenario: "feature changes attempt ID", source: "feature", day: 2, attemptId: "different" },
  { scenario: "revision also changes problem and family", source: "both", day: 3, changesIdentities: true },
])("excludes a sibling from a disputed submission when $scenario", ({ source, day, attemptId = "shared", changesIdentities }) => {
  const shared = { problemId: "shared-problem", familyKey: "shared-family", recordedAt: at(2) };
  const skillA = head("skill-a", 2, { ...shared, requirementKey: "A" });
  const skillB = head("skill-b", 2, { ...shared, requirementKey: "B" });
  const revision = { ...skillA, attemptedAt: at(day), recordedAt: at(4),
    ...(changesIdentities ? { problemId: "other-problem", familyKey: "other-family" } : {}) };
  const observations = [skillA, skillB];
  const features = observations.map(row => feature(row, { attemptId: "shared" }));
  if (source !== "feature") observations.push(revision);
  if (source !== "observation") features.push(feature(revision, { attemptId, recordedAt: at(4) }));
  const input = { scope: { ...scope, requirementKey: "B" }, cutoff: at(4), observations, features,
    targetFamilyKeys: [], propagatedFamilyKeys: [] };

  const before = buildSkillBeliefTrajectory(input);
  expect(before.steps).toMatchObject([{ observationId: skillB.id, omega: 1 }]);
  expect(before.belief.lastDirectRecallAtMs).toBe(Date.parse(at(2)));
  expect(compareLearnerShadowV2(input).rows.map(row => row.observationId)).toEqual([skillB.id]);

  const afterRevision = { ...input, cutoff: at(5) };
  const after = buildSkillBeliefTrajectory(afterRevision);
  expect(after.steps).toMatchObject([{ observationId: skillB.id, omega: 0 }]);
  expect(after.belief.lastDirectRecallAtMs).toBeNull();
  expect(compareLearnerShadowV2(afterRevision).rows).toEqual([]);
});

it("excludes duplicate requirements even after one head is revised to a missing requirement in a shared submission", () => {
  const shared = { problemId: "shared-problem", familyKey: "shared-family" };
  const firstA = head("first-a", 1, { ...shared, requirementKey: "A" });
  const secondA = head("second-a", 1, { ...shared, requirementKey: "A" });
  const skillB = head("skill-b", 1, { ...shared, requirementKey: "B" });
  const observations = [firstA, skillB, secondA];
  const features = [...observations.map(row => feature(row, { attemptId: "shared" })),
    feature(firstA, { attemptId: "shared", requirementKey: null, recordedAt: at(2) })];
  const input = { scope: { ...scope, requirementKey: "A" }, cutoff: at(2), observations, features,
    targetFamilyKeys: [], propagatedFamilyKeys: [] };

  expect(buildSkillBeliefTrajectory(input).steps).toMatchObject([
    { observationId: firstA.id, omega: 0 }, { observationId: secondA.id, omega: 0 },
  ]);
  expect(compareLearnerShadowV2(input).rows).toEqual([]);
  const afterRevision = { ...input, cutoff: at(3) };
  expect(buildSkillBeliefTrajectory(afterRevision).steps).toMatchObject([{ observationId: secondA.id, omega: 0 }]);
  expect(compareLearnerShadowV2(afterRevision).rows).toEqual([]);
  for (const replay of [input, afterRevision]) {
    const otherSkill = { ...replay, scope: { ...scope, requirementKey: "B" } };
    const result = buildSkillBeliefTrajectory(otherSkill);
    expect(result.steps).toMatchObject([{ observationId: skillB.id, omega: 1 }]);
    expect(result.belief.lastDirectRecallAtMs).toBe(Date.parse(at(1)));
    expect(compareLearnerShadowV2(otherSkill).rows.map(row => row.observationId)).toEqual([skillB.id]);
  }
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
  // The extra feature slot makes the untimestamped projection's visible presence uncertain.
  expect(predictLearnerShadowV2(appended).evidenceObservationIds).toEqual(["original", "problem"]);
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

it("treats explicit and legacy projections of the same recording as one piece of evidence", () => {
  const input = { ...projectProducedAttempts([head("evidence", 2)], at(3), { untimestamped: false }),
    targetFamilyKeys: [], propagatedFamilyKeys: [] };
  const [explicit] = input.observations;
  const { recordedAt, ...legacy } = explicit!;
  expect(recordedAt).toBe(at(2));
  expect(input.features).toHaveLength(1);

  const before = buildSkillBeliefTrajectory(input);
  const holdout = compareLearnerShadowV2(input);
  expect(before.steps).toMatchObject([{ observationId: legacy.id, omega: 1 }]);
  expect(before.belief.lastDirectRecallAtMs).toBe(Date.parse(at(2)));
  expect(holdout.rows.map(row => row.observationId)).toEqual([legacy.id]);
  for (const observations of [[legacy], [explicit!, legacy], [legacy, explicit!]]) {
    expect(buildSkillBeliefTrajectory({ ...input, observations })).toEqual(before);
    expect(compareLearnerShadowV2({ ...input, observations })).toEqual(holdout);
  }

  for (const conflict of [{ ...legacy, isMultiDraft: true }, { ...legacy, isFirstSubmission: false },
    { ...legacy, recordedAt: at(4) }]) {
    const disputed = { ...input, cutoff: at(5), observations: [explicit!, conflict] };
    const after = buildSkillBeliefTrajectory(disputed);
    expect(after.steps).toMatchObject([{ observationId: legacy.id, omega: 0 }]);
    expect(after.belief.lastDirectRecallAtMs).toBeNull();
    expect(compareLearnerShadowV2(disputed).rows).toEqual([]);
  }
});

it.each([
  { projection: "untimestamped original", originalTimestamped: false, revisionFirst: false },
  { projection: "timestamped original before the revision", originalTimestamped: true, revisionFirst: false },
  { projection: "timestamped original after the revision", originalTimestamped: true, revisionFirst: true },
])("binds a future untimestamped revision before replay with $projection", ({ originalTimestamped, revisionFirst }) => {
  const evidence = head("evidence", 2);
  const original = originalTimestamped ? { ...evidence, recordedAt: at(2) } : evidence;
  const revision = { ...evidence, isMultiDraft: true, isFirstSubmission: false, familyKey: "other-family" };
  const input = { scope, cutoff: at(3), observations: [original], features: [feature(original)],
    targetFamilyKeys: [], propagatedFamilyKeys: [] };
  const appended = { ...input, observations: revisionFirst ? [revision, original] : [original, revision],
    features: [...input.features, feature(revision, { recordedAt: at(4) })] };

  const before = buildSkillBeliefTrajectory(input);
  const holdout = compareLearnerShadowV2(input).rows;
  expect(before.steps).toMatchObject([{ observationId: original.id, omega: 1 }]);
  expect(before.belief.lastDirectRecallAtMs).toBe(Date.parse(at(2)));
  expect(holdout.map(row => row.observationId)).toEqual([original.id]);
  expect(buildSkillBeliefTrajectory(appended)).toEqual(before);
  expect(compareLearnerShadowV2(appended).rows).toEqual(holdout);

  const afterRevision = { ...appended, cutoff: at(5) };
  const after = buildSkillBeliefTrajectory(afterRevision);
  expect(after.steps).toMatchObject([{ observationId: original.id, omega: 0 }]);
  expect(after.belief.lastDirectRecallAtMs).toBeNull();
  expect(compareLearnerShadowV2(afterRevision).rows).toEqual([]);
});

it.each([
  { projection: "duplicate copies of the first revision", ambiguous: false },
  { projection: "three distinct revisions for two slots", ambiguous: true },
])("keeps future legacy revisions out of a claimed past slot with $projection", ({ ambiguous }) => {
  const legacy = head("evidence", 2);
  const original = { ...legacy, recordedAt: at(2) };
  const firstRevision = { ...legacy, isMultiDraft: true };
  const secondRevision = { ...legacy, problemId: "other-problem", familyKey: "other-family" };
  const extra = ambiguous ? { ...legacy, isFirstSubmission: false } : { ...firstRevision };
  const input = { scope, cutoff: at(3), observations: [original], features: [feature(original)],
    targetFamilyKeys: [], propagatedFamilyKeys: [] };
  const appended = { ...input, observations: [original, firstRevision, extra, secondRevision],
    features: [...input.features, feature(firstRevision, { recordedAt: at(4) }), feature(secondRevision, { recordedAt: at(5) })] };

  const before = buildSkillBeliefTrajectory(input);
  expect(before.steps).toMatchObject([{ observationId: original.id, omega: 1 }]);
  expect(before.belief.lastDirectRecallAtMs).toBe(Date.parse(at(2)));
  expect(buildSkillBeliefTrajectory(appended)).toEqual(before);
  expect(compareLearnerShadowV2(appended).rows.map(row => row.observationId)).toEqual([original.id]);

  const betweenRevisions = { ...appended, cutoff: "2026-10-04T22:00:00.000Z" };
  const between = buildSkillBeliefTrajectory(betweenRevisions);
  expect(between.steps).toMatchObject(ambiguous ? [] : [{ observationId: original.id, omega: 0 }]);
  expect(between.belief.lastDirectRecallAtMs).toBeNull();
  expect(compareLearnerShadowV2(betweenRevisions).rows).toEqual([]);

  const afterBothRevisions = { ...appended, cutoff: at(6) };
  expect(buildSkillBeliefTrajectory(afterBothRevisions).steps).toEqual([]);
  expect(compareLearnerShadowV2(afterBothRevisions).rows).toEqual([]);
});

it.each([
  { projection: "untimestamped original", originalTimestamped: false },
  { projection: "timestamped original", originalTimestamped: true },
])("pairs duplicate future legacy revisions by slot with an $projection", ({ originalTimestamped }) => {
  const legacy = head("evidence", 2);
  const original = originalTimestamped ? { ...legacy, recordedAt: at(2) } : legacy;
  const revision = { ...legacy, isMultiDraft: true };
  const input = { scope, cutoff: at(3), observations: [original], features: [feature(original)],
    targetFamilyKeys: [], propagatedFamilyKeys: [] };
  const appended = { ...input, observations: [original, revision, { ...revision }],
    features: [...input.features, feature(revision, { recordedAt: at(4) }), feature(revision, { recordedAt: at(5) })] };

  const before = buildSkillBeliefTrajectory(input);
  const holdout = compareLearnerShadowV2(input).rows;
  expect(before.steps).toMatchObject([{ observationId: original.id, omega: 1 }]);
  expect(before.belief.lastDirectRecallAtMs).toBe(Date.parse(at(2)));
  expect(holdout.map(row => row.observationId)).toEqual([original.id]);
  expect(buildSkillBeliefTrajectory(appended)).toEqual(before);
  expect(compareLearnerShadowV2(appended).rows).toEqual(holdout);

  for (const cutoff of ["2026-10-04T22:00:00.000Z", at(6)]) {
    const afterRevision = { ...appended, cutoff };
    const after = buildSkillBeliefTrajectory(afterRevision);
    expect(after.steps).toMatchObject([{ observationId: original.id, omega: 0 }]);
    expect(after.belief.lastDirectRecallAtMs).toBeNull();
    expect(compareLearnerShadowV2(afterRevision).rows).toEqual([]);
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

it.each([
  { scenario: "valid reservation", reservation: block(2, "10:30", "10:50"), availableUntil: "11:00", dueAt: null,
    kept: true, expectedStart: "10:30", unscheduled: false },
  { scenario: "reservation before the task opens", reservation: block(2, "10:10", "10:30"), availableUntil: "11:00", dueAt: null,
    kept: false, expectedStart: "10:20", unscheduled: false },
  { scenario: "reservation after the deadline", reservation: block(2, "10:30", "10:50"), availableUntil: "11:00", dueAt: time("10:45"),
    kept: false, expectedStart: "10:20", unscheduled: false },
  { scenario: "unreserved task", reservation: undefined, availableUntil: "11:00", dueAt: null,
    kept: false, expectedStart: "10:20", unscheduled: false },
  { scenario: "released task with no fitting slot", reservation: block(2, "10:10", "10:30"), availableUntil: "10:30", dueAt: null,
    kept: false, expectedStart: undefined, unscheduled: true },
])("R27 checks a deferred task's $scenario during wheel-spinning carryover", ({
  reservation, availableUntil, dueAt, kept, expectedStart, unscheduled,
}) => {
  const now = new Date(time("10:00"));
  const active = block(1, "09:45", "10:30");
  const input = { acceptedBlocks: reservation ? [active, reservation] : [active],
    tasks: [task(1), { ...task(2), notBefore: time("10:20"), dueAt }], now,
    constraints: [{ kind: "free" as const, start: time("09:00"), end: time(availableUntil) }],
    options: { localDate: "2026-10-16", timeZone: "UTC" } };
  const replanned = buildLocalReplan({ ...input,
    wheelSpinningGuard: { taskId: taskId(1), events: stalledEvents(["09:50", "09:55", "10:00"]) } });

  expect(replanned.fixedBlocks).toEqual([{ ...active, end: time("10:00") }, ...(kept ? [reservation] : [])]);
  expect(replanned.blocks.find(row => row.taskId === taskId(2))?.start).toBe(expectedStart ? time(expectedStart) : undefined);
  expect(replanned.releasedTaskVersions.map(row => row.id).sort()).toEqual(reservation && !kept
    ? [taskId(1), taskId(2)] : [taskId(1)]);
  expect(replanned.unscheduledTaskIds).toEqual(unscheduled ? [taskId(2)] : []);
  if (reservation) {
    expect(buildLocalReplan(input).releasedTaskVersions).toEqual([{ id: taskId(2), version: 1, status: "pending" }]);
  }
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
