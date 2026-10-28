import { expect, it } from "vitest";
import { normalizeLearningCapacityActivities } from "./opening-learning-capacity";
import { calculateSpanTutorBudgetUsage } from "./opening-span-tutor-budget";
const day = { localDate: "2026-11-01", timeZone: "America/Los_Angeles" };
it("uses one activity reservation across two goals and actual stopped card time", () => {
  const rows = normalizeLearningCapacityActivities([
    { id: "a", created_at: "2026-11-01T12:00:00Z", create_intent: {}, goal_json: { learningBudget: { ...day, minutes: 20, goalIds: ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"] } } },
    { id: "b", created_at: "2026-11-01T12:00:00Z", status: "completed", create_intent: { protocol: "card-review-session-v1" },
      goal_json: { learningBudget: { ...day, minutes: 15 } }, checkpoint_json: { cardReviewSession: { elapsedSeconds: 180, stoppedAt: "2026-11-01T12:05:00Z" } } },
  ]);
  expect(calculateSpanTutorBudgetUsage(day, rows, [], [])).toBe(23);
});
it("preserves a ninety-second card stop as exactly one and a half minutes", () => {
  const rows = normalizeLearningCapacityActivities([{ id: "b", created_at: "2026-11-01T12:00:00Z", create_intent: { protocol: "card-review-session-v1" },
    goal_json: { learningBudget: { ...day, minutes: 10 } }, checkpoint_json: { cardReviewSession: { elapsedSeconds: 90, stoppedAt: "2026-11-01T12:02:00Z" } } }]);
  expect(calculateSpanTutorBudgetUsage(day, rows, [], [])).toBe(1.5);
});
it("does not charge synthetic legacy course cursors with no actual activity", () => {
  expect(normalizeLearningCapacityActivities([{ id: "a", create_intent: { legacy: true } }])).toEqual([]);
});
it("does not double-charge the same accepted interval restored under two day rows", () => {
  const block = { taskId: "t", start: "2026-11-01T12:00:00Z", end: "2026-11-01T12:20:00Z" };
  expect(calculateSpanTutorBudgetUsage(day, [], [], [block, block])).toBe(20);
});
it("charges two goal activities linked to the same task only once", () => {
  const rows = normalizeLearningCapacityActivities(["a", "b"].map(id => ({ id, created_at: "2026-11-01T12:00:00Z", create_intent: { source: "task", taskId: "t" },
    goal_json: { learningBudget: { ...day, minutes: 20 } } })));
  expect(calculateSpanTutorBudgetUsage(day, rows, [{ id: "t", minutes: 20, status: "pending", due_at: "2026-11-01T12:00:00Z" }], [])).toBe(20);
});
