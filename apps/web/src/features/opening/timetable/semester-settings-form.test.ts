import { describe, expect, it } from "vitest";
import {
  PERIOD_45MIN_TEMPLATE,
  applyPeriodTemplate,
  blankSemesterDraft,
  periodEntries,
  validateSemesterDraft,
} from "./semester-settings-form";
import { DEFAULT_OPENING_PLANNING_SETTINGS } from "@aistudy/contracts";

describe("semester settings defaults", () => {
  it("uses contract daily/meal/sleep defaults and 45-minute period template", () => {
    const draft = blankSemesterDraft();
    expect(draft.dailyWindow).toEqual(DEFAULT_OPENING_PLANNING_SETTINGS.dailyWindow);
    expect(draft.lunch).toEqual(DEFAULT_OPENING_PLANNING_SETTINGS.lunch);
    expect(draft.dinner).toEqual(DEFAULT_OPENING_PLANNING_SETTINGS.dinner);
    expect(draft.sleep).toEqual(DEFAULT_OPENING_PLANNING_SETTINGS.sleep);
    expect(draft.periodTimes).toEqual(PERIOD_45MIN_TEMPLATE);
    expect(periodEntries(PERIOD_45MIN_TEMPLATE)[0]).toEqual({
      period: "1",
      start: "08:00",
      end: "08:45",
    });
  });

  it("applyPeriodTemplate replaces period times without touching other fields", () => {
    const draft = blankSemesterDraft();
    draft.periodTimes = { "1": { start: "09:00", end: "09:45" } };
    draft.weekOneMonday = "2026-09-07";
    const next = applyPeriodTemplate(draft);
    expect(next.weekOneMonday).toBe("2026-09-07");
    expect(next.periodTimes).toEqual(PERIOD_45MIN_TEMPLATE);
  });

  it("rejects missing Monday and accepts a valid Monday draft", () => {
    expect(validateSemesterDraft(blankSemesterDraft())).toMatch(/周一/);
    expect(validateSemesterDraft({
      ...blankSemesterDraft(),
      weekOneMonday: "2026-09-08",
    })).toMatch(/星期一/);
    expect(validateSemesterDraft({
      ...blankSemesterDraft(),
      weekOneMonday: "2026-09-07",
    })).toBeNull();
  });
});
