import { expect, it } from "vitest";
import { DEFAULT_OPENING_GUIDANCE_SETTINGS, openingGuidanceSettingsSchema, DEFAULT_OPENING_PLANNING_SETTINGS } from "@aistudy/contracts";
import { guidanceProtectedBlocks } from "./guidance-blocks";
import { deriveDayBlocks } from "./day-blocks";
it("turns protected clocks into timezone-correct locks and removes them from free slots", () => {
  const guidance = { ...DEFAULT_OPENING_GUIDANCE_SETTINGS, protectedSlots: [{ start: "20:10", end: "20:30" }] };
  const locks = guidanceProtectedBlocks("2026-10-14", "Asia/Shanghai", guidance);
  expect(locks).toEqual([{ start: "2026-10-14T12:10:00.000Z", end: "2026-10-14T12:30:00.000Z", kind: "locked" }]);
  const blocks = deriveDayBlocks("2026-10-14", { ...DEFAULT_OPENING_PLANNING_SETTINGS, timeZone: "Asia/Shanghai",
    weekOneMonday: "2026-10-12", dailyWindow: { start: "20:00", end: "21:00" } }, [], locks);
  expect(blocks.filter(b => b.kind === "free").every(b => b.end <= locks[0]!.start || b.start >= locks[0]!.end)).toBe(true);
});
it("accepts no protected slots and rejects invalid or overnight clocks and forged activation", () => {
  expect(guidanceProtectedBlocks("2026-10-14", "America/Los_Angeles", DEFAULT_OPENING_GUIDANCE_SETTINGS)).toEqual([]);
  for (const patch of [{ protectedSlots: [{ start: "25:00", end: "26:00" }] }, { protectedSlots: [{ start: "23:00", end: "02:00" }] },
    { dailyMinutes: 0 }, { automaticReorderingActive: true }]) {
    expect(openingGuidanceSettingsSchema.safeParse({ ...DEFAULT_OPENING_GUIDANCE_SETTINGS, ...patch }).success).toBe(false);
  }
});
