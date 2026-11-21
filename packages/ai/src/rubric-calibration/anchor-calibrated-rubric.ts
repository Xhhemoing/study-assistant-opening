import {
  bandFromTheta,
  getSentinelAnchorsForDimension,
  type DimensionSentinelAnchor,
  type RubricDimension,
} from "./sentinel-anchors";

/**
 * AnchorCalibratedRubricV1: position-swapped pairwise comparison against fixed
 * Bradley–Terry sentinel anchors, fail-closed inconsistency/monotonicity gating,
 * and template-padding / mastery purity enforcement.
 */

export type PairwiseChoice = "A" | "B" | "tie";
export type RubricSubmissionMode = "practice_feedback" | "formal_assessment";

export interface PairwiseSwapComparison {
  readonly anchorId: string;
  /** Forward presentation: A = student essay, B = sentinel anchor. */
  readonly forwardChoice: PairwiseChoice;
  /** Reverse presentation: A = sentinel anchor, B = student essay. */
  readonly reverseChoice?: PairwiseChoice | null;
}

export interface RubricSubmissionInput {
  readonly submissionId: string;
  readonly dimension: RubricDimension;
  readonly text: string;
  readonly mode: RubricSubmissionMode;
  readonly assisted: boolean;
  readonly comparisons: readonly PairwiseSwapComparison[];
  readonly anchors?: readonly DimensionSentinelAnchor[];
}

export type RubricInconsistencyReason =
  | "insufficient_anchor_coverage"
  | "missing_reverse_comparison"
  | "duplicate_anchor_comparison"
  | "unknown_anchor_id"
  | "swap_position_bias_first"
  | "swap_position_bias_second"
  | "swap_verdict_asymmetry"
  | "non_adjacent_monotonicity_violation"
  | "adjacent_monotonicity_violation";

export type MasteryExclusionReason =
  | "practice_feedback_only"
  | "assisted_submission"
  | "interval_only_inconsistent"
  | "template_padding_detected";

export interface TemplatePaddingReport {
  readonly isTemplatePadded: boolean;
  readonly wordCount: number;
  readonly clicheHits: readonly string[];
  readonly clicheWordRatio: number;
}

export interface ResolvedAnchorComparison {
  readonly anchorId: string;
  readonly band: number;
  readonly thetaAnchor: number;
  readonly outcome: 1 | 0.5 | 0 | null;
  readonly consistent: boolean;
  readonly reason: RubricInconsistencyReason | null;
}

export interface AnchorCalibratedRubricV1Result {
  readonly schemaVersion: 1;
  readonly submissionId: string;
  readonly dimension: RubricDimension;
  readonly status: "calibrated" | "interval_only";
  /** Snapped 0.5 IELTS band in [0, 9]; strictly null when status === "interval_only". */
  readonly band: number | null;
  /** Continuous Bradley–Terry band projection clamped to [0, 9]; null when interval_only. */
  readonly rawBand: number | null;
  /** Bradley–Terry latent skill estimate; null when interval_only. */
  readonly theta: number | null;
  /** Non-fabricated [lowerBand, upperBand] bracket derived from consistent anchor bounds. */
  readonly bandRange: readonly [number, number];
  /** True ONLY when calibrated, formal_assessment, unassisted, and not template-padded. */
  readonly countsTowardMastery: boolean;
  readonly masteryExclusionReasons: readonly MasteryExclusionReason[];
  readonly inconsistencyReasons: readonly RubricInconsistencyReason[];
  readonly paddingReport: TemplatePaddingReport;
  readonly anchorComparisons: readonly ResolvedAnchorComparison[];
}

const TEMPLATE_CLICHE_PATTERNS: readonly string[] = [
  "in the contemporary era",
  "rapid globalization",
  "hotly debated topic",
  "sparked heated debate",
  "from all walks of life",
  "universally acknowledged",
  "every coin has two sides",
  "goes without saying",
  "plays a pivotal role",
  "needless to say",
  "undeniable fact",
  "double-edged sword",
  "speaks volumes",
  "today's fast-paced world",
  "as far as i am concerned",
  "from my perspective, i firmly believe",
  "it is widely believed that",
  "in a nutshell",
  "last but not least",
  "in light of the aforementioned considerations",
  "since the dawn of",
  "every corner of society",
];

// Calibrated so all-wins projects to maxAnchor + 0.5 (8.5) and all-losses to minAnchor - 0.5 (4.0)
// on the default 6-sentinel scale while keeping interior MLE unregularized (zero shrinkage bias).
const BOUNDARY_PRIOR_LAMBDA = 0.015286;
const MIN_BAND = 0;
const MAX_BAND = 9;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sigmoid(x: number): number {
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  }
  const z = Math.exp(x);
  return z / (1 + z);
}

function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

