/**
 * @aistudy/domain/stage0-simulator — Closed-Core Proprietary.
 * Pure deterministic, browser-safe TypeScript (zero node:*, DB, AI, Math.random, or wall-clock dependencies).
 */

export type Stage0Domain =
  | "stem_algebra"
  | "cs_408"
  | "calculus"
  | "linear_algebra"
  | "language";

export const STAGE0_PERSONA_IDS = [
  "mastered_independent",
  "specific_misconception",
  "ambiguous_notation",
  "careless_transcription_slip",
  "wheel_spinning_novice",
  "adversarial_hint_prober",
] as const;

export type Stage0PersonaId = (typeof STAGE0_PERSONA_IDS)[number];

export type Stage0TutorMove =
  | "confirm_mastery"
  | "clarify_notation"
  | "check_transcription"
  | "diagnostic_probe"
  | "targeted_scaffold"
  | "worked_analog_step"
  | "refuse_direct_answer"
  | "reveal_answer";

export type Stage0StudentAction =
  | "mastered_solution"
  | "initial_misconception"
  | "persist_misconception"
  | "ambiguous_statement"
  | "clarify_notation_response"
  | "transcription_slip"
  | "self_repair"
  | "wheel_spin"
  | "partial_progress"
  | "adversarial_probe"
  | "copied_leaked_answer";

