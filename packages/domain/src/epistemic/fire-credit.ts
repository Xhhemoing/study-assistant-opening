import {
  effectiveRetrievability,
  retrievability,
  withBeliefBounds,
  type SkillBeliefV1,
} from "./belief";
import {
  conditionalSuccessProbability,
  updateBeliefWithEvidence,
  type BeliefEvidenceUpdate,
  type EvidenceChannel,
  type EvidenceObservation,
  type SkillItemModel,
} from "./gauss-hermite";

export type { EvidenceChannel } from "./gauss-hermite";

export function deriveSessionScaffoldingAbility(input: {
  belief: SkillBeliefV1;
  item: SkillItemModel;
  atMs: number;
  retryIndex?: number;
  etaH?: number;
  hMax?: number;
  tauHMs?: number;
}): number {
  const delta = input.belief.lastDirectRecallAtMs == null ? 0 : Math.max(0, input.atMs - input.belief.lastDirectRecallAtMs);
  const q = conditionalSuccessProbability(input.item, input.belief.abilityMean);
  const retry = Math.min(1, Math.max(0, input.retryIndex ?? 0) / 2);
  const credit = Math.min(input.hMax ?? 0.5, (input.etaH ?? 0.5) * (1 - q) * (1 - Math.exp(-retry)) * Math.exp(-delta / (input.tauHMs ?? 3 * 60 * 60 * 1000)));
  return input.belief.abilityMean + credit;
}

export function applyEvidenceChannel({ belief, item, atMs, ...observation }: EvidenceObservation & {
  belief: SkillBeliefV1;
  channel: EvidenceChannel;
  atMs: number;
  item: SkillItemModel;
}): Pick<BeliefEvidenceUpdate, "belief" | "directRetrievability" | "posteriorMass"> {
  const result = updateBeliefWithEvidence({ belief, item, observation, atMs });
  return { belief: result.belief, directRetrievability: result.directRetrievability, posteriorMass: result.posteriorMass };
}

export function prerequisiteInspectionWeights(input: {
  localizedFailures: readonly { skillId: string; likelihoodRatio: number; h: number }[];
  kappa?: number;
}): ReadonlyArray<readonly [string, number]> {
  const weighted = input.localizedFailures.map(row => [row.skillId, Math.max(0, row.likelihoodRatio - 1) * Math.max(0, row.h)] as const);
  const total = weighted.reduce((sum, [, value]) => sum + value, 0);
  if (!(total > 0)) return [];
  const kappa = Math.max(0, input.kappa ?? 1);
  return weighted.map(([id, value]) => [id, value / (kappa + total)] as const);
}

export type FireTarget = {
  belief: SkillBeliefV1;
  edgeWeight: number;
  covered: boolean;
  stepPassed: boolean;
  activeMandatoryRetest?: boolean;
  recentLapse?: boolean;
};

export function propagateFireCredit(input: {
  sourceSkillId: string;
  attemptId: string;
  atMs: number;
  source: SkillBeliefV1;
  targets: Readonly<Record<string, FireTarget>>;
  rhoPlus?: number;
  etaEncompassing?: number;
  minimumRetrievability?: number;
  seenAttemptIds?: readonly string[];
}): { targets: Record<string, FireTarget>; propagatedSkillIds: string[] } {
  const result: Record<string, FireTarget> = {};
  const propagatedSkillIds: string[] = [];
  const duplicate = input.seenAttemptIds?.includes(input.attemptId) ?? false;
  for (const [skillId, target] of Object.entries(input.targets)) {
    const direct = retrievability(target.belief, input.atMs);
    const gated = !duplicate && target.edgeWeight > 0 && target.edgeWeight <= 1 && target.covered && target.stepPassed
      && target.belief.lastDirectRecallAtMs != null && !target.activeMandatoryRetest && !target.recentLapse && direct >= (input.minimumRetrievability ?? 0.1);
    if (!gated) { result[skillId] = target; continue; }
    const increment = target.edgeWeight * (input.etaEncompassing ?? 0.2) * Math.min(1, Math.max(0, input.rhoPlus ?? 1)) * (1 - direct);
    result[skillId] = { ...target, belief: withBeliefBounds(target.belief, { implicitLogCredit: Math.min(Math.log(1.2), target.belief.implicitLogCredit + increment) }) };
    propagatedSkillIds.push(skillId);
  }
  return { targets: result, propagatedSkillIds };
}

export { effectiveRetrievability };
