import type { LearnerStateFeature } from "./learner-state";
import { predictClassicalBkt, predictSmoothedFrequency, CLASSICAL_BKT_PARAMETERS } from "./measurement/models";
import { isAiGradedEvidence } from "./ai-evaluation";
import { computeCardRetrievability, createInitialState, scheduleReview } from "../srs/scheduler";
import { effectiveRetrievability, retrievability, type SkillBeliefV1 } from "../epistemic/belief";
import { conditionalSuccessProbability, GAUSS_HERMITE_3, type SkillItemModel } from "../epistemic/gauss-hermite";
import type { ShadowV2Row } from "../epistemic/shadow-v2";

/** Predeclared experiment threshold, not fitted or calibrated for a learner. */
export const LEARNER_SHADOW_ADVANCE_THRESHOLD = 0.8;
export const LEARNER_PFA_PARAMETERS = { intercept: -0.8, success: 0.45, failure: -0.35 } as const;
export type LearnerShadowPrediction = { modelId: "classical-bkt" | "pfa" | "smoothed-frequency"; modelVersion: "1";
  calibrated: false; probability: number; parameters: Record<string, number> };

/** Only comparable, independently verified, current-version binary evidence enters these unfitted models. */
export function predictLearnerShadow(input: { features: readonly LearnerStateFeature[]; courseId: string;
  requirementKey: string; cutoff: string; excludedProblemIds: readonly string[] }) {
  const cutoff = Date.parse(input.cutoff);
  if (!Number.isFinite(cutoff)) throw new RangeError("Invalid shadow prediction cutoff");
  const eligible = input.features.filter(row => row.courseId === input.courseId && row.requirementKey === input.requirementKey
    && row.eligibility.independentAttempt === "yes" && row.eligibility.usableForCurrentVersion === "yes"
    && row.eligibility.verifiedCorrect !== "unknown" && Date.parse(row.attemptedAt) < cutoff
    // AI feedback guides practice, but is not calibration truth for another model.
    && !isAiGradedEvidence(row.eligibility)
    && (row.recordedAt == null || Date.parse(row.recordedAt) < cutoff)
    && !input.excludedProblemIds.includes(row.observationId));
  const ordered = [...eligible].sort((a, b) => Date.parse(a.attemptedAt) - Date.parse(b.attemptedAt) || a.observationId.localeCompare(b.observationId));
  const outcomes = ordered.map(row => row.eligibility.verifiedCorrect === "yes");
  const success = outcomes.filter(Boolean).length, failure = outcomes.length - success;
  const pfa = 1 / (1 + Math.exp(-(LEARNER_PFA_PARAMETERS.intercept + LEARNER_PFA_PARAMETERS.success * success + LEARNER_PFA_PARAMETERS.failure * failure)));
  const predictions: LearnerShadowPrediction[] = [
    { modelId: "classical-bkt", modelVersion: "1", calibrated: false, probability: predictClassicalBkt(outcomes), parameters: { ...CLASSICAL_BKT_PARAMETERS } },
    { modelId: "pfa", modelVersion: "1", calibrated: false, probability: pfa, parameters: { ...LEARNER_PFA_PARAMETERS } },
    { modelId: "smoothed-frequency", modelVersion: "1", calibrated: false, probability: predictSmoothedFrequency(outcomes), parameters: { priorCorrect: 1, priorIncorrect: 1 } },
  ];
  return { predictions, evidenceObservationIds: ordered.map(row => row.observationId), success, failure };
}

