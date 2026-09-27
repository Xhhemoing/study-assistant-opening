import { describe, expect, it } from "vitest";
import { canAcceptPlan } from "./plan-action";

describe("canAcceptPlan", () => {
  it("does not resubmit a pending or stale plan", () => {
    expect(canAcceptPlan({ pending: true, stale: false })).toBe(false);
    expect(canAcceptPlan({ pending: false, stale: true })).toBe(false);
    expect(canAcceptPlan({ pending: false, stale: false })).toBe(true);
  });
});
