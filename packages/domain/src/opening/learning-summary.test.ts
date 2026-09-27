import { describe, expect, it } from "vitest";
import type { LearningObservation } from "@aistudy/contracts";
import { summarizeObservations } from "./learning-summary";

const NOW = "2026-09-12T10:00:00.000Z";
const courseId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const ws = "33333333-3333-4333-8333-333333333333";

function obs(over: Partial<LearningObservation> & Pick<LearningObservation, "id" | "skillLabel" | "assistance" | "outcome" | "verdictSource">): LearningObservation {
  return {
    sessionId,
    courseId,
    workspaceId: ws,
    sourceIds: [],
    answer: "x",
    clientKey: `ck-${over.id.slice(0, 8)}`,
    occurredAt: NOW,
    sourceTurnIds: [],
    referenceSourceId: null,
    evidenceVerdict: "MASTERY_NOT_ESTABLISHED",
    problemId: null,
    retestId: null,
    ...over,
  };
}

describe("summarizeObservations", () => {
  it("does not manufacture mastery with no evidence", () => {
    expect(summarizeObservations([], NOW)).toEqual([]);
  });

  it("maps unverified and self_report / model_suggestion to needs_check", () => {
    const rows = [
      obs({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
        skillLabel: "fractions",
        assistance: "independent",
        outcome: "unverified",
        verdictSource: "self_report",
      }),
      obs({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
        skillLabel: "fractions",
        assistance: "independent",
        outcome: "correct",
        verdictSource: "model_suggestion",
      }),
    ];
    const summary = summarizeObservations(rows, NOW);
    expect(summary).toHaveLength(1);
    expect(summary[0]?.status).toBe("needs_check");
    expect(summary[0]?.sampleCount).toBe(2);
    expect(summary[0]?.evidenceIds).toEqual([
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
    ]);
  });

  it("maps independent + reference_checked correct to observed_independent", () => {
    const rows = [
      obs({
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
        skillLabel: "algebra",
        assistance: "independent",
        outcome: "correct",
        verdictSource: "reference_checked",
        referenceSourceId: "44444444-4444-4444-8444-444444444444",
        problemId: "55555555-5555-4555-8555-555555555555",
      }),
    ];
    expect(summarizeObservations(rows, NOW)[0]).toMatchObject({
      skillLabel: "algebra",
      status: "observed_independent",
      sampleCount: 1,
    });
  });

  it("hinted correct cannot become observed_independent", () => {
    const rows = [
      obs({
        id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
        skillLabel: "geometry",
        assistance: "hinted",
        outcome: "correct",
        verdictSource: "reference_checked",
        referenceSourceId: "44444444-4444-4444-8444-444444444444",
      }),
    ];
    expect(summarizeObservations(rows, NOW)[0]?.status).toBe("needs_check");
  });

  it("accepted due retest forces needs_review for that skill", () => {
    const rows = [
      obs({
        id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1",
        skillLabel: "algebra",
        assistance: "independent",
        outcome: "correct",
        verdictSource: "reference_checked",
        referenceSourceId: "44444444-4444-4444-8444-444444444444",
        problemId: "55555555-5555-4555-8555-555555555555",
        retestId: "66666666-6666-4666-8666-666666666666",
      }),
    ];
    expect(
      summarizeObservations(rows, NOW, {
        dueRetestSkillLabels: new Set(["algebra"]),
      })[0]?.status,
    ).toBe("needs_review");
  });

  it("requires a current owned source version for observed_independent", () => {
    const sourceId = "44444444-4444-4444-8444-444444444444";
    const rows = [
      obs({
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1",
        skillLabel: "algebra",
        assistance: "independent",
        outcome: "correct",
        verdictSource: "reference_checked",
        referenceSourceId: sourceId,
        sourceIds: [sourceId],
        problemId: "55555555-5555-4555-8555-555555555555",
      }),
    ];
    expect(
      summarizeObservations(rows, NOW, {
        currentSourceVersions: { [sourceId]: 3 },
        observationSourceVersions: {
          "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1": { [sourceId]: 3 },
        },
      })[0]?.status,
    ).toBe("observed_independent");
  });

  it("ignores a stale source version and does not treat it as independent", () => {
    const sourceId = "44444444-4444-4444-8444-444444444444";
    const rows = [
      obs({
        id: "ffffffff-ffff-4fff-8fff-fffffffffff1",
        skillLabel: "algebra",
        assistance: "independent",
        outcome: "correct",
        verdictSource: "reference_checked",
        referenceSourceId: sourceId,
        sourceIds: [sourceId],
        problemId: "55555555-5555-4555-8555-555555555555",
      }),
    ];
    const summary = summarizeObservations(rows, NOW, {
      currentSourceVersions: { [sourceId]: 4 },
      observationSourceVersions: {
        "ffffffff-ffff-4fff-8fff-fffffffffff1": { [sourceId]: 2 },
      },
    });
    expect(summary).toEqual([]);
  });

  it("does not promote model_suggestion even when the outcome is correct", () => {
    const rows = [
      obs({
        id: "12121212-1212-4121-8121-121212121212",
        skillLabel: "ratios",
        assistance: "independent",
        outcome: "correct",
        verdictSource: "model_suggestion",
        referenceSourceId: "44444444-4444-4444-8444-444444444444",
      }),
    ];
    expect(summarizeObservations(rows, NOW)[0]?.status).toBe("needs_check");
  });

  it("keeps assisted reference-checked answers at needs_check", () => {
    const rows = [
      obs({
        id: "13131313-1313-4131-8131-131313131313",
        skillLabel: "ratios",
        assistance: "assisted",
        outcome: "correct",
        verdictSource: "reference_checked",
        referenceSourceId: "44444444-4444-4444-8444-444444444444",
      }),
    ];
    expect(summarizeObservations(rows, NOW)[0]?.status).toBe("needs_check");
  });
});
