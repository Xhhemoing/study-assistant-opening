import { describe, expect, it } from "vitest";
import { courseEvidence, courseEvidenceCases, learningObservation, qualifiedInput } from "./learning-summary-fixtures";
import { assembleLearnerState } from "./learner-state";

const read = (evidence = courseEvidence(), limit = 100) => assembleLearnerState({ evidence, limit, stateVersion: "state-1", dataAsOf: "2026-10-19T00:00:00.000Z" });
describe("LearnerState projection", () => {
  it("keeps qualification and provenance without claiming mastery or transfer from browsing", () => {
    const result = read();
    expect(result.features[0]).toMatchObject({ observationId: learningObservation.id, requirementKey: qualifiedInput.observation.requirementKey,
      eligibility: { verifiedCorrect: "yes", independentAttempt: "yes" }, views: ["independent", "retention"], availability: "available" });
    expect(result.summary[0]?.views.transfer).toBe(0);
    expect(result.summary[0]?.gaps).toContain("retention_intervening_exposure_not_established");
    expect(result.projection.repairTriggered).toBe(false);
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
  });
});
