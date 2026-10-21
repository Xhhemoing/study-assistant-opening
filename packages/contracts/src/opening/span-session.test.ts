import { expect, it } from "vitest";
import { spanLessonCreateInputSchema, spanLessonSaveInputSchema, spanLessonSnapshotSchema } from "./span-session";
const id = "11111111-1111-4111-8111-111111111111";
const intent = { purpose: "self_study", timeBudgetMinutes: 15, language: "bilingual", pace: "normal", continuous: true, selfReportedFatigue: "unknown" };
const create = { courseId: id, sourceIds: [id], intent, clientKey: "span-session-1" };
it("accepts an explicit course/material/intent identity without accepting client session IDs", () => {
  expect(spanLessonCreateInputSchema.parse(create)).toEqual(create);
  expect(spanLessonCreateInputSchema.safeParse({ ...create, sessionId: id }).success).toBe(false);
  expect(spanLessonCreateInputSchema.safeParse({ ...create, sourceIds: [] }).success).toBe(false);
  expect(spanLessonCreateInputSchema.safeParse({ ...create, sourceIds: [id, id] }).success).toBe(false);
});
it("rejects invalid intent, malformed retest identity and unbounded client keys", () => {
  expect(spanLessonCreateInputSchema.safeParse({ ...create, retestId: "next week" }).success).toBe(false);
  expect(spanLessonCreateInputSchema.safeParse({ ...create, intent: { ...intent, timeBudgetMinutes: 0 } }).success).toBe(false);
  expect(spanLessonCreateInputSchema.safeParse({ ...create, clientKey: "x".repeat(161) }).success).toBe(false);
});
it("requires a positive compare-and-set revision and a real supported move", () => {
  const save = { intent, moveId: "self-faded", status: "paused", expectedRevision: 1 };
  expect(spanLessonSaveInputSchema.parse(save)).toEqual(save);
  expect(spanLessonSaveInputSchema.safeParse({ ...save, expectedRevision: 0 }).success).toBe(false);
  expect(spanLessonSaveInputSchema.safeParse({ ...save, moveId: "complete-with-full-mastery" }).success).toBe(false);
  expect(spanLessonSaveInputSchema.safeParse({ ...save, status: "mastered" }).success).toBe(false);
});
it("keeps server session/activity IDs and completion separate from mastery", () => {
  const state = { activityId: id, sessionId: id, courseId: id, sourceIds: [id], intent, moveId: "self_study-reserved", status: "completed", revision: 3, retestId: null,
    createdAt: "2026-10-21T00:00:00Z", updatedAt: "2026-10-21T00:15:00Z" };
  expect(spanLessonSnapshotSchema.parse(state)).toEqual(state);
  expect(spanLessonSnapshotSchema.safeParse({ ...state, mastered: true }).success).toBe(false);
});
