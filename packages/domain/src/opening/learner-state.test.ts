import { describe, expect, it } from "vitest";
import { courseEvidence, courseEvidenceCases, learningObservation, qualifiedInput } from "./learning-summary-fixtures";
import { assembleLearnerState, countValidLearnerObservations, learnerEvidenceDisplayState } from "./learner-state";
import { evaluateEvidenceEligibility } from "./evidence-eligibility";
import { exposure } from "./evidence-eligibility-fixtures";

const read = (evidence = courseEvidence(), limit = 100) => assembleLearnerState({ evidence, limit, stateVersion: "state-1", dataAsOf: "2026-10-19T00:00:00.000Z" });
describe("LearnerState projection", () => {
  it("keeps qualification and provenance without claiming mastery or transfer from browsing", () => {
    const result = read();
    expect(result.features[0]).toMatchObject({ observationId: learningObservation.id, requirementKey: qualifiedInput.observation.requirementKey,
      eligibility: { verifiedCorrect: "yes", independentAttempt: "yes" }, views: ["independent", "retention"], availability: "available" });
    expect(result.summary[0]?.views.transfer).toBe(0);
    expect(result.summary[0]?.gaps).toContain("retention_intervening_exposure_not_established");
    expect(result.projection.repairTriggered).toBe(false);
    expect(result.skillProfile).toMatchObject({ profileVersion: "rule-profile:1", stateVersion: "state-1",
      qualificationVersion: result.policyVersion, scope: { workspaceId: "", ownerUserId: "", courseId: null },
      items: [{ courseId: learningObservation.courseId, requirementKey: qualifiedInput.observation.requirementKey,
        state: "independent", observationRefs: [{ observationId: learningObservation.id, sourceIds: learningObservation.sourceIds }] }] });
  });
  it("limits evidence display while preserving the entire ordered predictor sequence", () => {
    const evidence = courseEvidence();
    const rows = [3, 1, 2].map(i => ({ ...learningObservation, id: `observation-${i}`, submittedAt: `2026-10-18T0${i}:00:00.000Z` }));
    evidence.observations = rows;
    evidence.evidenceContexts = Object.fromEntries(rows.map(row => [row.id, { ...qualifiedInput, observation: { ...qualifiedInput.observation, submittedAt: Date.parse(row.submittedAt) } }]));
    const result = read(evidence, 1);
    expect(result.evidence.map(row => row.observationId)).toEqual(["observation-3"]);
    expect(result.features.map(row => row.observationId)).toEqual(["observation-1", "observation-2", "observation-3"]);
    expect(result.completeness).toMatchObject({ status: "truncated", total: 3, returned: 1 });
    expect(countValidLearnerObservations(result.features)).toBe(3);
  });
  it.each([["source changed", "stale"], ["source unavailable", "unavailable"]] as const)("distinguishes %s from absent evidence", (name, availability) => {
    const result = read(courseEvidenceCases.find(row => row.name === name)!.evidence);
    expect(result.evidence[0]?.availability).toBe(availability);
    expect(result.features).toHaveLength(1);
    expect(result.evidence[0]?.eligibility.verifiedCorrect).toBe("yes");
  });
  it("empty evidence remains unobserved, not mastered or failed", () => {
    const result = read({ observations: [], evidenceContexts: {} });
    expect(result.summary).toEqual([]);
    expect(result.completeness).toMatchObject({ status: "complete", gaps: ["no_observation_evidence"] });
    expect(result.display).toMatchObject({ scope: "recorded_requirements", total: 0, counts: { independent: 0, hinted: 0, retest: 0, insufficient: 0 } });
  });
});

