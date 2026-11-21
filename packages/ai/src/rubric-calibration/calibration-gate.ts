import type { AnchorCalibratedRubricV1Result } from "./anchor-calibrated-rubric";
import { snapHalfBand } from "./anchor-calibrated-rubric";

/**
 * Four-Fold + 3-Way Anti-Padding Calibration Gate for AnchorCalibratedRubricV1.
 * Rejects mean-compressed scorers even when QWK and overall SMD appear healthy.
 */

export type RubricCalibrationPoint = Pick<
  AnchorCalibratedRubricV1Result,
  "status" | "band" | "rawBand" | "countsTowardMastery"
>;

export interface GoldRubricBenchmarkItem {
  readonly itemId: string;
  readonly trueBand: number;
  readonly evaluation: RubricCalibrationPoint;
}

export interface EvaluatedCounterfactualTriplet {
  readonly tripletId: string;
  readonly substantiveConcise: RubricCalibrationPoint;
  readonly templatePaddedExpansion: RubricCalibrationPoint;
  readonly equalLengthSubstantive: RubricCalibrationPoint;
}

export interface RubricCalibrationGateThresholds {
  readonly minQwk?: number;
  readonly maxAbsSmd?: number;
  readonly maxAbsBiasLow?: number;
  readonly maxAbsBiasHigh?: number;
  readonly minSdRatio?: number;
  readonly minAdmissibleCoverage?: number;
  readonly lowTailMaxBand?: number;
  readonly highTailMinBand?: number;
  readonly maxPaddingGain?: number;
}

export type RubricCalibrationGateFailure =
  | "invalid_threshold_configuration"
  | "empty_benchmark"
  | "admissible_coverage_below_threshold"
  | "missing_low_tail_samples"
  | "missing_high_tail_samples"
  | "qwk_below_threshold"
  | "smd_exceeds_threshold"
  | "low_tail_bias_exceeds_threshold"
  | "high_tail_bias_exceeds_threshold"
  | "sd_ratio_compression_detected"
  | "missing_counterfactual_triplets"
  | "counterfactual_missing_point_score"
  | "counterfactual_padding_gain_exceeds_limit"
  | "counterfactual_padded_not_below_equal_length_substantive"
  | "counterfactual_padded_counts_toward_mastery";

export interface CounterfactualTripletAudit {
  readonly tripletId: string;
  readonly passed: boolean;
  readonly conciseScore: number | null;
  readonly paddedScore: number | null;
  readonly equalLengthScore: number | null;
  readonly paddingGain: number | null;
  readonly failures: readonly RubricCalibrationGateFailure[];
}

export interface RubricCalibrationGateReport {
  readonly passed: boolean;
  readonly metrics: {
    readonly totalCount: number;
    readonly admissibleCount: number;
    readonly admissibleCoverage: number;
    readonly lowTailCount: number;
    readonly highTailCount: number;
    readonly qwk: number | null;
    readonly smd: number | null;
    readonly biasLow: number | null;
    readonly biasHigh: number | null;
    readonly sdTrue: number | null;
    readonly sdPred: number | null;
    readonly sdRatio: number | null;
  };
  readonly counterfactualAudits: readonly CounterfactualTripletAudit[];
  readonly failures: readonly RubricCalibrationGateFailure[];
}

export const DEFAULT_CALIBRATION_THRESHOLDS = {
  minQwk: 0.70,
  maxAbsSmd: 0.15,
  maxAbsBiasLow: 0.25,
  maxAbsBiasHigh: 0.25,
  minSdRatio: 0.75,
  minAdmissibleCoverage: 0.85,
  lowTailMaxBand: 5.0,
  highTailMinBand: 7.5,
  maxPaddingGain: 0.25,
} as const;

const HALF_BAND_LEVELS = 19; // [0.0, 0.5, ..., 9.0]
const MAX_LEVEL_INDEX = HALF_BAND_LEVELS - 1;
const FLOAT_EPSILON = 1e-9;

