import { expect, it } from "vitest";
import type { TeachingActivity } from "@aistudy/contracts";
import { currentCourseActivity, courseStudyActivities } from "./course-study-model";
const activity = (id: string, overrides: Partial<TeachingActivity> = {}) => ({ id, courseId: "course", status: "active", updatedAt: "2026-11-01T00:00:00Z", intentKind: "topic", contentVersion: 1, ...overrides }) as TeachingActivity;
it("shares descending tie order for course history and current selection", () => {
  const rows = [activity("a"), activity("z")];
  expect(currentCourseActivity(rows, "course")?.id).toBe("z");
  expect(courseStudyActivities(rows, "course").map(row => row.id)).toEqual(["z", "a"]);
});
it("retains qualified static lessons in current and history but not checkpoint-shaped shells", () => {
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const lesson = activity("lesson", { intentKind: "course_continue", contentVersion: 0, staticLesson: { protocol: "span-lesson-v1", sessionId } });
  const shell = activity("shell", { intentKind: "course_continue", contentVersion: 0, checkpointJson: { spanLesson: { sessionId } } });
  expect(currentCourseActivity([lesson, shell], "course")).toEqual(lesson);
  expect(courseStudyActivities([lesson, shell], "course")).toEqual([lesson]);
  expect(currentCourseActivity([lesson], "other-course")).toBeNull();
});
it("keeps the legacy two-argument call and rejects invalid explicit references without fallback", () => {
  const rows = [activity("old"), activity("new", { updatedAt: "2026-11-02T00:00:00Z" }), activity("done", { status: "completed" }), activity("shell", { intentKind: "course_continue", contentVersion: 0 })];
  expect(currentCourseActivity(rows, "course")?.id).toBe("new");
  expect(currentCourseActivity(rows, "course", ["old"])?.id).toBe("old");
  for (const refs of [["missing"], ["old", "new"], ["done"], ["shell"]]) expect(currentCourseActivity(rows, "course", refs)).toBeNull();
});
