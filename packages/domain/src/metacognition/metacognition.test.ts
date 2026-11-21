import { describe, expect, it } from "vitest";
import {
  computeMurphyBrierReceipt,
  confidenceToProbability,
  evaluateWheelSpinningFormula,
  PRE_ANSWER_CONFIDENCE_PROBABILITY,
  PRE_ANSWER_CONFIDENCE_STATES,
  routeMetacognitiveConfidence,
  WHEEL_SPINNING_DWELL_STALL_MS,
  WHEEL_SPINNING_WINDOW_MS,
  wheelSpinningGuard,
  type MurphyBrierObservation,
  type PreAnswerConfidence,
  type ScheduleTimeBlock,
  type WheelSpinningAttemptEvent,
} from "./index";

// Deterministic PRNG (Mulberry32) for reproducible property tests.
function createPrng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("metacognition: 3-state confidence calibration & hypercorrection router", () => {
  it("maps canonical 3-state confidence values to exact forecast probabilities", () => {
    expect(PRE_ANSWER_CONFIDENCE_STATES).toEqual(["guessing", "unsure", "sure"]);
    expect(PRE_ANSWER_CONFIDENCE_PROBABILITY).toEqual({
      guessing: 0.25,
      unsure: 0.6,
      sure: 0.9,
    });
    expect(confidenceToProbability("guessing")).toBe(0.25);
    expect(confidenceToProbability("unsure")).toBe(0.6);
    expect(confidenceToProbability("sure")).toBe(0.9);
  });

  it("routes sure + wrong to hypercorrection_counterexample with counterexample & micro-check", () => {
    const decision = routeMetacognitiveConfidence({
      preAnswerConfidence: "sure",
      isCorrect: false,
      hasValidIntermediateSteps: false,
      priorConsecutiveErrors: 2,
      assisted: false,
    });

    expect(decision.route).toBe("hypercorrection_counterexample");
    expect(decision.confidenceProbability).toBe(0.9);
    expect(decision.flagsOverconfidentMisconception).toBe(true);
    expect(decision.flagsLuckyGuess).toBe(false);
    expect(decision.allowMasteryAdvance).toBe(false);
    expect(decision.calibrationEligible).toBe(true);
    expect(decision.productiveFailureRecognized).toBe(false);
    expect(decision.effectiveFrustrationStreak).toBe(3);
    expect(decision.directive.includeMinimalCounterexample).toBe(true);
    expect(decision.directive.includeImmediateMicroCheck).toBe(true);
    expect(decision.directive.acknowledgeValidIntermediateSteps).toBe(false);
  });

  it("routes guessing + wrong to faded_worked_example with single faded completion slot", () => {
    const decision = routeMetacognitiveConfidence({
      preAnswerConfidence: "guessing",
      isCorrect: false,
      hasValidIntermediateSteps: false,
      priorConsecutiveErrors: 1,
      assisted: false,
    });

    expect(decision.route).toBe("faded_worked_example");
    expect(decision.confidenceProbability).toBe(0.25);
    expect(decision.flagsOverconfidentMisconception).toBe(false);
    expect(decision.allowMasteryAdvance).toBe(false);
    expect(decision.effectiveFrustrationStreak).toBe(2);
    expect(decision.directive.includeFadedWorkedExample).toBe(true);
    expect(decision.directive.singleFadedCompletionSlot).toBe(true);
  });

  it("routes unsure + wrong to targeted_subgoal_cue", () => {
    const decision = routeMetacognitiveConfidence({
      preAnswerConfidence: "unsure",
      isCorrect: false,
      hasValidIntermediateSteps: false,
      priorConsecutiveErrors: 0,
      assisted: false,
    });

    expect(decision.route).toBe("targeted_subgoal_cue");
    expect(decision.confidenceProbability).toBe(0.6);
    expect(decision.allowMasteryAdvance).toBe(false);
    expect(decision.effectiveFrustrationStreak).toBe(1);
    expect(decision.directive.includeSocraticSubgoalSplit).toBe(true);
  });

  it("routes guessing + correct (unassisted) to lucky_guess_verification_probe without false advance", () => {
    const decision = routeMetacognitiveConfidence({
      preAnswerConfidence: "guessing",
      isCorrect: true,
      hasValidIntermediateSteps: false,
      priorConsecutiveErrors: 3,
      assisted: false,
    });

    expect(decision.route).toBe("lucky_guess_verification_probe");
    expect(decision.flagsLuckyGuess).toBe(true);
    expect(decision.allowMasteryAdvance).toBe(false);
    expect(decision.calibrationEligible).toBe(true);
    expect(decision.effectiveFrustrationStreak).toBe(0);
    expect(decision.directive.requireJustificationProbe).toBe(true);
  });

  it("routes sure and unsure + correct (unassisted) to calibrated_advance", () => {
    for (const confidence of ["sure", "unsure"] as const) {
      const decision = routeMetacognitiveConfidence({
        preAnswerConfidence: confidence,
        isCorrect: true,
        hasValidIntermediateSteps: true,
        priorConsecutiveErrors: 2,
        assisted: false,
      });

      expect(decision.route).toBe("calibrated_advance");
      expect(decision.allowMasteryAdvance).toBe(true);
      expect(decision.flagsLuckyGuess).toBe(false);
      expect(decision.calibrationEligible).toBe(true);
      expect(decision.productiveFailureRecognized).toBe(false);
      expect(decision.effectiveFrustrationStreak).toBe(0);
    }
  });

  it("routes assisted correct answers to assisted_consolidation_check (ineligible for calibration or advance)", () => {
    for (const confidence of PRE_ANSWER_CONFIDENCE_STATES) {
      const decision = routeMetacognitiveConfidence({
        preAnswerConfidence: confidence,
        isCorrect: true,
        hasValidIntermediateSteps: false,
        priorConsecutiveErrors: 4,
        assisted: true,
      });

      expect(decision.route).toBe("assisted_consolidation_check");
      expect(decision.calibrationEligible).toBe(false);
      expect(decision.allowMasteryAdvance).toBe(false);
      expect(decision.flagsLuckyGuess).toBe(false);
      expect(decision.effectiveFrustrationStreak).toBe(0);
      expect(decision.directive.requireIndependentTransferCheck).toBe(true);
    }
  });

  it("interrupts frustration failure streak whenever hasValidIntermediateSteps is true (Productive Failure)", () => {
    const cases: Array<{
      confidence: PreAnswerConfidence;
      expectedRoute: ReturnType<typeof routeMetacognitiveConfidence>["route"];
    }> = [
      { confidence: "sure", expectedRoute: "hypercorrection_counterexample" },
      { confidence: "unsure", expectedRoute: "targeted_subgoal_cue" },
      { confidence: "guessing", expectedRoute: "faded_worked_example" },
    ];

    for (const { confidence, expectedRoute } of cases) {
      const decision = routeMetacognitiveConfidence({
        preAnswerConfidence: confidence,
        isCorrect: false,
        hasValidIntermediateSteps: true,
        priorConsecutiveErrors: 5,
        assisted: false,
      });

      expect(decision.route).toBe(expectedRoute);
      expect(decision.productiveFailureRecognized).toBe(true);
      expect(decision.effectiveFrustrationStreak).toBe(0);
      expect(decision.directive.acknowledgeValidIntermediateSteps).toBe(true);
    }
  });

  it("rejects invalid inputs with RangeError", () => {
    expect(() =>
      routeMetacognitiveConfidence({
        preAnswerConfidence: "sure",
        isCorrect: false,
        hasValidIntermediateSteps: false,
        priorConsecutiveErrors: -1,
        assisted: false,
      }),
    ).toThrow(RangeError);

    expect(() =>
      routeMetacognitiveConfidence({
        preAnswerConfidence: "sure",
        isCorrect: false,
        hasValidIntermediateSteps: false,
        priorConsecutiveErrors: 1.5,
        assisted: false,
      }),
    ).toThrow(RangeError);

    expect(() =>
      routeMetacognitiveConfidence({
        preAnswerConfidence: "certain" as PreAnswerConfidence,
        isCorrect: true,
        hasValidIntermediateSteps: false,
        priorConsecutiveErrors: 0,
        assisted: false,
      }),
    ).toThrow(RangeError);
  });
});