function bandToHalfBandIndex(band: number): number {
  const snapped = snapHalfBand(band);
  return Math.min(MAX_LEVEL_INDEX, Math.max(0, Math.round(snapped * 2)));
}

/** Exact discrete 19x19 Quadratic Weighted Kappa over IELTS [0, 9] half-band grid. */
export function computeQuadraticWeightedKappa(
  trueBands: readonly number[],
  predBands: readonly number[],
): number {
  const n = trueBands.length;
  if (n === 0 || n !== predBands.length) return Number.NaN;

  const observed: number[][] = Array.from({ length: HALF_BAND_LEVELS }, () =>
    new Array<number>(HALF_BAND_LEVELS).fill(0),
  );
  const trueHist = new Array<number>(HALF_BAND_LEVELS).fill(0);
  const predHist = new Array<number>(HALF_BAND_LEVELS).fill(0);

  for (let k = 0; k < n; k++) {
    const tVal = trueBands[k];
    const pVal = predBands[k];
    if (tVal === undefined || pVal === undefined) continue;
    const ti = bandToHalfBandIndex(tVal);
    const pi = bandToHalfBandIndex(pVal);
    const row = observed[ti];
    if (row) row[pi] = (row[pi] ?? 0) + 1;
    trueHist[ti] = (trueHist[ti] ?? 0) + 1;
    predHist[pi] = (predHist[pi] ?? 0) + 1;
  }

  let observedWeighted = 0;
  let expectedWeighted = 0;
  for (let i = 0; i < HALF_BAND_LEVELS; i++) {
    const row = observed[i];
    const hi = trueHist[i] ?? 0;
    for (let j = 0; j < HALF_BAND_LEVELS; j++) {
      const weight = ((i - j) / MAX_LEVEL_INDEX) ** 2;
      const oij = (row?.[j] ?? 0) / n;
      const eij = (hi / n) * ((predHist[j] ?? 0) / n);
      observedWeighted += weight * oij;
      expectedWeighted += weight * eij;
    }
  }

  if (expectedWeighted === 0) {
    return observedWeighted === 0 ? 1 : 0;
  }
  return 1 - observedWeighted / expectedWeighted;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function standardDeviation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mu = mean(values);
  const sumSq = values.reduce((sum, v) => sum + (v - mu) ** 2, 0);
  return Math.sqrt(sumSq / (values.length - 1));
}

function extractPointScore(point: RubricCalibrationPoint): number | null {
  if (point.status !== "calibrated") return null;
  const score = point.band ?? point.rawBand;
  if (score === null || !Number.isFinite(score) || score < 0 || score > 9) return null;
  return score;
}

function extractCounterfactualScore(point: RubricCalibrationPoint): number | null {
  if (point.status !== "calibrated") return null;
  const score = point.rawBand ?? point.band;
  if (score === null || !Number.isFinite(score) || score < 0 || score > 9) return null;
  return score;
}

interface ResolvedCalibrationThresholds {
  readonly minQwk: number;
  readonly maxAbsSmd: number;
  readonly maxAbsBiasLow: number;
  readonly maxAbsBiasHigh: number;
  readonly minSdRatio: number;
  readonly minAdmissibleCoverage: number;
  readonly lowTailMaxBand: number;
  readonly highTailMinBand: number;
  readonly customLowTailMaxBand: number | null;
  readonly customHighTailMinBand: number | null;
  readonly maxPaddingGain: number;
}

