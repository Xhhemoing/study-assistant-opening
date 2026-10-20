import { describe, expect, it } from "vitest";
import { parseCourseStudyPracticeEntry } from "./course-study-query";

describe("explicit course practice entry", () => {
  it("preserves normal course resume and accepts an exact matrix transfer variant", () => {
    expect(parseCourseStudyPracticeEntry({ activity: "existing" })).toEqual({});
    expect(parseCourseStudyPracticeEntry({ mode: "matrix", exercise: "multiplication", variant: "2" })).toEqual({ initialMode: "matrix", initialMatrixKey: "multiplication", initialMatrixVariant: 2 });
  });
  it.each([
    { mode: "matrix", variant: "9" }, { mode: "matrix", variant: "1.5" }, { mode: "practice", exercise: "addition" },
    { mode: "matrix", exercise: "invented" }, { mode: "practice", activity: "existing" }, { mode: "matrix", after: "ended" },
    { exercise: "multiplication" }, { mode: "other" },
  ])("refuses an invalid or conflicting entry without choosing a replacement activity: %j", query => {
    expect(parseCourseStudyPracticeEntry(query)).toHaveProperty("practiceEntryError");
    expect(parseCourseStudyPracticeEntry(query)).not.toHaveProperty("initialMode");
  });
});

it("carries the exact skill and requirement into explicit practice, refusing activity resumption", () => {
  expect(parseCourseStudyPracticeEntry({ mode: "practice", skillLabel: "span", requirementKey: "span:v1" })).toMatchObject({ initialMode: "practice", initialFocus: { skillLabel: "span", requirementKey: "span:v1" } });
  expect(parseCourseStudyPracticeEntry({ mode: "practice", skillLabel: "span", activity: "other" })).toHaveProperty("practiceEntryError");
  expect(parseCourseStudyPracticeEntry({ mode: "practice", requirementKey: "missing-skill" })).toHaveProperty("practiceEntryError");
  expect(parseCourseStudyPracticeEntry({ mode: "matrix", skillLabel: "span" })).toHaveProperty("practiceEntryError");
});
