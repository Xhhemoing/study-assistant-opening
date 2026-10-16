import type {
  MeasurementAttempt, MeasurementModelManifest, MeasurementPrediction,
} from "@aistudy/contracts";
import { CLASSICAL_BKT_PARAMETERS, FREQUENCY_PARAMETERS, predictClassicalBkt, predictSmoothedFrequency } from "./models";

/** Add an approved pure predictor here; HTTP input never selects or loads executable code. */
export type MeasurementPredictorPlugin = {
  readonly manifest: MeasurementModelManifest;
  predict(history: readonly boolean[]): number;
};

const classicalBktPlugin: MeasurementPredictorPlugin = {
  manifest: {
    id: "classical-bkt", version: "1", label: "经典 BKT（未校准）", calibrated: false,
    parameters: { ...CLASSICAL_BKT_PARAMETERS },
  },
  predict: predictClassicalBkt,
};
const smoothedFrequencyPlugin: MeasurementPredictorPlugin = {
  manifest: {
    id: "smoothed-frequency", version: "1", label: "平滑历史正确率（未校准）", calibrated: false,
    parameters: { ...FREQUENCY_PARAMETERS },
  },
  predict: predictSmoothedFrequency,
};

/** Retain old versions here while persisted trials still depend on them. */
export const MEASUREMENT_PLUGINS: readonly MeasurementPredictorPlugin[] = [classicalBktPlugin, smoothedFrequencyPlugin];

/** The defaults for new trials are independent of the versions retained in the registry. */
export const MEASUREMENT_MODELS: MeasurementModelManifest[] = [classicalBktPlugin, smoothedFrequencyPlugin].map(({ manifest }) => ({
  ...manifest, parameters: { ...manifest.parameters },
}));

/** Persisted manifests must still refer to exactly the installed, unchanged model definitions. */
export function resolveMeasurementPlugins(
  models: readonly MeasurementModelManifest[], available: readonly MeasurementPredictorPlugin[] = MEASUREMENT_PLUGINS,
): MeasurementPredictorPlugin[] {
  if (models.length === 0 || new Set(models.map(model => model.id)).size !== models.length) {
    throw new RangeError("Measurement trial requires unique model identities");
  }
  return models.map(model => {
    const matches = available.filter(plugin => plugin.manifest.id === model.id && plugin.manifest.version === model.version);
    const plugin = matches[0];
    const installed = plugin?.manifest;
    if (matches.length !== 1 || !plugin || !installed || model.calibrated !== false ||
      Object.keys(installed.parameters).length !== Object.keys(model.parameters).length ||
      Object.entries(installed.parameters).some(([key, value]) => model.parameters[key] !== value)) {
      throw new RangeError(`Measurement model ${model.id}@${model.version} is unavailable or changed; restore its versioned plugin to continue this trial`);
    }
    return plugin;
  });
}

export function validateMeasurementModels(models: readonly MeasurementModelManifest[]): void {
  resolveMeasurementPlugins(models);
}

/** One reason per row, so the exclusion counts sum to the non-scored attempts. */
export function measurementEligibility(attempt: MeasurementAttempt): string | null {
  if (attempt.retractedAt !== null) return "retracted";
  if (attempt.feedbackWithheld) return "feedback_withheld";
  if (attempt.outcome === "skipped") return "skipped";
  if (attempt.answeredAt === null) return "pending";
  if (attempt.outcome === null) return "missing_outcome";
  if (attempt.helpEvents.length > 0) return "assisted";
  if (!attempt.firstAttempt) return "repeated";
  if (!Number.isFinite(Date.parse(attempt.presentedAt)) || !Number.isFinite(Date.parse(attempt.answeredAt)) ||
    Date.parse(attempt.answeredAt) < Date.parse(attempt.presentedAt)) return "invalid_timing";
  return null;
}

const HOUR_MS = 60 * 60 * 1000;

/** Predeclared protocol windows, not evidence that these windows are optimal for learning. */
export function measurementTimingExclusion(attempt: MeasurementAttempt, history: readonly MeasurementAttempt[]): string | null {
  if (attempt.item.phase === "practice") return null;
  const dueAt = attempt.dueAt === null ? Number.NaN : Date.parse(attempt.dueAt);
  const presentedAt = Date.parse(attempt.presentedAt);
  const answeredAt = attempt.answeredAt === null ? Number.NaN : Date.parse(attempt.answeredAt);
  if (!Number.isFinite(dueAt) || !Number.isFinite(presentedAt) || !Number.isFinite(answeredAt) ||
    presentedAt < dueAt || answeredAt < presentedAt) return "invalid_timing";
  const answerWindow = (attempt.item.phase === "delay_48h" ? 48 : 72) * HOUR_MS;
  if (answeredAt > dueAt + answerWindow) return "late_probe";
  if (attempt.item.phase === "delay_7d" && history.some(prior => {
    if (prior.trialId !== attempt.trialId || prior.item.phase !== "delay_48h" || prior.answeredAt === null) return false;
    const gap = presentedAt - Date.parse(prior.answeredAt);
    // Any recent probe can expose or rehearse content, even when its score was excluded.
    return gap >= 0 && gap < 72 * HOUR_MS;
  })) return "insufficient_retest_gap";
  return null;
}

