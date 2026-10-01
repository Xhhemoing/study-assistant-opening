import { describe, expect, it } from "vitest";
import type { LearningObservation } from "@aistudy/contracts";
import { summarizeObservations, type ObservationEligibilityInput } from "./learning-summary";
import { learningObservation, qualifiedInput } from "./learning-summary-fixtures";

const NOW = "2026-09-30T12:00:00.000Z";
function attempt(id: string, day: number, outcome: LearningObservation["outcome"] = "correct", requirementKey: string | null = "requirement-1") {
  const submittedAt = `2026-09-${String(day).padStart(2, "0")}T10:00:00.000Z`;
  const identity = { attemptId: `attempt-${id}`, problemId: `problem-${id}`, itemVersionId: `version-${id}` };
  const row: LearningObservation = { ...learningObservation, ...identity, id, requirementKey, outcome, occurredAt: submittedAt, submittedAt };
  const input: ObservationEligibilityInput = {
    observation: { ...qualifiedInput.observation, ...identity, requirementKey, outcome, startedAt: Date.parse(submittedAt) - 1000, submittedAt: Date.parse(submittedAt) },
    context: { ...qualifiedInput.context,
      referenceCheck: { ...qualifiedInput.context.referenceCheck!, ...identity, outcome },
      version: { applicability: "exact", currentItemVersionId: identity.itemVersionId },
    },
  };
  return { row, input };
}
function summarize(entries: ReturnType<typeof attempt>[], due = false) {
  return summarizeObservations(entries.map(({ row }) => row), NOW, {
    evidenceContexts: Object.fromEntries(entries.map(({ row, input }) => [row.id, input])),
    dueRetests: due ? [{ courseId: learningObservation.courseId, requirementKey: "requirement-1", skillLabel: learningObservation.skillLabel }] : [],
  });
}

describe("learning progress from comparable original attempts", () => {
  it("recognizes later independent success while retaining historical errors and unknowns", () => {
    const entries = [attempt("failed", 12, "incorrect"), attempt("unknown", 13, "unverified"), attempt("success", 14)];
    const before = structuredClone(entries);
    expect(summarize(entries)[0]).toMatchObject({
      status: "observed_independent", sampleCount: 3,
      evidenceIds: ["failed", "unknown", "success"],
      recentPerformance: { status: "observed_independent", evidenceIds: ["success"] },
      historicalIncorrectCount: 1, unverifiedCount: 1,
    });
    expect(entries).toEqual(before);
  });

  it.each(["incorrect", "unverified"] as const)("does not let old success conceal a latest %s result", (outcome) => {
    expect(summarize([attempt("success", 12), attempt("latest", 14, outcome)])[0]).toMatchObject({
      status: "needs_check", recentPerformance: { status: "needs_check", evidenceIds: ["latest"] }, historicalIncorrectCount: 0,
    });
  });

  it("is independent of read order and uses original submission rather than correction recording time", () => {
    const correction = attempt("corrected-old", 12);
    correction.row.revisionKind = "replace";
    correction.row.rootObservationId = "original";
    correction.row.recordedAt = "2026-09-30T10:00:00.000Z";
    correction.row.occurredAt = "2026-09-29T10:00:00.000Z";
    expect(summarize([attempt("latest-failure", 14, "incorrect"), correction])[0]).toMatchObject({
      status: "needs_check", recentPerformance: { evidenceIds: ["latest-failure"] },
    });
  });

  it("does not upgrade an answer corrected after delivered help", () => {
    const correction = attempt("corrected", 14);
    correction.input.context.helpHistory = { complete: true, answerRecordedAt: Date.parse("2026-09-14T10:02:00.000Z"), exposures: [{
      attemptId: correction.input.observation.attemptId, problemId: correction.input.observation.problemId,
      level: "revealed", delivered: true, deliveredAt: Date.parse("2026-09-14T10:01:00.000Z"),
    }] };
    expect(summarize([attempt("failed", 12, "incorrect"), correction])[0]).toMatchObject({
      status: "needs_check", recentPerformance: { status: "needs_check" },
      evidenceEligibility: [{ observationId: "failed" }, { observationId: "corrected", eligibility: { independentAttempt: "no" } }],
    });
  });

  it("retains uncertainty when different outcomes share the latest submission time", () => {
    const entries = [attempt("success", 14), attempt("failed", 14, "incorrect")];
    for (const ordered of [entries, [...entries].reverse()]) {
      expect(summarize(ordered)[0]).toMatchObject({ status: "needs_check", recentPerformance: { status: "needs_check" }, historicalIncorrectCount: 0 });
      expect(summarize(ordered)[0]?.recentPerformance?.evidenceIds).toHaveLength(2);
    }
  });

  it("keeps requirements with identical labels independent", () => {
    const result = summarize([attempt("failed", 12, "incorrect", "requirement-1"), attempt("success", 14, "correct", "requirement-2")]);
    expect(result).toHaveLength(2);
    expect(result.find(row => row.requirementKey === "requirement-1")?.status).toBe("needs_check");
    expect(result.find(row => row.requirementKey === "requirement-2")?.status).toBe("observed_independent");
  });

  it("does not infer compatibility for records without a requirement identity", () => {
    expect(summarize([attempt("failed", 12, "incorrect", null), attempt("success", 14, "correct", null)])[0]).toMatchObject({ status: "needs_check" });
    expect(summarize([attempt("failed", 12, "incorrect", null), attempt("success", 14, "correct", null)])[0]?.recentPerformance).toBeUndefined();
  });

  it("does not use a recent success whose captured version needs checking", () => {
    const changed = attempt("changed", 14);
    changed.input.context.version = { applicability: "changed_needs_check", currentItemVersionId: "different-version" };
    expect(summarize([attempt("success", 12), changed])[0]).toMatchObject({ status: "needs_check", recentPerformance: { status: "needs_check", evidenceIds: ["changed"] } });
  });

  it("lets current independent evidence replace an obsolete failure without erasing the old qualification", () => {
    const changed = attempt("old-version", 12, "incorrect");
    changed.input.context.version = { applicability: "changed_needs_check", currentItemVersionId: "different-version" };
    expect(summarize([changed, attempt("current", 14)])[0]).toMatchObject({
      status: "observed_independent", historicalIncorrectCount: 1,
      evidenceEligibility: [{ observationId: "old-version", eligibility: { usableForCurrentVersion: "unknown" } }, { observationId: "current" }],
    });
  });

  it("keeps recent performance when a due retest takes precedence", () => {
    expect(summarize([attempt("failed", 12, "incorrect"), attempt("success", 14)], true)[0]).toMatchObject({
      status: "needs_review", recentPerformance: { status: "observed_independent", evidenceIds: ["success"] }, historicalIncorrectCount: 1,
    });
  });
});
