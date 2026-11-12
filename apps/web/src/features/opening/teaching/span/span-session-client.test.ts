import { expect, it } from "vitest";
import { spanLessonDetailsSchema } from "./span-session-client";
const id = "11111111-1111-4111-8111-111111111111";
const snapshot = { activityId: id, sessionId: id, courseId: id, sourceIds: [id], intent: { purpose: "self_study", timeBudgetMinutes: 20, language: "zh", pace: "normal", continuous: true, selfReportedFatigue: "unknown" }, moveId: "self-example", status: "active", revision: 3, retestId: null, createdAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T00:00:00Z" };
const base = { session: null, attempts: [], observations: [], assistance: {} };
const requirement = { id, revision: 1, stableSkillId: id, requirementKey: "span:linear-combination:v1" };
const prerequisiteRepair = { version: 1, status: "ready", targetSkill: "equation", focusSummary: "核对原向量等式",
  prerequisiteRequirement: requirement, targetRequirement: { ...requirement, id: "22222222-2222-4222-8222-222222222222" },
  returnToRequirementId: "22222222-2222-4222-8222-222222222222" };
const executionUnavailable = { reasonCode: "SPAN_PREREQUISITE_EVIDENCE_CHANGED", message: "原证据变化，保留历史" };
it("preserves the exact B public context and refusal without synthesizing authority", () => {
  expect(spanLessonDetailsSchema.parse({ ...base, session: snapshot, prerequisiteRepair }).prerequisiteRepair).toEqual(prerequisiteRepair);
  expect(spanLessonDetailsSchema.parse({ ...base, executionUnavailable }).executionUnavailable).toEqual(executionUnavailable);
  const ordinary = spanLessonDetailsSchema.parse(base);
  expect(ordinary).not.toHaveProperty("prerequisiteRepair"); expect(ordinary).not.toHaveProperty("executionUnavailable");
});
it.each([
  { prerequisiteRepair, repair: { status: "ready", version: 1, contentVersion: 1, targetSkill: "equation", focusSummary: "本题", prerequisiteStatus: "unknown" } },
  { prerequisiteRepair, executionUnavailable },
  ...[0, 2, "1", null].map(version => ({ prerequisiteRepair: { ...prerequisiteRepair, version } })),
  { prerequisiteRepair: { ...prerequisiteRepair, targetSkill: "future" } },
  { prerequisiteRepair: { ...prerequisiteRepair, prerequisiteRequirement: { ...requirement, revision: 0 } } },
  { prerequisiteRepair: { ...prerequisiteRepair, teachingExample: { problemId: "hidden" } } },
  { prerequisiteRepair: {} }, { prerequisiteRepair: null },
  { executionUnavailable: { ...executionUnavailable, reasonCode: "unknown" } },
])("fails closed instead of stripping invalid/conflicting B into ordinary content: %j", marker => {
  expect(spanLessonDetailsSchema.safeParse({ ...base, session: snapshot, ...marker }).success).toBe(false);
});
it("preserves the optional targeted focus without changing legacy details", () => {
  const targetedFocus = "系数代入后，第3坐标没对上。";
  expect(spanLessonDetailsSchema.parse({ ...base, targetedFocus }).targetedFocus).toBe(targetedFocus);
  expect(spanLessonDetailsSchema.parse(base).targetedFocus).toBeUndefined();
});
it("preserves backend estimates, accepts legacy/null and rejects non-minute values", () => {
  expect(spanLessonDetailsSchema.parse({ ...base, estimateMinutes: 17 }).estimateMinutes).toBe(17);
  expect(spanLessonDetailsSchema.parse({ ...base, estimateMinutes: null }).estimateMinutes).toBeNull();
  expect(spanLessonDetailsSchema.parse(base).estimateMinutes).toBeUndefined();
  for (const estimateMinutes of [-1, 0, 1.5, 1441, "20"]) expect(spanLessonDetailsSchema.safeParse({ ...base, estimateMinutes }).success).toBe(false);
});
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
