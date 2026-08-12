import { describe, expect, it } from "vitest";
import { abilityDimensions } from "@aistudy/contracts";
import {
  ABILITY_DIMENSION_LABELS,
  defaultRequirementProfileDraft,
  REQUIREMENT_PROFILE_OPTIONS,
  requirementProfileDraftToInput,
  requirementProfileLabel,
} from "./requirement-profile-model";

describe("course-settings requirement profile model", () => {
  it("defaults to free-exploration with assessment enabled", () => {
    expect(defaultRequirementProfileDraft()).toEqual({
      kind: "free-exploration",
      assessmentMode: "basic",
    });
  });

  it("exposes six labelled profile options", () => {
    expect(REQUIREMENT_PROFILE_OPTIONS).toHaveLength(6);
    expect(REQUIREMENT_PROFILE_OPTIONS.map((option) => option.value)).toEqual([
      "memory",
      "mathematical-procedural",
      "language",
      "research-writing",
      "programming-project",
      "free-exploration",
    ]);
    for (const option of REQUIREMENT_PROFILE_OPTIONS) {
      expect(option.label).toBeTruthy();
      expect(option.description).toBeTruthy();
    }
  });

  it("labels every ability dimension", () => {
    expect(Object.keys(ABILITY_DIMENSION_LABELS).sort()).toEqual(
      [...abilityDimensions].sort(),
    );
  });

  it("resolves a known profile label", () => {
    expect(requirementProfileLabel("memory")).toBe("记忆型");
    expect(requirementProfileLabel("free-exploration")).toBe("自由探索");
  });

  it("converts a draft to a contract input", () => {
    expect(
      requirementProfileDraftToInput({ kind: "memory", assessmentMode: "disabled" }),
    ).toEqual({ kind: "memory", assessmentMode: "disabled" });
  });
});
