import { describe, expect, it } from "vitest";
import type { CourseGoal, CourseMilestone } from "@aistudy/contracts";
import { localDateKeyInZone } from "../daily-draft";
import { goalPlanningPriority, goalPlanningReason, resolveGoalLearningContext } from "./goal-policy";

const goal = (changes: Partial<CourseGoal> = {}): CourseGoal => ({ targetDate: null, weeklyMinutes: 180, kind: "final-exam", ...changes });
const milestone = (targetDate: string, status: CourseMilestone["status"] = "planned"): CourseMilestone => ({
  id: "00000000-0000-4000-8000-000000000001", title: "测验", successCriteria: "完成独立测验",
  targetDate, status, revision: 1, confirmedAt: null, evidenceRefs: [], history: [],
});

describe("goal execution policy", () => {
  it("keeps ordinary deadlines out of automatic exam mode", () => {
    expect(resolveGoalLearningContext(goal({ kind: "custom", targetDate: "2026-10-18" }), "2026-10-17").mode).toBe("understand");
    expect(resolveGoalLearningContext({ targetDate: "2026-10-18", weeklyMinutes: 20 }, "2026-10-17").mode).toBe("understand");
  });
  it("keeps missing and historical undated goals in understanding mode without priority", () => {
    for (const value of [null, goal()]) {
      const context = resolveGoalLearningContext(value, "2026-10-17");
      expect(context).toMatchObject({ mode: "understand", reasonCode: "long_term", targetDate: null,
        daysRemaining: null, priority: 0, prerequisiteBudgetMinutes: 10 });
      expect(goalPlanningPriority(context)).toBe(0);
    }
  });

  it("uses the closest active main target or unconfirmed milestone", () => {
    expect(resolveGoalLearningContext(goal({ targetDate: "2026-11-17", milestones: [
      milestone("2026-10-18", "confirmed_by_learner"), milestone("2026-10-16"), milestone("2026-10-21"),
    ] }), "2026-10-17")).toMatchObject({ mode: "exam", targetDate: "2026-10-21", daysRemaining: 4, prerequisiteBudgetMinutes: 5 });
  });

  it("does not keep an expired target artificially urgent", () => {
    const context = resolveGoalLearningContext(goal({ targetDate: "2026-10-16" }), "2026-10-17");
    expect(context).toMatchObject({ mode: "understand", targetDate: null, daysRemaining: null });
    expect(goalPlanningPriority(context)).toBe(0);
    expect(resolveGoalLearningContext(goal({ targetDate: "2026-10-16", learningMode: "exam" }), "2026-10-17").mode).toBe("exam");
  });

  it("honors explicit teaching mode while still recognizing an imminent goal", () => {
    const context = resolveGoalLearningContext(goal({ targetDate: "2026-10-20", learningMode: "understand", priority: 3 }), "2026-10-17");
    expect(context).toMatchObject({ mode: "understand", reasonCode: "selected_understand", prerequisiteBudgetMinutes: 10 });
    expect(goalPlanningPriority(context)).toBeGreaterThan(0);
    expect(goalPlanningReason(context)).toContain("理解与应用");
    expect(goalPlanningReason(context)).not.toContain("应试");
    expect(resolveGoalLearningContext(goal({ learningMode: "exam" }), "2026-10-17").reasonCode).toBe("selected_exam");
  });

  it("uses local calendar days across timezone and DST boundaries", () => {
    const local = localDateKeyInZone(new Date("2026-11-01T06:30:00Z"), "America/Los_Angeles");
    expect(local).toBe("2026-10-31");
    expect(resolveGoalLearningContext(goal({ targetDate: "2026-11-14" }), local)).toMatchObject({ daysRemaining: 14, mode: "exam" });
    expect(resolveGoalLearningContext(goal({ targetDate: "2026-11-15" }), local)).toMatchObject({ daysRemaining: 15, mode: "understand" });
    expect(resolveGoalLearningContext(goal({ targetDate: local }), local).daysRemaining).toBe(0);
  });

  it("uses the same fourteen-day window for auto mode, planning priority and its reason", () => {
    const near = resolveGoalLearningContext(goal({ targetDate: "2026-10-31" }), "2026-10-17");
    expect(near).toMatchObject({ mode: "exam", reasonCode: "deadline_near", daysRemaining: 14 });
    expect(goalPlanningPriority(near)).toBe(5);
    expect(goalPlanningReason(near)).toContain("距离目标 14 天");
    const later = resolveGoalLearningContext(goal({ targetDate: "2026-11-01" }), "2026-10-17");
    expect(later).toMatchObject({ mode: "understand", reasonCode: "long_term", daysRemaining: 15 });
    expect(goalPlanningPriority(later)).toBe(0);
    expect(goalPlanningReason(later)).toBe("按当前学习目标优先安排");
  });
});