/** Comparison is descriptive and paired on exactly the same held-out answers, never a mastery update. */
export function compareLearnerShadow(rows: readonly { predictions: LearnerShadowPrediction[]; correct: boolean; familyKey: string; predictedAt: string }[], options: { advanceThreshold?: number } = {}) {
  const advanceThreshold = options.advanceThreshold ?? LEARNER_SHADOW_ADVANCE_THRESHOLD;
  if (!Number.isFinite(advanceThreshold) || advanceThreshold < 0 || advanceThreshold > 1) throw new RangeError("Invalid predeclared advance threshold");
  const ids = ["classical-bkt", "pfa", "smoothed-frequency"] as const;
  for (const row of rows) {
    if (!Array.isArray(row.predictions) || row.predictions.length !== ids.length
      || ids.some(id => row.predictions.filter(p => p.modelId === id).length !== 1)
      || row.predictions.some(prediction => prediction.modelVersion !== "1" || prediction.calibrated !== false
        || !Number.isFinite(prediction.probability) || prediction.probability < 0 || prediction.probability > 1)) {
      throw new RangeError("Invalid persisted shadow prediction pair");
    }
  }
  const paired = rows;
  return { mode: "shadow" as const, calibrated: false as const, count: paired.length,
    families: [...new Set(paired.map(row => row.familyKey))], cutoff: paired.map(row => row.predictedAt).sort().at(-1) ?? null,
    advanceThreshold, thresholdPolicyVersion: "shadow-advance-threshold-v1" as const,
    models: ids.map(modelId => {
      const aboveThreshold = paired.filter(row => row.predictions.find(p => p.modelId === modelId)!.probability >= advanceThreshold);
      const failedAboveThreshold = aboveThreshold.filter(row => !row.correct).length;
      return { modelId, count: paired.length, aboveThresholdCount: aboveThreshold.length, failedAboveThreshold,
      failureRateAboveThreshold: aboveThreshold.length ? failedAboveThreshold / aboveThreshold.length : null,
      brier: paired.length ? paired.reduce((sum, row) => sum + (row.predictions.find(p => p.modelId === modelId)!.probability - Number(row.correct)) ** 2, 0) / paired.length : null,
      logLoss: paired.length ? paired.reduce((sum, row) => { const p = Math.max(1e-15, Math.min(1 - 1e-15, row.predictions.find(p => p.modelId === modelId)!.probability));
        return sum - (row.correct ? Math.log(p) : Math.log1p(-p)); }, 0) / paired.length : null }; }) };
}

function epistemicSuccess(belief: SkillBeliefV1, item: SkillItemModel, recall: number): number {
  const deltas = new Map(item.misconceptions?.map(({ id, delta }) => [id, delta]));
  const scale = Math.sqrt(3 * belief.abilityVariance);
  const probability = GAUSS_HERMITE_3.reduce((sum, { weight, offset }) => {
    const theta = belief.abilityMean + scale * offset;
    const success = belief.misconceptionMass.reduce((total, [id, mass]) =>
      total + mass * conditionalSuccessProbability(item, theta, deltas.get(id) ?? 0),
    belief.otherMass * conditionalSuccessProbability(item, theta));
    return sum + weight * success;
  }, 0);
  // Match the outcome model used by updateBeliefWithEvidence on a no-recall branch.
  return recall * probability + (1 - recall) * 0.25;
}

/** Scores a forecast from a replay that has already enforced the v2 evidence boundary. */
export function scoreLearnerShadowV2(input: {
  features: readonly LearnerStateFeature[]; courseId: string; requirementKey: string; cutoff: string;
  belief: SkillBeliefV1; noDcmBelief: SkillBeliefV1; item: SkillItemModel;
}): ShadowV2Row["predictions"] {
  const { belief, noDcmBelief, item, cutoff } = input;
  const at = new Date(cutoff);
  const { predictions } = predictLearnerShadow({ ...input, excludedProblemIds: [] });
  // Binary verified attempts map to Good/Again on a shadow skill card, using the existing FSRS engine.
  const first = input.features[0];
  const card = first ? input.features.reduce((state, row) => scheduleReview(state,
    row.eligibility.verifiedCorrect === "yes" ? "good" : "again", new Date(row.attemptedAt)),
  createInitialState(input.requirementKey, new Date(first.attemptedAt))) : null;
  return {
    "classical-bkt": predictions[0]!.probability,
    pfa: predictions[1]!.probability,
    "smoothed-frequency": predictions[2]!.probability,
    "ts-fsrs": (card && computeCardRetrievability(card, at).retrievability) ?? 0.5,
    "hsrs-fire-dcm-v1": epistemicSuccess(belief, item, effectiveRetrievability(belief, at.getTime())),
    "no-fire": epistemicSuccess(belief, item, retrievability(belief, at.getTime())),
    "no-dcm": epistemicSuccess(noDcmBelief, { ...item, misconceptions: undefined }, effectiveRetrievability(noDcmBelief, at.getTime())),
  };
}