function resolveTighteningThresholds(
  overrides: RubricCalibrationGateThresholds | undefined,
): { readonly thresholds: ResolvedCalibrationThresholds; readonly valid: boolean } {
  if (!overrides) {
    return {
      thresholds: {
        ...DEFAULT_CALIBRATION_THRESHOLDS,
        customLowTailMaxBand: null,
        customHighTailMinBand: null,
      },
      valid: true,
    };
  }

  let valid = true;
  const checkFinite = (
    value: number | undefined,
    fallback: number,
    minAllowed: number,
    maxAllowed: number,
  ): number => {
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !Number.isFinite(value) || value < minAllowed || value > maxAllowed) {
      valid = false;
      return fallback;
    }
    return value;
  };

  const minQwk = Math.max(
    DEFAULT_CALIBRATION_THRESHOLDS.minQwk,
    checkFinite(overrides.minQwk, DEFAULT_CALIBRATION_THRESHOLDS.minQwk, -1, 1),
  );
  const maxAbsSmd = Math.min(
    DEFAULT_CALIBRATION_THRESHOLDS.maxAbsSmd,
    checkFinite(overrides.maxAbsSmd, DEFAULT_CALIBRATION_THRESHOLDS.maxAbsSmd, 0, Number.MAX_SAFE_INTEGER),
  );
  const maxAbsBiasLow = Math.min(
    DEFAULT_CALIBRATION_THRESHOLDS.maxAbsBiasLow,
    checkFinite(overrides.maxAbsBiasLow, DEFAULT_CALIBRATION_THRESHOLDS.maxAbsBiasLow, 0, 9),
  );
  const maxAbsBiasHigh = Math.min(
    DEFAULT_CALIBRATION_THRESHOLDS.maxAbsBiasHigh,
    checkFinite(overrides.maxAbsBiasHigh, DEFAULT_CALIBRATION_THRESHOLDS.maxAbsBiasHigh, 0, 9),
  );
  const minSdRatio = Math.max(
    DEFAULT_CALIBRATION_THRESHOLDS.minSdRatio,
    checkFinite(overrides.minSdRatio, DEFAULT_CALIBRATION_THRESHOLDS.minSdRatio, 0, Number.MAX_SAFE_INTEGER),
  );
  const minAdmissibleCoverage = Math.max(
    DEFAULT_CALIBRATION_THRESHOLDS.minAdmissibleCoverage,
    checkFinite(overrides.minAdmissibleCoverage, DEFAULT_CALIBRATION_THRESHOLDS.minAdmissibleCoverage, 0, 1),
  );

  // Default tail cutoffs are always mandatory; custom cutoffs are validated and enforced additionally.
  const customLowTailMaxBand =
    overrides.lowTailMaxBand === undefined
      ? null
      : checkFinite(overrides.lowTailMaxBand, DEFAULT_CALIBRATION_THRESHOLDS.lowTailMaxBand, 0, 9);
  const customHighTailMinBand =
    overrides.highTailMinBand === undefined
      ? null
      : checkFinite(overrides.highTailMinBand, DEFAULT_CALIBRATION_THRESHOLDS.highTailMinBand, 0, 9);
  const maxPaddingGain = Math.min(
    DEFAULT_CALIBRATION_THRESHOLDS.maxPaddingGain,
    checkFinite(overrides.maxPaddingGain, DEFAULT_CALIBRATION_THRESHOLDS.maxPaddingGain, 0, 9),
  );

  const effectiveCustomLow = customLowTailMaxBand ?? DEFAULT_CALIBRATION_THRESHOLDS.lowTailMaxBand;
  const effectiveCustomHigh = customHighTailMinBand ?? DEFAULT_CALIBRATION_THRESHOLDS.highTailMinBand;
  if (effectiveCustomLow >= effectiveCustomHigh) {
    valid = false;
  }

  return {
    valid,
    thresholds: {
      minQwk,
      maxAbsSmd,
      maxAbsBiasLow,
      maxAbsBiasHigh,
      minSdRatio,
      minAdmissibleCoverage,
      lowTailMaxBand: DEFAULT_CALIBRATION_THRESHOLDS.lowTailMaxBand,
      highTailMinBand: DEFAULT_CALIBRATION_THRESHOLDS.highTailMinBand,
      customLowTailMaxBand,
      customHighTailMinBand,
      maxPaddingGain,
    },
  };
}

