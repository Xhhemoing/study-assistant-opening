/**
 * Closed-Core Domain Types for Metacognitive Calibration, Murphy (1973) Brier
 * Decomposition, and 20-Minute Sliding-Window Wheel-Spinning Guard.
 *
 * Pure browser-safe TypeScript — zero Node/DB/AI imports.
 */

export const PRE_ANSWER_CONFIDENCE_STATES = ["guessing", "unsure", "sure"] as const;

export type PreAnswerConfidence = (typeof PRE_ANSWER_CONFIDENCE_STATES)[number];

export const PRE_ANSWER_CONFIDENCE_PROBABILITY: Readonly<Record<PreAnswerConfidence, number>> =
  Object.freeze({
    guessing: 0.25,
    unsure: 0.6,
    sure: 0.9,
  });

export function isPreAnswerConfidence(value: unknown): value is PreAnswerConfidence {
  return value === "guessing" || value === "unsure" || value === "sure";
}

export function confidenceToProbability(confidence: PreAnswerConfidence): number {
  if (!isPreAnswerConfidence(confidence)) {
    throw new RangeError(`Invalid preAnswerConfidence: ${String(confidence)}`);
  }
  return PRE_ANSWER_CONFIDENCE_PROBABILITY[confidence];
}

// ---------------------------------------------------------------------------
// 1. 3-State Confidence Calibration & Hypercorrection Router
// ---------------------------------------------------------------------------

export type MetacognitiveRoute =
  | "hypercorrection_counterexample"
  | "faded_worked_example"
  | "targeted_subgoal_cue"
  | "lucky_guess_verification_probe"
  | "calibrated_advance"
  | "assisted_consolidation_check";

export type ConfidenceRouteInput = {
  preAnswerConfidence: PreAnswerConfidence;
  isCorrect: boolean;
  hasValidIntermediateSteps: boolean;
  priorConsecutiveErrors: number;
  assisted: boolean;
};

export type PedagogicalDirective = Readonly<{
  includeMinimalCounterexample: boolean;
  includeImmediateMicroCheck: boolean;
  includeFadedWorkedExample: boolean;
  singleFadedCompletionSlot: boolean;
  includeSocraticSubgoalSplit: boolean;
  requireJustificationProbe: boolean;
  requireIndependentTransferCheck: boolean;
  acknowledgeValidIntermediateSteps: boolean;
}>;

export type ConfidenceRouteDecision = Readonly<{
  schemaVersion: 1;
  route: MetacognitiveRoute;
  preAnswerConfidence: PreAnswerConfidence;
  confidenceProbability: number;
  isCorrect: boolean;
  assisted: boolean;
  calibrationEligible: boolean;
  allowMasteryAdvance: boolean;
  flagsLuckyGuess: boolean;
  flagsOverconfidentMisconception: boolean;
  productiveFailureRecognized: boolean;
  effectiveFrustrationStreak: number;
  directive: PedagogicalDirective;
  rationaleCode: string;
}>;

// ---------------------------------------------------------------------------
// 2. Exact Murphy (1973) Brier Score Decomposition & Honesty Gate
// ---------------------------------------------------------------------------

export type MurphyBrierObservation = {
  /** Optional item identifier used to guard against repeat-same-item contamination. */
  itemId?: string;
  /** Pre-answer 3-state confidence forecast. */
  preAnswerConfidence: PreAnswerConfidence;
  /** Outcome of the attempt; non-boolean marks the outcome invalid. */
  isCorrect: boolean | null | undefined;
  /** Must be true to pass the epistemic honesty gate. */
  isFirstSubmission: boolean;
  /** Must be false to pass the epistemic honesty gate. */
  assisted: boolean;
  /** Optional explicit hint exposure flag; if true, excluded as assisted. */
  hinted?: boolean;
  /** Optional multi-draft submission flag; if true, excluded. */
  isMultiDraft?: boolean;
  /** Optional validity override; if false, excluded as invalid outcome. */
  validOutcome?: boolean;
};

export type MurphyBrierOptions = {
  /** Signed bias tolerance for "well_calibrated" diagnosis (default: 0.05). */
  biasTolerance?: number;
  /** Minimum eligible observations required for status "computed" (default: 1). */
  minSampleSize?: number;
};

export type MurphyCalibrationDiagnosis =
  | "well_calibrated"
  | "overconfident"
  | "underconfident";

export type MurphyBrierBin = Readonly<{
  confidence: PreAnswerConfidence;
  forecastProbability: number;
  count: number;
  correctCount: number;
  empiricalAccuracy: number | null;
  reliabilityContribution: number;
  resolutionContribution: number;
  signedBias: number | null;
}>;

type MurphyBrierReceiptBase = Readonly<{
  schemaVersion: 1;
  sampleCount: number;
  totalInputCount: number;
  excludedAssistedOrRepeatCount: number;
  excludedInvalidOutcomeCount: number;
  bins: readonly [MurphyBrierBin, MurphyBrierBin, MurphyBrierBin];
}>;

export type InsufficientSampleMurphyBrierReceipt = MurphyBrierReceiptBase &
  Readonly<{
    status: "insufficient_sample";
    brierScore: null;
    reliability: null;
    resolution: null;
    uncertainty: null;
    bias: null;
    ece: null;
    baseRate: null;
    identityResidual: null;
    diagnosis: null;
  }>;

