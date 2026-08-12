import { describe, expect, it } from "vitest";
import {
  getRequirementProfile,
  isAssessmentEnabled,
  listRequirementProfileKinds,
  normalizeAbilityWeights,
  REQUIREMENT_PROFILE_VERSION,
  REQUIREMENT_PROFILES,
  resolveRequirementProfile,
  validateAbilityWeights,
} from "./requirements";

function weightSum(profile: ReturnType<typeof getRequirementProfile>): number {
  const a = profile.abilities;
  return a.recognition + a.recall + a.procedural + a.transfer + a.expression + a.timed;
}

describe("course requirement profiles", () => {
  it("exposes all six profile kinds in a stable order", () => {
    expect(listRequirementProfileKinds()).toEqual([
      "memory",
      "mathematical-procedural",
      "language",
      "research-writing",
      "programming-project",
      "free-exploration",
    ]);
  });

  it("is versioned", () => {
    expect(REQUIREMENT_PROFILE_VERSION).toBe("req-profile-1");
  });

  it.each(REQUIREMENT_PROFILES.map((p) => [p.kind] as const))(
    "normalizes %s weights to a sum of 100",
    (kind) => {
      const profile = getRequirementProfile(kind, "basic");
      expect(weightSum(profile)).toBe(100);
    },
  );

  it("emphasises recall for memory-heavy courses", () => {
    const { abilities } = getRequirementProfile("memory", "basic");
    expect(abilities.recall).toBeGreaterThan(abilities.expression);
    expect(abilities.recall).toBeGreaterThan(abilities.procedural);
  });

  it("emphasises procedural + transfer for mathematical courses", () => {
    const { abilities } = getRequirementProfile("mathematical-procedural", "basic");
    expect(abilities.procedural + abilities.transfer).toBeGreaterThan(
      abilities.recall + abilities.expression,
    );
  });

  it("emphasises expression for research-writing courses", () => {
    const { abilities } = getRequirementProfile("research-writing", "basic");
    expect(abilities.expression).toBeGreaterThan(abilities.procedural);
    expect(abilities.expression).toBeGreaterThan(abilities.timed);
  });

  it("emphasises procedural + expression for programming-project courses", () => {
    const { abilities } = getRequirementProfile("programming-project", "basic");
    expect(abilities.procedural).toBeGreaterThan(abilities.recall);
    expect(abilities.expression).toBeGreaterThan(abilities.recognition);
  });

  it("keeps free-exploration balanced without exam pressure", () => {
    const { abilities } = getRequirementProfile("free-exploration", "basic");
    expect(abilities.timed).toBeLessThanOrEqual(10);
    const values = [
      abilities.recognition,
      abilities.recall,
      abilities.procedural,
      abilities.transfer,
      abilities.expression,
    ];
    expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(5);
  });

  it("keeps weights when assessment is disabled but flags the profile", () => {
    const enabled = getRequirementProfile("language", "basic");
    const disabled = getRequirementProfile("language", "disabled");
    expect(disabled.abilities).toEqual(enabled.abilities);
    expect(isAssessmentEnabled(enabled)).toBe(true);
    expect(isAssessmentEnabled(disabled)).toBe(false);
  });

  it("resolves a user input to a full profile with defaults", () => {
    expect(resolveRequirementProfile({})).toEqual(
      getRequirementProfile("free-exploration", "basic"),
    );
    expect(resolveRequirementProfile({ kind: "memory", assessmentMode: "disabled" })).toEqual(
      getRequirementProfile("memory", "disabled"),
    );
  });

  it("normalizes arbitrary weights to a sum of 100", () => {
    const normalized = normalizeAbilityWeights({
      recognition: 1,
      recall: 1,
      procedural: 1,
      transfer: 1,
      expression: 1,
      timed: 1,
    });
    expect(
      normalized.recognition +
        normalized.recall +
        normalized.procedural +
        normalized.transfer +
        normalized.expression +
        normalized.timed,
    ).toBe(100);
  });

  it("normalizes round-drift edge cases to exactly 100", () => {
    const normalized = normalizeAbilityWeights({
      recognition: 0,
      recall: 52,
      procedural: 100,
      transfer: 1,
      expression: 1,
      timed: 1,
    });
    const total =
      normalized.recognition +
      normalized.recall +
      normalized.procedural +
      normalized.transfer +
      normalized.expression +
      normalized.timed;
    expect(total).toBe(100);
    for (const value of Object.values(normalized)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });

  it("throws on an unknown profile kind", () => {
    expect(() =>
      getRequirementProfile("not-a-kind" as never, "basic"),
    ).toThrow(/Unknown requirement profile kind/);
  });

  it("rejects weights that do not sum to 100", () => {
    const base = getRequirementProfile("memory", "basic").abilities;
    expect(validateAbilityWeights(base)).toBe(true);
    expect(validateAbilityWeights({ ...base, recall: 39 })).toBe(false);
  });
});
