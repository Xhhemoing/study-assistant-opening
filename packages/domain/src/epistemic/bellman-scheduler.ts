export type SchedulerAction = {
  id: string;
  durationMinutes: number;
  utility?: number;
  retentionGain?: number;
  diagnosticInformationGain?: number;
  informationGain?: number;
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
  return action.durationMinutes > 0 ? (action.utility ?? 0) / action.durationMinutes : 0;
}

export function explorationWeight(hoursToExam: number, options: { min?: number; max?: number } = {}): number {
  const minimum = options.min ?? 0.1;
  const maximum = options.max ?? 0.9;
  const z = Math.min(1, Math.max(0, (hoursToExam - 72) / 96));
  const smooth = 3 * z * z - 2 * z * z * z;
  return minimum + (maximum - minimum) * smooth;
}

export function mutualInformation(states: readonly { probability: number; outcome: readonly number[] }[]): number {
  const rows = states.flatMap(({ probability, outcome }) => {
    if (!Number.isFinite(probability) || probability <= 0
      || outcome.some(value => !Number.isFinite(value) || value < 0)) return [];
    const maximum = outcome.reduce((max, value) => Math.max(max, value), 0);
    if (maximum === 0) return [];
    const scaled = outcome.map(value => value / maximum);
    const total = scaled.reduce((sum, value) => sum + value, 0);
    return [{ probability, conditional: scaled.map(value => value / total) }];
  });
  const first = rows[0]?.conditional;
  if (!first || rows.every(({ conditional }) => conditional.length === first.length
    && conditional.every((value, index) => value === first[index]))) return 0;

  const maxPrior = rows.reduce((max, row) => Math.max(max, row.probability), 0);
  const priorTotal = rows.reduce((sum, row) => sum + row.probability / maxPrior, 0);
  const joint = rows.map(row => {
    const prior = (row.probability / maxPrior) / priorTotal;
    return { conditional: row.conditional, probabilities: row.conditional.map(value => prior * value) };
  });

  const marginals: number[] = [];
  for (const row of joint) {
    for (const [k, probability] of row.probabilities.entries()) {
      marginals[k] = (marginals[k] ?? 0) + probability;
    }
  }

  let information = 0;
  for (const row of joint) {
    for (const [k, probability] of row.probabilities.entries()) {
      if (probability > 0) information += probability * (Math.log(row.conditional[k]!) - Math.log(marginals[k]!));
    }
  }
  return Math.max(0, information);
}

export type FiniteHorizonPlan = {
  actionIds: string[];
  actionStartSlots: number[];
  utility: number;
  elapsedMinutes: number;
  /** Remaining utility along the chosen plan, from slot 0 to the terminal slot. */
  valueByStep: number[];
};

type Candidate = {
  id: string;
  minutes: number;
  slots: number;
  firstSlot: number;
  lastSlot: number;
  retentionGain: number;
  informationGain: number;
};
type Choice = { actionIndex: number; start: number; gain: number };
const EXACT_ACTION_LIMIT = 16;

function exactChoices(actions: readonly Candidate[], weights: readonly number[]): Choice[] {
  type Decision = Choice & { value: number };
  const memo: Array<Map<number, Decision | null> | undefined> = [];

  function best(slot: number, used: number): Decision | null {
    const decisions = memo[used] ?? (memo[used] = new Map());
    const cached = decisions.get(slot);
    if (cached !== undefined) return cached;

    let choice: Decision | null = null;
    let value = 0;
    for (const [actionIndex, action] of actions.entries()) {
      const bit = 1 << actionIndex;
      if ((used & bit) !== 0) continue;
      const firstStart = Math.max(slot, action.firstSlot);
      // Waiting before this action cannot improve a nonincreasing reward.
      // For an increasing reward, compare each distinct later reward as well.
      const lastStart = action.informationGain < 0 ? action.lastSlot : Math.min(firstStart, action.lastSlot);
      for (let start = firstStart; start <= lastStart; start++) {
        if (start !== firstStart && weights[start] === weights[start - 1]) continue;
        const gain = action.retentionGain + weights[start]! * action.informationGain;
        if (gain <= 0) continue;
        const candidate = gain + (best(start + action.slots, used | bit)?.value ?? 0);
        if (candidate > value || (candidate === value && choice !== null && start < choice.start)) {
          choice = { actionIndex, start, gain, value: candidate };
          value = candidate;
        }
      }
    }
    decisions.set(slot, choice);
    return choice;
  }

  const choices: Choice[] = [];
  let used = 0;
  let slot = 0;
  for (let decision = best(slot, used); decision !== null; decision = best(slot, used)) {
    choices.push(decision);
    used |= 1 << decision.actionIndex;
    slot = decision.start + actions[decision.actionIndex]!.slots;
  }
  return choices;
}

