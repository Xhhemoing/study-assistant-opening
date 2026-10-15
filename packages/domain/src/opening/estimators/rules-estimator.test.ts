import { describe, expect, it } from "vitest";
import type { LearningObservation } from "@aistudy/contracts";
import { summarizeObservations, type CourseEvidence, type RetestEvidenceIdentity } from "../learning-summary";
import { courseEvidence, courseEvidenceCases, learningObservation, qualifiedInput } from "../learning-summary-fixtures";
import { createRulesSkillStateEstimator } from "./rules-estimator";
import { toSkillEvidence } from "./skill-evidence";

const evaluatedAt = "2026-10-15T00:00:00.000Z";

function estimate(input: CourseEvidence, dueRetests: RetestEvidenceIdentity[] = []) {
  return createRulesSkillStateEstimator({ evaluatedAt, dueRetests }).estimate(input.observations
    .map(record => toSkillEvidence(record, input.evidenceContexts[record.id] ?? null)));
}

describe("rules-1 skill estimator", () => {
  it("has a version and keeps an empty evidence group unobserved", () => {
    const estimator = createRulesSkillStateEstimator({ evaluatedAt });
    expect(estimator.version).toBe("rules-1");
    expect(estimator.estimate([])).toEqual({ state: "unobserved", reasons: ["no_observations"] });
  });

  it.each(courseEvidenceCases)("preserves existing summary state for $name", ({ evidence }) => {
    const before = structuredClone(evidence);
    const summary = summarizeObservations(evidence.observations, evaluatedAt, { evidenceContexts: evidence.evidenceContexts });
    expect(estimate(evidence).state).toBe(summary[0]!.status);
    expect(evidence).toEqual(before);
  });

  it("retains due-retest precedence and the original qualification reasons", () => {
    const evidence = courseEvidence();
    const dueRetests = [{ courseId: learningObservation.courseId, requirementKey: qualifiedInput.observation.requirementKey!, skillLabel: learningObservation.skillLabel }];
    const result = estimate(evidence, dueRetests);
    expect(result.state).toBe(summarizeObservations(evidence.observations, evaluatedAt, { evidenceContexts: evidence.evidenceContexts, dueRetests })[0]!.status);
    expect(result.state).toBe("needs_review");
    expect(result.reasons).toContain("due_retest");
    expect(result.reasons).toContain("reference_checked_correct");
  });

  it.each(["self_report", "model_suggestion"] as const)("does not promote %s to observed independent", verdictSource => {
    const evidence = courseEvidence({ ...qualifiedInput, observation: { ...qualifiedInput.observation, verdictSource } });
    evidence.observations = evidence.observations.map(record => ({ ...record, verdictSource }));
    expect(estimate(evidence).state).toBe("needs_check");
    expect(estimate(evidence).reasons).toContain("verification_source_untrusted");
  });

  it("uses original submission time across revisions, preserving later independent success and simultaneous uncertainty", () => {
    const earlier = { ...learningObservation, id: "earlier", submittedAt: "2026-09-10T10:00:00.000Z", recordedAt: "2026-10-14T10:00:00.000Z", outcome: "incorrect" as const };
    const later = { ...learningObservation, id: "later", submittedAt: "2026-09-11T10:00:00.000Z" };
    const makeInput = (row: LearningObservation) => ({ observation: { ...qualifiedInput.observation, submittedAt: Date.parse(row.submittedAt!), outcome: row.outcome },
      context: { ...qualifiedInput.context, referenceCheck: { ...qualifiedInput.context.referenceCheck!, outcome: row.outcome } } });
    for (const observations of [[earlier, later], [later, earlier]]) {
      const evidence = { observations, evidenceContexts: { earlier: makeInput(earlier), later: makeInput(later) } };
      expect(estimate(evidence).state).toBe("observed_independent");
      expect(estimate(evidence).state).toBe(summarizeObservations(observations, evaluatedAt, { evidenceContexts: evidence.evidenceContexts })[0]!.status);
    }
    const tied = { ...earlier, submittedAt: later.submittedAt };
    expect(estimate({ observations: [tied, later], evidenceContexts: { earlier: makeInput(tied), later: makeInput(later) } }).state).toBe("needs_check");
  });

  it("requires all legacy evidence when requirement identity is absent", () => {
    const evidence = courseEvidence({ ...qualifiedInput, observation: { ...qualifiedInput.observation, requirementKey: null } });
    const incorrect = { ...learningObservation, id: "incorrect", outcome: "incorrect" as const };
    evidence.observations.push(incorrect);
    evidence.evidenceContexts[incorrect.id] = { ...qualifiedInput, observation: { ...qualifiedInput.observation, requirementKey: null, outcome: "incorrect" },
      context: { ...qualifiedInput.context, referenceCheck: { ...qualifiedInput.context.referenceCheck!, outcome: "incorrect" } } };
    expect(estimate(evidence).state).toBe("needs_check");
  });

  it("rejects multiple identities instead of silently returning the first skill's state", () => {
    const first = toSkillEvidence(learningObservation, qualifiedInput);
    const second = toSkillEvidence({ ...learningObservation, id: "other", courseId: "other-course" }, qualifiedInput);
    expect(() => createRulesSkillStateEstimator({ evaluatedAt }).estimate([first, second])).toThrow(/one workspace, course, requirement, and skill group/);
  });
});