describe("metacognition: exact Murphy (1973) Brier decomposition & epistemic honesty gate", () => {
  it("returns insufficient_sample with zero NaNs when N === 0", () => {
    const empty = computeMurphyBrierReceipt([]);
    expect(empty.status).toBe("insufficient_sample");
    expect(empty.sampleCount).toBe(0);
    expect(empty.totalInputCount).toBe(0);
    expect(empty.excludedAssistedOrRepeatCount).toBe(0);
    expect(empty.excludedInvalidOutcomeCount).toBe(0);
    expect(empty.brierScore).toBeNull();
    expect(empty.reliability).toBeNull();
    expect(empty.resolution).toBeNull();
    expect(empty.uncertainty).toBeNull();
    expect(empty.bias).toBeNull();
    expect(empty.ece).toBeNull();
    expect(empty.baseRate).toBeNull();
    expect(empty.diagnosis).toBeNull();
    for (const bin of empty.bins) {
      expect(bin.count).toBe(0);
      expect(bin.empiricalAccuracy).toBeNull();
      expect(Number.isNaN(bin.reliabilityContribution)).toBe(false);
      expect(Number.isNaN(bin.resolutionContribution)).toBe(false);
    }
  });

  it("strictly excludes assisted, hinted, multi-draft, non-first, repeat-item, and invalid-outcome attempts", () => {
    const observations: MurphyBrierObservation[] = [
      // Valid first independent unassisted submission (#1)
      {
        itemId: "item-1",
        preAnswerConfidence: "sure",
        isCorrect: true,
        isFirstSubmission: true,
        assisted: false,
      },
      // Repeat of item-1 even if caller forgot isFirstSubmission=false
      {
        itemId: "item-1",
        preAnswerConfidence: "sure",
        isCorrect: false,
        isFirstSubmission: true,
        assisted: false,
      },
      // Assisted submission
      {
        itemId: "item-2",
        preAnswerConfidence: "sure",
        isCorrect: false,
        isFirstSubmission: true,
        assisted: true,
      },
      // Subsequent unassisted attempt on already-assisted item-2 (repeat exposure)
      {
        itemId: "item-2",
        preAnswerConfidence: "sure",
        isCorrect: false,
        isFirstSubmission: true,
        assisted: false,
      },
      // Hinted submission
      {
        itemId: "item-3",
        preAnswerConfidence: "unsure",
        isCorrect: true,
        isFirstSubmission: true,
        assisted: false,
        hinted: true,
      },
      // Multi-draft submission
      {
        itemId: "item-4",
        preAnswerConfidence: "guessing",
        isCorrect: false,
        isFirstSubmission: true,
        assisted: false,
        isMultiDraft: true,
      },
      // Non-first submission
      {
        itemId: "item-5",
        preAnswerConfidence: "guessing",
        isCorrect: false,
        isFirstSubmission: false,
        assisted: false,
      },
      // Invalid outcome (null isCorrect)
      {
        itemId: "item-6",
        preAnswerConfidence: "unsure",
        isCorrect: null,
        isFirstSubmission: true,
        assisted: false,
      },
      // Invalid outcome flag
      {
        itemId: "item-7",
        preAnswerConfidence: "unsure",
        isCorrect: true,
        isFirstSubmission: true,
        assisted: false,
        validOutcome: false,
      },
      // Valid first independent unassisted submission (#2)
      {
        itemId: "item-8",
        preAnswerConfidence: "guessing",
        isCorrect: false,
        isFirstSubmission: true,
        assisted: false,
      },
    ];

    const receipt = computeMurphyBrierReceipt(observations);
    expect(receipt.status).toBe("computed");
    if (receipt.status !== "computed") throw new Error("expected computed receipt");

    expect(receipt.totalInputCount).toBe(10);
    expect(receipt.sampleCount).toBe(2);
    expect(receipt.excludedAssistedOrRepeatCount).toBe(6);
    expect(receipt.excludedInvalidOutcomeCount).toBe(2);

    // Only item-1 (p=0.9, y=1) and item-8 (p=0.25, y=0) should be included.
    const expectedBS = ((0.9 - 1) ** 2 + (0.25 - 0) ** 2) / 2;
    const expectedREL = (1 * (0.9 - 1) ** 2 + 1 * (0.25 - 0) ** 2) / 2;
    const expectedRES = (1 * (1 - 0.5) ** 2 + 1 * (0 - 0.5) ** 2) / 2;
    const expectedUNC = 0.5 * 0.5;
    const expectedBias = ((0.9 - 1) + (0.25 - 0)) / 2;
    const expectedECE = (Math.abs(0.9 - 1) + Math.abs(0.25 - 0)) / 2;

    expect(receipt.brierScore).toBeCloseTo(expectedBS, 12);
    expect(receipt.reliability).toBeCloseTo(expectedREL, 12);
    expect(receipt.resolution).toBeCloseTo(expectedRES, 12);
    expect(receipt.uncertainty).toBeCloseTo(expectedUNC, 12);
    expect(receipt.bias).toBeCloseTo(expectedBias, 12);
    expect(receipt.ece).toBeCloseTo(expectedECE, 12);
    expect(
      Math.abs(
        receipt.brierScore - (receipt.reliability - receipt.resolution + receipt.uncertainty),
      ),
    ).toBeLessThan(1e-12);
    expect(receipt.identityResidual).toBeLessThan(1e-12);
  });

  it("returns insufficient_sample when all observations are excluded by the honesty gate", () => {
    const receipt = computeMurphyBrierReceipt([
      {
        itemId: "a",
        preAnswerConfidence: "sure",
        isCorrect: true,
        isFirstSubmission: true,
        assisted: true,
      },
      {
        itemId: "b",
        preAnswerConfidence: "unsure",
        isCorrect: false,
        isFirstSubmission: false,
        assisted: false,
      },
    ]);

    expect(receipt.status).toBe("insufficient_sample");
    expect(receipt.sampleCount).toBe(0);
    expect(receipt.excludedAssistedOrRepeatCount).toBe(2);
    expect(receipt.brierScore).toBeNull();
  });

  it("diagnoses well_calibrated, overconfident, and underconfident learners accurately", () => {
    // Perfect calibration across all 3 bins:
    // guessing (0.25): 1/4 correct; unsure (0.60): 3/5 correct; sure (0.90): 9/10 correct.
    const wellCalibratedObs: MurphyBrierObservation[] = [
      ...Array.from({ length: 4 }, (_, i) => ({
        preAnswerConfidence: "guessing" as const,
        isCorrect: i < 1,
        isFirstSubmission: true,
        assisted: false,
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        preAnswerConfidence: "unsure" as const,
        isCorrect: i < 3,
        isFirstSubmission: true,
        assisted: false,
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        preAnswerConfidence: "sure" as const,
        isCorrect: i < 9,
        isFirstSubmission: true,
        assisted: false,
      })),
    ];

    const wellCalibrated = computeMurphyBrierReceipt(wellCalibratedObs);
    expect(wellCalibrated.status).toBe("computed");
    if (wellCalibrated.status !== "computed") throw new Error("expected computed");
    expect(wellCalibrated.reliability).toBeCloseTo(0, 12);
    expect(wellCalibrated.ece).toBeCloseTo(0, 12);
    expect(wellCalibrated.bias).toBeCloseTo(0, 12);
    expect(wellCalibrated.diagnosis).toBe("well_calibrated");

    // Overconfident: always sure (0.90), only 20% correct -> Bias = +0.70.
    const overconfident = computeMurphyBrierReceipt(
      Array.from({ length: 10 }, (_, i) => ({
        preAnswerConfidence: "sure" as const,
        isCorrect: i < 2,
        isFirstSubmission: true,
        assisted: false,
      })),
    );
    expect(overconfident.status).toBe("computed");
    if (overconfident.status !== "computed") throw new Error("expected computed");
    expect(overconfident.bias).toBeCloseTo(0.7, 12);
    expect(overconfident.diagnosis).toBe("overconfident");

    // Underconfident: always guessing (0.25), 80% correct -> Bias = -0.55.
    const underconfident = computeMurphyBrierReceipt(
      Array.from({ length: 10 }, (_, i) => ({
        preAnswerConfidence: "guessing" as const,
        isCorrect: i < 8,
        isFirstSubmission: true,
        assisted: false,
      })),
    );
    expect(underconfident.status).toBe("computed");
    if (underconfident.status !== "computed") throw new Error("expected computed");
    expect(underconfident.bias).toBeCloseTo(-0.55, 12);
    expect(underconfident.diagnosis).toBe("underconfident");
  });

  it("satisfies exact algebraic identity BS === REL - RES + UNC to 1e-12 across randomized & adversarial sequences", () => {
    const rand = createPrng(20261121);

    // 1. Adversarial single-bin, all-correct, all-incorrect, extreme skewed sequences
    const adversarialSequences: MurphyBrierObservation[][] = [
      // Single observation per confidence × outcome
      ...PRE_ANSWER_CONFIDENCE_STATES.flatMap((confidence) =>
        [true, false].map((isCorrect) => [
          {
            preAnswerConfidence: confidence,
            isCorrect,
            isFirstSubmission: true,
            assisted: false,
          },
        ]),
      ),
      // All-correct across all 3 bins (UNC = 0, RES = 0)
      Array.from({ length: 30 }, (_, i) => ({
        preAnswerConfidence: PRE_ANSWER_CONFIDENCE_STATES[i % 3]!,
        isCorrect: true,
        isFirstSubmission: true,
        assisted: false,
      })),
      // All-incorrect across all 3 bins (UNC = 0, RES = 0)
      Array.from({ length: 30 }, (_, i) => ({
        preAnswerConfidence: PRE_ANSWER_CONFIDENCE_STATES[i % 3]!,
        isCorrect: false,
        isFirstSubmission: true,
        assisted: false,
      })),
      // Heavily imbalanced bin counts (1 vs 100 vs 2)
      [
        {
          preAnswerConfidence: "guessing",
          isCorrect: true,
          isFirstSubmission: true,
          assisted: false,
        },
        ...Array.from({ length: 100 }, (_, i) => ({
          preAnswerConfidence: "sure" as const,
          isCorrect: i % 7 === 0,
          isFirstSubmission: true,
          assisted: false,
        })),
        {
          preAnswerConfidence: "unsure",
          isCorrect: false,
          isFirstSubmission: true,
          assisted: false,
        },
        {
          preAnswerConfidence: "unsure",
          isCorrect: true,
          isFirstSubmission: true,
          assisted: false,
        },
      ],
    ];

    for (const seq of adversarialSequences) {
      const receipt = computeMurphyBrierReceipt(seq);
      expect(receipt.status).toBe("computed");
      if (receipt.status !== "computed") throw new Error("expected computed");
      const lhs = receipt.brierScore;
      const rhs = receipt.reliability - receipt.resolution + receipt.uncertainty;
      expect(Math.abs(lhs - rhs)).toBeLessThan(1e-12);
      expect(receipt.identityResidual).toBeLessThan(1e-12);
      expect(receipt.reliability).toBeGreaterThanOrEqual(0);
      expect(receipt.resolution).toBeGreaterThanOrEqual(0);
      expect(receipt.uncertainty).toBeGreaterThanOrEqual(0);
      expect(receipt.uncertainty).toBeLessThanOrEqual(0.25 + 1e-12);
    }

    // 2. 100 randomized trials of sizes 1..150 mixed with assisted/repeat noise
    for (let trial = 0; trial < 100; trial++) {
      const n = 1 + Math.floor(rand() * 150);
      const observations: MurphyBrierObservation[] = [];

      for (let i = 0; i < n; i++) {
        const confidence = PRE_ANSWER_CONFIDENCE_STATES[Math.floor(rand() * 3)]!;
        observations.push({
          preAnswerConfidence: confidence,
          isCorrect: rand() < 0.5,
          isFirstSubmission: true,
          assisted: false,
        });
        if (rand() < 0.25) {
          observations.push({
            preAnswerConfidence: confidence,
            isCorrect: rand() < 0.5,
            isFirstSubmission: rand() < 0.5,
            assisted: true,
          });
        }
      }

      const receipt = computeMurphyBrierReceipt(observations);
      expect(receipt.status).toBe("computed");
      if (receipt.status !== "computed") throw new Error("expected computed");
      const lhs = receipt.brierScore;
      const rhs = receipt.reliability - receipt.resolution + receipt.uncertainty;
      expect(Math.abs(lhs - rhs)).toBeLessThan(1e-12);
      expect(receipt.identityResidual).toBeLessThan(1e-12);
      expect(receipt.sampleCount).toBe(n);
    }
  });
});

