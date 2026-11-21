import {
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
  | "invalid_anchor_definitions"
  | "insufficient_anchor_coverage"
  | "missing_reverse_comparison"
  | "invalid_comparison_choice"
  | "duplicate_anchor_comparison"
  | "unknown_anchor_id"
  | "swap_position_bias_first"
  | "swap_position_bias_second"
  | "swap_verdict_asymmetry"
  | "non_adjacent_monotonicity_violation"
  | "adjacent_monotonicity_violation"
  | "non_finite_projection"
  | "projection_outside_evidence_bracket";

export type MasteryExclusionReason =
  | "practice_feedback_only"
  | "assisted_submission"
  | "interval_only_inconsistent"
  | "template_padding_detected";

export interface TemplatePaddingReport {
  readonly isTemplatePadded: boolean;
  readonly wordCount: number;
  readonly clicheHits: readonly string[];
  readonly totalClicheOccurrences: number;
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
const MAX_ABS_THETA_ANCHOR = 20;
const BRACKET_EPSILON = 1e-9;

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

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[a-z0-9]/.test(ch);
}

function countNonOverlappingOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let fromIndex = 0;
  while (fromIndex <= haystack.length - needle.length) {
    const idx = haystack.indexOf(needle, fromIndex);
    if (idx === -1) break;
    const beforeOk = idx === 0 || !isWordChar(haystack[idx - 1]);
    const end = idx + needle.length;
    const afterOk = end === haystack.length || !isWordChar(haystack[end]);
    if (beforeOk && afterOk) {
      count++;
      fromIndex = end;
    } else {
      fromIndex = idx + 1;
    }
  }
  return count;
}

export function detectTemplatePadding(text: string): TemplatePaddingReport {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  const wordCount = countWords(normalized);
  const clicheHits: string[] = [];
  let totalClicheOccurrences = 0;
  let clicheWordCount = 0;

  for (const phrase of TEMPLATE_CLICHE_PATTERNS) {
    const occurrences = countNonOverlappingOccurrences(normalized, phrase);
    if (occurrences > 0) {
      clicheHits.push(phrase);
      totalClicheOccurrences += occurrences;
      clicheWordCount += countWords(phrase) * occurrences;
    }
  }

  const clicheWordRatio = wordCount > 0 ? Math.min(1, clicheWordCount / wordCount) : 0;
  const isTemplatePadded =
    clicheHits.length >= 2 || totalClicheOccurrences >= 2 || clicheWordRatio >= 0.20;

  return {
    isTemplatePadded,
    wordCount,
    clicheHits,
    totalClicheOccurrences,
    clicheWordRatio,
  };
}