describe("learner progress sample count", () => {
  it("counts correct, incorrect and assisted answers once without treating every view as another answer", () => {
    const correct = read().features[0]!;
    const assisted = read(courseEvidenceCases.find(row => row.name === "help before submission")!.evidence).features[0]!;
    const wrong = read(courseEvidence({ observation: { ...qualifiedInput.observation, outcome: "incorrect" },
      context: { ...qualifiedInput.context, referenceCheck: { ...qualifiedInput.context.referenceCheck!, outcome: "incorrect" } } })).features[0]!;
    expect(wrong.eligibility.verifiedCorrect).toBe("no");
    expect(assisted.eligibility.independentAttempt).toBe("no");
    expect(countValidLearnerObservations([correct, correct,
      { ...assisted, observationId: "assisted" }, { ...wrong, observationId: "wrong" }])).toBe(3);
  });

  it("excludes ungraded, self-reported, stale, unavailable and privacy-excluded answers", () => {
    const invalid = ["legacy identity missing", "reference_checked label without method", "self-reported correct",
      "source changed", "source unavailable", "source privacy excluded"].flatMap(name =>
      read(courseEvidenceCases.find(row => row.name === name)!.evidence).features.map(row => ({ ...row, observationId: name })));
    expect(countValidLearnerObservations(invalid)).toBe(0);
    expect(countValidLearnerObservations([])).toBe(0);
  });
});

