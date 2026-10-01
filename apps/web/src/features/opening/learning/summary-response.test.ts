import { describe, expect, it } from "vitest";
import { learningSummarySchema, type LearningObservation } from "@aistudy/contracts";
import { summarizeObservations, type ObservationEligibilityInput } from "@aistudy/domain";
import { learningObservation, qualifiedInput } from "../../../../../../packages/domain/src/opening/learning-summary-fixtures";
import { projectLearningSummaryResponse } from "./summary-response";

const NOW = "2026-09-30T12:00:00.000Z";
const id = (index: number, prefix = "44444444") => `${prefix}-4444-4444-8444-${String(index).padStart(12, "0")}`;
function attempt(index: number, outcome: LearningObservation["outcome"] = "correct", occurredAt = NOW) {
  const identity = { attemptId: id(index, "55555555"), problemId: id(index, "66666666"), itemVersionId: id(index, "77777777") };
  const row: LearningObservation = { ...learningObservation, ...identity, id: id(index), outcome, requirementKey: "requirement-1", occurredAt, submittedAt: occurredAt };
  const input: ObservationEligibilityInput = {
    observation: { ...qualifiedInput.observation, ...identity, outcome, startedAt: Date.parse(occurredAt) - 1000, submittedAt: Date.parse(occurredAt) },
    context: { ...qualifiedInput.context,
      referenceCheck: outcome === "unverified" ? null : { ...qualifiedInput.context.referenceCheck!, ...identity, outcome },
      version: { applicability: "exact", currentItemVersionId: identity.itemVersionId },
    },
  };
  return { row, input };
}
function summarize(entries: ReturnType<typeof attempt>[]) {
  return summarizeObservations(entries.map(entry => entry.row), NOW, {
    evidenceContexts: Object.fromEntries(entries.map(entry => [entry.row.id, entry.input])),
  });
}

function assertOnlyEvidenceProjection(full: ReturnType<typeof summarize>[number]) {
  const before = structuredClone(full);
  const response = projectLearningSummaryResponse(full);
  expect(full).toEqual(before);
  expect({ ...response, evidenceIds: full.evidenceIds, evidenceEligibility: full.evidenceEligibility,
    ...(full.recentPerformance ? { recentPerformance: full.recentPerformance } : {}) }).toEqual(full);
  expect(response.evidenceEligibility?.map(entry => entry.observationId)).toEqual(response.evidenceIds);
  expect(response.evidenceIds.length).toBeLessThanOrEqual(20);
  if (response.recentPerformance) {
    expect(response.recentPerformance.evidenceIds.length).toBeGreaterThan(0);
    expect(response.recentPerformance.evidenceIds.every(value => response.evidenceIds.includes(value))).toBe(true);
  }
  expect(learningSummarySchema.parse(response)).toEqual(response);
  return response;
}

