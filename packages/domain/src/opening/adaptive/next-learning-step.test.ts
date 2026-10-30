import { describe, expect, it } from "vitest";
import { captureNextLearningStep, nextLearningStep } from "./next-learning-step";
import type { NextLearningStepInput, SnapshotObservation } from "./snapshot-sources";

const observation = (overrides: Partial<SnapshotObservation> = {}): SnapshotObservation => ({
  id: "latest-observation",
  skillLabel: "矩阵乘法",
  attemptedAt: "2026-10-16T07:00:00.000Z",
  assistance: "independent",
  verifiedCorrect: "yes",
  independentAttempt: "yes",
  usableForCurrentVersion: "yes",
  problemId: "matrix-problem",
  ...overrides,
});

const input = (overrides: Partial<NextLearningStepInput> = {}): NextLearningStepInput => ({
  status: "needs_check",
  observations: [],
  wantsFullExplanation: false,
  ...overrides,
});

describe("nextLearningStep", () => {
  it("captures phase policy once and prioritizes the latest effective head", () => {
    for (const request of [input({ learningPhase: "new_learning", dueRetest: true }), input({ learningPhase: "consolidate" }), input({ dueRetest: true, wantsFullExplanation: true })]) {
      expect(captureNextLearningStep(request).decision).toEqual(nextLearningStep(request));
    }
    expect(nextLearningStep(input({ learningPhase: "new_learning", dueRetest: true }))).toMatchObject({ activityKind: "full_explain", phase: "new_learning" });
    expect(nextLearningStep(input({ dueRetest: true, wantsFullExplanation: true }))).toMatchObject({ activityKind: "transfer_check", phase: "maintain" });
    expect(nextLearningStep(input({ status: "observed_independent", phaseSource: "automatic", observations: [observation(), observation({ verifiedCorrect: "no" })] })))
      .toMatchObject({ phase: "explore", activityKind: "transfer_check" });
  });
  it("selects four phases while keeping the legacy activity decision", () => {
    expect(nextLearningStep(input({ phaseSource: "automatic" }))).toMatchObject({ phase: "explore", phaseSource: "automatic" });
    expect(nextLearningStep(input({ phaseSource: "automatic", observations: [observation({ verifiedCorrect: "no" })] }))).toMatchObject({ phase: "new_learning" });
    expect(nextLearningStep(input({ phaseSource: "automatic", observations: [observation({ assistance: "hinted" })] }))).toMatchObject({ phase: "consolidate" });
    expect(nextLearningStep(input({ dueRetest: true }))).toMatchObject({ phase: "maintain" });
    expect(nextLearningStep(input({ learningPhase: "new_learning", phaseSource: "explicit" }))).toMatchObject({ phase: "new_learning", phaseSource: "explicit" });
    expect(nextLearningStep(input({ learningPhase: "maintain", phaseSource: "explicit" }))).not.toMatchObject({ phase: "maintain" });
    expect(nextLearningStep(input({}))).not.toHaveProperty("phase");
  });
  it("owns legacy thin and adaptive decisions without manufacturing observations", () => {
    expect(nextLearningStep({ kind: "adaptive", input: {
      nodeId: "node-1", hasCheckedIndependent: false, hasAssistance: true, retestDue: false,
    } })).toEqual({ kind: "independent_variant" });
    expect(nextLearningStep({ kind: "thin", input: {
      skillLabel: "limits", currentPage: 2, sourceIds: [], sessionExposures: ["hinted"],
      assistedSuccessOnCurrentItem: false, retestDue: false,
    } })).toEqual({ kind: "worked_example", skillLabel: "limits", currentPage: 2,
      nodeId: null, evidenceIds: [], problemRef: null,
      reason: "Hint delivered; offer a full worked example if still stuck." });
  });

  it("captures only evaluated priority branches and the original rule decision", () => {
    const captured = captureNextLearningStep(input({ observations: [observation({ verifiedCorrect: "no" })] }));
    expect(captured.decision).toEqual(nextLearningStep(input({ observations: [observation({ verifiedCorrect: "no" })] })));
    expect(captured.candidates).toEqual([
      { action: "full_explain", eligible: false, reasonCodes: ["not_requested_full"], evidenceRefs: [] },
      { action: "diagnose", eligible: false, reasonCodes: ["has_current_evidence"], evidenceRefs: ["observation:latest-observation"] },
      { action: "targeted_explain", eligible: true, reasonCodes: ["verified_incorrect"], evidenceRefs: ["observation:latest-observation"] },
    ]);
  });
  it.each(["no", "unknown", undefined] as const)("does not teach from an inapplicable error or help (%s)", (usableForCurrentVersion) => {
    expect(nextLearningStep(input({ status: "observed_independent", observations: [
      observation({ verifiedCorrect: "no", assistance: "revealed", usableForCurrentVersion }),
    ] }))).toEqual({ activityKind: "diagnose", focusObservationId: null, reasonCode: "no_evidence" });
  });

  it("honors a full explanation request even with a verified error and assisted attempts", () => {
    expect(nextLearningStep(input({
      wantsFullExplanation: true,
      status: "observed_independent",
      observations: [observation({ verifiedCorrect: "no", assistance: "revealed" })],
    }))).toEqual({ activityKind: "full_explain", focusObservationId: null, reasonCode: "requested_full" });
    expect(nextLearningStep(input({ wantsFullExplanation: true }))).toEqual({
      activityKind: "full_explain", focusObservationId: null, reasonCode: "requested_full",
    });
  });

  it("diagnoses an unobserved skill even when its supplied status says independent", () => {
    expect(nextLearningStep(input({ status: "observed_independent" }))).toEqual({
      activityKind: "diagnose", focusObservationId: null, reasonCode: "no_evidence",
    });
  });

  it.each(["independent", "hinted", "revealed", "unknown"] as const)(
    "targets the latest verified error with %s assistance before other rules",
    (assistance) => {
      expect(nextLearningStep(input({
        status: "observed_independent",
        observations: [
          observation({ id: "latest-error", verifiedCorrect: "no", assistance }),
          observation({ id: "older-error", verifiedCorrect: "no", assistance: "hinted" }),
          observation({ id: "oldest", assistance: "revealed" }),
        ],
      }))).toEqual({
        activityKind: "targeted_explain", focusObservationId: "latest-error", reasonCode: "verified_incorrect",
      });
    },
  );

  it("diagnoses unverified attempts before interpreting hints or an independent status", () => {
    expect(nextLearningStep(input({
      status: "observed_independent",
      observations: [
        observation({ verifiedCorrect: "unknown", assistance: "hinted" }),
        observation({ id: "older", verifiedCorrect: "unknown", assistance: "revealed" }),
      ],
    }))).toEqual({ activityKind: "diagnose", focusObservationId: null, reasonCode: "unverified_only" });
  });

  it("fades help after a hinted correct answer instead of choosing a transfer check", () => {
    expect(nextLearningStep(input({
      status: "observed_independent",
      observations: [observation({ assistance: "hinted", independentAttempt: "no" })],
    }))).toEqual({
      activityKind: "reduced_help_practice", focusObservationId: null, reasonCode: "assistance_dependent",
    });
  });

  it("combines hinted and revealed attempts when checking the recent majority", () => {
    expect(nextLearningStep(input({
      observations: [
        observation(),
        observation({ id: "older", assistance: "hinted" }),
        observation({ id: "oldest", assistance: "revealed" }),
      ],
    }))).toEqual({
      activityKind: "reduced_help_practice", focusObservationId: null, reasonCode: "assistance_dependent",
    });
  });

  it("offers a transfer check after independent work despite an older verified error", () => {
    expect(nextLearningStep(input({
      status: "observed_independent",
      observations: [observation(), observation({ id: "older-error", verifiedCorrect: "no" })],
    }))).toEqual({ activityKind: "transfer_check", focusObservationId: null, reasonCode: "independent" });
  });

  it.each(["unobserved", "needs_check", "needs_review"] as const)(
    "keeps %s in diagnosis when no higher-priority rule applies",
    (status) => {
      expect(nextLearningStep(input({ status, observations: [observation()] }))).toEqual({
        activityKind: "diagnose", focusObservationId: null, reasonCode: "needs_check",
      });
    },
  );

  it("does not mistake a two-attempt tie or unknown assistance for an assisted majority", () => {
    for (const assistance of ["independent", "unknown"] as const) {
      expect(nextLearningStep(input({
        status: "observed_independent",
        observations: [observation({ assistance: "hinted" }), observation({ id: "older", assistance })],
      }))).toEqual({ activityKind: "transfer_check", focusObservationId: null, reasonCode: "independent" });
    }
  });

  it("limits assistance history to the latest three attempts", () => {
    expect(nextLearningStep(input({
      status: "observed_independent",
      observations: [
        observation(),
        observation({ id: "recent-2" }),
        observation({ id: "recent-3", assistance: "hinted" }),
        ...["old-1", "old-2", "old-3"].map((id) => observation({ id, assistance: "revealed" })),
      ],
    }))).toEqual({ activityKind: "transfer_check", focusObservationId: null, reasonCode: "independent" });
  });

  it("checks the full history before declaring that all attempts are unverified", () => {
    expect(nextLearningStep(input({
      observations: [
        ...["recent-1", "recent-2", "recent-3"].map((id) => observation({ id, verifiedCorrect: "unknown" })),
        observation({ id: "older-verified" }),
      ],
    }))).toEqual({ activityKind: "diagnose", focusObservationId: null, reasonCode: "needs_check" });
  });

  it("returns the same decision without changing the input or reordering its observations", () => {
    const original = input({
      observations: [
        observation({ assistance: "hinted" }),
        observation({ id: "older", assistance: "revealed", attemptedAt: "2026-10-15T07:00:00.000Z" }),
      ],
    });
    const before = structuredClone(original);
    original.observations.forEach(Object.freeze);
    Object.freeze(original.observations);
    Object.freeze(original);

    expect(nextLearningStep(original)).toEqual(nextLearningStep(original));
    expect(original).toEqual(before);
  });
});
