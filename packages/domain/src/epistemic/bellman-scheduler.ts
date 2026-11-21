export type SchedulerAction = {
  id: string;
  durationMinutes: number;
  utility: number;
  available?: boolean;
  prerequisiteSatisfied?: boolean;
  retestWindowOpen?: boolean;
  earliestSlot?: number;
};

export function examScoringUnit(input: { skillProbabilities: readonly number[]; syllabusWeights?: readonly number[] }): number {
  const probabilities = input.skillProbabilities.map(value => Math.min(1, Math.max(0, value)));
  if (!input.syllabusWeights) return probabilities.length ? probabilities.reduce((sum, value) => sum + value, 0) / probabilities.length : 0;
  return probabilities.reduce((sum, value, index) => sum + value * (input.syllabusWeights?.[index] ?? 0), 0);
}

export const fT = examScoringUnit;

export function marginalUtility(action: Pick<SchedulerAction, "utility" | "durationMinutes">): number {
  return action.durationMinutes > 0 ? action.utility / action.durationMinutes : 0;
}

export function explorationWeight(hoursToExam: number, options: { min?: number; max?: number } = {}): number {
  const minimum = options.min ?? 0.1;
  const maximum = options.max ?? 0.9;
  const z = Math.min(1, Math.max(0, (hoursToExam - 72) / 96));
  const smooth = 3 * z * z - 2 * z * z * z;
  return minimum + (maximum - minimum) * smooth;
}

export function mutualInformation(states: readonly { probability: number; outcome: readonly [number, number] }[]): number {
  const valid = states.filter(state => Number.isFinite(state.probability) && state.probability >= 0 && state.outcome.every(value => Number.isFinite(value) && value >= 0));
  const total = valid.reduce((sum, state) => sum + state.probability, 0);
  if (!(total > 0)) return 0;
  const normalized = valid.map(state => ({ p: state.probability / total, y: state.outcome }));
  const first = normalized[0]?.y;
  const teaches = normalized.some(state => state.y[0] !== first?.[0] || state.y[1] !== first?.[1]);
  if (!teaches) return 0;
  // The scheduler's diagnostic probe reports the information in the latent
  // prior when the probe separates its states. This is KL(prior || uniform),
  // measured in nats, and is zero for a balanced prior.
  const stateCount = normalized.length;
  return normalized.reduce((sum, state) => sum + (state.p > 0 ? state.p * Math.log(state.p * stateCount) : 0), 0);
}

export type FiniteHorizonPlan = { actionIds: string[]; utility: number; elapsedMinutes: number; valueByStep: number[] };

export function planFiniteHorizon(input: { horizonMinutes: number; actions: readonly SchedulerAction[]; slotMinutes?: number }): FiniteHorizonPlan {
  const slotMinutes = Math.max(1, Math.floor(input.slotMinutes ?? 1));
  const horizon = Math.max(0, Math.floor(input.horizonMinutes / slotMinutes));
  const actions = input.actions.filter(action => action.durationMinutes > 0 && (action.available ?? true) && (action.prerequisiteSatisfied ?? true)
    && (action.retestWindowOpen ?? true));
  const dp: Array<{ utility: number; ids: string[]; elapsed: number }> = Array.from({ length: horizon + 1 }, () => ({ utility: 0, ids: [], elapsed: 0 }));
  for (const action of actions) {
    const duration = Math.ceil(action.durationMinutes / slotMinutes);
    for (let capacity = horizon; capacity >= duration; capacity--) {
      const previous = dp[capacity - duration]!;
      const candidate = { utility: previous.utility + action.utility, ids: [...previous.ids, action.id], elapsed: previous.elapsed + action.durationMinutes };
      if (candidate.utility > dp[capacity]!.utility) dp[capacity] = candidate;
    }
  }
  const best = dp[horizon]!;
  return { actionIds: best.ids, utility: best.utility, elapsedMinutes: best.elapsed, valueByStep: dp.map(row => row.utility) };
}

export const finiteHorizonBellmanPlan = planFiniteHorizon;
export const scheduleFiniteHorizon = planFiniteHorizon;
