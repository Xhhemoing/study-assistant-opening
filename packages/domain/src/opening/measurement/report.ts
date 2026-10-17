import type {
  MeasurementAttempt, MeasurementCalibrationBin, MeasurementModelManifest, MeasurementModelScore,
  MeasurementPhase, MeasurementReport,
} from "@aistudy/contracts";
import { MEASUREMENT_MODELS, measurementEligibility, measurementTimingExclusion, predictionPairExclusion } from "./evaluation";

// Finite endpoint handling for proper log scores; probabilities themselves remain unchanged.
const LOG_SCORE_EPSILON = 1e-15;
const CALIBRATION_BINS = 5;
const PHASES: MeasurementPhase[] = ["practice", "delay_48h", "delay_7d"];

function scoreModel(attempts: readonly MeasurementAttempt[], model: MeasurementModelManifest): MeasurementModelScore {
  const rows = attempts.map(attempt => ({
    probability: attempt.predictions.find(prediction => prediction.modelId === model.id && prediction.modelVersion === model.version)!.probability,
    correct: attempt.outcome === "correct" ? 1 : 0,
  }));
  const calibration: MeasurementCalibrationBin[] = Array.from({ length: CALIBRATION_BINS }, (_, index) => {
    const members = rows.filter(row => Math.min(CALIBRATION_BINS - 1, Math.floor(row.probability * CALIBRATION_BINS)) === index);
    return {
      lower: index / CALIBRATION_BINS, upper: (index + 1) / CALIBRATION_BINS, count: members.length,
      meanPrediction: members.length ? members.reduce((sum, row) => sum + row.probability, 0) / members.length : null,
      observedAccuracy: members.length ? members.reduce((sum, row) => sum + row.correct, 0) / members.length : null,
    };
  });
  return {
    modelId: model.id, modelVersion: model.version, count: rows.length,
    brier: rows.length ? rows.reduce((sum, row) => sum + (row.probability - row.correct) ** 2, 0) / rows.length : null,
    logLoss: rows.length ? rows.reduce((sum, row) => {
      const probability = Math.max(LOG_SCORE_EPSILON, Math.min(1 - LOG_SCORE_EPSILON, row.probability));
      return sum - (row.correct ? Math.log(probability) : Math.log1p(-probability));
    }, 0) / rows.length : null,
    calibration,
  };
}

/** Descriptive, paired comparison. One learner's repeated answers do not establish causal learning gains. */
export function buildMeasurementReport(
  attempts: readonly MeasurementAttempt[], models: readonly MeasurementModelManifest[] = MEASUREMENT_MODELS,
): MeasurementReport {
  const attemptsById = new Map(attempts.map(attempt => [attempt.id, attempt]));
  if (attemptsById.size !== attempts.length) throw new RangeError("Measurement report contains duplicate attempts");
  if (new Set(attempts.map(attempt => attempt.trialId)).size > 1) throw new RangeError("Measurement report requires one trial");
  if (models.length === 0 || new Set(models.map(model => JSON.stringify([model.id, model.version]))).size !== models.length) {
    throw new RangeError("Measurement report requires unique model versions");
  }
  const excluded: Record<string, number> = {};
  const eligible = attempts.filter(attempt => {
    const reason = measurementEligibility(attempt) ?? measurementTimingExclusion(attempt, attempts) ?? predictionPairExclusion(attempt, attemptsById, models);
    if (reason !== null) excluded[reason] = (excluded[reason] ?? 0) + 1;
    return reason === null;
  });
  const scores = (rows: readonly MeasurementAttempt[]) => models.map(model => scoreModel(rows, model));
  const modelScores = scores(eligible);
  const bkt = modelScores.find(model => model.modelId === "classical-bkt");
  const baseline = modelScores.find(model => model.modelId === "smoothed-frequency");
  return {
    conclusion: "insufficient_evidence",
    presented: attempts.length,
    answered: attempts.filter(attempt => attempt.answeredAt !== null).length,
    pending: attempts.filter(attempt => attempt.answeredAt === null).length,
    skipped: attempts.filter(attempt => attempt.outcome === "skipped").length,
    eligible: eligible.length, excluded, models: modelScores,
    byPhase: PHASES.map(phase => {
      const rows = eligible.filter(attempt => attempt.item.phase === phase);
      return { phase, eligible: rows.length, models: scores(rows) };
    }),
    bySkill: [...new Set(attempts.map(attempt => attempt.item.skillId))].sort().map(skillId => {
      const rows = eligible.filter(attempt => attempt.item.skillId === skillId);
      return { skillId, eligible: rows.length, models: scores(rows) };
    }),
    // Negative differences favor BKT on these same held-out observations only.
    pairedBrierDifference: bkt?.brier != null && baseline?.brier != null ? bkt.brier - baseline.brier : null,
    pairedLogLossDifference: bkt?.logLoss != null && baseline?.logLoss != null ? bkt.logLoss - baseline.logLoss : null,
  };
}
