import { describe, expect, it } from "vitest";
import { resolveLearningPreferences } from "./learning-preferences";

const enabled = {
  assessmentEnabled: true,
  retestSuggestionsEnabled: true,
  automaticRemindersEnabled: true,
};

describe("resolveLearningPreferences", () => {
  it("lets an account assessment shutdown suppress every automatic action", () => {
    expect(resolveLearningPreferences(
      { ...enabled, assessmentEnabled: false },
      { assessmentEnabled: true, retestSuggestionsEnabled: true },
      false,
    )).toEqual({ assessmentEnabled: false, retestSuggestionsEnabled: false, automaticRemindersEnabled: false });
  });

  it("allows a course to narrow account permissions but not expand them", () => {
    expect(resolveLearningPreferences(enabled, { retestSuggestionsEnabled: false }, false))
      .toEqual({ ...enabled, retestSuggestionsEnabled: false });
    expect(resolveLearningPreferences({ ...enabled, automaticRemindersEnabled: false },
      { automaticRemindersEnabled: true }, false).automaticRemindersEnabled).toBe(false);
  });

  it("suppresses all automatic actions for an archived course", () => {
    expect(resolveLearningPreferences(enabled, {}, true))
      .toEqual({ assessmentEnabled: false, retestSuggestionsEnabled: false, automaticRemindersEnabled: false });
  });
});