describe("metacognition: 20-minute sliding-window wheelSpinningGuard & non-destructive schedule carry-over", () => {
  const NOW = 1_800_000_000_000;

  /**
   * Builds a synthetic in-window event sequence that realizes any exact
   * (R, D, H, L) boolean combination in {0, 1}^4.
   */
  function buildEventsForSignals(
    R: boolean,
    D: boolean,
    H: boolean,
    L: boolean,
  ): WheelSpinningAttemptEvent[] {
    const events: WheelSpinningAttemptEvent[] = [];

    if (R && L) {
      // 3 consecutive non-productive failures -> streak=3 (R=1), ratio=0/3=0 < 0.25 (L=1).
      const perDwell = D ? 240_000 : 60_000; // 720_000 vs 180_000
      for (let i = 0; i < 3; i++) {
        events.push({
          timestampMs: NOW - (3 - i) * 60_000,
          isCorrect: false,
          assisted: false,
          hasValidIntermediateSteps: false,
          dwellMs: perDwell,
          hintEscalations: H && i === 0 ? 2 : 0,
          bottomOutReached: false,
        });
      }
    } else if (R && !L) {
      // 1 productive failure followed by 3 consecutive non-productive failures
      // -> trailing streak=3 (R=1), ratio=1/4=0.25 (not < 0.25 -> L=0).
      const perDwell = D ? 180_000 : 60_000; // 720_000 vs 240_000
      events.push({
        timestampMs: NOW - 4 * 60_000,
        isCorrect: false,
        assisted: false,
        hasValidIntermediateSteps: true,
        dwellMs: perDwell,
        hintEscalations: H ? 2 : 0,
        bottomOutReached: false,
      });
      for (let i = 0; i < 3; i++) {
        events.push({
          timestampMs: NOW - (3 - i) * 60_000,
          isCorrect: false,
          assisted: false,
          hasValidIntermediateSteps: false,
          dwellMs: perDwell,
          hintEscalations: 0,
          bottomOutReached: false,
        });
      }
    } else if (!R && L) {
      // 2 consecutive non-productive failures -> streak=2 (< 3 -> R=0), ratio=0/2=0 < 0.25 (L=1).
      const perDwell = D ? 360_000 : 60_000; // 720_000 vs 120_000
      for (let i = 0; i < 2; i++) {
        events.push({
          timestampMs: NOW - (2 - i) * 60_000,
          isCorrect: false,
          assisted: false,
          hasValidIntermediateSteps: false,
          dwellMs: perDwell,
          hintEscalations: H && i === 0 ? 2 : 0,
          bottomOutReached: false,
        });
      }
    } else {
      // !R && !L: 1 productive failure -> streak=0 (R=0), ratio=1/1=1.0 >= 0.25 (L=0).
      events.push({
        timestampMs: NOW - 60_000,
        isCorrect: false,
        assisted: false,
        hasValidIntermediateSteps: true,
        dwellMs: D ? 720_000 : 60_000,
        hintEscalations: H ? 2 : 0,
        bottomOutReached: false,
      });
    }

    return events;
  }

  it("matches all 16 truth-table combinations of A = R && ((D && H) || (L && (D || H)))", () => {
    const bits = [false, true] as const;
    let totalRows = 0;
    let trueRows = 0;

    for (const R of bits) {
      for (const D of bits) {
        for (const H of bits) {
          for (const L of bits) {
            totalRows += 1;
            const expected = R && ((D && H) || (L && (D || H)));
            if (expected) trueRows += 1;

            // 1. Direct formula verification
            expect(
              evaluateWheelSpinningFormula({
                repeatedFailure: R,
                dwellStall: D,
                hintSaturation: H,
                lowVelocity: L,
              }),
            ).toBe(expected);

            // 2. End-to-end verification through wheelSpinningGuard
            const decision = wheelSpinningGuard({
              taskId: "task-truth-table",
              nowMs: NOW,
              events: buildEventsForSignals(R, D, H, L),
            });

            expect(decision.signals).toEqual({
              repeatedFailure: R,
              dwellStall: D,
              hintSaturation: H,
              lowVelocity: L,
            });
            expect(decision.triggered).toBe(expected);
            expect(decision.action).toBe(
              expected ? "micro_consolidation_and_graceful_wrapup" : "continue",
            );
            expect(decision.carryOverTaskId).toBe(expected ? "task-truth-table" : null);
            expect(decision.rescheduleReason).toBe(
              expected ? "wheel_spinning_graceful_carryover" : null,
            );
          }
        }
      }
    }

    expect(totalRows).toBe(16);
    expect(trueRows).toBe(4);
  });

  it("expires events strictly outside the 20-minute sliding window [nowMs - 1_200_000, nowMs]", () => {
    const events: WheelSpinningAttemptEvent[] = [
      // 1 ms before window start -> EXPIRED
      {
        timestampMs: NOW - WHEEL_SPINNING_WINDOW_MS - 1,
        isCorrect: false,
        assisted: false,
        hasValidIntermediateSteps: false,
        dwellMs: 600_000,
        hintEscalations: 3,
        bottomOutReached: true,
      },
      // Exactly at window start -> INCLUDED
      {
        timestampMs: NOW - WHEEL_SPINNING_WINDOW_MS,
        isCorrect: false,
        assisted: false,
        hasValidIntermediateSteps: false,
        dwellMs: 360_000,
        hintEscalations: 1,
      },
      {
        timestampMs: NOW - 60_000,
        isCorrect: false,
        assisted: false,
        hasValidIntermediateSteps: false,
        dwellMs: 360_000,
        hintEscalations: 1,
      },
    ];

    const decision = wheelSpinningGuard({
      taskId: "task-window-expiry",
      nowMs: NOW,
      events,
    });

    expect(decision.metrics.expiredEventCount).toBe(1);
    expect(decision.metrics.inWindowEventCount).toBe(2);
    expect(decision.metrics.trailingNonProductiveErrors).toBe(2);
    expect(decision.metrics.activeWindowDwellMs).toBe(WHEEL_SPINNING_DWELL_STALL_MS);
    expect(decision.metrics.bottomOutReached).toBe(false);
    expect(decision.signals.repeatedFailure).toBe(false);
    expect(decision.signals.dwellStall).toBe(true);
    expect(decision.signals.hintSaturation).toBe(true);
    expect(decision.triggered).toBe(false);
  });

  it("resets consecutive failure streak R when learner produces valid intermediate steps", () => {
    const events: WheelSpinningAttemptEvent[] = [
      {
        timestampMs: NOW - 5 * 60_000,
        isCorrect: false,
        assisted: false,
        hasValidIntermediateSteps: false,
        dwellMs: 300_000,
        hintEscalations: 1,
      },
      {
        timestampMs: NOW - 4 * 60_000,
        isCorrect: false,
        assisted: false,
        hasValidIntermediateSteps: false,
        dwellMs: 300_000,
        hintEscalations: 1,
      },
      // Productive failure resets streak!
      {
        timestampMs: NOW - 3 * 60_000,
        isCorrect: false,
        assisted: false,
        hasValidIntermediateSteps: true,
        dwellMs: 200_000,
        hintEscalations: 0,
      },
      // Only 2 subsequent non-productive failures (< 3)
      {
        timestampMs: NOW - 2 * 60_000,
        isCorrect: false,
        assisted: false,
        hasValidIntermediateSteps: false,
        dwellMs: 100_000,
      },
      {
        timestampMs: NOW - 1 * 60_000,
        isCorrect: false,
        assisted: false,
        hasValidIntermediateSteps: false,
        dwellMs: 100_000,
      },
    ];

    const decision = wheelSpinningGuard({
      taskId: "task-productive-reset",
      nowMs: NOW,
      events,
    });

    expect(decision.metrics.trailingNonProductiveErrors).toBe(2);
    expect(decision.signals.repeatedFailure).toBe(false);
    expect(decision.signals.dwellStall).toBe(true);
    expect(decision.signals.hintSaturation).toBe(true);
    expect(decision.signals.lowVelocity).toBe(true); // 1/5 = 0.20 < 0.25
    expect(decision.triggered).toBe(false);
  });

  it("triggers D via latency spike and H via bottom-out scaffold even under 12-min total dwell", () => {
    const events: WheelSpinningAttemptEvent[] = [
      {
        timestampMs: NOW - 6 * 60_000,
        isCorrect: false,
        assisted: false,
        hasValidIntermediateSteps: false,
        dwellMs: 60_000,
        latencyMs: 60_000,
      },
      {
        timestampMs: NOW - 4 * 60_000,
        isCorrect: false,
        assisted: false,
        hasValidIntermediateSteps: false,
        dwellMs: 60_000,
        latencyMs: 60_000,
      },
      {
        timestampMs: NOW - 1 * 60_000,
        isCorrect: false,
        assisted: true,
        hasValidIntermediateSteps: false,
        dwellMs: 300_000,
        latencyMs: 300_000, // > 240_000 default spike threshold
        bottomOutReached: true, // triggers H even with 0 hintEscalations
      },
    ];

    const decision = wheelSpinningGuard({
      taskId: "task-latency-bottomout",
      skillId: "skill-integrals",
      nowMs: NOW,
      events,
    });

    expect(decision.metrics.activeWindowDwellMs).toBe(420_000);
    expect(decision.metrics.latencySpikeDetected).toBe(true);
    expect(decision.metrics.bottomOutReached).toBe(true);
    expect(decision.signals).toEqual({
      repeatedFailure: true,
      dwellStall: true,
      hintSaturation: true,
      lowVelocity: true,
    });
    expect(decision.triggered).toBe(true);
    expect(decision.action).toBe("micro_consolidation_and_graceful_wrapup");
    expect(decision.microConsolidationPlan).toEqual({
      durationMinMinutes: 2,
      durationMaxMinutes: 3,
      targetStrategy: "prerequisite_micro_consolidation_success_anchor",
      pauseAfterConsolidation: true,
    });
    expect(decision.carryOverTaskId).toBe("task-latency-bottomout");
    expect(decision.rescheduleReason).toBe("wheel_spinning_graceful_carryover");
  });

  it("preserves exact taskId and keeps all completed historical blocks bit-for-bit untouched & immutable", () => {
    const completedBlock1: ScheduleTimeBlock = {
      blockId: "blk-hist-1",
      taskId: "task-calculus-42",
      startMs: NOW - 90 * 60_000,
      endMs: NOW - 60 * 60_000,
      status: "completed",
      label: "Earlier completed session for same task",
    };
    const completedBlock2: ScheduleTimeBlock = {
      blockId: "blk-hist-2",
      taskId: "task-other-99",
      startMs: NOW - 60 * 60_000,
      endMs: NOW - 30 * 60_000,
      status: "completed",
      label: "Earlier completed session for other task",
    };
    const activeTargetBlock: ScheduleTimeBlock = {
      blockId: "blk-active-target",
      taskId: "task-calculus-42",
      startMs: NOW - 15 * 60_000,
      endMs: NOW + 15 * 60_000,
      status: "active",
      label: "Current active block",
    };
    const futureTargetBlock: ScheduleTimeBlock = {
      blockId: "blk-future-target",
      taskId: "task-calculus-42",
      startMs: NOW + 30 * 60_000,
      endMs: NOW + 60 * 60_000,
      status: "scheduled",
      label: "Remaining scheduled block for same task",
    };
    const futureOtherBlock: ScheduleTimeBlock = {
      blockId: "blk-future-other",
      taskId: "task-other-99",
      startMs: NOW + 60 * 60_000,
      endMs: NOW + 90 * 60_000,
      status: "scheduled",
      label: "Unrelated future task",
    };

    const originalBlocks: ScheduleTimeBlock[] = [
      completedBlock1,
      completedBlock2,
      activeTargetBlock,
      futureTargetBlock,
      futureOtherBlock,
    ];
    const originalCompletedSnapshot = JSON.stringify([completedBlock1, completedBlock2]);

    const decision = wheelSpinningGuard({
      taskId: "task-calculus-42",
      nowMs: NOW,
      events: buildEventsForSignals(true, true, true, true),
      scheduleBlocks: originalBlocks,
    });

    expect(decision.triggered).toBe(true);
    expect(decision.carryOverTaskId).toBe("task-calculus-42");
    expect(decision.rescheduleReason).toBe("wheel_spinning_graceful_carryover");

    const { scheduleProjection } = decision;

    // 1. All completed historical blocks are bit-for-bit identical and frozen.
    const projectedCompleted = scheduleProjection.blocks.filter(
      (block) => block.status === "completed",
    );
    expect(JSON.stringify(projectedCompleted)).toBe(originalCompletedSnapshot);
    expect(scheduleProjection.preservedCompletedBlocks).toEqual([
      completedBlock1,
      completedBlock2,
    ]);
    for (const block of projectedCompleted) {
      expect(Object.isFrozen(block)).toBe(true);
    }

    // 2. Active block of target task is truncated gracefully at nowMs; suffix carried over.
    const wrappedActive = scheduleProjection.blocks.find(
      (block) => block.blockId === "blk-active-target",
    );
    expect(wrappedActive).toEqual({
      ...activeTargetBlock,
      endMs: NOW,
      status: "wrapped_up",
    });
    expect(scheduleProjection.truncatedActiveBlockIds).toEqual(["blk-active-target"]);

    // 3. Future scheduled block of target task is marked carried_over.
    const carriedFuture = scheduleProjection.blocks.find(
      (block) => block.blockId === "blk-future-target",
    );
    expect(carriedFuture).toEqual({
      ...futureTargetBlock,
      status: "carried_over",
    });
    expect(scheduleProjection.carriedOverBlockIds).toEqual(["blk-future-target"]);

    // 4. Unrelated future block is untouched.
    const untouchedOther = scheduleProjection.blocks.find(
      (block) => block.blockId === "blk-future-other",
    );
    expect(untouchedOther).toEqual(futureOtherBlock);

    // 5. Carry-over duration equals remaining active suffix (15 min) + future scheduled block (30 min).
    expect(scheduleProjection.carryOverDurationMs).toBe(45 * 60_000);

    // 6. Original input objects were never mutated.
    expect(activeTargetBlock.endMs).toBe(NOW + 15 * 60_000);
    expect(activeTargetBlock.status).toBe("active");
    expect(futureTargetBlock.status).toBe("scheduled");
  });

  it("handles out-of-order input events deterministically and excludes future-dated events", () => {
    const events: WheelSpinningAttemptEvent[] = [
      // Future event (strictly after nowMs) -> ignored
      {
        timestampMs: NOW + 1,
        isCorrect: true,
        assisted: false,
        hasValidIntermediateSteps: true,
        dwellMs: 10_000,
      },
      // Out of order timestamps inside the 20-min window
      {
        timestampMs: NOW - 1 * 60_000,
        isCorrect: false,
        assisted: false,
        hasValidIntermediateSteps: false,
        dwellMs: 240_000,
      },
      {
        timestampMs: NOW - 3 * 60_000,
        isCorrect: false,
        assisted: false,
        hasValidIntermediateSteps: false,
        dwellMs: 240_000,
        hintEscalations: 2,
      },
      {
        timestampMs: NOW - 2 * 60_000,
        isCorrect: false,
        assisted: false,
        hasValidIntermediateSteps: false,
        dwellMs: 240_000,
      },
    ];

    const decision = wheelSpinningGuard({
      taskId: "task-chronological",
      nowMs: NOW,
      events,
    });

    expect(decision.metrics.inWindowEventCount).toBe(3);
    expect(decision.triggered).toBe(true);
  });
});
