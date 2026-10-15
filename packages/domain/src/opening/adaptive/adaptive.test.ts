import { describe, expect, it } from "vitest";
import type { PlannedBlock, SuggestedTask, TaskItem } from "@aistudy/contracts";
import {
  autonomyGuidanceMode,
  decideCoachAutoAccept,
  interleaveCourses,
  isCourseBehind,
  parseSuggestionKey,
  proposeAdaptiveTasks,
  rankForPlan,
  shouldOfferReplan,
  suggestionIdentity,
  suggestionKey,
  type CourseSignal,
  type LearnerSnapshot,
} from "./index";

const tz = "Asia/Shanghai";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const courseA = id(901), courseB = id(902);
let nextId = 500;
const idFor = () => id(nextId++);

const course = (overrides: Partial<CourseSignal> = {}): CourseSignal => ({
  courseId: courseA, title: "高等数学", skills: [], nextSkills: [], hasUsableMaterials: true,
  goal: null, minutesThisWeek: 0, ...overrides,
});
const snapshot = (overrides: Partial<LearnerSnapshot> = {}): LearnerSnapshot => ({
  date: "2026-10-21", timeZone: tz, courses: [], dueCardCount: 0, plannerHistory: [], ...overrides,
});
const task = (n: number, overrides: Partial<TaskItem> = {}): TaskItem => ({
  id: id(n), title: `任务${n}`, minutes: 30, dueAt: null, priority: 1, status: "pending", ...overrides,
});
const propose = (snap: LearnerSnapshot, overrides: Partial<Parameters<typeof proposeAdaptiveTasks>[1]> = {}) =>
  proposeAdaptiveTasks(snap, { autonomy: "copilot", capacityMinutes: 180, committedMinutes: 0, pendingTasks: [], idFor, ...overrides }).suggestions;

describe("proposeAdaptiveTasks", () => {
  it("proposes nothing in manual mode", () => {
    expect(propose(snapshot({ dueCardCount: 20, courses: [course({ nextSkills: ["导数"] })] }), { autonomy: "manual" })).toEqual([]);
  });

  it("flags needs_review skills and skills leaning on hints, not independent ones", () => {
    const suggestions = propose(snapshot({ courses: [course({ skills: [
      { skillLabel: "极限", status: "needs_review", lastObservedAt: null, recentAssistance: [] },
      { skillLabel: "连续", status: "needs_check", lastObservedAt: null, recentAssistance: ["hinted", "revealed", "independent"] },
      { skillLabel: "求导", status: "needs_check", lastObservedAt: null, recentAssistance: ["hinted", "independent", "independent"] },
      { skillLabel: "积分", status: "observed_independent", lastObservedAt: null, recentAssistance: ["hinted", "hinted"] },
    ] })] }));
    expect(suggestions.map((s) => [s.kind, s.skillLabel])).toEqual([["weak_skill", "极限"], ["weak_skill", "连续"]]);
    expect(suggestions[0]).toMatchObject({ courseId: courseA, minutes: 25, reasonCode: "weak_skill", key: suggestionKey("2026-10-21", suggestionIdentity("weak_skill", courseA, "极限")) });
  });

  it("skips a skill that already has a pending task", () => {
    const suggestions = propose(
      snapshot({ courses: [course({ skills: [{ skillLabel: "极限", status: "needs_review", lastObservedAt: null, recentAssistance: [] }] })] }),
      { pendingTasks: [task(1, { courseId: courseA, skillLabel: "极限" })] },
    );
    expect(suggestions).toEqual([]);
  });

  it("merges due cards into one review task only from five cards", () => {
    expect(propose(snapshot({ dueCardCount: 4 }))).toEqual([]);
    expect(propose(snapshot({ dueCardCount: 12 }))).toMatchObject([{ kind: "review_cards", minutes: 12, courseId: null }]);
    expect(propose(snapshot({ dueCardCount: 80 }))[0]?.minutes).toBe(30);
  });

  it("caps count at three and minutes at 80% of capacity minus committed work", () => {
    const skills = ["a", "b", "c", "d"].map((label) => ({ skillLabel: label, status: "needs_review" as const, lastObservedAt: null, recentAssistance: [] }));
    expect(propose(snapshot({ courses: [course({ skills })] }))).toHaveLength(3);
    // floor(100 * 0.8) - 40 = 40 minutes: one 25-minute suggestion fits.
    expect(propose(snapshot({ courses: [course({ skills })] }), { capacityMinutes: 100, committedMinutes: 40 })).toHaveLength(1);
    expect(propose(snapshot({ courses: [course({ skills })] }), { capacityMinutes: 30, committedMinutes: 0 })).toEqual([]);
  });

  it("puts a course behind its weekly goal first and adds pace work when it has nothing else", () => {
    // Wednesday: 3/7 of 210 minutes = 90 expected.
    const behind = course({ courseId: courseB, title: "线性代数", goal: { targetDate: null, weeklyMinutes: 210 }, minutesThisWeek: 30 });
    expect(isCourseBehind(behind, "2026-10-21")).toBe(true);
    expect(isCourseBehind({ ...behind, minutesThisWeek: 90 }, "2026-10-21")).toBe(false);
    const suggestions = propose(snapshot({ courses: [course({ nextSkills: ["导数"] }), behind] }));
    expect(suggestions.map((s) => [s.kind, s.courseId])).toEqual([["course_pace", courseB], ["new_skill", courseA]]);
  });

  it("halves a suggestion skipped two days running and drops it after three", () => {
    const identity = suggestionIdentity("new_skill", courseA, "导数");
    const skipped = (date: string) => ({ date, identity, status: "skipped" as const });
    const base = snapshot({ courses: [course({ nextSkills: ["导数"] })] });
    expect(propose({ ...base, plannerHistory: [skipped("2026-10-20")] })[0]).toMatchObject({ minutes: 25, reasonCode: "new_skill" });
    expect(propose({ ...base, plannerHistory: [skipped("2026-10-20"), skipped("2026-10-19")] })[0])
      .toMatchObject({ minutes: 13, reasonCode: "repeatedly_skipped" });
    expect(propose({ ...base, plannerHistory: [skipped("2026-10-20"), skipped("2026-10-19"), skipped("2026-10-18")] })).toEqual([]);
    // A gap resets the streak.
    expect(propose({ ...base, plannerHistory: [skipped("2026-10-19"), skipped("2026-10-18")] })[0]?.minutes).toBe(25);
  });

  it("does not re-suggest an identity whose planner task is still pending", () => {
    const identity = suggestionIdentity("review_cards", null, null);
    expect(propose(snapshot({ dueCardCount: 9, plannerHistory: [{ date: "2026-10-20", identity, status: "pending" }] }))).toEqual([]);
  });

  it("round-trips suggestion keys", () => {
    const key = suggestionKey("2026-10-21", suggestionIdentity("weak_skill", courseA, "极限"));
    expect(parseSuggestionKey(key)).toEqual({ date: "2026-10-21", identity: suggestionIdentity("weak_skill", courseA, "极限") });
    expect(parseSuggestionKey("course-seed:x")).toBeNull();
  });
});

