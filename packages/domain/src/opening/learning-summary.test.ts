import { describe, expect, it } from "vitest";
import { evaluateEvidenceEligibility } from "./evidence-eligibility";
import { summarizeObservations } from "./learning-summary";
import { courseEvidence, courseEvidenceCases, learningObservation, qualifiedInput } from "./learning-summary-fixtures";

const NOW = learningObservation.occurredAt;

describe("summarizeObservations shared eligibility", () => {
  it("keeps an empty course empty", () => {
    expect(summarizeObservations([], NOW)).toEqual([]);
  });

  it.each(courseEvidenceCases)("uses the evaluator for $name and preserves recorded facts", ({ evidence, independent }) => {
    const summary = summarizeObservations(evidence.observations, NOW, { evidenceContexts: evidence.evidenceContexts });
    const input = evidence.evidenceContexts[learningObservation.id];
    const expected = evaluateEvidenceEligibility(input?.observation ?? { problemId: learningObservation.problemId }, input?.context ?? {});
    expect(summary[0]).toMatchObject({
      courseId: learningObservation.courseId,
      status: independent ? "observed_independent" : "needs_check",
      evidenceIds: [learningObservation.id],
      evidenceSources: ["reference_checked"],
      sampleCount: 1,
      evidenceEligibility: [{ observationId: learningObservation.id, eligibility: expected }],
    });
    expect(evidence.observations[0]?.outcome).toBe("correct");
  });

  it("keeps historical observations visible when the source version changed", () => {
    const evidence = courseEvidenceCases.find((entry) => entry.name === "source changed")!.evidence;
    expect(summarizeObservations(evidence.observations, NOW, { evidenceContexts: evidence.evidenceContexts })[0]?.evidenceEligibility[0]?.eligibility.reasonCodes).toContain("version_changed_needs_check");
  });

  it("does not merge matching labels across courses or requirements", () => {
    const evidence = courseEvidence();
    const second = { ...learningObservation, id: "second", courseId: "another-course" };
    const third = { ...learningObservation, id: "third" };
    const summaries = summarizeObservations([...evidence.observations, second, third], NOW, {
      evidenceContexts: {
        ...evidence.evidenceContexts,
        [third.id]: { ...qualifiedInput, observation: { ...qualifiedInput.observation, requirementKey: "another-requirement" } },
      },
    });
    expect(summaries).toHaveLength(3);
    expect(summaries.map((row) => row.sampleCount)).toEqual([1, 1, 1]);
  });

  it("due retest status does not change the evidence qualifications", () => {
    const evidence = courseEvidence();
    const normal = summarizeObservations(evidence.observations, NOW, { evidenceContexts: evidence.evidenceContexts });
    const due = summarizeObservations(evidence.observations, NOW, { evidenceContexts: evidence.evidenceContexts, dueRetests: [{ courseId: learningObservation.courseId, requirementKey: qualifiedInput.observation.requirementKey!, skillLabel: learningObservation.skillLabel }] });
    expect(due[0]?.status).toBe("needs_review");
    expect(due[0]?.evidenceEligibility).toEqual(normal[0]?.evidenceEligibility);
  });
});


it("only marks the matching course and requirement as due, even when labels match", () => {
  const evidence = courseEvidence();
  const second = { ...learningObservation, id: "second" };
  const evidenceContexts = { ...evidence.evidenceContexts, [second.id]: { ...qualifiedInput, observation: { ...qualifiedInput.observation, requirementKey: "requirement-2" } } };
  const input = { courseId: learningObservation.courseId, requirementKey: qualifiedInput.observation.requirementKey!, skillLabel: learningObservation.skillLabel };
  const summaries = summarizeObservations([...evidence.observations, second], NOW, { evidenceContexts, dueRetests: [input] });
  expect(summaries.find((row) => row.requirementKey === input.requirementKey)?.status).toBe("needs_review");
  expect(summaries.find((row) => row.requirementKey === "requirement-2")?.status).toBe("observed_independent");
  for (const due of [{ ...input, requirementKey: null }, { ...input, courseId: "other-course" }]) {
    expect(summarizeObservations([...evidence.observations, second], NOW, { evidenceContexts, dueRetests: [due] }).map((row) => row.status)).toEqual(["observed_independent", "observed_independent"]);
  }
});

it("preserves unknown legacy qualification while exposing known unavailable source context", () => {
  const evidence = courseEvidence({ observation: {}, context: { version: { applicability: "unavailable" } } });
  const result = summarizeObservations(evidence.observations, NOW, { evidenceContexts: evidence.evidenceContexts });
  expect(result[0]?.evidenceEligibility[0]).toEqual({
    observationId: learningObservation.id,
    versionApplicability: "unavailable",
    eligibility: evaluateEvidenceEligibility({}, { version: { applicability: "unavailable" } }),
  });
});

it("uses the corrected head qualification without counting an old incorrect answer", () => {
  const corrected = { ...learningObservation, id: "corrected", rootObservationId: learningObservation.id, revisionKind: "replace" as const };
  const result = summarizeObservations([corrected], NOW, { evidenceContexts: { [corrected.id]: qualifiedInput } });
  expect(result[0]).toMatchObject({ status: "observed_independent", sampleCount: 1, evidenceIds: [corrected.id], lastObservedAt: learningObservation.occurredAt });
});