function isValidPairwiseChoice(choice: unknown): choice is PairwiseChoice {
  return choice === "A" || choice === "B" || choice === "tie";
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
  if (!isValidPairwiseChoice(forward)) {
    return { outcome: null, reason: "invalid_comparison_choice" };
  }
  if (reverse === null || reverse === undefined) {
    return { outcome: null, reason: "missing_reverse_comparison" };
  }
  if (!isValidPairwiseChoice(reverse)) {
    return { outcome: null, reason: "invalid_comparison_choice" };
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

  // Expand bracket defensively with bounded steps so g(lo) > 0 > g(hi).
  for (let step = 0; step < 64 && scoreGradient(lo).g <= 0; step++) lo -= 8;
  for (let step = 0; step < 64 && scoreGradient(hi).g >= 0; step++) hi += 8;

  let theta = clamp(priorCenter, lo + 1e-6, hi - 1e-6);
  for (let iteration = 0; iteration < 64; iteration++) {
    const { g, gp } = scoreGradient(theta);
    if (!Number.isFinite(g) || !Number.isFinite(gp)) return Number.NaN;
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

function projectThetaToBand(
  theta: number,
  anchors: readonly DimensionSentinelAnchor[],
): number {
  if (!Number.isFinite(theta) || anchors.length < 2) return Number.NaN;
  const first = anchors[0]!;
  const second = anchors[1]!;
  if (theta <= first.thetaAnchor) {
    const slope = (second.band - first.band) / (second.thetaAnchor - first.thetaAnchor);
    return first.band + (theta - first.thetaAnchor) * slope;
  }
  const last = anchors[anchors.length - 1]!;
  const prevLast = anchors[anchors.length - 2]!;
  if (theta >= last.thetaAnchor) {
    const slope = (last.band - prevLast.band) / (last.thetaAnchor - prevLast.thetaAnchor);
    return last.band + (theta - last.thetaAnchor) * slope;
  }
  for (let i = 0; i < anchors.length - 1; i++) {
    const lo = anchors[i]!;
    const hi = anchors[i + 1]!;
    if (theta >= lo.thetaAnchor && theta <= hi.thetaAnchor) {
      const t = (theta - lo.thetaAnchor) / (hi.thetaAnchor - lo.thetaAnchor);
      return lo.band + t * (hi.band - lo.band);
    }
  }
  return Number.NaN;
}

function validateAndSortAnchors(
  sourceAnchors: readonly DimensionSentinelAnchor[],
): readonly DimensionSentinelAnchor[] | null {
  if (!Array.isArray(sourceAnchors) || sourceAnchors.length < 2) return null;
  const seenIds = new Set<string>();
  for (let i = 0; i < sourceAnchors.length; i += 1) {
    if (!Object.hasOwn(sourceAnchors, i)) return null;
    const anchor = sourceAnchors[i];
    if (!anchor || typeof anchor.anchorId !== "string" || anchor.anchorId.trim().length === 0) return null;
    if (seenIds.has(anchor.anchorId)) return null;
    seenIds.add(anchor.anchorId);
    if (
      typeof anchor.band !== "number" ||
      !Number.isFinite(anchor.band) ||
      anchor.band < MIN_BAND ||
      anchor.band > MAX_BAND
    ) {
      return null;
    }
    if (
      typeof anchor.thetaAnchor !== "number" ||
      !Number.isFinite(anchor.thetaAnchor) ||
      Math.abs(anchor.thetaAnchor) > MAX_ABS_THETA_ANCHOR
    ) {
      return null;
    }
  }

  const sorted = [...sourceAnchors].sort((a, b) => a.band - b.band || a.thetaAnchor - b.thetaAnchor);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (!prev || !curr) return null;
    if (!(curr.band > prev.band) || !(curr.thetaAnchor > prev.thetaAnchor)) return null;
  }
  return sorted;
}

export function evaluateAnchorCalibratedRubric(input: RubricSubmissionInput): AnchorCalibratedRubricV1Result {
  const sourceAnchors = input.anchors ?? getSentinelAnchorsForDimension(input.dimension);
  const paddingReport = detectTemplatePadding(input.text);
  const anchors = validateAndSortAnchors(sourceAnchors);

  if (!anchors) {
    const masteryExclusionReasons: MasteryExclusionReason[] = [];
    if (input.mode === "practice_feedback") masteryExclusionReasons.push("practice_feedback_only");
    if (input.assisted) masteryExclusionReasons.push("assisted_submission");
    masteryExclusionReasons.push("interval_only_inconsistent");
    if (paddingReport.isTemplatePadded) masteryExclusionReasons.push("template_padding_detected");

    return {
      schemaVersion: 1,
      submissionId: input.submissionId,
      dimension: input.dimension,
      status: "interval_only",
      band: null,
      rawBand: null,
      theta: null,
      bandRange: [MIN_BAND, MAX_BAND],
      countsTowardMastery: false,
      masteryExclusionReasons,
      inconsistencyReasons: ["invalid_anchor_definitions"],
      paddingReport,
      anchorComparisons: [],
    };
  }

  const reasons = new Set<RubricInconsistencyReason>();

  const comparisonByAnchor = new Map<string, PairwiseSwapComparison>();
  const duplicateAnchorIds = new Set<string>();
  const validAnchorIds = new Set(anchors.map((a) => a.anchorId));

  for (const comparison of input.comparisons) {
    if (!validAnchorIds.has(comparison.anchorId)) {
      reasons.add("unknown_anchor_id");
      continue;
    }
    if (duplicateAnchorIds.has(comparison.anchorId)) {
      reasons.add("duplicate_anchor_comparison");
      continue;
    }
    if (comparisonByAnchor.has(comparison.anchorId)) {
      reasons.add("duplicate_anchor_comparison");
      duplicateAnchorIds.add(comparison.anchorId);
      comparisonByAnchor.delete(comparison.anchorId);
      continue;
    }
    comparisonByAnchor.set(comparison.anchorId, comparison);
  }

  if (anchors.length < 2 || comparisonByAnchor.size + duplicateAnchorIds.size < anchors.length) {
    reasons.add("insufficient_anchor_coverage");
  }

  const resolved: ResolvedAnchorComparison[] = anchors.map((anchor) => {
    if (duplicateAnchorIds.has(anchor.anchorId)) {
      return {
        anchorId: anchor.anchorId,
        band: anchor.band,
        thetaAnchor: anchor.thetaAnchor,
        outcome: null,
        consistent: false,
        reason: "duplicate_anchor_comparison",
      };
    }
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
  const rawUnclamped = projectThetaToBand(theta, anchors);
  const rawBand = clamp(rawUnclamped, MIN_BAND, MAX_BAND);
  const band = snapHalfBand(rawBand);

  const nonFinite =
    !Number.isFinite(theta) ||
    !Number.isFinite(rawUnclamped) ||
    !Number.isFinite(rawBand) ||
    !Number.isFinite(band) ||
    band < MIN_BAND ||
    band > MAX_BAND;
  const bracketLow = Math.min(bandRange[0], snapHalfBand(bandRange[0])) - BRACKET_EPSILON;
  const bracketHigh = Math.max(bandRange[1], snapHalfBand(bandRange[1])) + BRACKET_EPSILON;
  const outsideBracket =
    !nonFinite &&
    (rawBand < bandRange[0] - BRACKET_EPSILON ||
      rawBand > bandRange[1] + BRACKET_EPSILON ||
      band < bracketLow ||
      band > bracketHigh);

  if (nonFinite || outsideBracket) {
    const fallbackExclusions: MasteryExclusionReason[] = [...masteryExclusionReasons];
    if (!fallbackExclusions.includes("interval_only_inconsistent")) {
      fallbackExclusions.push("interval_only_inconsistent");
    }
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
      masteryExclusionReasons: fallbackExclusions,
      inconsistencyReasons: [nonFinite ? "non_finite_projection" : "projection_outside_evidence_bracket"],
      paddingReport,
      anchorComparisons: resolved,
    };
  }

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