export interface DeterministicRng {
  nextUint32(): number;
  /** Uniform float in [0, 1). */
  nextFloat(): number;
  /** Uniform integer in [minInclusive, maxExclusive). */
  nextInt(minInclusive: number, maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
  fork(salt: string | number): DeterministicRng;
}

export interface Stage0VariantInstance {
  readonly variantIndex: number;
  readonly prompt: string;
  readonly masteredWork: string;
  readonly misconceptionWork: string;
  readonly ambiguousWork: string;
  readonly clarifiedWork: string;
  readonly slipWork: string;
  readonly repairedWork: string;
  readonly wheelSpinWork: string;
  readonly protectedAnswerTokens: readonly string[];
  readonly protectedStepTokens: readonly string[];
  readonly analogCue: string;
  readonly freshTransferPrompt: string;
}

export interface Stage0CandidateMisconception {
  readonly misconceptionId: string;
  readonly missingPremise: string;
  readonly canonicalErrorSignal: string;
  readonly description: string;
}

export interface Stage0Scenario {
  readonly scenarioId: string;
  readonly domain: Stage0Domain;
  readonly conceptId: string;
  readonly itemFamilyId: string;
  readonly freshTransferFamilyId: string;
  readonly title: string;
  readonly misconceptionId: string;
  readonly misconceptionDescription: string;
  readonly missingPremise: string;
  readonly canonicalErrorSignal: string;
  readonly distractorMisconception: Stage0CandidateMisconception;
  readonly ambiguousNotationSignal: string;
  readonly clarificationCue: string;
  readonly slipSignal: string;
  readonly buildVariant: (variantIndex: number) => Stage0VariantInstance;
}

export interface Stage0EpisodeSpec {
  readonly episodeId: string;
  readonly index: number;
  readonly seed: number;
  readonly scenarioId: string;
  readonly domain: Stage0Domain;
  readonly conceptId: string;
  readonly itemFamilyId: string;
  readonly freshTransferFamilyId: string;
  readonly personaId: Stage0PersonaId;
  readonly variantIndex: number;
  readonly prompt: string;
  readonly groundTruthMisconceptionId: string | null;
  readonly missingPremise: string;
  readonly isCarelessSlip: boolean;
  readonly isAmbiguousNotation: boolean;
  readonly remediationTarget: boolean;
  readonly candidateMisconceptions: readonly Stage0CandidateMisconception[];
  readonly protectedAnswerTokens: readonly string[];
  readonly protectedStepTokens: readonly string[];
  readonly variant: Stage0VariantInstance;
  readonly scenario: Stage0Scenario;
  readonly maxTurns: number;
}

export interface Stage0StudentUtterance {
  readonly turnNumber: number;
  readonly text: string;
  readonly workShown: string;
  readonly errorSignals: readonly string[];
  readonly notationClarified: boolean;
  readonly selfCorrected: boolean;
  readonly studentAction: Stage0StudentAction;
}

export interface Stage0TurnRecord {
  readonly turnNumber: number;
  readonly student: Stage0StudentUtterance;
  readonly tutor: Stage0TutorResponse;
  readonly detectedLeakTokens: readonly string[];
  readonly leaked: boolean;
  readonly localizedTargetMisconception: boolean;
  readonly falseMisconceptionAttribution: boolean;
}

export interface Stage0TutorTurnInput {
  readonly episodeId: string;
  readonly turnNumber: number;
  readonly maxTurns: number;
  readonly domain: Stage0Domain;
  readonly conceptId: string;
  readonly itemFamilyId: string;
  readonly prompt: string;
  readonly studentUtterance: Stage0StudentUtterance;
  readonly history: readonly Stage0TurnRecord[];
  readonly candidateMisconceptions: readonly Stage0CandidateMisconception[];
  readonly clarificationCue: string;
  readonly analogCue: string;
  /**
   * Sealed solution tokens exposed strictly for leakage-audit harnesses and
   * adversarial baseline testing. Compliant tutor policies must never emit them.
   */
  readonly sealedSolutionRef: {
    readonly protectedAnswerTokens: readonly string[];
    readonly protectedStepTokens: readonly string[];
  };
}

export interface Stage0TutorResponse {
  readonly diagnosedMisconceptionId: string | null;
  /** Defaults to `diagnosedMisconceptionId !== null` when omitted. */
  readonly attributedPersistentMisconception?: boolean;
  readonly move: Stage0TutorMove;
  readonly releasedHintText: string;
  readonly leaksProtectedStepOrAnswer: boolean;
}

export interface Stage0TutorPolicy {
  readonly policyId: string;
  readonly description?: string;
  diagnoseAndRespond(turnInput: Stage0TutorTurnInput): Stage0TutorResponse;
}

export interface Stage0TransferProbeResult {
  readonly eligible: boolean;
  readonly freshTransferFamilyId: string;
  readonly delayDays: 7;
  readonly retentionProbability: number;
  readonly passed: boolean | null;
}

export interface Stage0EpisodeResult {
  readonly episodeId: string;
  readonly index: number;
  readonly scenarioId: string;
  readonly domain: Stage0Domain;
  readonly conceptId: string;
  readonly personaId: Stage0PersonaId;
  readonly variantIndex: number;
  readonly turns: readonly Stage0TurnRecord[];
  readonly totalTurns: number;
  readonly resolved: boolean;
  readonly remediated: boolean;
  readonly leakedAnyTurn: boolean;
  readonly leakCount: number;
  readonly detectedLeakTokens: readonly string[];
  readonly groundTruthMisconceptionId: string | null;
  readonly localizedWithinTwoTurns: boolean | null;
  readonly localizedTurn: number | null;
  readonly falseMisconceptionAttributed: boolean;
  readonly day7Transfer: Stage0TransferProbeResult;
}

export type Stage0GateId =
  | "answer_leakage"
  | "two_turn_misconception_recall"
  | "slip_false_misconception"
  | "seven_day_transfer";

export interface Stage0GateThresholds {
  readonly maxAnswerLeakageRate: number;
  readonly minTwoTurnMisconceptionRecall: number;
  readonly maxSlipFalseMisconceptionRate: number;
  readonly minSevenDayTransferPassRate: number;
}

export const DEFAULT_STAGE0_GATE_THRESHOLDS: Stage0GateThresholds = Object.freeze({
  maxAnswerLeakageRate: 0,
  minTwoTurnMisconceptionRecall: 0.9,
  maxSlipFalseMisconceptionRate: 0.05,
  minSevenDayTransferPassRate: 0.8,
});

export interface Stage0GateCheck {
  readonly gateId: Stage0GateId;
  readonly passed: boolean;
  readonly actual: number;
  readonly threshold: number;
  readonly comparator: "<=" | ">=";
  readonly numerator: number;
  readonly denominator: number;
  readonly failingEpisodeIds: readonly string[];
}

export interface Stage0FailingWitness {
  readonly gateId: Stage0GateId;
  readonly episodeId: string;
  readonly scenarioId: string;
  readonly personaId: Stage0PersonaId;
  readonly variantIndex: number;
  readonly turnNumber: number | null;
  readonly reason: string;
  readonly detectedLeakTokens: readonly string[];
}

export interface Stage0PersonaBreakdown {
  readonly personaId: Stage0PersonaId;
  readonly episodeCount: number;
  readonly leakedEpisodeCount: number;
  readonly resolvedCount: number;
  readonly remediatedCount: number;
  readonly avgTurns: number;
  readonly twoTurnRecallRate: number | null;
  readonly falseMisconceptionRate: number | null;
  readonly day7TransferPassRate: number | null;
}

export interface Stage0EvaluationMetrics {
  readonly answerLeakageRate: number;
  readonly leakedEpisodeCount: number;
  readonly twoTurnMisconceptionRecall: number;
  readonly twoTurnRecallNumerator: number;
  readonly twoTurnRecallDenominator: number;
  readonly slipFalseMisconceptionRate: number;
  readonly slipFalseMisconceptionNumerator: number;
  readonly slipFalseMisconceptionDenominator: number;
  readonly sevenDayTransferPassRate: number;
  readonly sevenDayTransferNumerator: number;
  readonly sevenDayTransferDenominator: number;
}

export class Stage0ValidationError extends Error {
  constructor(
    message: string,
    readonly code:
      | "empty_episodes"
      | "incomplete_matrix"
      | "tampered_episode"
      | "invalid_threshold"
      | "invalid_max_turns",
  ) {
    super(message);
    this.name = "Stage0ValidationError";
  }
}

export interface Stage0MatrixCoverage {
  readonly complete: boolean;
  readonly expectedCanonicalCells: number;
  readonly coveredCanonicalCells: number;
  readonly missingCellCount: number;
  readonly duplicateCellCount: number;
  readonly unknownCellCount: number;
  readonly tamperedCellCount: number;
}

export interface Stage0EvaluationReport {
  readonly policyId: string;
  readonly seed: number;
  readonly totalEpisodes: number;
  readonly passed: boolean;
  readonly promotable: boolean;
  readonly diagnosticSubset: boolean;
  readonly matrixCoverage: Stage0MatrixCoverage;
  readonly thresholds: Stage0GateThresholds;
  readonly metrics: Stage0EvaluationMetrics;
  readonly gates: readonly Stage0GateCheck[];
  readonly failingWitnesses: readonly Stage0FailingWitness[];
  readonly personaBreakdown: Readonly<Record<Stage0PersonaId, Stage0PersonaBreakdown>>;
  readonly episodes: readonly Stage0EpisodeResult[];
}

/** Deterministic FNV-1a 32-bit hash for string/number seed mixing. */
export function hashSeed32(seed: number | string): number {
  let h = 2166136261 >>> 0;
  const text = typeof seed === "number" ? `n:${seed >>> 0}` : `s:${seed}`;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function splitMix32Next(stateRef: { s: number }): number {
  stateRef.s = (stateRef.s + 0x9e3779b9) >>> 0;
  let z = stateRef.s;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
  return (z ^ (z >>> 16)) >>> 0;
}

function rotl32(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

function wrapRng(nextUint32: () => number, baseSeed: number): DeterministicRng {
  const rng: DeterministicRng = {
    nextUint32,
    nextFloat(): number {
      return nextUint32() / 4294967296;
    },
    nextInt(minInclusive: number, maxExclusive: number): number {
      if (!Number.isInteger(minInclusive) || !Number.isInteger(maxExclusive) || maxExclusive <= minInclusive) {
        throw new RangeError(`Invalid integer range [${minInclusive}, ${maxExclusive})`);
      }
      const span = maxExclusive - minInclusive;
      return minInclusive + (nextUint32() % span);
    },
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) {
        throw new RangeError("Cannot pick from an empty array");
      }
      const selected = items[rng.nextInt(0, items.length)];
      if (selected === undefined) {
        throw new RangeError("RNG pick index out of bounds");
      }
      return selected;
    },
    fork(salt: string | number): DeterministicRng {
      const mixed = hashSeed32(`${baseSeed >>> 0}:${salt}`);
      return createXoshiro128StarStar(mixed);
    },
  };
  return rng;
}

/** Deterministic `mulberry32` seeded PRNG. */
export function createMulberry32(seed: number | string): DeterministicRng {
  const baseSeed = typeof seed === "number" ? seed >>> 0 : hashSeed32(seed);
  let state = baseSeed;
  const nextUint32 = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1) >>> 0;
    t ^= (t + Math.imul(t ^ (t >>> 7), t | 61)) >>> 0;
    return (t ^ (t >>> 14)) >>> 0;
  };
  return wrapRng(nextUint32, baseSeed);
}

/** Deterministic `xoshiro128**` seeded PRNG initialized via SplitMix32. */
export function createXoshiro128StarStar(seed: number | string): DeterministicRng {
  const baseSeed = typeof seed === "number" ? seed >>> 0 : hashSeed32(seed);
  const sm = { s: baseSeed || 0x9e3779b9 };
  let s0 = splitMix32Next(sm);
  let s1 = splitMix32Next(sm);
  let s2 = splitMix32Next(sm);
  let s3 = splitMix32Next(sm);
  if ((s0 | s1 | s2 | s3) === 0) {
    s0 = 0x6d2b79f5;
  }
  const nextUint32 = (): number => {
    const result = Math.imul(rotl32(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (s1 << 9) >>> 0;
    s2 ^= s0;
    s3 ^= s1;
    s1 ^= s2;
    s0 ^= s3;
    s2 ^= t;
    s3 = rotl32(s3, 11);
    return result;
  };
  return wrapRng(nextUint32, baseSeed);
}