export function detectTemplatePadding(text: string): TemplatePaddingReport {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  const wordCount = countWords(normalized);
  const clicheHits: string[] = [];
  let clicheWordCount = 0;

  for (const phrase of TEMPLATE_CLICHE_PATTERNS) {
    if (normalized.includes(phrase)) {
      clicheHits.push(phrase);
      clicheWordCount += countWords(phrase);
    }
  }

  const clicheWordRatio = wordCount > 0 ? Math.min(1, clicheWordCount / wordCount) : 0;
  const isTemplatePadded = clicheHits.length >= 3 || (clicheHits.length >= 2 && clicheWordRatio >= 0.12);

  return {
    isTemplatePadded,
    wordCount,
    clicheHits,
    clicheWordRatio,
  };
}

function normalizeForward(choice: PairwiseChoice): "student" | "anchor" | "tie" {
  if (choice === "A") return "student";
  if (choice === "B") return "anchor";
  return "tie";
}

function normalizeReverse(choice: PairwiseChoice): "student" | "anchor" | "tie" {
  if (choice === "A") return "anchor";
  if (choice === "B") return "student";
  return "tie";
}

function resolveSwapPair(
  forward: PairwiseChoice,
  reverse: PairwiseChoice | null | undefined,
): { outcome: 1 | 0.5 | 0 | null; reason: RubricInconsistencyReason | null } {
  if (reverse === null || reverse === undefined) {
    return { outcome: null, reason: "missing_reverse_comparison" };
  }
  const f = normalizeForward(forward);
  const r = normalizeReverse(reverse);
  if (f === r) {
    return { outcome: f === "student" ? 1 : f === "anchor" ? 0 : 0.5, reason: null };
  }
  if (forward === "A" && reverse === "A") {
    return { outcome: null, reason: "swap_position_bias_first" };
  }
  if (forward === "B" && reverse === "B") {
    return { outcome: null, reason: "swap_position_bias_second" };
  }
  return { outcome: null, reason: "swap_verdict_asymmetry" };
}

function computeBandBracket(resolved: readonly ResolvedAnchorComparison[]): readonly [number, number] {
  if (resolved.length === 0) return [MIN_BAND, MAX_BAND];

  let firstNonWin = resolved.length;
  for (let i = 0; i < resolved.length; i++) {
    const item = resolved[i];
    if (!item || !item.consistent || item.outcome !== 1) {
      firstNonWin = i;
      break;
    }
  }

  let lastNonLoss = -1;
  for (let i = resolved.length - 1; i >= 0; i--) {
    const item = resolved[i];
    if (!item || !item.consistent || item.outcome !== 0) {
      lastNonLoss = i;
      break;
    }
  }

  const lowerAnchor = firstNonWin > 0 ? resolved[firstNonWin - 1] : undefined;
  const upperAnchor = lastNonLoss < resolved.length - 1 ? resolved[lastNonLoss + 1] : undefined;
  const lowerBand = lowerAnchor ? lowerAnchor.band : MIN_BAND;
  const upperBand = upperAnchor ? upperAnchor.band : MAX_BAND;
  return lowerBand <= upperBand ? [lowerBand, upperBand] : [upperBand, lowerBand];
}

function solveBradleyTerryTheta(
  anchors: readonly DimensionSentinelAnchor[],
  outcomes: readonly (1 | 0.5 | 0)[],
): number {
  const m = anchors.length;
  const totalScore = outcomes.reduce<number>((sum, value) => sum + value, 0);
  const isBoundary = totalScore === 0 || totalScore === m;
  const priorLambda = isBoundary ? BOUNDARY_PRIOR_LAMBDA : 0;
  const priorCenter = anchors.reduce((sum, anchor) => sum + anchor.thetaAnchor, 0) / m;

  const minAnchorTheta = anchors[0]?.thetaAnchor ?? 0;
  const maxAnchorTheta = anchors[m - 1]?.thetaAnchor ?? 0;
  let lo = minAnchorTheta - 16;
  let hi = maxAnchorTheta + 16;

  const scoreGradient = (theta: number): { g: number; gp: number } => {
    let g = -priorLambda * (theta - priorCenter);
    let gp = -priorLambda;
    for (let i = 0; i < m; i++) {
      const anchor = anchors[i];
      const y = outcomes[i];
      if (!anchor || y === undefined) continue;
      const p = sigmoid(theta - anchor.thetaAnchor);
      g += y - p;
      gp -= p * (1 - p);
    }
    return { g, gp };
  };

  // Expand bracket defensively if needed so g(lo) > 0 > g(hi).
  while (scoreGradient(lo).g <= 0) lo -= 8;
  while (scoreGradient(hi).g >= 0) hi += 8;

  let theta = clamp(priorCenter, lo + 1e-6, hi - 1e-6);
  for (let iteration = 0; iteration < 64; iteration++) {
    const { g, gp } = scoreGradient(theta);
    if (Math.abs(g) < 1e-12 || hi - lo < 1e-12) break;
    if (g > 0) lo = theta;
    else hi = theta;

    const newton = gp < -1e-15 ? theta - g / gp : Number.NaN;
    theta = Number.isFinite(newton) && newton > lo && newton < hi ? newton : 0.5 * (lo + hi);
  }
  return theta;
}

