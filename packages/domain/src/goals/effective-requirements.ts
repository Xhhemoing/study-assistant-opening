import type {
  AbilityDimension,
  AbilityWeights,
  AssessmentMode,
  CourseRequirementProfile,
} from "@aistudy/contracts";
import { normalizeAbilityWeights } from "../courses/requirements";

export type { AbilityWeights };

export const EFFECTIVE_REQUIREMENTS_VERSION = "effective-req-1";

export type GoalKind = "final-exam" | "entrance-exam" | "interest" | "maintenance" | "custom";

export type TimeWindowPhase = "foundation" | "consolidation" | "rehearsal" | "maintenance";

const DIMENSIONS: readonly AbilityDimension[] = [
  "recognition",
  "recall",
  "procedural",
  "transfer",
  "expression",
  "timed",
];

export interface GoalRequirement {
  goalId: string;
  kind: GoalKind;
  abilities: AbilityWeights;
  /** Higher priority applies later in the deterministic merge. */
  priority: number;
  /** 0..1 blend strength against the accumulated weights. */
  intensity: number;
  active: boolean;
  strategyVersion: string;
}

export interface TimeWindow {
  goalId: string;
  phase: TimeWindowPhase;
  startsAt: string;
  endsAt: string;
  /** Additive deltas applied to the matching ability dimensions. */
  modifier: Partial<Record<AbilityDimension, number>>;
}

export interface UserOverride {
  abilities?: Partial<AbilityWeights>;
  assessmentMode?: AssessmentMode;
}

export interface EffectiveRequirements {
  abilities: AbilityWeights;
  assessmentMode: AssessmentMode;
  strategyVersion: string;
  /** Ordered provenance of every contributor to the merge. */
  sources: string[];
}

function weights(
  recognition: number,
  recall: number,
  procedural: number,
  transfer: number,
  expression: number,
  timed: number,
): AbilityWeights {
  return { recognition, recall, procedural, transfer, expression, timed };
}

/** Default ability mix per goal kind; every preset sums to 100. */
export function defaultGoalAbilities(kind: GoalKind): AbilityWeights {
  switch (kind) {
    case "final-exam":
      return weights(15, 20, 25, 20, 10, 10);
    case "entrance-exam":
      return weights(10, 25, 20, 25, 10, 10);
    case "interest":
      return weights(20, 15, 15, 20, 20, 10);
    case "maintenance":
      return weights(20, 35, 15, 15, 5, 10);
    case "custom":
      return weights(15, 20, 20, 20, 15, 10);
    default:
      throw new Error(`Unknown goal kind: ${String(kind)}`);
  }
}

function clampIntensity(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function mix(a: AbilityWeights, b: AbilityWeights, t: number): AbilityWeights {
  const result = {} as AbilityWeights;
  for (const key of DIMENSIONS) {
    result[key] = a[key] * (1 - t) + b[key] * t;
  }
  return result;
}

function applyModifier(
  a: AbilityWeights,
  modifier: Partial<Record<AbilityDimension, number>>,
): AbilityWeights {
  const result = { ...a };
  for (const key of DIMENSIONS) {
    const delta = modifier[key];
    if (delta !== undefined && Number.isFinite(delta)) {
      result[key] = Math.max(0, a[key] + delta);
    }
  }
  return result;
}

function isWindowActive(window: TimeWindow, now: Date): boolean {
  const t = now.getTime();
  const start = Date.parse(window.startsAt);
  const end = Date.parse(window.endsAt);
  return Number.isFinite(start) && Number.isFinite(end) && t >= start && t <= end;
}

/**
 * Deterministic merge order:
 * course baseline → active goal requirements → current time-window modifier → user override,
 * followed by re-normalisation to a sum of 100.
 */
export function computeEffectiveRequirements(input: {
  baseline: CourseRequirementProfile;
  goals: GoalRequirement[];
  timeWindows: TimeWindow[];
  now: Date;
  userOverride?: UserOverride;
}): EffectiveRequirements {
  const sources = [`baseline:${input.baseline.strategyVersion}`];

  let accumulated: AbilityWeights = { ...input.baseline.abilities };
  let assessmentMode = input.baseline.assessmentMode;

  const activeGoals = input.goals
    .filter((goal) => goal.active)
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        (a.goalId < b.goalId ? -1 : a.goalId > b.goalId ? 1 : 0),
    );

  for (const goal of activeGoals) {
    accumulated = mix(accumulated, goal.abilities, clampIntensity(goal.intensity));
    sources.push(`goal:${goal.kind}:${goal.strategyVersion}`);
  }

  for (const window of input.timeWindows) {
    const matchesGoal = activeGoals.some((goal) => goal.goalId === window.goalId);
    if (matchesGoal && isWindowActive(window, input.now)) {
      accumulated = applyModifier(accumulated, window.modifier);
      sources.push(`window:${window.phase}`);
    }
  }

  if (input.userOverride) {
    if (input.userOverride.abilities) {
      accumulated = { ...accumulated, ...input.userOverride.abilities };
      sources.push("override:abilities");
    }
    if (input.userOverride.assessmentMode) {
      assessmentMode = input.userOverride.assessmentMode;
      sources.push("override:assessmentMode");
    }
  }

  return {
    abilities: normalizeAbilityWeights(accumulated),
    assessmentMode,
    strategyVersion: EFFECTIVE_REQUIREMENTS_VERSION,
    sources,
  };
}
