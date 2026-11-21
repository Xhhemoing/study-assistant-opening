import {
  effectiveRetrievability,
  retrievability,
  withBeliefBounds,
  type SkillBeliefV1,
} from "./belief";

export const GAUSS_HERMITE_3 = [
  { offset: -1, weight: 1 / 6 },
  { offset: 0, weight: 2 / 3 },
  { offset: 1, weight: 1 / 6 },
] as const;

export type MisconceptionSpec = { id: string; delta: number };
export type SkillItemModel = {
  itemId: string;
  a: number;
  b: number;
  g: number;
  l: number;
  misconceptions?: readonly MisconceptionSpec[];
};

export type EvidenceObservation = {
  outcome: boolean;
  channel?: "unassisted" | "hinted" | "distractor" | "step-failure";
  misconceptionId?: string;
  powerWeight?: number;
  isFreshFamily?: boolean;
  sameItemRepeat?: boolean;
  sameFamilyClone?: boolean;
  hintsOrExposures?: boolean;
  localizedStepFailure?: boolean;
  retrievalProbability?: number;
  misconceptionLikelihoodRatio?: number;
};

export type BeliefEvidenceUpdate = {
  belief: SkillBeliefV1;
  directRetrievability: number;
  effectiveRetrievability: number;
  retrievedProbability: number;
  posteriorMass: ReadonlyArray<readonly [string, number]>;
  prerequisiteInspectionWeights: ReadonlyArray<readonly [string, number]>;
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const sigmoid = (value: number): number => {
  if (value >= 0) { const e = Math.exp(-value); return 1 / (1 + e); }
  const e = Math.exp(value); return e / (1 + e);
};
const safeProbability = (value: number): number => clamp(Number.isFinite(value) ? value : 0.5, 1e-15, 1 - 1e-15);

export function logSumExp(values: readonly number[]): number {
  if (!values.length) return -Infinity;
  const maximum = Math.max(...values);
  if (!Number.isFinite(maximum)) return maximum;
  return maximum + Math.log(values.reduce((sum, value) => sum + Math.exp(value - maximum), 0));
}

export function conditionalSuccessProbability(item: SkillItemModel, theta: number, misconceptionDelta = 0): number {
  const a = Number.isFinite(item.a) ? item.a : 1;
  const g = clamp(item.g, 0, 1);
  const l = clamp(item.l, 0, 1 - g);
  return clamp(g + (1 - g - l) * sigmoid(a * (theta - item.b) - misconceptionDelta), 1e-12, 1 - 1e-12);
}

function statePriors(belief: SkillBeliefV1, item: SkillItemModel): Array<{ id: string; prior: number; delta: number }> {
  const masses = new Map(belief.misconceptionMass);
  const itemDeltas = new Map((item.misconceptions ?? []).map(row => [row.id, row.delta] as const));
  const ids = new Set([...(item.misconceptions ?? []).map(row => row.id), ...masses.keys()]);
  return [
    { id: "__none__", prior: belief.otherMass, delta: 0 },
    ...[...ids].map(id => ({ id, prior: masses.get(id) ?? 1e-12, delta: itemDeltas.get(id) ?? 0 })),
  ];
}

export function posteriorMisconceptionMass(input: {
  priorMass: number;
  likelihoodRatio: number;
}): number {
  const prior = clamp(input.priorMass, 1e-15, 1 - 1e-15);
  const ratio = Math.max(0, input.likelihoodRatio);
  return prior * ratio / (prior * ratio + (1 - prior));
}

export function updateBeliefWithEvidence(input: {
  belief: SkillBeliefV1;
  item: SkillItemModel;
  observation: EvidenceObservation;
  atMs: number;
  familyPrior?: number;
  etaPlus?: number;
  etaMinus?: number;
  bounds?: { varianceMin?: number; varianceMax?: number; logStabilityMin?: number; logStabilityMax?: number };
}): BeliefEvidenceUpdate {
  const { belief, item, observation } = input;
  const direct = retrievability(belief, input.atMs, { familyPrior: input.familyPrior });
  const effective = effectiveRetrievability(belief, input.atMs, { familyPrior: input.familyPrior });
  const retrieval = clamp(observation.retrievalProbability ?? direct, 0, 1);
  const weight = clamp(observation.powerWeight ?? 1, 0, 1);
  const states = statePriors(belief, item);
  const nodes = GAUSS_HERMITE_3.map(node => ({ theta: belief.abilityMean + Math.sqrt(3 * belief.abilityVariance) * node.offset, weight: node.weight }));
  const terms: Array<{ state: string; theta: number; logWeight: number; retrieval: number }> = [];
  for (const state of states) {
    for (const node of nodes) {
      const q = conditionalSuccessProbability(item, node.theta, state.delta);
      const passLikelihood = observation.outcome ? q : 1 - q;
      const baseLikelihood = safeProbability(retrieval * passLikelihood + (1 - retrieval) * (observation.outcome ? 0.25 : 0.75));
      const curatedRatio = observation.misconceptionId === state.id && observation.channel === "distractor"
        ? Math.max(1, observation.misconceptionLikelihoodRatio ?? 8) : 1;
      terms.push({ state: state.id, theta: node.theta, logWeight: Math.log(node.weight) + Math.log(state.prior) + weight * Math.log(safeProbability(baseLikelihood * curatedRatio)), retrieval });
    }
  }
  const denominator = logSumExp(terms.map(term => term.logWeight));
  const responsibilities = terms.map(term => ({ ...term, responsibility: Math.exp(term.logWeight - denominator) }));
  const statePosterior = new Map<string, number>();
  let abilityMean = 0;
  for (const term of responsibilities) {
    statePosterior.set(term.state, (statePosterior.get(term.state) ?? 0) + term.responsibility);
    abilityMean += term.responsibility * term.theta;
  }
  if (observation.channel === "distractor" && observation.misconceptionId) {
    const target = states.find(state => state.id === observation.misconceptionId);
    if (target) {
      const ratio = Math.max(1, observation.misconceptionLikelihoodRatio ?? 8);
      const targetMass = posteriorMisconceptionMass({ priorMass: target.prior, likelihoodRatio: ratio });
      const currentTarget = statePosterior.get(target.id) ?? 0;
      const remainder = Math.max(0, 1 - currentTarget);
      const scale = remainder > 0 ? (1 - targetMass) / remainder : 0;
      for (const [id, mass] of statePosterior) statePosterior.set(id, id === target.id ? targetMass : mass * scale);
    }
  }
  const abilityVariance = responsibilities.reduce((sum, term) => sum + term.responsibility * (term.theta - abilityMean) ** 2, 0);
  const misconceptionMass = states.filter(state => state.id !== "__none__").map(state => [state.id, statePosterior.get(state.id) ?? 1e-12] as const);
  const otherMass = Math.max(1e-12, statePosterior.get("__none__") ?? 1e-12);
  const channel = observation.channel ?? "unassisted";
  let updated = withBeliefBounds(belief, { abilityMean, abilityVariance, misconceptionMass, otherMass }, input.bounds);
  if (channel === "unassisted" && observation.outcome && observation.isFreshFamily === true && !observation.sameItemRepeat && !observation.sameFamilyClone && !observation.hintsOrExposures) {
    const eta = input.etaPlus ?? 0.25;
    updated = withBeliefBounds(updated, { logStability: updated.logStability + eta * retrieval * (1 - direct), lastDirectRecallAtMs: input.atMs, implicitLogCredit: 0 }, input.bounds);
  } else if (channel === "distractor" || channel === "step-failure") {
    const eta = input.etaMinus ?? 0.25;
    const decay = eta * Math.max(0, (1 - retrieval) - (1 - direct));
    updated = withBeliefBounds(updated, { logStability: updated.logStability - decay, implicitLogCredit: 0 }, input.bounds);
  } else if (channel === "hinted") {
    updated = belief;
  }
  return {
    belief: updated,
    directRetrievability: direct,
    effectiveRetrievability: effective,
    retrievedProbability: retrieval,
    posteriorMass: [...statePosterior.entries()].map(([id, mass]) => [id, mass] as const),
    prerequisiteInspectionWeights: [],
  };
}
