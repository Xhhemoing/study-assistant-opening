import { describe, expect, it } from "vitest";
import { checkTeachingFormula } from "./teaching-formula-check";

describe("exact arithmetic teaching formula tool", () => {
  it.each([
    "1 + 2 = 3 = 6/2",
    "0.1 + 0.2 = 0.3",
    "\\frac{1}{3} + \\frac{1}{6} = 1/2",
    "2 × (3 − 1) = 4",
  ])("accepts each supported equality step: %s", async (formula) => {
    expect(await checkTeachingFormula(formula)).toEqual({ ok: true });
  });
  it.each(["1 + 2 = 4", "1 + 2 = 4 = 3", "0.1 + 0.2 = 0.30000000000000001"])(
    "rejects a contradictory equality step: %s", async (formula) => {
      expect(await checkTeachingFormula(formula)).toEqual({ ok: false });
    },
  );
  it.each([
    "1 + 2", "3 = 3", "x + 1 = 2", "1m + 2m = 3m", "证明 1 + 2 = 3",
    "1/0 = 2", "1 + 2 = 3/0", "1 + 2 =", "1 + 2 == 3", "2^3 = 8",
    "1 + 2 ≈ 3", "1 1/2 + 1 = 2.5", "计算1 + 2 = 3",
    `1 + 2 = ${"3".repeat(1200)}`, `1 + 2${" = 3".repeat(12)}`,
  ])("leaves unsupported input unknown: %s", async (formula) => {
    expect(await checkTeachingFormula(formula)).toEqual({ unknown: true, reason: expect.any(String) });
  });
});
