import { describe, expect, it } from "vitest";
import type { CourseRouteRequirementInput } from "@aistudy/contracts";
import { decideCourseRouteVerification } from "./opening-course-route-verification-policy";

type Verification = CourseRouteRequirementInput["verification"];
const submitted = (kind: Verification["kind"], rubric: string | null = "标准"): Verification => ({
  kind, rubric, status: "ready", exerciseKeys: ["forged"], missingReasons: ["forged"],
});
describe("server verification policy", () => {
  for (const available of [false, true]) for (const enabled of [false, true]) {
    it(`ignores client unavailable state (sources=${available}, exact=${enabled})`, () => {
      for (const old of [null, submitted("unavailable"), submitted("unavailable", "旧标准")]) {
        expect(decideCourseRouteVerification(submitted("unavailable"), old, available, enabled)).toEqual({
          kind: "unavailable", status: "missing", exerciseKeys: [], rubric: "标准", missingReasons: ["尚未确认本要求的题目与判定标准"],
        });
      }
    });
    for (const kind of ["rubric", "manual"] as const) {
      it(`preserves only matching confirmed ${kind} (sources=${available}, exact=${enabled})`, () => {
        const previous = { ...submitted(kind, "  标准\n  一 "), exerciseKeys: ["server"], missingReasons: [] };
        expect(decideCourseRouteVerification(submitted(kind, "标准 一"), previous, available, enabled)).toEqual(previous);
        for (const old of [null, { ...previous, status: "needs_check" as const }, { ...previous, kind: "exact" as const }, { ...previous, rubric: "旧标准" }]) {
          expect(decideCourseRouteVerification(submitted(kind, "标准 一"), old, available, enabled)).toMatchObject({
            kind, status: "needs_check", exerciseKeys: [], rubric: "标准 一",
          });
          expect(decideCourseRouteVerification(submitted(kind, "标准 一"), old, available, enabled).missingReasons).not.toEqual(["forged"]);
        }
      });
    }
    it(`derives exact readiness from capability and sources (sources=${available}, exact=${enabled})`, () => {
      for (const old of [null, submitted("exact"), submitted("exact", "旧标准"), submitted("rubric", "其他")]) {
        const result = decideCourseRouteVerification(submitted("exact"), old, available, enabled);
        expect(result).toMatchObject({ kind: "exact", status: enabled && available ? "ready" : "missing", exerciseKeys: [], rubric: "标准" });
        expect(result.missingReasons.length).toBe(enabled && available ? 0 : 1);
        expect(result.missingReasons).not.toContain("forged");
      }
    });
  }
});

describe("unchanged stored verification", () => {
  const oldReason = ["尚未提供验证题目或评分标准"];
  it.each([
    { kind: "unavailable" as const, status: "missing" as const, rubric: null, enabled: false },
    { kind: "rubric" as const, status: "needs_check" as const, rubric: "  标准  ", enabled: false },
    { kind: "manual" as const, status: "needs_check" as const, rubric: "  标准  ", enabled: false },
    { kind: "exact" as const, status: "missing" as const, rubric: "标准", enabled: false },
  ])("preserves old reason for $kind/$status", ({ kind, status, rubric, enabled }) => {
    const previous: Verification = { kind, status, rubric, exerciseKeys: [], missingReasons: oldReason };
    expect(decideCourseRouteVerification(submitted(kind, rubric?.trim() ?? null), previous, true, enabled)).toEqual(previous);
  });
  it("normalizes a non-ready row with exercise keys", () => {
    const previous: Verification = { kind: "rubric", status: "needs_check", rubric: "标准", exerciseKeys: ["forged"], missingReasons: oldReason };
    expect(decideCourseRouteVerification(submitted("rubric"), previous, true, false)).toEqual({
      kind: "rubric", status: "needs_check", rubric: "标准", exerciseKeys: [], missingReasons: ["请先确认本要求的题目与判定标准"],
    });
  });
  it("normalizes an incorrect status", () => {
    const previous: Verification = { kind: "rubric", status: "missing", rubric: "标准", exerciseKeys: [], missingReasons: oldReason };
    expect(decideCourseRouteVerification(submitted("rubric"), previous, true, false)).toMatchObject({ status: "needs_check", exerciseKeys: [], missingReasons: ["请先确认本要求的题目与判定标准"] });
  });
  it("normalizes a changed rubric", () => {
    const previous: Verification = { kind: "rubric", status: "needs_check", rubric: "旧标准", exerciseKeys: [], missingReasons: oldReason };
    expect(decideCourseRouteVerification(submitted("rubric"), previous, true, false)).toMatchObject({ status: "needs_check", rubric: "标准", exerciseKeys: [], missingReasons: ["请先确认本要求的题目与判定标准"] });
  });
  it("enables exact when capability and sources become available", () => {
    const previous: Verification = { kind: "exact", status: "missing", rubric: "标准", exerciseKeys: [], missingReasons: oldReason };
    expect(decideCourseRouteVerification(submitted("exact"), previous, true, true)).toEqual({ kind: "exact", status: "ready", rubric: "标准", exerciseKeys: [], missingReasons: [] });
  });
  it("preserves ready when both rubrics are null, but not when only one is null", () => {
    const previous: Verification = { kind: "rubric", status: "ready", rubric: null, exerciseKeys: ["server"], missingReasons: [] };
    expect(decideCourseRouteVerification(submitted("rubric", null), previous, true, false)).toEqual(previous);
    expect(decideCourseRouteVerification(submitted("rubric", "标准"), previous, true, false)).toMatchObject({ status: "needs_check", exerciseKeys: [] });
    expect(decideCourseRouteVerification(submitted("rubric", null), { ...previous, rubric: "标准" }, true, false)).toMatchObject({ status: "needs_check", exerciseKeys: [] });
  });
});