describe("rankForPlan", () => {
  const suggestion = (n: number, courseId: string | null): SuggestedTask => ({
    key: `planner:2026-10-21:s${n}`, id: id(n), kind: "weak_skill", title: `建议${n}`, minutes: 25,
    courseId, skillLabel: courseId ? `技能${n}` : null, reasonCode: "weak_skill", reason: `原因${n}`,
  });
  const yesterday = (n: number): PlannedBlock => ({ taskId: id(n), start: "2026-10-20T11:00:00.000Z", end: "2026-10-20T11:30:00.000Z", reason: "x" });

  it("orders deadlines, due retests, carry-over, own tasks, then suggestions, each with a reason", () => {
    const now = new Date("2026-10-21T02:00:00.000Z");
    const result = rankForPlan({
      tasks: [
        task(1),
        task(2, { dueAt: "2026-10-21T12:00:00.000Z" }),
        task(3, { retest: { candidateId: id(80), activityId: id(81), courseId: courseA, skillLabel: "极限", prompt: "重做", recommendedAt: "2026-10-21T01:00:00.000Z" } }),
        task(4),
        task(5, { status: "done" }),
        task(6, { notBefore: "2026-10-21T16:00:00.000Z" }),
      ],
      suggestions: [suggestion(7, null)],
      yesterdayAccepted: [yesterday(4), yesterday(5)],
      date: "2026-10-21", timeZone: tz, now,
    });
    expect(result.orderedTaskIds).toEqual([id(2), id(3), id(4), id(1), id(7)]);
    expect(result.reasons[id(2)]).toEqual({ code: "deadline", label: "今天截止" });
    expect(result.reasons[id(3)]?.code).toBe("retest_due");
    expect(result.reasons[id(4)]?.code).toBe("carry_over");
    expect(result.reasons[id(1)]?.code).toBe("pending_task");
    expect(result.reasons[id(7)]).toEqual({ code: "weak_skill", label: "原因7" });
  });

  it("marks a passed deadline as overdue", () => {
    const result = rankForPlan({ tasks: [task(1, { dueAt: "2026-10-21T01:00:00.000Z" })], suggestions: [], yesterdayAccepted: [],
      date: "2026-10-21", timeZone: tz, now: new Date("2026-10-21T02:00:00.000Z") });
    expect(result.reasons[id(1)]?.label).toBe("已逾期，优先处理");
  });

  it("never lets one course run more than two items", () => {
    const items = [courseA, courseA, courseA, courseB, null, courseA].map((courseId, index) => ({
      id: id(index), courseId, reason: { code: "pending_task" as const, label: "x" },
    }));
    expect(interleaveCourses(items).map((item) => item.courseId)).toEqual([courseA, courseA, courseB, courseA, null, courseA]);
  });

  it("does not let course alternation pull a lower band ahead of a higher band", () => {
    // Three A retests would invite a B pull-forward if bands were flat-merged;
    // B is only an own pending task, so it must stay after all retests.
    const result = rankForPlan({
      tasks: [
        task(1, { courseId: courseA, retest: { candidateId: id(80), activityId: id(81), courseId: courseA, skillLabel: "a1", prompt: "r1", recommendedAt: "2026-10-21T01:00:00.000Z" } }),
        task(2, { courseId: courseA, retest: { candidateId: id(82), activityId: id(83), courseId: courseA, skillLabel: "a2", prompt: "r2", recommendedAt: "2026-10-21T01:01:00.000Z" } }),
        task(3, { courseId: courseA, retest: { candidateId: id(84), activityId: id(85), courseId: courseA, skillLabel: "a3", prompt: "r3", recommendedAt: "2026-10-21T01:02:00.000Z" } }),
        task(4, { courseId: courseB, priority: 1 }),
      ],
      suggestions: [],
      yesterdayAccepted: [],
      date: "2026-10-21", timeZone: tz, now: new Date("2026-10-21T02:00:00.000Z"),
    });
    expect(result.orderedTaskIds).toEqual([id(1), id(2), id(3), id(4)]);
    expect(result.reasons[id(1)]?.code).toBe("retest_due");
    expect(result.reasons[id(4)]?.code).toBe("pending_task");
  });
});