export type ComputedMurphyBrierReceipt = MurphyBrierReceiptBase &
  Readonly<{
    status: "computed";
    brierScore: number;
    reliability: number;
    resolution: number;
    uncertainty: number;
    bias: number;
    ece: number;
    baseRate: number;
    identityResidual: number;
    diagnosis: MurphyCalibrationDiagnosis;
  }>;

export type MurphyBrierReceipt =
  | InsufficientSampleMurphyBrierReceipt
  | ComputedMurphyBrierReceipt;

// ---------------------------------------------------------------------------
// 3. 20-Minute Sliding-Window wheelSpinningGuard & Schedule Preservation
// ---------------------------------------------------------------------------

export type ScheduleBlockStatus =
  | "completed"
  | "active"
  | "scheduled"
  | "wrapped_up"
  | "carried_over";

export type ScheduleTimeBlock = Readonly<{
  blockId: string;
  taskId: string;
  startMs: number;
  endMs: number;
  status: ScheduleBlockStatus;
  label?: string;
}>;

export type WheelSpinningAttemptEvent = {
  /** Event timestamp in epoch milliseconds. */
  timestampMs: number;
  /** Whether the attempt achieved a correct final answer. */
  isCorrect: boolean;
  /** Whether the learner received assistance/hints on this attempt. */
  assisted: boolean;
  /** True when at least one newly verified valid intermediate step was produced. */
  hasValidIntermediateSteps: boolean;
  /** Active dwell time spent on this attempt in milliseconds. */
  dwellMs: number;
  /** Optional single-attempt latency in milliseconds for latency-spike detection. */
  latencyMs?: number;
  /** Number of hint escalations during this attempt (default: 0). */
  hintEscalations?: number;
  /** True if a bottom-out scaffold / full reveal was reached during this attempt. */
  bottomOutReached?: boolean;
};

export type WheelSpinningThresholds = {
  /** Sliding window length in ms (default: 1_200_000 = 20 minutes). */
  windowMs?: number;
  /** Consecutive non-productive failures needed for R (default: 3). */
  consecutiveFailureThreshold?: number;
  /** Active window dwell without unassisted pass needed for D (default: 720_000 = 12 minutes). */
  dwellStallMs?: number;
  /** Single-attempt latency threshold for latency spike in D (default: 240_000 = 4 minutes). */
  latencySpikeThresholdMs?: number;
  /** Hint escalations needed for H (default: 2). */
  hintEscalationThreshold?: number;
  /** Productive valid-step ratio ceiling for L (default: 0.25, strictly less than). */
  lowVelocityThreshold?: number;
};

export type WheelSpinningGuardInput = {
  taskId: string;
  skillId?: string;
  nowMs: number;
  events: readonly WheelSpinningAttemptEvent[];
  /** Optional additional active dwell time in ms for an in-progress attempt. */
  additionalActiveDwellMs?: number;
  /** Optional current schedule blocks to project non-destructively. */
  scheduleBlocks?: readonly ScheduleTimeBlock[];
  /** Optional threshold overrides. */
  thresholds?: WheelSpinningThresholds;
};

export type WheelSpinningSignals = Readonly<{
  /** R: >= 3 consecutive non-productive incorrect attempts (reset by valid intermediate steps). */
  repeatedFailure: boolean;
  /** D: >= 12 min active dwell without unassisted pass, OR median/latest latency spike. */
  dwellStall: boolean;
  /** H: >= 2 hint escalations OR bottom-out scaffold reached in window. */
  hintSaturation: boolean;
  /** L: productive valid-step ratio < 0.25 across attempts in window. */
  lowVelocity: boolean;
}>;

export type WheelSpinningWindowMetrics = Readonly<{
  windowStartMs: number;
  windowEndMs: number;
  inWindowEventCount: number;
  expiredEventCount: number;
  trailingNonProductiveErrors: number;
  activeWindowDwellMs: number;
  hasUnassistedPassInWindow: boolean;
  medianLatencyMs: number | null;
  latestLatencyMs: number | null;
  latencySpikeDetected: boolean;
  hintEscalationCount: number;
  bottomOutReached: boolean;
  productiveAttemptCount: number;
  productiveStepRatio: number | null;
}>;

export type MicroConsolidationPlan = Readonly<{
  durationMinMinutes: 2;
  durationMaxMinutes: 3;
  targetStrategy: "prerequisite_micro_consolidation_success_anchor";
  pauseAfterConsolidation: true;
}>;

export type ScheduleBlockProjection = Readonly<{
  blocks: readonly ScheduleTimeBlock[];
  preservedCompletedBlocks: readonly ScheduleTimeBlock[];
  truncatedActiveBlockIds: readonly string[];
  carriedOverBlockIds: readonly string[];
  carryOverDurationMs: number;
}>;

export type WheelSpinningAction =
  | "continue"
  | "micro_consolidation_and_graceful_wrapup";

export type WheelSpinningRescheduleReason = "wheel_spinning_graceful_carryover";

export type WheelSpinningGuardDecision = Readonly<{
  schemaVersion: 1;
  taskId: string;
  skillId: string | null;
  triggered: boolean;
  action: WheelSpinningAction;
  signals: WheelSpinningSignals;
  metrics: WheelSpinningWindowMetrics;
  microConsolidationPlan: MicroConsolidationPlan | null;
  carryOverTaskId: string | null;
  rescheduleReason: WheelSpinningRescheduleReason | null;
  scheduleProjection: ScheduleBlockProjection;
}>;