export function evaluateRubricCalibrationGate(input: {
  readonly benchmarkItems: readonly GoldRubricBenchmarkItem[];
  readonly counterfactualTriplets: readonly EvaluatedCounterfactualTriplet[];
  readonly thresholds?: RubricCalibrationGateThresholds;
}): RubricCalibrationGateReport {
  const { thresholds: t, valid: thresholdsValid } = resolveTighteningThresholds(input.thresholds);
  const failures = new Set<RubricCalibrationGateFailure>();
  if (!thresholdsValid) {
    failures.add("invalid_threshold_configuration");
  }

  const totalCount = input.benchmarkItems.length;
  if (totalCount === 0) {
    failures.add("empty_benchmark");
  }

  const admissiblePairs: Array<{ trueBand: number; predBand: number }> = [];
  for (const item of input.benchmarkItems) {
    if (!Number.isFinite(item.trueBand) || item.trueBand < 0 || item.trueBand > 9) continue;
    const predBand = extractPointScore(item.evaluation);
    if (predBand !== null) {
      admissiblePairs.push({ trueBand: item.trueBand, predBand });
    }
  }

  const admissibleCount = admissiblePairs.length;
  const admissibleCoverage = totalCount > 0 ? admissibleCount / totalCount : 0;
  if (totalCount > 0 && admissibleCoverage + FLOAT_EPSILON < t.minAdmissibleCoverage) {
    failures.add("admissible_coverage_below_threshold");
  }

  const lowTail = admissiblePairs.filter((pair) => pair.trueBand <= t.lowTailMaxBand + FLOAT_EPSILON);
  const highTail = admissiblePairs.filter((pair) => pair.trueBand >= t.highTailMinBand - FLOAT_EPSILON);
  if (lowTail.length === 0) failures.add("missing_low_tail_samples");
  if (highTail.length === 0) failures.add("missing_high_tail_samples");

  const customLowTail =
    t.customLowTailMaxBand !== null
      ? admissiblePairs.filter((pair) => pair.trueBand <= t.customLowTailMaxBand! + FLOAT_EPSILON)
      : null;
  const customHighTail =
    t.customHighTailMinBand !== null
      ? admissiblePairs.filter((pair) => pair.trueBand >= t.customHighTailMinBand! - FLOAT_EPSILON)
      : null;
  if (customLowTail !== null && customLowTail.length === 0) failures.add("missing_low_tail_samples");
  if (customHighTail !== null && customHighTail.length === 0) failures.add("missing_high_tail_samples");

  const trueBands = admissiblePairs.map((pair) => pair.trueBand);
  const predBands = admissiblePairs.map((pair) => pair.predBand);

  const qwk = admissibleCount > 0 ? computeQuadraticWeightedKappa(trueBands, predBands) : null;
  const sdTrue = admissibleCount > 0 ? standardDeviation(trueBands) : null;
  const sdPred = admissibleCount > 0 ? standardDeviation(predBands) : null;

  let smd: number | null = null;
  if (admissibleCount > 0 && sdTrue !== null && sdPred !== null) {
    const meanDiff = mean(predBands) - mean(trueBands);
    const pooledSd = Math.sqrt(0.5 * (sdTrue * sdTrue + sdPred * sdPred));
    if (pooledSd === 0) {
      smd = Math.abs(meanDiff) < FLOAT_EPSILON ? 0 : Math.sign(meanDiff) * Number.POSITIVE_INFINITY;
    } else {
      smd = meanDiff / pooledSd;
    }
  }

  const biasLow = lowTail.length > 0 ? mean(lowTail.map((p) => p.predBand - p.trueBand)) : null;
  const biasHigh = highTail.length > 0 ? mean(highTail.map((p) => p.predBand - p.trueBand)) : null;
  const customBiasLow =
    customLowTail !== null && customLowTail.length > 0
      ? mean(customLowTail.map((p) => p.predBand - p.trueBand))
      : null;
  const customBiasHigh =
    customHighTail !== null && customHighTail.length > 0
      ? mean(customHighTail.map((p) => p.predBand - p.trueBand))
      : null;
  const sdRatio = sdTrue !== null && sdPred !== null && sdTrue > 0 ? sdPred / sdTrue : null;

  if (qwk === null || !Number.isFinite(qwk) || qwk + FLOAT_EPSILON < t.minQwk) {
    failures.add("qwk_below_threshold");
  }
  if (smd === null || !Number.isFinite(smd) || Math.abs(smd) > t.maxAbsSmd + FLOAT_EPSILON) {
    failures.add("smd_exceeds_threshold");
  }
  if (
    (biasLow !== null && Math.abs(biasLow) > t.maxAbsBiasLow + FLOAT_EPSILON) ||
    (customBiasLow !== null && Math.abs(customBiasLow) > t.maxAbsBiasLow + FLOAT_EPSILON)
  ) {
    failures.add("low_tail_bias_exceeds_threshold");
  }
  if (
    (biasHigh !== null && Math.abs(biasHigh) > t.maxAbsBiasHigh + FLOAT_EPSILON) ||
    (customBiasHigh !== null && Math.abs(customBiasHigh) > t.maxAbsBiasHigh + FLOAT_EPSILON)
  ) {
    failures.add("high_tail_bias_exceeds_threshold");
  }
  if (sdRatio === null || !Number.isFinite(sdRatio) || sdRatio + FLOAT_EPSILON < t.minSdRatio) {
    failures.add("sd_ratio_compression_detected");
  }

  const counterfactualAudits: CounterfactualTripletAudit[] = [];
  if (input.counterfactualTriplets.length === 0) {
    failures.add("missing_counterfactual_triplets");
  } else {
    for (const triplet of input.counterfactualTriplets) {
      const tripletFailures: RubricCalibrationGateFailure[] = [];
      if (triplet.templatePaddedExpansion.countsTowardMastery !== false) {
        tripletFailures.push("counterfactual_padded_counts_toward_mastery");
        failures.add("counterfactual_padded_counts_toward_mastery");
      }
      const conciseScore = extractCounterfactualScore(triplet.substantiveConcise);
      const paddedScore = extractCounterfactualScore(triplet.templatePaddedExpansion);
      const equalLengthScore = extractCounterfactualScore(triplet.equalLengthSubstantive);

      if (conciseScore === null || paddedScore === null || equalLengthScore === null) {
        tripletFailures.push("counterfactual_missing_point_score");
        failures.add("counterfactual_missing_point_score");
        counterfactualAudits.push({
          tripletId: triplet.tripletId,
          passed: false,
          conciseScore,
          paddedScore,
          equalLengthScore,
          paddingGain: null,
          failures: tripletFailures,
        });
        continue;
      }

      const paddingGain = paddedScore - conciseScore;
      if (paddingGain > t.maxPaddingGain + FLOAT_EPSILON) {
        tripletFailures.push("counterfactual_padding_gain_exceeds_limit");
        failures.add("counterfactual_padding_gain_exceeds_limit");
      }
      if (!(paddedScore + FLOAT_EPSILON < equalLengthScore)) {
        tripletFailures.push("counterfactual_padded_not_below_equal_length_substantive");
        failures.add("counterfactual_padded_not_below_equal_length_substantive");
      }

      counterfactualAudits.push({
        tripletId: triplet.tripletId,
        passed: tripletFailures.length === 0,
        conciseScore,
        paddedScore,
        equalLengthScore,
        paddingGain,
        failures: tripletFailures,
      });
    }
  }

  const failureList = [...failures];
  return {
    passed: failureList.length === 0,
    metrics: {
      totalCount,
      admissibleCount,
      admissibleCoverage,
      lowTailCount: lowTail.length,
      highTailCount: highTail.length,
      qwk,
      smd,
      biasLow,
      biasHigh,
      sdTrue,
      sdPred,
      sdRatio,
    },
    counterfactualAudits,
    failures: failureList,
  };
}
