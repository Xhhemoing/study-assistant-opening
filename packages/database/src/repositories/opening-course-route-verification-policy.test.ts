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