describe("recorded requirement evidence states", () => {
  const eligibility = evaluateEvidenceEligibility(qualifiedInput.observation, qualifiedInput.context);
  it("requires qualified correctness and independence, with hint level one already counting as help", () => {
    expect(learnerEvidenceDisplayState({ assistance: "independent", eligibility })).toBe("independent");
    expect(learnerEvidenceDisplayState({ assistance: "hinted", eligibility: { ...eligibility, independentAttempt: "no" } })).toBe("hinted");
    expect(learnerEvidenceDisplayState({ assistance: "hinted", eligibility: { ...eligibility, independentAttempt: "no", verifiedCorrect: "unknown" } })).toBe("insufficient");
    expect(learnerEvidenceDisplayState({ assistance: "independent", eligibility: { ...eligibility, independentAttempt: "unknown" } })).toBe("insufficient");
    expect(learnerEvidenceDisplayState(null)).toBe("insufficient");
  });

  it("uses a review next step for errors, exposed answers and actual due checks without changing qualification", () => {
    expect(learnerEvidenceDisplayState({ assistance: "independent", eligibility: { ...eligibility, verifiedCorrect: "no" } })).toBe("retest");
    expect(learnerEvidenceDisplayState({ assistance: "revealed", eligibility })).toBe("retest");
    expect(learnerEvidenceDisplayState({ assistance: "independent", eligibility: { ...eligibility, reasonCodes: ["prior_answer_exposure"] } })).toBe("retest");
    expect(learnerEvidenceDisplayState({ assistance: "independent", eligibility }, { dueRetest: true })).toBe("retest");
    expect(learnerEvidenceDisplayState({ assistance: "independent", eligibility }, { solutionDelivered: true })).toBe("retest");
    expect(eligibility).toMatchObject({ verifiedCorrect: "yes", independentAttempt: "yes", usableForCurrentVersion: "yes" });
  });

  it.each(["source changed", "source unavailable", "legacy identity missing"])("does not turn %s into current success or failure", name => {
    const result = read(courseEvidenceCases.find(row => row.name === name)!.evidence);
    if (name === "legacy identity missing") {
      expect(result.display).toMatchObject({ total: 0, unscopedObservations: 1 });
    } else {
      expect(result.display.counts).toEqual({ independent: 0, hinted: 0, retest: 0, insufficient: 1 });
    }
    expect(learnerEvidenceDisplayState({ assistance: "revealed", eligibility: { ...eligibility, usableForCurrentVersion: "unknown" } }, { dueRetest: true })).toBe("insufficient");
  });

  it("uses canonical delivered help even when the stored answer claims independence", () => {
    const result = read(courseEvidenceCases.find(row => row.name === "help before submission")!.evidence);
    expect(result.display.counts).toEqual({ independent: 0, hinted: 1, retest: 0, insufficient: 0 });
    expect(result.features[0]?.eligibility.independentAttempt).toBe("no");
  });

  it("counts latest requirements across the full history, keeping course and requirement identities separate", () => {
    const specs = [
      { id: "old", courseId: "a", requirementKey: "one", submittedAt: 100, wrong: true },
      { id: "latest", courseId: "a", requirementKey: "one", submittedAt: 300, wrong: false },
      { id: "same-label", courseId: "a", requirementKey: "two", submittedAt: 200, wrong: true },
      { id: "same-requirement-other-course", courseId: "b", requirementKey: "one", submittedAt: 200, wrong: false },
      { id: "unknown-requirement", courseId: "a", requirementKey: null, submittedAt: 200, wrong: false },
    ];
    const evidence = { observations: specs.map(spec => ({ ...learningObservation, id: spec.id, courseId: spec.courseId })),
      evidenceContexts: Object.fromEntries(specs.map(spec => [spec.id, { observation: { ...qualifiedInput.observation, ...spec,
        outcome: spec.wrong ? "incorrect" as const : "correct" as const }, context: { ...qualifiedInput.context,
        referenceCheck: { ...qualifiedInput.context.referenceCheck!, outcome: spec.wrong ? "incorrect" as const : "correct" as const } } }])) };
    const result = assembleLearnerState({ evidence, limit: 1, stateVersion: "s", dataAsOf: "2026-10-21T00:00:00.000Z",
      dueRetests: [{ courseId: "b", requirementKey: "one", skillLabel: learningObservation.skillLabel },
        { courseId: "a", requirementKey: "missing", skillLabel: learningObservation.skillLabel }] });
    expect(result.display).toMatchObject({ scope: "recorded_requirements", total: 3, unscopedObservations: 1,
      counts: { independent: 1, hinted: 0, retest: 2, insufficient: 0 } });
    expect(result.display.requirements.find(row => row.courseId === "a" && row.requirementKey === "one")).toMatchObject({ state: "independent", observationIds: ["latest"], dueRetest: false });
    expect(result.evidence).toHaveLength(1);
    expect(result.features).toHaveLength(5);
  });

  it("does not pick a winner by id when conflicting latest attempts have equal timestamps", () => {
    const evidence = courseEvidence();
    evidence.observations.push({ ...learningObservation, id: "other" });
    evidence.evidenceContexts.other = { ...qualifiedInput, context: { ...qualifiedInput.context,
      helpHistory: { complete: true, exposures: [exposure] } } };
    expect(read(evidence).display).toMatchObject({ total: 1, counts: { independent: 0, hinted: 0, retest: 0, insufficient: 1 } });
  });

  it.each([
    ["solution", "revealed", "math", "attempt-2", true, "retest"],
    ["solution", "revealed", "unknown", "attempt-2", true, "retest"],
    ["solution", "revealed", "language", "attempt-2", true, "independent"],
    ["hint", "hinted", "math", "attempt-2", true, "independent"],
    ["solution", "revealed", "math", "other-attempt", true, "independent"],
    ["solution", "revealed", "math", "attempt-2", false, "independent"],
  ] as const)("handles post-answer %s/%s/%s for %s delivered=%s", (kind, level, supportDomain, attemptId, delivered, state) => {
    const evidence = courseEvidence({ ...qualifiedInput, context: { ...qualifiedInput.context, helpHistory: { complete: true,
      exposures: [{ ...exposure, kind, level, supportDomain, attemptId, delivered, deliveredAt: 350 }] } } });
    evidence.observations[0] = { ...learningObservation, attemptId: "attempt-2" };
    const result = read(evidence);
    expect(result.display.requirements[0]?.state).toBe(state);
    expect(result.features[0]?.eligibility).toMatchObject({ independentAttempt: "yes", verifiedCorrect: "yes" });
  });

  it("treats a language solution as answer exposure for a language assessment", () => {
    const evidence = courseEvidence({ observation: { ...qualifiedInput.observation, assessmentDomain: "language" },
      context: { ...qualifiedInput.context, helpHistory: { complete: true,
        exposures: [{ ...exposure, kind: "solution", level: "revealed", supportDomain: "language", deliveredAt: 350 }] } } });
    evidence.observations[0] = { ...learningObservation, attemptId: "attempt-2" };
    expect(read(evidence).display.requirements[0]?.state).toBe("retest");
  });
});