/** Call before presentation. Never pass the current answer as history. */
export function predictMeasurementPair(input: {
  skillId: string; history: readonly MeasurementAttempt[]; predictedAt: string;
  plugins?: readonly MeasurementPredictorPlugin[];
}): MeasurementPrediction[] {
  const cutoff = Date.parse(input.predictedAt);
  if (!Number.isFinite(cutoff)) throw new RangeError("Prediction time must be a valid instant");
  if (new Set(input.history.map(attempt => attempt.trialId)).size > 1) {
    throw new RangeError("Measurement prediction history must belong to one trial");
  }
  if (new Set(input.history.map(attempt => attempt.id)).size !== input.history.length) {
    throw new RangeError("Measurement prediction history contains duplicate attempts");
  }
  const evidence = input.history.filter(attempt => attempt.item.skillId === input.skillId &&
    measurementEligibility(attempt) === null && measurementTimingExclusion(attempt, input.history) === null &&
    Date.parse(attempt.answeredAt!) <= cutoff)
    .sort((a, b) => Date.parse(a.answeredAt!) - Date.parse(b.answeredAt!) || a.ordinal - b.ordinal);
  const outcomes = evidence.map(attempt => attempt.outcome === "correct");
  const plugins = input.plugins ?? resolveMeasurementPlugins(MEASUREMENT_MODELS);
  if (new Set(plugins.map(plugin => plugin.manifest.id)).size !== plugins.length) throw new RangeError("Duplicate measurement plugins");
  return plugins.map(plugin => {
    const probability = plugin.predict([...outcomes]);
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new RangeError("Measurement plugin returned an invalid probability");
    return {
      modelId: plugin.manifest.id, modelVersion: plugin.manifest.version, probability,
      predictedAt: input.predictedAt, evidenceAttemptIds: evidence.map(attempt => attempt.id),
    };
  });
}

/** Stored forecasts are never recomputed, including after an evidence correction. */
export function predictionPairExclusion(
  attempt: MeasurementAttempt, attemptsById: ReadonlyMap<string, MeasurementAttempt>,
  models: readonly MeasurementModelManifest[],
): string | null {
  const selected: MeasurementPrediction[] = [];
  for (const model of models) {
    const matches = attempt.predictions.filter(prediction => prediction.modelId === model.id && prediction.modelVersion === model.version);
    if (matches.length === 0) return "missing_prediction";
    if (matches.length !== 1) return "invalid_prediction";
    const prediction = matches[0]!;
    if (!Number.isFinite(prediction.probability) || prediction.probability < 0 || prediction.probability > 1) return "invalid_prediction";
    const predictionTime = Date.parse(prediction.predictedAt);
    if (!Number.isFinite(predictionTime) || predictionTime > Date.parse(attempt.presentedAt) ||
      predictionTime > Date.parse(attempt.answeredAt!)) return "prediction_after_presentation";
    if (new Set(prediction.evidenceAttemptIds).size !== prediction.evidenceAttemptIds.length) return "invalid_prediction_history";
    for (const id of prediction.evidenceAttemptIds) {
      const evidence = attemptsById.get(id);
      if (!evidence) return "missing_prediction_history";
      if (evidence.retractedAt !== null) return "invalidated_history";
      if (evidence.trialId !== attempt.trialId || evidence.item.skillId !== attempt.item.skillId ||
        evidence.ordinal >= attempt.ordinal || measurementEligibility(evidence) !== null ||
        measurementTimingExclusion(evidence, [...attemptsById.values()]) !== null ||
        Date.parse(evidence.answeredAt!) > predictionTime) return "invalid_prediction_history";
    }
    selected.push(prediction);
  }
  const first = selected[0];
  if (first && selected.some(prediction => prediction.predictedAt !== first.predictedAt ||
    JSON.stringify(prediction.evidenceAttemptIds) !== JSON.stringify(first.evidenceAttemptIds))) return "unpaired_prediction_history";
  return null;
}
