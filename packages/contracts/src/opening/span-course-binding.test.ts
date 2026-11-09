import { describe, expect, it } from "vitest";
import { spanCourseBindingSchema } from "./span-course-binding";
const id = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const third = "00000000-0000-4000-8000-000000000003";
const requirement = { id, revision: 1, stableSkillId: other, requirementKey: "span:linear-combination:v1" };
const binding = { version: 1, origin: "confirmed_course_route", courseId: id, routeActivityId: other,
  goalId: third, goalRevision: 1, requirement };
describe("span course binding snapshot", () => {
  it("accepts the strict R1 snapshot without changing scoring specs", () => {
    expect(spanCourseBindingSchema.parse(binding)).toEqual(binding);
  });
  it("rejects unsupported versions, missing identities and client authority fields", () => {
    for (const value of [{ ...binding, version: 2 }, { ...binding, goalRevision: 0 }, { ...binding, routeActivityId: undefined },
      { ...binding, trusted: true }, { ...binding, requirement: { ...requirement, revision: 0 } },
      { ...binding, requirement: { ...requirement, status: "ready" } }])
      expect(spanCourseBindingSchema.safeParse(value).success).toBe(false);
  });
  it("reserves only paired, distinct R2 identities, without granting execution", () => {
    const returnTarget = { ...requirement, id: other, stableSkillId: third };
    expect(spanCourseBindingSchema.parse({ ...binding, returnTarget, relationSource: "confirmed_course_requirement" }).returnTarget).toEqual(returnTarget);
    for (const value of [{ ...binding, returnTarget }, { ...binding, relationSource: "confirmed_course_requirement" },
      { ...binding, returnTarget: requirement, relationSource: "confirmed_course_requirement" },
      { ...binding, returnTarget: { ...returnTarget, stableSkillId: requirement.stableSkillId }, relationSource: "confirmed_course_requirement" }])
      expect(spanCourseBindingSchema.safeParse(value).success).toBe(false);
  });
});
