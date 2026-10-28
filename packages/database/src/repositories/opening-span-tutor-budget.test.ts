import { describe, expect, it } from "vitest";
import { calculateSpanTutorBudgetUsage } from "./opening-span-tutor-budget";
const day = { localDate: "2026-11-01", timeZone: "America/Los_Angeles" };
const task = { id: "t", minutes: 20, status: "pending", due_at: null, not_before: null,
  retest_id: "r", recommended_at: "2026-11-01T12:00:00Z", not_before_at: "2026-11-01T12:00:00Z", snoozed_until: null,
  learning_protocol: null };
describe("shared span tutor time budget", () => {
  it("counts a retest, its accepted block and its running lesson only once", () => {
    const activities = [{ id: "a", created_at: "2026-11-01T12:00:00Z", create_intent: { protocol: "span-lesson-v1", intent: { timeBudgetMinutes: 20 } },
      checkpoint_json: { spanLesson: { retestId: "r" } }, goal_json: {} }];
    const blocks = [{ taskId: "t", start: "2026-11-01T12:00:00Z", end: "2026-11-01T12:20:00Z" }];
    expect(calculateSpanTutorBudgetUsage(day, activities, [task], blocks)).toBe(20);
  });
  it("counts actual manual span duration alongside a future automated retest", () => {
    const activities = [{ id: "a", created_at: "2026-11-01T12:00:00Z", create_intent: { protocol: "span-lesson-v1", intent: { timeBudgetMinutes: 25 } }, checkpoint_json: {}, goal_json: {} }];
    expect(calculateSpanTutorBudgetUsage(day, activities, [task], [])).toBe(45);
  });
  it("does not guess an undated accepted retest's day", () => {
    expect(() => calculateSpanTutorBudgetUsage(day, [], [{ ...task, recommended_at: null, not_before_at: null }], []))
      .toThrow("日期");
  });
  it("respects postponement and does not count a closed unstarted task", () => {
    expect(calculateSpanTutorBudgetUsage(day, [], [{ ...task, snoozed_until: "2026-11-02T12:00:00Z" }], [])).toBe(0);
    expect(calculateSpanTutorBudgetUsage(day, [], [{ ...task, status: "skipped" }], [])).toBe(0);
  });
  it("counts a completed activity even when its task was closed, without adding a cancelled reservation", () => {
    const activities = [{ id: "a", created_at: "2026-11-01T12:00:00Z", create_intent: { taskId: "t" }, checkpoint_json: {},
      goal_json: { tutorBudget: { ...day, minutes: 20, grantRevision: 1 } } }];
    expect(calculateSpanTutorBudgetUsage(day, activities, [{ ...task, status: "skipped" }], [])).toBe(20);
  });
  it("counts an accepted block on the 25-hour DST day using real instants", () => {
    expect(calculateSpanTutorBudgetUsage(day, [], [{ ...task, retest_id: null, recommended_at: null, not_before_at: null }],
      [{ taskId: "t", start: "2026-11-02T07:30:00Z", end: "2026-11-02T08:00:00Z" }])).toBe(30);
  });
  it("refuses an activity with no trustworthy duration instead of assuming zero", () => {
    expect(() => calculateSpanTutorBudgetUsage(day, [{ id: "a", created_at: "2026-11-01T12:00:00Z", create_intent: {}, checkpoint_json: {}, goal_json: {} }], [], []))
      .toThrow("时长");
  });
});

it("resolves a restored stable retest alias before charging its lesson", () => {
  const activity = { id: "a", created_at: "2026-11-01T12:00:00Z", create_intent: { protocol: "span-lesson-v1", intent: { timeBudgetMinutes: 20 } },
    checkpoint_json: { spanLesson: { retestId: "original-candidate" } }, goal_json: {} };
  expect(calculateSpanTutorBudgetUsage(day, [activity], [{ ...task, candidate_id: null, candidate_reference_id: "original-candidate" }], [])).toBe(20);
});

it.each([false, true])("charges a moved retest on its scheduled day even with original automation metadata (%s)", automated => {
  const moved = { ...task, recommended_at: "2026-10-31T12:00:00Z", not_before_at: "2026-10-31T12:00:00Z",
    scheduled_start_at: "2026-11-01T12:00:00Z", learning_protocol: automated ? { tutorAutomation: {
      localDate: "2026-10-31", timeZone: day.timeZone, minutes: 20, grantRevision: 1, createdTaskVersion: 1,
    } } : null };
  expect(calculateSpanTutorBudgetUsage(day, [], [moved], [])).toBe(20);
  expect(calculateSpanTutorBudgetUsage({ ...day, localDate: "2026-10-31" }, [], [moved], [])).toBe(0);
});
