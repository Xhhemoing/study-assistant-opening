import { describe, expect, it } from "vitest";
import { reservedArithmeticIdentity, readOpeningReservedSupply } from "./opening-course-reserved-selection";
import type { CourseRequirement } from "@aistudy/contracts";
import type { Sql } from "postgres";

describe("private inventory is not exposure qualification", () => {
  it.each([
    { requirementKey: "rank", verification: { kind: "rubric" } },
    { requirementKey: "arithmetic", verification: { kind: "rubric" } },
  ])("does not query or certify unsupported inventory %#", async requirement => {
    const db = (() => { throw new Error("unsupported producer must not resolve or authorize a question"); }) as unknown as Sql;
    expect(await readOpeningReservedSupply(db, { workspaceId: "workspace", ownerUserId: "owner" }, requirement as CourseRequirement))
      .toEqual({ status: "missing", available: 0, reason: "本要求的私有生成与身份校验题型尚不支持" });
  });
});

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
