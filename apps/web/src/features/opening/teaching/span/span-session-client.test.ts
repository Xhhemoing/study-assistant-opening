import { expect, it } from "vitest";
import { spanLessonDetailsSchema } from "./span-session-client";
const id = "11111111-1111-4111-8111-111111111111";
const snapshot = { activityId: id, sessionId: id, courseId: id, sourceIds: [id], intent: { purpose: "self_study", timeBudgetMinutes: 20, language: "zh", pace: "normal", continuous: true, selfReportedFatigue: "unknown" }, moveId: "self-example", status: "active", revision: 3, retestId: null, createdAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T00:00:00Z" };
const base = { session: null, attempts: [], observations: [], assistance: {} };
it("preserves an admitted origin change instead of silently dropping it before rendering", () => {
  const originChange = { reason: "evidence_changed", originSession: snapshot, observationId: id };
  expect(spanLessonDetailsSchema.parse({ ...base, originChange })).toHaveProperty("originChange", originChange);
});
it("accepts historical details without an origin change and an unavailable origin with no head", () => {
  expect(spanLessonDetailsSchema.safeParse(base).success).toBe(true);
  expect(spanLessonDetailsSchema.parse({ ...base, originChange: { reason: "source_unavailable", originSession: null, observationId: null } })).toHaveProperty("originChange.reason", "source_unavailable");
});
it.each([
  { reason: "other", originSession: null, observationId: null },
  { reason: "evidence_changed", originSession: snapshot, observationId: "not-an-id" },
  { reason: "evidence_changed", originSession: { ...snapshot, revision: "old" }, observationId: id },
])("rejects unstructured change facts before a next-action request %j", originChange => {
  expect(spanLessonDetailsSchema.safeParse({ ...base, originChange }).success).toBe(false);
});
