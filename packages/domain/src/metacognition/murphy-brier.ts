import {
  isPreAnswerConfidence,
  PRE_ANSWER_CONFIDENCE_PROBABILITY,
  PRE_ANSWER_CONFIDENCE_STATES,
  type MurphyBrierBin,
  type MurphyBrierObservation,
  type MurphyBrierOptions,
  type MurphyBrierReceipt,
  type MurphyCalibrationDiagnosis,
  type PreAnswerConfidence,
} from "./types";

export const DEFAULT_CALIBRATION_BIAS_TOLERANCE = 0.05;
export const DEFAULT_MURPHY_MIN_SAMPLE_SIZE = 1;

function normalizeZero(value: number): number {
  return value === 0 ? 0 : value;
}

function emptyBins(): readonly [MurphyBrierBin, MurphyBrierBin, MurphyBrierBin] {
  const bins = PRE_ANSWER_CONFIDENCE_STATES.map((confidence) =>
    Object.freeze({
      confidence,
      forecastProbability: PRE_ANSWER_CONFIDENCE_PROBABILITY[confidence],
      count: 0,
      correctCount: 0,
      empiricalAccuracy: null,
      reliabilityContribution: 0,
      resolutionContribution: 0,
      signedBias: null,
    }),
  );
  return Object.freeze([bins[0]!, bins[1]!, bins[2]!] as const);
}

function classifyCalibrationDiagnosis(
  bias: number,
  tolerance: number,
): MurphyCalibrationDiagnosis {
  if (bias > tolerance) return "overconfident";
  if (bias < -tolerance) return "underconfident";
  return "well_calibrated";
}

/**
 * Exact Murphy (1973) Brier Score decomposition over the 3 canonical confidence bins
 * (`guessing = 0.25`, `unsure = 0.60`, `sure = 0.90`) with a strict epistemic honesty gate.
 *
 * Honesty Gate:
 * - Only first independent unassisted submissions with valid outcomes (`isFirstSubmission === true`,
 *   `assisted === false`, `hinted !== true`, `isMultiDraft !== true`, `validOutcome !== false`,
 *   boolean `isCorrect`, and valid 3-state confidence) enter calibration metrics.
 * - Duplicate submissions sharing an already-seen `itemId` are excluded as repeats.
 *
 * Exact Algebraic Identity (verified to <= 1e-12):
 *   BS === REL - RES + UNC
 */
