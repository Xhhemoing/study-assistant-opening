import { describe, expect, it } from "vitest";
import { courseStudyStandaloneActivity, parseCourseStudyPracticeEntry } from "./course-study-query";

const activity = "11111111-1111-4111-8111-111111111111";
const task = "22222222-2222-4222-8222-222222222222";

describe("explicit course practice entry", () => {
  it("preserves normal course resume and accepts an exact matrix transfer variant", () => {
    expect(parseCourseStudyPracticeEntry({ activity })).toEqual({});
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

it("keeps task/activity pairs on the task-validated entry instead of the standalone span dispatcher", () => {
  expect(parseCourseStudyPracticeEntry({ task, activity })).toEqual({});
  expect(courseStudyStandaloneActivity({ activity })).toBe(activity);
  for (const query of [{ activity, task }, { activity, retest: task }, { activity, task: "" }, { activity, after: task },
    { activity, mode: "practice" }, { activity: "not-a-uuid" }]) {
    expect(courseStudyStandaloneActivity(query)).toBeUndefined();
  }
});

it.each([
  { activity: "bad" }, { activity, task: "bad" }, { activity, task: "" }, { task: "" },
  { task, after: activity }, { activity, after: task }, { retest: "bad" },
  { task, mode: "practice" }, { task, mode: "matrix", exercise: "multiplication" },
])("rejects malformed/conflicting target parameters instead of opening a different flow: %j", query => {
  expect(parseCourseStudyPracticeEntry(query)).toHaveProperty("practiceEntryError");
  expect(parseCourseStudyPracticeEntry(query)).not.toHaveProperty("initialMode");
});
