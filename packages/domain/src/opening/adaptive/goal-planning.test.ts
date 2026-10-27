import { describe, expect, it } from "vitest";
import type { CourseGoal, SuggestedTask, TaskItem } from "@aistudy/contracts";
import { proposeAdaptiveTasks } from "./propose-tasks";
import { rankForPlan } from "./rank-for-plan";
import { suggestionIdentity, type CourseSignal, type LearnerSnapshot } from "./types";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const a = id(901), b = id(902);
const date = "2026-10-17", now = new Date("2026-10-17T07:00:00Z");
const goal = (changes: Partial<CourseGoal> = {}): CourseGoal => ({ targetDate: null, weeklyMinutes: 0, ...changes });
const task = (n: number, changes: Partial<TaskItem> = {}): TaskItem => ({
  id: id(n), title: `任务 ${n}`, minutes: 25, dueAt: null, priority: 1, status: "pending", ...changes,
});
const suggestion = (n: number, courseId: string): SuggestedTask => ({
  id: id(n), key: `suggestion-${n}`, title: `建议 ${n}`, minutes: 25, courseId, skillLabel: "积分",
  kind: "weak_skill", reasonCode: "weak_skill", reason: "积分需要练习",
});
const course = (courseId: string, changes: Partial<CourseSignal> = {}): CourseSignal => ({
  courseId, title: courseId, goal: null, minutesThisWeek: 0, nextSkills: ["积分"], skills: [], hasUsableMaterials: true, ...changes,
});
const snapshot = (courses: CourseSignal[]): LearnerSnapshot => ({ date, timeZone: "America/Los_Angeles", courses, dueCardCount: 0, plannerHistory: [] });
const propose = (value: LearnerSnapshot, changes: Partial<Parameters<typeof proposeAdaptiveTasks>[1]> = {}) =>
  proposeAdaptiveTasks(value, { autonomy: "copilot", capacityMinutes: 100, committedMinutes: 0, pendingTasks: [], idFor: key => key, ...changes }).suggestions;

describe("goal-aware planning", () => {
  it("promotes imminent study ahead of carry-over without overtaking real deadlines", () => {
    const result = rankForPlan({
      tasks: [task(1, { courseId: b }), task(2, { dueAt: "2026-10-18T06:00:00Z" }),
        task(3, { dueAt: "2026-10-16T20:00:00Z" })],
      suggestions: [suggestion(4, a)], courseGoals: { [a]: goal({ targetDate: "2026-10-19" }) },
      yesterdayAccepted: [{ taskId: id(1), start: "2026-10-16T20:00:00Z", end: "2026-10-16T20:25:00Z", reason: "昨天" }],
      date, now, timeZone: "America/Los_Angeles",
    });
    expect(result.orderedTaskIds).toEqual([id(3), id(2), id(4), id(1)]);
    expect(result.reasons[id(2)]?.code).toBe("deadline");
    expect(result.reasons[id(4)]?.code).toBe("goal_priority");
  });

  it("keeps explicit priorities meaningful and does not force course switches in a focused run", () => {
    const result = rankForPlan({ tasks: [task(1, { courseId: a }), task(2, { courseId: a }), task(3, { courseId: a }), task(4, { courseId: b })],
      suggestions: [], yesterdayAccepted: [], date, now, timeZone: "UTC",
      courseGoals: { [a]: goal({ priority: 2 }), [b]: goal({ targetDate: "2026-10-18" }) },
    });
    expect(result.orderedTaskIds).toEqual([id(1), id(2), id(3), id(4)]);
  });

  it("never brings a future retest forward or revives it through a suggestion id", () => {
    const result = rankForPlan({ tasks: [task(1, { courseId: a, notBefore: "2026-10-18T08:00:00Z" })],
      suggestions: [suggestion(1, a)], yesterdayAccepted: [], date, now, timeZone: "America/Los_Angeles",
      courseGoals: { [a]: goal({ targetDate: "2026-10-18", priority: 5 }) },
    });
    expect(result.orderedTaskIds).toEqual([]);
  });

  it("puts near goals before ordinary weak skills and uses a small exam block when time is short", () => {
    const snap = snapshot([course(b, { skills: [{ skillLabel: "级数", status: "needs_review", lastObservedAt: null, recentAssistance: [] }], nextSkills: [] }),
      course(a, { goal: goal({ kind: "final-exam", targetDate: "2026-10-20" }) })]);
    expect(propose(snap)[0]?.courseId).toBe(a);
    expect(propose(snap, { capacityMinutes: 20 })).toMatchObject([{ courseId: a, minutes: 16 }]);
    expect(propose(snap, { capacityMinutes: 12 })).toEqual([]);
    expect(propose(snapshot([course(a)]), { capacityMinutes: 20 })).toEqual([]);
  });
  it("prioritizes an ordinary deadline without treating it as a shortened exam block", () => {
    const snap = snapshot([course(a, { goal: goal({ kind: "custom", targetDate: "2026-10-20" }) })]);
    expect(propose(snap)).toMatchObject([{ courseId: a, minutes: 25 }]);
    expect(propose(snap, { capacityMinutes: 20 })).toEqual([]);
  });

  it("preserves same-day deduplication and requirement isolation under exam priority", () => {
    const snap = snapshot([course(a, { goal: goal({ targetDate: "2026-10-20" }), nextSkills: [], skills: ["calculate", "prove"].map(requirementKey => ({
      skillLabel: "极限", requirementKey, status: "needs_review", lastObservedAt: null, recentAssistance: [],
    })) })]);
    const withPending = propose(snap, { pendingTasks: [task(1, { courseId: a, skillLabel: "极限", requirementKey: "calculate" })] });
    expect(withPending).toMatchObject([{ requirementKey: "prove" }]);
    expect(propose({ ...snap, plannerHistory: [{ date, status: "done", identity: suggestionIdentity("weak_skill", a, "极限", "prove") }] }))
      .toMatchObject([{ requirementKey: "calculate" }]);
  });

  it("does not reserve low-goal work against a higher-goal suggestion", () => {
    const suggestions = propose(snapshot([course(a, { goal: goal({ priority: 3 }) }), course(b)]), {
      committedMinutes: 100, committedMinutesForCourse: courseId => courseId === a ? 0 : 100,
    });
    expect(suggestions).toMatchObject([{ courseId: a, minutes: 25 }]);
  });
});
