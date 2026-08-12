import { describe, expect, it } from "vitest";
import { getRequirementProfile } from "../courses/requirements";
import {
  computeEffectiveRequirements,
  defaultGoalAbilities,
  EFFECTIVE_REQUIREMENTS_VERSION,
  type AbilityWeights,
  type GoalKind,
  type GoalRequirement,
} from "./effective-requirements";

const BASELINE = getRequirementProfile("mathematical-procedural", "basic");

function weightsSum(a: AbilityWeights): number {
  return a.recognition + a.recall + a.procedural + a.transfer + a.expression + a.timed;
}

function goal(
  goalId: string,
  kind: GoalKind,
  overrides: Partial<Omit<GoalRequirement, "goalId" | "kind" | "abilities">> = {},
): GoalRequirement {
  return {
    goalId,
    kind,
    abilities: defaultGoalAbilities(kind),
    priority: 0,
    intensity: 0.5,
    active: true,
    strategyVersion: "goal-1",
    ...overrides,
  };
}

const NOW = new Date("2026-08-13T08:00:00.000Z");

describe("effective requirement merge", () => {
  it("is deterministic and versioned", () => {
    const goals = [
      goal("g-final", "final-exam", { priority: 2, intensity: 0.5 }),
      goal("g-entrance", "entrance-exam", { priority: 3, intensity: 0.6 }),
    ];
    const input = { baseline: BASELINE, goals, timeWindows: [], now: NOW };
    const first = computeEffectiveRequirements(input);
    const second = computeEffectiveRequirements(input);
    expect(first).toEqual(second);
    expect(first.strategyVersion).toBe(EFFECTIVE_REQUIREMENTS_VERSION);
  });

  it("fully replaces baseline when a single goal has intensity 1", () => {
    const result = computeEffectiveRequirements({
      baseline: BASELINE,
      goals: [goal("g", "maintenance", { intensity: 1 })],
      timeWindows: [],
      now: NOW,
    });
    expect(result.abilities).toEqual(defaultGoalAbilities("maintenance"));
    expect(weightsSum(result.abilities)).toBe(100);
  });

  it("leaves baseline unchanged when a single goal has intensity 0", () => {
    const result = computeEffectiveRequirements({
      baseline: BASELINE,
      goals: [goal("g", "maintenance", { intensity: 0 })],
      timeWindows: [],
      now: NOW,
    });
    expect(result.abilities).toEqual(BASELINE.abilities);
  });

  it("blends baseline and goal at intensity 0.5", () => {
    const result = computeEffectiveRequirements({
      baseline: BASELINE,
      goals: [goal("g", "maintenance", { intensity: 0.5 })],
      timeWindows: [],
      now: NOW,
    });
    const target = defaultGoalAbilities("maintenance");
    // recall: baseline 15 -> goal 35, midpoint 25 (integer, no rounding drift).
    expect(result.abilities.recall).toBe(25);
    expect(result.abilities.recall).toBeGreaterThan(BASELINE.abilities.recall);
    expect(result.abilities.recall).toBeLessThan(target.recall);
  });

  it("ignores inactive goals", () => {
    const active = computeEffectiveRequirements({
      baseline: BASELINE,
      goals: [goal("g", "maintenance", { intensity: 1, active: false })],
      timeWindows: [],
      now: NOW,
    });
    expect(active.abilities).toEqual(BASELINE.abilities);
  });

  it("merges multiple goals deterministically regardless of argument order", () => {
    const goals = [
      goal("g-final", "final-exam", { priority: 2, intensity: 0.5 }),
      goal("g-entrance", "entrance-exam", { priority: 3, intensity: 0.6 }),
      goal("g-interest", "interest", { priority: 1, intensity: 0.3 }),
      goal("g-maintenance", "maintenance", { priority: 0, intensity: 0.2 }),
    ];
    const shuffled = [goals[3]!, goals[0]!, goals[2]!, goals[1]!];
    const a = computeEffectiveRequirements({ baseline: BASELINE, goals, timeWindows: [], now: NOW });
    const b = computeEffectiveRequirements({ baseline: BASELINE, goals: shuffled, timeWindows: [], now: NOW });
    expect(a.abilities).toEqual(b.abilities);
    expect(weightsSum(a.abilities)).toBe(100);
  });

  it("gives higher-priority goals more influence", () => {
    // maintenance emphasises recall (35); entrance-exam recall is 25.
    const maintenanceFirst = computeEffectiveRequirements({
      baseline: BASELINE,
      goals: [
        goal("g-maintenance", "maintenance", { priority: 10, intensity: 0.5 }),
        goal("g-entrance", "entrance-exam", { priority: 0, intensity: 0.5 }),
      ],
      timeWindows: [],
      now: NOW,
    });
    const entranceFirst = computeEffectiveRequirements({
      baseline: BASELINE,
      goals: [
        goal("g-maintenance", "maintenance", { priority: 0, intensity: 0.5 }),
        goal("g-entrance", "entrance-exam", { priority: 10, intensity: 0.5 }),
      ],
      timeWindows: [],
      now: NOW,
    });
    expect(maintenanceFirst.abilities.recall).toBeGreaterThan(entranceFirst.abilities.recall);
  });

  it("applies the active time-window modifier", () => {
    const result = computeEffectiveRequirements({
      baseline: BASELINE,
      goals: [goal("g", "entrance-exam", { intensity: 0 })],
      timeWindows: [
        {
          goalId: "g",
          phase: "rehearsal",
          startsAt: "2026-08-01T00:00:00.000Z",
          endsAt: "2026-09-01T00:00:00.000Z",
          modifier: { timed: 30 },
        },
      ],
      now: NOW,
    });
    expect(result.abilities.timed).toBeGreaterThan(BASELINE.abilities.timed);
    expect(weightsSum(result.abilities)).toBe(100);
  });

  it("ignores time windows outside the current time", () => {
    const result = computeEffectiveRequirements({
      baseline: BASELINE,
      goals: [goal("g", "entrance-exam", { intensity: 0 })],
      timeWindows: [
        {
          goalId: "g",
          phase: "rehearsal",
          startsAt: "2026-09-02T00:00:00.000Z",
          endsAt: "2026-10-01T00:00:00.000Z",
          modifier: { timed: 30 },
        },
      ],
      now: NOW,
    });
    expect(result.abilities).toEqual(BASELINE.abilities);
  });

  it("lets user override win and records provenance", () => {
    const result = computeEffectiveRequirements({
      baseline: BASELINE,
      goals: [goal("g", "entrance-exam", { intensity: 0 })],
      timeWindows: [],
      now: NOW,
      userOverride: { abilities: { recall: 60 }, assessmentMode: "disabled" },
    });
    expect(result.abilities.recall).toBeGreaterThan(BASELINE.abilities.recall);
    expect(result.assessmentMode).toBe("disabled");
    expect(result.sources).toContain("override:abilities");
    expect(result.sources).toContain("override:assessmentMode");
    expect(result.sources).toContain(`baseline:${BASELINE.strategyVersion}`);
    expect(weightsSum(result.abilities)).toBe(100);
  });

  it("returns the normalised baseline when no goals or windows apply", () => {
    const result = computeEffectiveRequirements({
      baseline: BASELINE,
      goals: [],
      timeWindows: [],
      now: NOW,
    });
    expect(result.abilities).toEqual(BASELINE.abilities);
    expect(result.assessmentMode).toBe(BASELINE.assessmentMode);
  });

  it("normalises every preset goal weight to a sum of 100", () => {
    for (const kind of [
      "final-exam",
      "entrance-exam",
      "interest",
      "maintenance",
      "custom",
    ] as const) {
      expect(weightsSum(defaultGoalAbilities(kind))).toBe(100);
    }
  });
});
