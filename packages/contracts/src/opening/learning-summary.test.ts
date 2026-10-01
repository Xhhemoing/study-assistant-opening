import { describe, expect, it } from "vitest";
import { learningSummarySchema } from "./learning";

const observationId = "44444444-4444-4444-8444-444444444444";
const summary = {
  skillLabel: "fractions", status: "observed_independent", evidenceIds: [observationId], sampleCount: 1,
  lastObservedAt: "2026-09-14T10:00:00.000Z",
};
const recentPerformance = { status: "observed_independent", evidenceIds: [observationId] };

describe("learning summary recent performance contract", () => {
  it("keeps existing summaries compatible and preserves explicit recent evidence", () => {
    expect(learningSummarySchema.parse(summary)).toEqual(summary);
    const withProgress = { ...summary, recentPerformance, historicalIncorrectCount: 0, unverifiedCount: 0 };
    expect(learningSummarySchema.parse(withProgress)).toEqual(withProgress);
  });

  it.each([
    { recentPerformance: { ...recentPerformance, evidenceIds: [] } },
    { recentPerformance: { ...recentPerformance, evidenceIds: ["not-an-id"] } },
    { recentPerformance: { ...recentPerformance, status: "mastered" } },
    { historicalIncorrectCount: -1 },
    { unverifiedCount: 0.5 },
  ])("rejects malformed recent performance and counts: %j", (fields) => {
    expect(learningSummarySchema.safeParse({ ...summary, ...fields }).success).toBe(false);
  });
});

it("preserves complete recent evidence counts alongside bounded representatives", () => {
  const value = { ...summary, sampleCount: 201, recentPerformance: { ...recentPerformance, evidenceCount: 201 } };
  expect(learningSummarySchema.parse(value)).toEqual(value);
});

it.each([0, -1, 1.5])("rejects an invalid complete recent evidence count %s", evidenceCount => {
  expect(learningSummarySchema.safeParse({ ...summary, recentPerformance: { ...recentPerformance, evidenceCount } }).success).toBe(false);
});

it("does not accept a complete count smaller than its recent representatives", () => {
  expect(learningSummarySchema.safeParse({ ...summary, recentPerformance: { ...recentPerformance, evidenceIds: [observationId, "55555555-5555-4555-8555-555555555555"], evidenceCount: 1 } }).success).toBe(false);
});

it.each([0, 1, 200, 201])("keeps the legacy response bound compatible for %s evidence IDs", count => {
  const value = { ...summary, sampleCount: count, evidenceIds: Array.from({ length: count }, (_, index) => `44444444-4444-4444-8444-${String(index).padStart(12, "0")}`) };
  expect(learningSummarySchema.safeParse(value).success).toBe(count <= 200);
});
