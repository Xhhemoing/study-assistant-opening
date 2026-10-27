import { expect, it } from "vitest";
import { learningMaintenanceDue } from "./opening-long-term-maintenance";
it("uses the explicit maintenance interval and never treats pause or absence as a failed answer", () => {
  const now = new Date("2026-11-15T00:00:00Z"), last = "2026-11-02T00:00:00Z";
  expect(learningMaintenanceDue({ lifecycle: "maintenance", maintenanceIntervalDays: 14 }, last, now)).toBe(false);
  expect(learningMaintenanceDue({ lifecycle: "reduced", maintenanceIntervalDays: 7 }, last, now)).toBe(true);
  expect(learningMaintenanceDue({ lifecycle: "paused", maintenanceIntervalDays: 7 }, last, now)).toBe(false);
  expect(learningMaintenanceDue({ lifecycle: "maintenance", maintenanceIntervalDays: null }, null, now)).toBe(false);
});
it("becomes due on the next workspace calendar day even when spring DST makes it 23 hours", () => {
  expect(learningMaintenanceDue({ lifecycle: "maintenance", maintenanceIntervalDays: 1 }, "2026-03-07T20:00:00Z", new Date("2026-03-08T19:00:00Z"), "America/Los_Angeles")).toBe(true);
});
