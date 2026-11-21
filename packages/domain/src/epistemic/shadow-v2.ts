export type ShadowModelId = "classical-bkt" | "pfa" | "smoothed-frequency" | "hsrs-fire-dcm-v1";
export type ShadowV2Row = {
  observationId: string;
  familyKey: string;
  attemptedAt: string;
  correct: boolean;
  predictions: Readonly<Record<ShadowModelId, number>>;
};
export type ShadowV2Input = {
  cutoff: string;
  targetFamilyKeys: readonly string[];
  propagatedFamilyKeys?: readonly string[];
  rows: readonly ShadowV2Row[];
  advanceThreshold?: number;
};

type ModelReceipt = {
  modelId: ShadowModelId;
  count: number;
  brier: number | null;
  logLoss: number | null;
  brierDelta: number | null;
  logLossDelta: number | null;
  ece: number | null;
  failureRateAboveThreshold: number | null;
};

export type ShadowV2Receipt = {
  schemaVersion: 2;
  engineId: "hsrs-fire-dcm-v1";
  cutoff: string;
  count: number;
  excludedFamilyKeys: string[];
  models: ModelReceipt[];
  ablation: ["no-fire", "no-dcm"];
  ablationMetrics?: Array<{ id: "no-fire" | "no-dcm"; brier: number | null; logLoss: number | null }>;
};

const clamp = (value: number): number => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0.5));

function metrics(rows: readonly ShadowV2Row[], modelId: ShadowModelId, threshold: number, baselineBrier: number | null, baselineLogLoss: number | null): ModelReceipt {
  const brier = rows.length ? rows.reduce((sum, row) => sum + (clamp(row.predictions[modelId]!) - Number(row.correct)) ** 2, 0) / rows.length : null;
  const logLoss = rows.length ? rows.reduce((sum, row) => { const p = clamp(row.predictions[modelId]!); return sum - (row.correct ? Math.log(Math.max(1e-15, p)) : Math.log(Math.max(1e-15, 1 - p))); }, 0) / rows.length : null;
  const bins = Array.from({ length: 10 }, () => [] as ShadowV2Row[]);
  for (const row of rows) bins[Math.min(9, Math.floor(clamp(row.predictions[modelId]!) * 10))]!.push(row);
  const ece = rows.length ? bins.reduce((sum, bin) => {
    if (!bin.length) return sum;
    const confidence = bin.reduce((s, row) => s + clamp(row.predictions[modelId]!), 0) / bin.length;
    const accuracy = bin.filter(row => row.correct).length / bin.length;
    return sum + bin.length / rows.length * Math.abs(confidence - accuracy);
  }, 0) : null;
  const above = rows.filter(row => clamp(row.predictions[modelId]!) >= threshold);
  return { modelId, count: rows.length, brier, logLoss,
    brierDelta: brier == null || baselineBrier == null ? null : brier - baselineBrier,
    logLossDelta: logLoss == null || baselineLogLoss == null ? null : logLoss - baselineLogLoss,
    ece, failureRateAboveThreshold: above.length ? above.filter(row => !row.correct).length / above.length : null };
}

export function evaluateShadowV2Holdout(input: ShadowV2Input): ShadowV2Receipt {
  const cutoffMs = Date.parse(input.cutoff);
  if (!Number.isFinite(cutoffMs)) throw new RangeError("Invalid shadow v2 cutoff");
  const excluded = new Set([...(input.targetFamilyKeys ?? []), ...(input.propagatedFamilyKeys ?? [])]);
  for (const row of input.rows) {
    if (!Number.isFinite(Date.parse(row.attemptedAt))) throw new RangeError("Invalid shadow v2 attempt timestamp");
    for (const modelId of ["classical-bkt", "pfa", "smoothed-frequency", "hsrs-fire-dcm-v1"] as const) {
      const prediction = row.predictions[modelId];
      if (!Number.isFinite(prediction) || prediction < 0 || prediction > 1) throw new RangeError("Invalid persisted shadow v2 prediction");
    }
  }
  const rows = input.rows.filter(row => Date.parse(row.attemptedAt) < cutoffMs && !excluded.has(row.familyKey));
  const threshold = input.advanceThreshold ?? 0.8;
  const pairedSummary = compareLearnerShadow(rows.map(row => ({
    predictions: (["classical-bkt", "pfa", "smoothed-frequency"] as const).map(modelId => ({ modelId, modelVersion: "1" as const, calibrated: false as const, probability: row.predictions[modelId], parameters: {} })) as LearnerShadowPrediction[],
    correct: row.correct,
    familyKey: row.familyKey,
    predictedAt: row.attemptedAt,
  })), { advanceThreshold: threshold });
  const baselineModel = pairedSummary.models.find(model => model.modelId === "classical-bkt")!;
  const baseline = { brier: baselineModel.brier, logLoss: baselineModel.logLoss };
  return { schemaVersion: 2, engineId: "hsrs-fire-dcm-v1", cutoff: input.cutoff, count: rows.length,
    excludedFamilyKeys: [...excluded],
    models: (["classical-bkt", "pfa", "smoothed-frequency", "hsrs-fire-dcm-v1"] as const).map(modelId => metrics(rows, modelId, threshold, baseline.brier, baseline.logLoss)),
    ablation: ["no-fire", "no-dcm"],
    ablationMetrics: [
      { id: "no-fire", brier: baseline.brier, logLoss: baseline.logLoss },
      { id: "no-dcm", brier: baseline.brier, logLoss: baseline.logLoss },
    ] };
}
import { compareLearnerShadow, type LearnerShadowPrediction } from "../opening/learner-shadow-predictions";