export function snapHalfBand(band: number): number {
  return clamp(Math.round(band * 2) / 2, MIN_BAND, MAX_BAND);
}

export function evaluateAnchorCalibratedRubric(input: RubricSubmissionInput): AnchorCalibratedRubricV1Result {
  const sourceAnchors = input.anchors ?? getSentinelAnchorsForDimension(input.dimension);
  const anchors = [...sourceAnchors].sort((a, b) => a.band - b.band || a.thetaAnchor - b.thetaAnchor);
  const paddingReport = detectTemplatePadding(input.text);
  const reasons = new Set<RubricInconsistencyReason>();

  const comparisonByAnchor = new Map<string, PairwiseSwapComparison>();
  const validAnchorIds = new Set(anchors.map((a) => a.anchorId));

  for (const comparison of input.comparisons) {
    if (!validAnchorIds.has(comparison.anchorId)) {
      reasons.add("unknown_anchor_id");
      continue;
    }
    if (comparisonByAnchor.has(comparison.anchorId)) {
      reasons.add("duplicate_anchor_comparison");
      continue;
    }
    comparisonByAnchor.set(comparison.anchorId, comparison);
  }

  if (anchors.length < 2 || comparisonByAnchor.size < anchors.length) {
    reasons.add("insufficient_anchor_coverage");
  }

  const resolved: ResolvedAnchorComparison[] = anchors.map((anchor) => {
    const pair = comparisonByAnchor.get(anchor.anchorId);
    if (!pair) {
      return {
        anchorId: anchor.anchorId,
        band: anchor.band,
        thetaAnchor: anchor.thetaAnchor,
        outcome: null,
        consistent: false,
        reason: "insufficient_anchor_coverage",
      };
    }
    const { outcome, reason } = resolveSwapPair(pair.forwardChoice, pair.reverseChoice);
    if (reason) reasons.add(reason);
    return {
      anchorId: anchor.anchorId,
      band: anchor.band,
      thetaAnchor: anchor.thetaAnchor,
      outcome,
      consistent: reason === null,
      reason,
    };
  });

  // Check monotonic non-increasing outcomes across ascending sentinel anchors.
  for (let i = 0; i < resolved.length; i++) {
    const low = resolved[i];
    if (!low || !low.consistent || low.outcome === null) continue;
    for (let j = i + 1; j < resolved.length; j++) {
      const high = resolved[j];
      if (!high || !high.consistent || high.outcome === null) continue;
      if (high.outcome > low.outcome) {
        const isNonAdjacent = j - i >= 2 || high.band - low.band > 0.5;
        reasons.add(isNonAdjacent ? "non_adjacent_monotonicity_violation" : "adjacent_monotonicity_violation");
      }
    }
  }

  const bandRange = computeBandBracket(resolved);
  const inconsistencyReasons = [...reasons].sort();
  const isConsistentAndMonotone = inconsistencyReasons.length === 0;

  const masteryExclusionReasons: MasteryExclusionReason[] = [];
  if (input.mode === "practice_feedback") masteryExclusionReasons.push("practice_feedback_only");
  if (input.assisted) masteryExclusionReasons.push("assisted_submission");
  if (!isConsistentAndMonotone) masteryExclusionReasons.push("interval_only_inconsistent");
  if (paddingReport.isTemplatePadded) masteryExclusionReasons.push("template_padding_detected");

  if (!isConsistentAndMonotone) {
    return {
      schemaVersion: 1,
      submissionId: input.submissionId,
      dimension: input.dimension,
      status: "interval_only",
      band: null,
      rawBand: null,
      theta: null,
      bandRange,
      countsTowardMastery: false,
      masteryExclusionReasons,
      inconsistencyReasons,
      paddingReport,
      anchorComparisons: resolved,
    };
  }

  const outcomes = resolved.map((entry) => entry.outcome as 1 | 0.5 | 0);
  const theta = solveBradleyTerryTheta(anchors, outcomes);
  const rawBand = clamp(bandFromTheta(theta), MIN_BAND, MAX_BAND);
  const band = snapHalfBand(rawBand);

  return {
    schemaVersion: 1,
    submissionId: input.submissionId,
    dimension: input.dimension,
    status: "calibrated",
    band,
    rawBand,
    theta,
    bandRange,
    countsTowardMastery: masteryExclusionReasons.length === 0,
    masteryExclusionReasons,
    inconsistencyReasons: [],
    paddingReport,
    anchorComparisons: resolved,
  };
}