describe("HTTP learning summary representatives", () => {
  it.each([0, 1, 200, 201])("bounds %s same-time observations without changing complete counts", count => {
    const full = summarize(Array.from({ length: count }, (_, index) => attempt(index)));
    if (!count) {
      expect(full.map(projectLearningSummaryResponse)).toEqual([]);
      return;
    }
    const response = assertOnlyEvidenceProjection(full[0]!);
    expect(response.sampleCount).toBe(count);
    expect(response.evidenceIds).toHaveLength(Math.min(count, 20));
    expect(response.recentPerformance?.evidenceIds).toHaveLength(Math.min(count, 20));
    expect(response.recentPerformance?.evidenceCount ?? response.recentPerformance?.evidenceIds.length).toBe(count);
    expect(full[0]!.evidenceIds).toHaveLength(count);
    expect(full[0]!.evidenceEligibility).toHaveLength(count);
  });

  it("deterministically retains recent failure, unknown and unavailable explanations beyond the first 200", () => {
    const entries = Array.from({ length: 204 }, (_, index) => attempt(index));
    entries[201] = attempt(201, "incorrect");
    entries[202] = attempt(202, "unverified");
    entries[203]!.input.context.version = { applicability: "unavailable" };
    const full = summarize(entries)[0]!;
    const response = assertOnlyEvidenceProjection(full);
    expect(response).toMatchObject({ status: "needs_check", sampleCount: 204, unverifiedCount: 1,
      recentPerformance: { status: "needs_check", evidenceCount: 204 } });
    expect(response.evidenceIds).toEqual(expect.arrayContaining([id(201), id(202), id(203)]));
    expect(response.evidenceEligibility).toEqual(expect.arrayContaining([
      expect.objectContaining({ observationId: id(201), eligibility: expect.objectContaining({ verifiedCorrect: "no" }) }),
      expect.objectContaining({ observationId: id(202), eligibility: expect.objectContaining({ verifiedCorrect: "unknown" }) }),
      expect.objectContaining({ observationId: id(203), versionApplicability: "unavailable" }),
    ]));
    expect(projectLearningSummaryResponse(summarize([...entries].reverse())[0]!)).toEqual(response);
  });

  it("retains historical errors and uncertainty alongside the current independent result", () => {
    const entries = Array.from({ length: 201 }, (_, index) => attempt(index));
    entries[198] = attempt(198, "incorrect", "2026-09-12T12:00:00.000Z");
    entries[199] = attempt(199, "unverified", "2026-09-13T12:00:00.000Z");
    entries[200] = attempt(200, "correct", "2026-09-14T12:00:00.000Z");
    entries[200]!.input.context.version = { applicability: "unavailable" };
    const response = assertOnlyEvidenceProjection(summarize(entries)[0]!);
    expect(response).toMatchObject({ status: "observed_independent", historicalIncorrectCount: 1, unverifiedCount: 1,
      recentPerformance: { status: "observed_independent", evidenceCount: 198 } });
    expect(response.evidenceIds).toEqual(expect.arrayContaining([id(198), id(199), id(200)]));
    expect(response.recentPerformance!.evidenceIds).not.toEqual(expect.arrayContaining([id(198)]));
  });

  it("keeps a single latest representative when history exceeds the limit", () => {
    const entries = Array.from({ length: 201 }, (_, index) => attempt(index, "incorrect", "2026-09-12T12:00:00.000Z"));
    entries[200] = attempt(200);
    const response = assertOnlyEvidenceProjection(summarize(entries)[0]!);
    expect(response).toMatchObject({ status: "observed_independent", historicalIncorrectCount: 200,
      recentPerformance: { evidenceIds: [id(200)], evidenceCount: 1 } });
  });

  it("keeps another requirement's failure separate from a large successful group", () => {
    const entries = Array.from({ length: 201 }, (_, index) => attempt(index));
    const failure = attempt(201, "incorrect");
    failure.input.observation.requirementKey = "requirement-2";
    const response = summarize([...entries, failure]).map(assertOnlyEvidenceProjection);
    expect(response).toHaveLength(2);
    expect(response[0]).toMatchObject({ requirementKey: "requirement-1", status: "observed_independent", sampleCount: 201 });
    expect(response[1]).toMatchObject({ requirementKey: "requirement-2", status: "needs_check", sampleCount: 1 });
  });

  it("does not promote a large unknown-requirement group after reducing its evidence", () => {
    const entries = Array.from({ length: 201 }, (_, index) => attempt(index));
    entries[200] = attempt(200, "incorrect", "2026-09-12T12:00:00.000Z");
    entries.forEach(entry => { entry.input.observation.requirementKey = null; });
    const response = assertOnlyEvidenceProjection(summarize(entries)[0]!);
    expect(response).toMatchObject({ status: "needs_check", sampleCount: 201, historicalIncorrectCount: 1 });
    expect(response.recentPerformance).toBeUndefined();
    expect(response.evidenceIds).toContain(id(200));
  });
});
