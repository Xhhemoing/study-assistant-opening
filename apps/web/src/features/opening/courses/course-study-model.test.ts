import { expect, it } from "vitest";
import type { TeachingActivity } from "@aistudy/contracts";
import { pickCurrentTeachingActivity } from "../teaching/today-activity";
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
it("marks unavailable static retests and sessionless span-lesson shells as placeholders so valid activities are not shadowed", () => {
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const valid = activity("valid", { updatedAt: "2026-11-01T00:00:00Z" });
  const deadRetest = activity("dead-retest", {
    intentKind: "goal",
    contentVersion: 0,
    staticLessonUnavailable: "retest_unavailable",
    updatedAt: "2026-11-03T00:00:00Z",
  });
  const sessionlessSpan = activity("sessionless-span", {
    intentKind: "goal",
    contentVersion: 0,
    checkpointJson: { spanLesson: { sessionId } },
    updatedAt: "2026-11-04T00:00:00Z",
  });
  expect(currentCourseActivity([valid, deadRetest, sessionlessSpan], "course")).toEqual(valid);
  expect(courseStudyActivities([valid, deadRetest, sessionlessSpan], "course")).toEqual([valid]);
  expect(currentCourseActivity([deadRetest, sessionlessSpan], "course")).toBeNull();
  expect(currentCourseActivity([deadRetest], "course", ["dead-retest"])).toBeNull();
});

it("selects the identical course activity as pickCurrentTeachingActivity across fractional timestamps, tie-breaks, status mixes, and shells", () => {
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const earlier = activity("ffffffff-ffff-4fff-8fff-ffffffffffff", { status: "paused", updatedAt: "2026-11-17T10:00:00Z" });
  const laterLowerUuid = activity("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { status: "active", updatedAt: "2026-11-17T10:00:00.500Z" });
  const laterTieHigherUuid = activity("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", {
    status: "paused",
    intentKind: "course_continue",
    contentVersion: 0,
    staticLesson: { protocol: "span-lesson-v1", sessionId },
    updatedAt: "2026-11-17T10:00:00.5Z",
  });
  const shells = [
    activity("c1", { clientKey: "card-session:abc", updatedAt: "2026-11-17T11:00:00.000Z" }),
    activity("c2", { checkpointJson: { cardReviewSession: { elapsedSeconds: 30 } }, updatedAt: "2026-11-17T11:00:00.000Z" }),
    activity("c3", { clientKey: "legacy-course-continue:course", updatedAt: "2026-11-17T11:00:00.000Z" }),
    activity("c4", { clientKey: "span-lesson:missing", contentVersion: 0, updatedAt: "2026-11-17T11:00:00.000Z" }),
    activity("c5", { intentKind: "course_continue", contentVersion: 0, updatedAt: "2026-11-17T11:00:00.000Z" }),
    activity("c6", { staticLessonUnavailable: "retest_unavailable", updatedAt: "2026-11-17T11:00:00.000Z" }),
    activity("c7", { status: "completed", updatedAt: "2026-11-17T11:00:00.000Z" }),
  ];

  const rows = [earlier, laterLowerUuid, laterTieHigherUuid, ...shells];
  expect(currentCourseActivity(rows, "course")?.id).toBe(laterTieHigherUuid.id);
  expect(pickCurrentTeachingActivity(rows)?.id).toBe(laterTieHigherUuid.id);
  expect(courseStudyActivities(rows, "course").map(row => row.id)).toEqual([
    "c7",
    laterTieHigherUuid.id,
    laterLowerUuid.id,
    earlier.id,
  ]);
});
