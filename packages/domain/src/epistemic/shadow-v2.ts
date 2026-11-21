import { compareLearnerShadow } from "../opening/learner-shadow-predictions";

const LEGACY_MODELS = ["classical-bkt", "pfa", "smoothed-frequency"] as const;
const SHADOW_MODELS = [...LEGACY_MODELS, "ts-fsrs", "hsrs-fire-dcm-v1"] as const;
const ABLATIONS = ["no-fire", "no-dcm"] as const;
const PREDICTION_IDS = [...SHADOW_MODELS, ...ABLATIONS] as const;

export type ShadowModelId = typeof SHADOW_MODELS[number];
type AblationId = typeof ABLATIONS[number];

export type ShadowV2Row = {
  observationId: string;
  familyKey: string;
  attemptedAt: string;
  correct: boolean;
  predictions: Readonly<Record<ShadowModelId | AblationId, number>>;
};

export type ShadowV2Input = {
  cutoff: string;
  targetFamilyKeys: readonly string[];
  propagatedFamilyKeys: ReadonlySet<string> | readonly string[];
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
  ablationMetrics: Array<{ id: AblationId; brier: number | null; logLoss: number | null }>;
};

function lossMetrics(rows: readonly ShadowV2Row[], modelId: ShadowModelId | AblationId): Pick<ModelReceipt, "brier" | "logLoss"> {
  if (!rows.length) return { brier: null, logLoss: null };
  let brier = 0;
  let logLoss = 0;
  for (const row of rows) {
    const p = row.predictions[modelId];
    const clipped = Math.max(1e-15, Math.min(1 - 1e-15, p));
    brier += (p - Number(row.correct)) ** 2;
    logLoss -= row.correct ? Math.log(clipped) : Math.log1p(-clipped);
  }
  return { brier: brier / rows.length, logLoss: logLoss / rows.length };
}

function metrics(rows: readonly ShadowV2Row[], modelId: ShadowModelId, threshold: number, baseline: Pick<ModelReceipt, "brier" | "logLoss">): ModelReceipt {
  const { brier, logLoss } = lossMetrics(rows, modelId);
  const bins = Array.from({ length: 10 }, () => [] as ShadowV2Row[]);
  for (const row of rows) bins[Math.min(9, Math.floor(row.predictions[modelId] * 10))]!.push(row);
  const ece = rows.length ? bins.reduce((sum, bin) => {
    if (!bin.length) return sum;
    const confidence = bin.reduce((total, row) => total + row.predictions[modelId], 0) / bin.length;
    const accuracy = bin.filter(row => row.correct).length / bin.length;
    return sum + bin.length / rows.length * Math.abs(confidence - accuracy);
  }, 0) : null;
  const above = rows.filter(row => row.predictions[modelId] >= threshold);
  return {
    modelId, count: rows.length, brier, logLoss, ece,
    brierDelta: brier == null || baseline.brier == null ? null : brier - baseline.brier,
    logLossDelta: logLoss == null || baseline.logLoss == null ? null : logLoss - baseline.logLoss,
    failureRateAboveThreshold: above.length ? above.filter(row => !row.correct).length / above.length : null,
  };
}

export function evaluateShadowV2Holdout(input: ShadowV2Input): ShadowV2Receipt {
  const cutoffMs = Date.parse(input.cutoff);
  if (!Number.isFinite(cutoffMs)) throw new RangeError("Invalid shadow v2 cutoff");
  if (input.propagatedFamilyKeys == null) throw new RangeError("Propagated family keys are required");
  const excluded = new Set([...input.targetFamilyKeys, ...input.propagatedFamilyKeys]);

  const rows = input.rows.filter(row => {
    const attemptMs = Date.parse(row.attemptedAt);
    if (!Number.isFinite(attemptMs)) throw new RangeError("Invalid shadow v2 attempt timestamp");
    for (const modelId of PREDICTION_IDS) {
      const prediction = row.predictions[modelId];
      if (!Number.isFinite(prediction) || prediction < 0 || prediction > 1) throw new RangeError("Invalid persisted shadow v2 prediction");
    }
    return attemptMs < cutoffMs && !excluded.has(row.familyKey);
  });

  const threshold = input.advanceThreshold ?? 0.8;
  const pairedSummary = compareLearnerShadow(rows.map(row => ({
    predictions: LEGACY_MODELS.map(modelId => ({
      modelId, modelVersion: "1", calibrated: false, probability: row.predictions[modelId], parameters: {},
    })),
    correct: row.correct,
    familyKey: row.familyKey,
    predictedAt: row.attemptedAt,
  })), { advanceThreshold: threshold });
  const baseline = pairedSummary.models.find(model => model.modelId === "classical-bkt")!;

  return {
    schemaVersion: 2, engineId: "hsrs-fire-dcm-v1", cutoff: input.cutoff, count: rows.length,
    excludedFamilyKeys: [...excluded],
    models: SHADOW_MODELS.map(modelId => metrics(rows, modelId, threshold, baseline)),
    ablation: [...ABLATIONS],
    ablationMetrics: ABLATIONS.map(id => ({ id, ...lossMetrics(rows, id) })),
  };
}
