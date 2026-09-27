import { describe, expect, it } from "vitest";
import { canProposePlan } from "./plan-input";

describe("canProposePlan", () => {
  it("requires an actual non-empty interval", () => {
    expect(canProposePlan({ start: "", end: "" })).toBe(false);
    expect(canProposePlan({ start: "2026-09-23T10:00", end: "2026-09-23T09:00" })).toBe(false);
    expect(canProposePlan({ start: "2026-09-23T09:00", end: "2026-09-23T10:00" })).toBe(true);
  });
});
