import { describe, expect, it } from "vitest";
import { reservedArithmeticIdentity } from "./opening-course-reserved-selection";

describe("private arithmetic identity", () => {
  it("recognizes exact rendering aliases without treating a new UUID as a new condition", () => {
    expect(reservedArithmeticIdentity("计算：12 × 7？")).toEqual(reservedArithmeticIdentity("12*7"));
    expect(reservedArithmeticIdentity("12+7")?.expression).not.toBe(reservedArithmeticIdentity("13+7")?.expression);
    expect(reservedArithmeticIdentity("12+7")?.familyId).toBe(reservedArithmeticIdentity("13+7")?.familyId);
    expect(reservedArithmeticIdentity("12*7")?.familyId).not.toBe(reservedArithmeticIdentity("12+7")?.familyId);
    expect(reservedArithmeticIdentity("7+12")?.value).toBe(reservedArithmeticIdentity("12+7")?.value);
  });
  it.each(["图中求面积", "x+1", "1/0", "1 1/2 + 3", "12+7 meters", "12+7; process.exit()"])("does not invent exact identity for %s", text => {
    expect(reservedArithmeticIdentity(text)).toBeNull();
  });
});
