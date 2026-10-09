import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPENING_PLANNING_SETTINGS,
  openingPlanningSettingsSchema,
} from "./planning-settings";

describe("openingPlanningSettingsSchema", () => {
  it("accepts defaults and overnight sleep", () => {
    const parsed = openingPlanningSettingsSchema.parse({
      ...DEFAULT_OPENING_PLANNING_SETTINGS,
      weekOneMonday: "2024-09-02",
      periodTimes: { "1": { start: "08:00", end: "08:45" } },
    });
    expect(parsed.sleep).toEqual({ start: "23:00", end: "07:00" });
    expect(parsed.dailyWindow.start).toBe("07:30");
  });

  it("rejects invalid HH:mm and same-day meal inversion", () => {
    expect(
      openingPlanningSettingsSchema.safeParse({
        ...DEFAULT_OPENING_PLANNING_SETTINGS,
        lunch: { start: "12:00", end: "25:00" },
      }).success,
    ).toBe(false);
    expect(
      openingPlanningSettingsSchema.safeParse({
        ...DEFAULT_OPENING_PLANNING_SETTINGS,
        dinner: { start: "18:00", end: "17:00" },
      }).success,
    ).toBe(false);
  });

  it("rejects unknown keys", () => {
    expect(
      openingPlanningSettingsSchema.safeParse({
        ...DEFAULT_OPENING_PLANNING_SETTINGS,
        extra: true,
      }).success,
    ).toBe(false);
  });
});
