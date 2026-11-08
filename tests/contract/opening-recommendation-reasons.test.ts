import { describe, expect, it } from "vitest";
import { systemQueryResultSchema } from "../../packages/contracts/src/opening/system-query";
import { nextLearningStep } from "../../packages/domain/src/opening/adaptive/next-learning-step";
import type { NextLearningStepInput, SnapshotObservation } from "../../packages/domain/src/opening/adaptive/snapshot-sources";

const id = "00000000-0000-4000-8000-000000000001";
const olderId = "00000000-0000-4000-8000-000000000002";
const observation = (overrides: Partial<SnapshotObservation> = {}): SnapshotObservation => ({
  id, skillLabel: "矩阵乘法", requirementKey: null, problemId: null, attemptedAt: "2026-10-19T00:00:00Z",
  assistance: "independent", verifiedCorrect: "yes", independentAttempt: "yes",
  usableForCurrentVersion: "yes", ...overrides,
});
const error = (observationId: string): SnapshotObservation => observation({
  id: observationId, verifiedCorrect: "no", independentAttempt: "no", assistance: "hinted",
  errors: [{ observationId, label: "coefficients", feedback: "wrong", source: "verified_steps" }],
});
const input = (overrides: Partial<NextLearningStepInput> = {}): NextLearningStepInput => ({
  status: "needs_check", wantsFullExplanation: false, observations: [], ...overrides,
});
const result = (step: unknown) => ({
  authorization: { purpose: "system_record_lookup", workspaceId: id, principalId: id,
    role: "workspace_owner", permissionRevision: "owner-fixture" },
  name: "recommendation", status: "partial", reason: "not_available", asOf: "2026-10-19T00:00:00Z",
  version: "1", evidence: [], sourceRefs: [], nextOffset: null,
  data: [{ identity: { courseId: id, skillLabel: "矩阵乘法", requirementKey: null }, step,
    evidenceIds: [], basis: "nextLearningStep/current-evidence", limitations: [], summary: "当前有效记录的推荐" }],
});

// The read-only query passes current evidence but no phase or due-retest controls.
// Exercise real policy outputs, not a second hand-written list of allowed codes.
const cases = [
  { reason: "no_evidence", activity: "diagnose", request: input() },
  { reason: "unverified_only", activity: "diagnose", request: input({ observations: [observation({ verifiedCorrect: "unknown" })] }) },
  { reason: "verified_incorrect", activity: "targeted_explain", request: input({ observations: [observation({ verifiedCorrect: "no" })] }) },
  { reason: "repeated_assisted_error", activity: "full_explain", request: input({ observations: [error(id), error(olderId)] }) },
  { reason: "assistance_dependent", activity: "reduced_help_practice", request: input({ observations: [observation({ assistance: "hinted", independentAttempt: "no" })] }) },
  { reason: "assistance_dependent", activity: "reduced_help_practice", request: input({ observations: [observation(), observation({ id: olderId, assistance: "hinted" }), observation({ assistance: "revealed" })] }) },
  { reason: "independent", activity: "transfer_check", request: input({ status: "observed_independent", observations: [observation()] }) },
  { reason: "correct_needs_independent_check", activity: "transfer_check", request: input({ observations: [observation({ assistance: "unknown", independentAttempt: "unknown" })] }) },
  { reason: "needs_check", activity: "diagnose", request: input({ observations: [observation({ independentAttempt: "no" })] }) },
];

describe("current-evidence recommendation reason compatibility", () => {
  it("accepts the historical v3 reason while new v2 decisions do not select it", () => {
    expect(systemQueryResultSchema.safeParse(result({ activityKind: "reduced_help_practice",
      reasonCode: "assisted_success", focusObservationId: null })).success).toBe(true);
    const step = nextLearningStep(input({ observations: [observation({ assistance: "hinted", independentAttempt: "no" }), observation({ id: olderId })] }));
    expect(step.reasonCode).toBe("needs_check");
  });
  it.each(cases)("accepts the real $reason decision without reshaping it", ({ reason, activity, request }) => {
    const step = nextLearningStep(request);
    expect(step).toMatchObject({ reasonCode: reason, activityKind: activity });
    const parsed = systemQueryResultSchema.parse(result(step));
    expect(parsed.data[0]).toMatchObject({ step });
    expect(systemQueryResultSchema.safeParse(result({ ...step, reasonCode: "invented_reason" })).success).toBe(false);
    expect(systemQueryResultSchema.safeParse(result({ ...step, unexpected: true })).success).toBe(false);
  });

  it.each([input({ dueRetest: true }), input({ learningPhase: "consolidate" })])(
    "does not silently widen a current-evidence result to a phase-only decision", request => {
      const step = nextLearningStep(request);
      expect(["due_retest", "requested_consolidate"]).toContain(step.reasonCode);
      // Removing metadata must not disguise an unsupported reason as current evidence.
      expect(systemQueryResultSchema.safeParse(result({ activityKind: step.activityKind,
        focusObservationId: step.focusObservationId, reasonCode: step.reasonCode })).success).toBe(false);
    },
  );
});
