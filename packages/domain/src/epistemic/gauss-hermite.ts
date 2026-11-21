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

export type EvidenceChannel = "unassisted" | "hinted" | "assisted" | "multi-draft" | "distractor" | "step-failure";

export type EvidenceObservation = {
  outcome: boolean;
  channel?: EvidenceChannel;
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
  const maximum = values.reduce((max, value) => Math.max(max, value), -Infinity);
  if (!Number.isFinite(maximum)) return maximum;
  return maximum + Math.log(values.reduce((sum, value) => sum + Math.exp(value - maximum), 0));
}

export function conditionalSuccessProbability(item: SkillItemModel, theta: number, misconceptionDelta = 0): number {
  const a = Number.isFinite(item.a) ? item.a : 1;
  const g = clamp(item.g, 0, 1);
  const l = clamp(item.l, 0, 1 - g);
  return clamp(g + (1 - g - l) * sigmoid(a * (theta - item.b) - misconceptionDelta), 1e-12, 1 - 1e-12);
}

function statePriors(belief: SkillBeliefV1, item: SkillItemModel): Array<{ id: string | null; prior: number; delta: number }> {
  const masses = new Map(belief.misconceptionMass);
  const itemDeltas = new Map((item.misconceptions ?? []).map(row => [row.id, row.delta] as const));
  const ids = new Set([...(item.misconceptions ?? []).map(row => row.id), ...masses.keys()]);
  return [
    { id: null, prior: belief.otherMass, delta: 0 },
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
  const override = observation.retrievalProbability;
  const retrieval = override !== undefined && Number.isFinite(override) ? clamp(override, 0, 1) : direct;
  const channel = observation.channel ?? "unassisted";
  const power = observation.powerWeight ?? 1;
  const weight = Number.isFinite(power) ? clamp(power, 0, 1) : 0;
  const noEvidence = channel === "hinted" || channel === "assisted" || channel === "multi-draft" || observation.hintsOrExposures;
  if (noEvidence || weight === 0) {
    return {
      belief,
      directRetrievability: direct,
      effectiveRetrievability: effective,
      retrievedProbability: retrieval,
      posteriorMass: [["__none__", belief.otherMass], ...belief.misconceptionMass],
      prerequisiteInspectionWeights: [],
    };
  }

  const states = statePriors(belief, item);
  const scale = Math.sqrt(3 * belief.abilityVariance);
  const nodes = GAUSS_HERMITE_3.map(node => ({ theta: belief.abilityMean + scale * node.offset, weight: node.weight }));
  const diagnosticTarget = !observation.outcome && (channel === "distractor" || channel === "step-failure")
    ? observation.misconceptionId : undefined;
  const ratio = observation.misconceptionLikelihoodRatio ?? 8;
  const diagnosticLogRatio = Math.log(Number.isFinite(ratio) ? Math.max(1, ratio) : 8);
  const guessLikelihood = observation.outcome ? 0.25 : 0.75;

  const terms = states.flatMap((state, stateIndex) => {
    const logRatio = state.id === diagnosticTarget ? diagnosticLogRatio : 0;
    return nodes.map(node => {
      const success = safeProbability(conditionalSuccessProbability(item, node.theta, state.delta));
      const retrievedLikelihood = retrieval * (observation.outcome ? success : 1 - success);
      const likelihood = retrievedLikelihood + (1 - retrieval) * guessLikelihood;
      return {
        stateIndex,
        theta: node.theta,
        logWeight: Math.log(state.prior) + Math.log(node.weight) + weight * (Math.log(likelihood) + logRatio),
        // The state-specific likelihood ratio multiplies both retrieval branches and cancels here.
        retrievedGivenOutcome: retrievedLikelihood / likelihood,
      };
    });
  });

  const denominator = logSumExp(terms.map(term => term.logWeight));
  const responsibilities = terms.map(term => Math.exp(term.logWeight - denominator));
  const statePosterior = new Float64Array(states.length);
  let abilityMean = 0;
  let posteriorRetrieval = 0;
  for (const [index, term] of terms.entries()) {
    const responsibility = responsibilities[index]!;
    statePosterior[term.stateIndex] = statePosterior[term.stateIndex]! + responsibility;
    abilityMean += responsibility * term.theta;
    posteriorRetrieval += responsibility * term.retrievedGivenOutcome;
  }
  const abilityVariance = terms.reduce((sum, term, i) => sum + responsibilities[i]! * (term.theta - abilityMean) ** 2, 0);
  const otherMass = statePosterior[0]!;
  const misconceptionMass = states.slice(1).map((state, index) => [state.id!, statePosterior[index + 1]!] as const);
  const rho = clamp(posteriorRetrieval, 0, 1);

  let logStability = belief.logStability;
  let implicitLogCredit = belief.implicitLogCredit;
  let lastDirectRecallAtMs = belief.lastDirectRecallAtMs;
  if (!observation.outcome) {
    // Even a lapse at certain retrieval supplies weak evidence against stability.
    logStability -= Math.max(0, input.etaMinus ?? 0.25) * weight * Math.max(1e-6, 1 - rho);
    implicitLogCredit = 0;
  } else if (channel === "unassisted" && observation.isFreshFamily === true && !observation.sameItemRepeat
    && !observation.sameFamilyClone && Number.isFinite(input.atMs) && rho > 0) {
    logStability += Math.max(0, input.etaPlus ?? 0.25) * weight * rho * (1 - direct);
    lastDirectRecallAtMs = input.atMs;
    implicitLogCredit = 0;
  }

  return {
    belief: withBeliefBounds(belief, {
      abilityMean, abilityVariance, misconceptionMass, otherMass, logStability, implicitLogCredit, lastDirectRecallAtMs,
    }, input.bounds),
    directRetrievability: direct,
    effectiveRetrievability: effective,
    retrievedProbability: rho,
    posteriorMass: [["__none__", otherMass], ...misconceptionMass],
    prerequisiteInspectionWeights: [],
  };
}
