import { describe, expect, it } from "vitest";
import {
  dailySlotsEqual,
  defaultGuidanceMode,
  GUIDANCE_MODE_OPTIONS,
  guidanceModeLabel,
  isValidDailySlot,
} from "./guidance-mode-model";

describe("guidance mode model", () => {
  it("defaults to advisory", () => {
    expect(defaultGuidanceMode()).toBe("advisory");
  });

  it("exposes three labelled modes", () => {
    expect(GUIDANCE_MODE_OPTIONS.map((option) => option.value)).toEqual([
      "free",
      "advisory",
      "coach",
    ]);
    for (const option of GUIDANCE_MODE_OPTIONS) {
      expect(option.label).toBeTruthy();
      expect(option.description).toBeTruthy();
    }
  });

  it("resolves mode labels", () => {
    expect(guidanceModeLabel("free")).toBe("自由模式");
    expect(guidanceModeLabel("coach")).toBe("教练模式");
  });

  it("validates daily protected slots", () => {
    expect(isValidDailySlot({ start: "19:00", end: "20:00" })).toBe(true);
    expect(isValidDailySlot({ start: "20:00", end: "19:00" })).toBe(false);
    expect(isValidDailySlot({ start: "9:00", end: "10:00" })).toBe(false);
  });

  it("compares daily slots", () => {
    expect(dailySlotsEqual({ start: "19:00", end: "20:00" }, { start: "19:00", end: "20:00" })).toBe(true);
    expect(dailySlotsEqual({ start: "19:00", end: "20:00" }, { start: "19:00", end: "21:00" })).toBe(false);
  });
});