export function computeMurphyBrierReceipt(
  observations: readonly MurphyBrierObservation[],
  options: MurphyBrierOptions = {},
): MurphyBrierReceipt {
  const biasTolerance = options.biasTolerance ?? DEFAULT_CALIBRATION_BIAS_TOLERANCE;
  if (!Number.isFinite(biasTolerance) || biasTolerance < 0) {
    throw new RangeError(
      `biasTolerance must be a finite non-negative number, received: ${String(biasTolerance)}`,
    );
  }

  const minSampleSize = options.minSampleSize ?? DEFAULT_MURPHY_MIN_SAMPLE_SIZE;
  if (!Number.isInteger(minSampleSize) || minSampleSize < 1) {
    throw new RangeError(
      `minSampleSize must be a positive integer, received: ${String(minSampleSize)}`,
    );
  }

  const totalInputCount = observations.length;
  let excludedAssistedOrRepeatCount = 0;
  let excludedInvalidOutcomeCount = 0;

  const seenItemIds = new Set<string>();
  const eligible: Array<{
    confidence: PreAnswerConfidence;
    forecast: number;
    outcome: 0 | 1;
  }> = [];

  for (const observation of observations) {
    const normalizedItemId =
      typeof observation.itemId === "string" && observation.itemId.length > 0
        ? observation.itemId
        : null;
    const isRepeatItem = normalizedItemId !== null && seenItemIds.has(normalizedItemId);
    if (normalizedItemId !== null) {
      seenItemIds.add(normalizedItemId);
    }

    const isAssistedOrRepeat =
      observation.assisted === true ||
      observation.hinted === true ||
      observation.isFirstSubmission !== true ||
      observation.isMultiDraft === true ||
      isRepeatItem;

    if (isAssistedOrRepeat) {
      excludedAssistedOrRepeatCount += 1;
      continue;
    }

    const hasValidOutcome =
      observation.validOutcome !== false &&
      typeof observation.isCorrect === "boolean" &&
      isPreAnswerConfidence(observation.preAnswerConfidence);

    if (!hasValidOutcome) {
      excludedInvalidOutcomeCount += 1;
      continue;
    }

    eligible.push({
      confidence: observation.preAnswerConfidence,
      forecast: PRE_ANSWER_CONFIDENCE_PROBABILITY[observation.preAnswerConfidence],
      outcome: observation.isCorrect ? 1 : 0,
    });
  }

  const sampleCount = eligible.length;

  if (sampleCount === 0 || sampleCount < minSampleSize) {
    return Object.freeze({
      schemaVersion: 1,
      status: "insufficient_sample",
      sampleCount,
      totalInputCount,
      excludedAssistedOrRepeatCount,
      excludedInvalidOutcomeCount,
      brierScore: null,
      reliability: null,
      resolution: null,
      uncertainty: null,
      bias: null,
      ece: null,
      baseRate: null,
      identityResidual: null,
      diagnosis: null,
      bins: emptyBins(),
    });
  }

  const binAcc: Record<PreAnswerConfidence, { count: number; correctCount: number }> = {
    guessing: { count: 0, correctCount: 0 },
    unsure: { count: 0, correctCount: 0 },
    sure: { count: 0, correctCount: 0 },
  };

  let brierSum = 0;
  let biasSum = 0;
  let correctSum = 0;

  for (const item of eligible) {
    const diff = item.forecast - item.outcome;
    brierSum += diff * diff;
    biasSum += diff;
    correctSum += item.outcome;

    const bucket = binAcc[item.confidence];
    bucket.count += 1;
    bucket.correctCount += item.outcome;
  }

  const brierScore = normalizeZero(brierSum / sampleCount);
  const bias = normalizeZero(biasSum / sampleCount);
  const baseRate = normalizeZero(correctSum / sampleCount);
  const uncertainty = normalizeZero(baseRate * (1 - baseRate));

  let reliability = 0;
  let resolution = 0;
  let ece = 0;

  const builtBins = PRE_ANSWER_CONFIDENCE_STATES.map((confidence) => {
    const forecastProbability = PRE_ANSWER_CONFIDENCE_PROBABILITY[confidence];
    const { count, correctCount } = binAcc[confidence];

    if (count === 0) {
      return Object.freeze({
        confidence,
        forecastProbability,
        count: 0,
        correctCount: 0,
        empiricalAccuracy: null,
        reliabilityContribution: 0,
        resolutionContribution: 0,
        signedBias: null,
      });
    }

    const empiricalAccuracy = normalizeZero(correctCount / count);
    const weight = count / sampleCount;
    const reliabilityContribution = normalizeZero(
      weight * (forecastProbability - empiricalAccuracy) ** 2,
    );
    const resolutionContribution = normalizeZero(
      weight * (empiricalAccuracy - baseRate) ** 2,
    );
    const signedBias = normalizeZero(forecastProbability - empiricalAccuracy);

    reliability += reliabilityContribution;
    resolution += resolutionContribution;
    ece += weight * Math.abs(forecastProbability - empiricalAccuracy);

    return Object.freeze({
      confidence,
      forecastProbability,
      count,
      correctCount,
      empiricalAccuracy,
      reliabilityContribution,
      resolutionContribution,
      signedBias,
    });
  });

  reliability = normalizeZero(reliability);
  resolution = normalizeZero(resolution);
  ece = normalizeZero(ece);

  const reconstructedBrier = reliability - resolution + uncertainty;
  const identityResidual = Math.abs(brierScore - reconstructedBrier);

  return Object.freeze({
    schemaVersion: 1,
    status: "computed",
    sampleCount,
    totalInputCount,
    excludedAssistedOrRepeatCount,
    excludedInvalidOutcomeCount,
    brierScore,
    reliability,
    resolution,
    uncertainty,
    bias,
    ece,
    baseRate,
    identityResidual,
    diagnosis: classifyCalibrationDiagnosis(bias, biasTolerance),
    bins: Object.freeze([builtBins[0]!, builtBins[1]!, builtBins[2]!] as const),
  });
}
