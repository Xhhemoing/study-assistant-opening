import { describe, expect, it } from "vitest";
import { buildDecisionInput } from "./decision-input";
import { nextLearningStep } from "./next-learning-step";
import type { SnapshotObservation } from "./snapshot-sources";

const row = (patch: Partial<SnapshotObservation> = {}): SnapshotObservation => ({
  id: "a", skillLabel: "span", requirementKey: "span", itemVersionId: null,
  attemptedAt: "2026-10-01T00:00:00.000Z", assistance: "unknown", verifiedCorrect: "unknown",
  independentAttempt: "unknown", usableForCurrentVersion: "yes", problemId: null, ...patch,
});

describe("canonical decision input from caller-owned effective facts", () => {
  it("keeps empty inputs and omitted phase controls literal, without inventing evidence", () => {
    const input = buildDecisionInput({ observations: [], wantsFullExplanation: false });
    expect(input).toEqual({ observations: [], wantsFullExplanation: false, status: "unobserved" });
    expect(nextLearningStep(input)).toEqual({ activityKind: "diagnose", focusObservationId: null, reasonCode: "no_evidence" });
  });

  it("orders the same facts identically without mutating caller arrays or their qualification", () => {
    const a = row(), b = row({ id: "b" }), old = row({ id: "old", attemptedAt: "2026-09-01T00:00:00Z" });
    const facts = Object.freeze([old, b, a]);
    const input = buildDecisionInput({ observations: facts, wantsFullExplanation: false });
    expect(input.observations.map(value => value.id)).toEqual(["a", "b", "old"]);
    expect(facts.map(value => value.id)).toEqual(["old", "b", "a"]);
    expect(buildDecisionInput({ observations: [a, old, b], wantsFullExplanation: false })).toEqual(input);
    expect(input.observations[0]).toBe(a);
    expect(nextLearningStep(input)).toEqual({ activityKind: "diagnose", focusObservationId: null, reasonCode: "unverified_only" });
  });

  it.each(["no", "unknown", undefined] as const)("does not turn unusable qualification %s into independent status", qualification => {
    const stale = row({ verifiedCorrect: "yes", independentAttempt: "yes", assistance: "independent", usableForCurrentVersion: qualification });
    const input = buildDecisionInput({ observations: [stale], wantsFullExplanation: false });
    expect(input.status).toBe("unobserved");
    expect(input.observations).toEqual([stale]); // No eligibility reclassification here.
    expect(nextLearningStep(input)).toEqual({ activityKind: "diagnose", focusObservationId: null, reasonCode: "no_evidence" });
  });

  it("does not let a newer stale success hide a current unknown result", () => {
    const input = buildDecisionInput({ wantsFullExplanation: false, observations: [
      row({ id: "stale", attemptedAt: "2026-10-02T00:00:00Z", usableForCurrentVersion: "no", verifiedCorrect: "yes", independentAttempt: "yes" }), row(),
    ] });
    expect(input.status).toBe("needs_check");
    expect(nextLearningStep(input)).toEqual({ activityKind: "diagnose", focusObservationId: null, reasonCode: "unverified_only" });
  });

  it.each([
    { independentAttempt: "unknown" as const, assistance: "unknown" as const, status: "needs_check", reasonCode: "correct_needs_independent_check" },
    { independentAttempt: "yes" as const, assistance: "independent" as const, status: "observed_independent", reasonCode: "independent" },
  ])("preserves qualified independence $independentAttempt rather than defaulting it", expected => {
    const input = buildDecisionInput({ observations: [row({ verifiedCorrect: "yes", independentAttempt: expected.independentAttempt, assistance: expected.assistance })], wantsFullExplanation: false });
    expect(input.status).toBe(expected.status);
    expect(nextLearningStep(input)).toEqual({ activityKind: "transfer_check", focusObservationId: null, reasonCode: expected.reasonCode });
  });

  it("retains verified repeated error details in canonical newest-first order", () => {
    const earlier = row({ id: "earlier", assistance: "hinted", verifiedCorrect: "no", errors: [{ observationId: "earlier", label: "coefficients", feedback: "check", source: "verified_steps" }] });
    const later = row({ ...earlier, id: "later", attemptedAt: "2026-10-02T00:00:00Z" });
    const input = buildDecisionInput({ observations: [earlier, later], wantsFullExplanation: false });
    expect(nextLearningStep(input)).toEqual({ activityKind: "full_explain", focusObservationId: "later", reasonCode: "repeated_assisted_error" });
  });

  it.each([
    { controls: { learningPhase: "new_learning" as const, phaseSource: "explicit" as const, dueRetest: true }, result: { activityKind: "full_explain", reasonCode: "requested_full", phase: "new_learning", phaseSource: "explicit" } },
    { controls: { learningPhase: "consolidate" as const, phaseSource: "explicit" as const, dueRetest: false }, result: { activityKind: "reduced_help_practice", reasonCode: "requested_consolidate", phase: "consolidate", phaseSource: "explicit" } },
    { controls: { dueRetest: true }, result: { activityKind: "transfer_check", reasonCode: "due_retest", phase: "maintain", phaseSource: "automatic" } },
    { controls: { learningPhase: "maintain" as const, phaseSource: "explicit" as const, dueRetest: false }, result: { activityKind: "diagnose", reasonCode: "no_evidence", phase: "explore", phaseSource: "explicit" } },
  ])("preserves explicit and due/revoked controls $controls", ({ controls, result }) => {
    const input = buildDecisionInput({ observations: [], wantsFullExplanation: false, ...controls });
    expect(input).toMatchObject(controls);
    expect(nextLearningStep(input)).toEqual({ ...result, focusObservationId: null });
  });
});