describe("autonomy and coach", () => {
  const draft = (overrides: Partial<Parameters<typeof decideCoachAutoAccept>[0]["draft"]> = {}) => ({
    status: "draft" as const, origin: "auto_draft" as const,
    blocks: [id(1), id(2), id(3)].map((taskId) => ({ taskId, start: "2026-10-21T11:00:00.000Z", end: "2026-10-21T11:25:00.000Z", reason: "x" })),
    suggestedTasks: [1, 2, 3, 4].map((n) => ({
      key: `planner:2026-10-21:k${n}`, id: id(n), kind: "weak_skill" as const, title: "t", minutes: 25,
      courseId: null, skillLabel: null, reasonCode: "weak_skill" as const, reason: "r",
    })),
    ...overrides,
  });
  const decide = (overrides: Partial<Parameters<typeof decideCoachAutoAccept>[0]> = {}) => decideCoachAutoAccept({
    autonomy: "coach", date: "2026-10-21", today: "2026-10-21", acceptedVersion: 0, acceptedOrigin: null,
    draft: draft(), budgetMinutes: 60, ...overrides,
  });

  it("maps modes onto the existing guidance policy", () => {
    expect([autonomyGuidanceMode("manual"), autonomyGuidanceMode("copilot"), autonomyGuidanceMode("coach")]).toEqual(["free", "advisory", "coach"]);
  });

  it("admits scheduled suggestions in order within the budget", () => {
    // Suggestion 4 has no block, so it is never created; 60 minutes fit two 25-minute tasks.
    expect(decide()).toEqual({ allow: true, acceptKeys: ["planner:2026-10-21:k1", "planner:2026-10-21:k2"], addedMinutes: 50 });
  });

  it("refuses other modes, other days, model drafts and learner-confirmed plans", () => {
    expect(decide({ autonomy: "copilot" })).toEqual({ allow: false, reason: "not_coach" });
    expect(decide({ date: "2026-10-20" })).toEqual({ allow: false, reason: "not_today" });
    expect(decide({ draft: draft({ origin: "agent" }) })).toEqual({ allow: false, reason: "not_auto_draft" });
    expect(decide({ draft: draft({ status: "accepted" }) })).toEqual({ allow: false, reason: "not_open" });
    expect(decide({ acceptedVersion: 1, acceptedOrigin: "user" })).toEqual({ allow: false, reason: "user_confirmed" });
    expect(decide({ acceptedVersion: 1, acceptedOrigin: "coach" })).toMatchObject({ allow: true });
  });
});

describe("shouldOfferReplan", () => {
  const block = (n: number, start: string, end: string): PlannedBlock => ({ taskId: id(n), start, end, reason: "x" });

  it("offers when a confirmed block ended with its task still pending", () => {
    const result = shouldOfferReplan({
      acceptedBlocks: [block(1, "2026-10-21T11:00:00.000Z", "2026-10-21T11:30:00.000Z"), block(2, "2026-10-21T12:00:00.000Z", "2026-10-21T12:30:00.000Z")],
      tasks: [task(1), task(2), task(3)],
      now: new Date("2026-10-21T11:40:00.000Z"),
    });
    expect(result).toEqual({ offer: true, taskIds: [id(1), id(3)], reason: "missed_block" });
  });

  it("offers when finishing early frees a future block and work is unplanned", () => {
    const blocks = [block(1, "2026-10-21T12:00:00.000Z", "2026-10-21T12:30:00.000Z")];
    const now = new Date("2026-10-21T11:00:00.000Z");
    expect(shouldOfferReplan({ acceptedBlocks: blocks, tasks: [task(1, { status: "done" }), task(2)], now }))
      .toEqual({ offer: true, taskIds: [id(2)], reason: "freed_time" });
    expect(shouldOfferReplan({ acceptedBlocks: blocks, tasks: [task(1, { status: "done" })], now }).offer).toBe(false);
    expect(shouldOfferReplan({ acceptedBlocks: blocks, tasks: [task(1)], now }).offer).toBe(false);
  });
});
