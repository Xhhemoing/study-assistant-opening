import { describe, expect, it } from "vitest";
import { builtInLessonsForCourse, courseMatchesLinearAlgebra } from "./built-in-lessons";

const id = "11111111-1111-4111-8111-111111111111";
describe("built-in lessons follow the course subject", () => {
  it("offers the linear-algebra lessons only to linear-algebra courses", () => {
    expect(courseMatchesLinearAlgebra({ title: "线性代数（下）", description: "" })).toBe(true);
    expect(courseMatchesLinearAlgebra({ title: "MATH 2210", description: "Intro to Linear Algebra" })).toBe(true);
    expect(courseMatchesLinearAlgebra({ title: "Span 完整流程验收", description: "" })).toBe(true);
    expect(builtInLessonsForCourse(id, { title: "矩阵论" }).map(lesson => lesson.id)).toEqual(["span", "matrix"]);
  });
  it("offers nothing to unrelated courses", () => {
    expect(builtInLessonsForCourse(id, { title: "大学英语四级", description: "词汇与阅读" })).toEqual([]);
    expect(builtInLessonsForCourse(id, { title: "中国近代史纲要", description: null })).toEqual([]);
    expect(builtInLessonsForCourse(id, null)).toEqual([]);
  });
});