function greedyChoices(actions: readonly Candidate[], weights: readonly number[]): Choice[] {
  const choices: Choice[] = [];
  const used = new Set<number>();
  let slot = 0;
  while (true) {
    let choice: Choice | undefined;
    let bestDensity = 0;
    for (const [actionIndex, action] of actions.entries()) {
      if (used.has(actionIndex)) continue;
      const firstStart = Math.max(slot, action.firstSlot);
      if (firstStart > action.lastSlot) continue;
      // Price idle slots into the rollout and compare a later start for increasing rewards.
      const firstGain = action.retentionGain + weights[firstStart]! * action.informationGain;
      const firstDensity = firstGain / (firstStart - slot + action.slots);
      const lateGain = action.retentionGain + weights[action.lastSlot]! * action.informationGain;
      const lateDensity = action.informationGain < 0 ? lateGain / (action.lastSlot - slot + action.slots) : -Infinity;
      const density = Math.max(firstDensity, lateDensity);
      const start = lateDensity > firstDensity ? action.lastSlot : firstStart;
      if (density > bestDensity || (density === bestDensity && choice !== undefined && start < choice.start)) {
        choice = { actionIndex, start, gain: start === firstStart ? firstGain : lateGain };
        bestDensity = density;
      }
    }
    if (!choice) return choices;
    choices.push(choice);
    used.add(choice.actionIndex);
    slot = choice.start + actions[choice.actionIndex]!.slots;
  }
}

export function planFiniteHorizon(input: {
  horizonMinutes: number;
  actions: readonly SchedulerAction[];
  slotMinutes?: number;
  deadlineHours?: number;
}): FiniteHorizonPlan {
  const { horizonMinutes, slotMinutes = 1, deadlineHours = Infinity } = input;
  if (!Number.isFinite(slotMinutes) || slotMinutes <= 0 || !Number.isFinite(horizonMinutes) || horizonMinutes < 0) {
    throw new RangeError("Horizon minutes must be finite and nonnegative and slot minutes must be finite and positive");
  }
  if (Number.isNaN(deadlineHours) || deadlineHours < 0) throw new RangeError("Deadline hours must be nonnegative");
  const horizon = Math.floor(horizonMinutes / slotMinutes);
  if (horizon >= 2 ** 32 - 1) throw new RangeError("Too many planning slots");

  const actions: Candidate[] = [];
  const ids = new Set<string>();
  for (const action of input.actions) {
    if (action.available === false || action.prerequisiteSatisfied === false || action.retestWindowOpen === false
      || ids.has(action.id) || !Number.isFinite(action.durationMinutes) || action.durationMinutes <= 0) continue;
    const slots = Math.max(1, Math.ceil(action.durationMinutes / slotMinutes));
    const firstSlot = Math.max(0, Math.ceil(action.earliestSlot ?? 0));
    const lastSlot = horizon - slots;
    const retentionGain = action.retentionGain ?? action.utility ?? 0;
    const informationGain = action.diagnosticInformationGain ?? action.informationGain ?? 0;
    if (!Number.isFinite(firstSlot) || firstSlot > lastSlot || !Number.isFinite(retentionGain) || !Number.isFinite(informationGain)) continue;
    actions.push({ id: action.id, minutes: action.durationMinutes, slots, firstSlot, lastSlot, retentionGain, informationGain });
    ids.add(action.id);
  }

  const weights = Array.from({ length: horizon }, (_, slot) =>
    explorationWeight(Math.max(0, deadlineHours - (slot * slotMinutes) / 60), { min: 0 }));
  const choices = actions.length <= EXACT_ACTION_LIMIT ? exactChoices(actions, weights) : greedyChoices(actions, weights);
  const valueByStep = Array<number>(horizon + 1).fill(0);
  for (const { start, gain } of choices) valueByStep[start] = gain;
  for (let slot = horizon - 1; slot >= 0; slot--) valueByStep[slot] = valueByStep[slot]! + valueByStep[slot + 1]!;
  const last = choices.at(-1);
  return {
    actionIds: choices.map(({ actionIndex }) => actions[actionIndex]!.id),
    actionStartSlots: choices.map(({ start }) => start),
    utility: valueByStep[0]!,
    elapsedMinutes: last ? last.start * slotMinutes + actions[last.actionIndex]!.minutes : 0,
    valueByStep,
  };
}

export const finiteHorizonBellmanPlan = planFiniteHorizon;
export const scheduleFiniteHorizon = planFiniteHorizon;
