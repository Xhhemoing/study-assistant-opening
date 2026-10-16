import { describe, expect, it } from "vitest";
import { nextLearningStep } from "./next-learning-step";
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
