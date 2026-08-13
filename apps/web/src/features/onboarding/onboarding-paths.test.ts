import { describe, expect, it } from "vitest";
import {
  ONBOARDING_PATHS,
  hasUnblockedExploration,
  onboardingPathById,
} from "./onboarding-paths";

describe("onboarding paths", () => {
  it("defines the four optional onboarding paths", () => {
    expect(ONBOARDING_PATHS.map((path) => path.id)).toEqual([
      "free-exploration",
      "goal-course",
      "knowledge-course",
      "promote-exploration",
    ]);
  });

  it("gives every path a valid workspace route", () => {
    for (const path of ONBOARDING_PATHS) {
      expect(path.href).toMatch(/^\/(learn|explore|library)/);
    }
  });

  it("never blocks exploration behind course or goal creation", () => {
    expect(hasUnblockedExploration(ONBOARDING_PATHS)).toBe(true);
  });

  it("resolves a path by id", () => {
    expect(onboardingPathById("goal-course")?.id).toBe("goal-course");
    expect(onboardingPathById("free-exploration")?.suggestsGoal).toBe(false);
  });

  it("distinguishes goal-driven from plan-free courses", () => {
    expect(onboardingPathById("goal-course")?.suggestsGoal).toBe(true);
    expect(onboardingPathById("knowledge-course")?.suggestsGoal).toBe(false);
  });

  it("keeps every path title and description present", () => {
    for (const path of ONBOARDING_PATHS) {
      expect(path.title.length).toBeGreaterThan(0);
      expect(path.description.length).toBeGreaterThan(0);
    }
  });
});
