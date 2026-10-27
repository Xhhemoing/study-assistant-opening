import { describe, expect, it } from "vitest";
import { coursePath, normalizeCourseSlug } from "./course-model";

describe("course model", () => {
  it("normalizes an editable slug to lowercase kebab-case", () => {
    expect(normalizeCourseSlug("  Calculus 101  ")).toBe("calculus-101");
    expect(normalizeCourseSlug("高等数学")).toBe("");
  });

  it("builds an encoded detail route", () => {
    expect(coursePath("course/1")).toBe("/learn/courses/course%2F1");
  });
});
