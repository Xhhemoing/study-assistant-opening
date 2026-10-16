/**
 * Seven planned days for one synthetic learner, run through the real pipeline
 * (snapshot → proposeAdaptiveTasks → rankForPlan → planDay → accept → scripted study),
 * checking the learning-loop behaviour metrics of docs/plans/2026-10-15-adaptive-learning-loop-v2.md.
 */
import { describe, expect, it } from "vitest";
import type { PlanningAutonomy, SuggestedTask, TaskItem, TimeBlock } from "@aistudy/contracts";
import { addLocalDays } from "../daily-draft";
import { planDay } from "../day-planner";
import {
  ADAPTIVE_STRATEGY_VERSION,
  decideCoachAutoAccept,
  parseSuggestionKey,
  proposeAdaptiveTasks,
  rankForPlan,
  stableHash,
  suggestionsAsTasks,
  taskCourseId,
  type CourseSignal,
  type LearnerSnapshot,
  type PlannerHistoryEntry,
  type SkillSignal,
} from "./index";

const tz = "Asia/Shanghai";
const START = "2026-10-19"; // Monday
const DAYS = 7;
const CAPACITY = 180; // 19:00–22:00 local
const calculus = "11111111-1111-4111-8111-111111111111";
const algebra = "22222222-2222-4222-8222-222222222222";

/** 19:00–22:00 Asia/Shanghai = 11:00–14:00Z. */
function freeBlocks(date: string): TimeBlock[] {
  return [{ start: `${date}T11:00:00.000Z`, end: `${date}T14:00:00.000Z`, kind: "free" }];
}

function uuidFrom(key: string): string {
  const hex = (stableHash(key) + stableHash(`${key}#2`) + stableHash(`${key}#3`) + stableHash(`${key}#4`)).slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

type DayRecord = {
  date: string;
  suggestions: SuggestedTask[];
  orderedTaskIds: string[];
  reasons: Record<string, { code: string; label: string }>;
  blocks: { taskId: string; start: string; end: string }[];
  unscheduled: string[];
  committedMinutes: number;
  coachAcceptKeys: string[] | null;
};

function simulate(autonomy: PlanningAutonomy): DayRecord[] {
  const limitId = "00000000-0000-4000-8000-000000000001";
  const homeworkId = "00000000-0000-4000-8000-000000000002";
  const tasks: TaskItem[] = [
    { id: limitId, title: "作业：极限习题", minutes: 40, dueAt: `${START}T12:30:00.000Z`, priority: 1, status: "pending" },
    { id: homeworkId, title: "整理笔记", minutes: 30, dueAt: null, priority: 1, status: "pending" },
  ];
  const keyOf = new Map<string, string>(); // task id → suggestion key
  let limitSkill: SkillSignal = { skillLabel: "极限", status: "needs_review", lastObservedAt: `${START}T00:00:00.000Z`, recentAssistance: ["hinted", "revealed"] };
  let dueCards = 12;
  const minutesThisWeek: Record<string, number> = { [calculus]: 0, [algebra]: 0 };
  const records: DayRecord[] = [];
  let yesterdayAccepted: { taskId: string; start: string; end: string; reason: string }[] = [];

  for (let day = 0; day < DAYS; day += 1) {
    const date = addLocalDays(START, day);
    const plannerHistory: PlannerHistoryEntry[] = tasks.flatMap((task) => {
      const parsed = keyOf.has(task.id) ? parseSuggestionKey(keyOf.get(task.id)!) : null;
      return parsed ? [{ date: parsed.date, identity: parsed.identity, status: task.status }] : [];
    });
    const courses: CourseSignal[] = [
      { courseId: calculus, title: "高等数学", skills: [limitSkill, { skillLabel: "连续", status: "observed_independent", lastObservedAt: null, recentAssistance: ["independent"] }],
        nextSkills: ["导数"], hasUsableMaterials: true, goal: { targetDate: addLocalDays(START, 14), weeklyMinutes: 300 }, minutesThisWeek: minutesThisWeek[calculus]! },
      { courseId: algebra, title: "线性代数", skills: [], nextSkills: ["矩阵乘法"], hasUsableMaterials: true, goal: null, minutesThisWeek: minutesThisWeek[algebra]! },
    ];
    const snapshot: LearnerSnapshot = { date, timeZone: tz, courses, dueCardCount: dueCards, plannerHistory };
    const pendingOwn = tasks.filter((task) => task.status === "pending" && !keyOf.has(task.id));
    const committedMinutes = pendingOwn.reduce((sum, task) => sum + task.minutes, 0);
    const { suggestions } = proposeAdaptiveTasks(snapshot, {
      autonomy, capacityMinutes: CAPACITY, committedMinutes, pendingTasks: tasks, idFor: uuidFrom,
    });
    const now = new Date(`${date}T10:00:00.000Z`);
    const ranked = rankForPlan({ tasks, suggestions, yesterdayAccepted, date, timeZone: tz, now });
    const planned = planDay([...tasks, ...suggestionsAsTasks(suggestions)], freeBlocks(date), {
      localDate: date, timeZone: tz, preferredOrder: ranked.orderedTaskIds,
    });
    const coach = decideCoachAutoAccept({
      autonomy, date, today: date, acceptedVersion: 0, acceptedOrigin: null,
      draft: { status: "draft", origin: "auto_draft", blocks: planned.blocks, suggestedTasks: suggestions }, budgetMinutes: 30,
    });
    records.push({
      date, suggestions, orderedTaskIds: ranked.orderedTaskIds, reasons: ranked.reasons,
      blocks: planned.blocks.map(({ taskId, start, end }) => ({ taskId, start, end })),
      unscheduled: planned.unscheduledTaskIds, committedMinutes,
      coachAcceptKeys: coach.allow ? coach.acceptKeys : null,
    });

    // Accept: every scheduled suggestion becomes a planner task.
    const scheduled = new Set(planned.blocks.map((block) => block.taskId));
    for (const suggestion of suggestions) {
      if (!scheduled.has(suggestion.id)) continue;
      keyOf.set(suggestion.id, suggestion.key);
      tasks.push({ ...suggestionsAsTasks([suggestion])[0]! });
    }
    yesterdayAccepted = planned.blocks;

    // Study script: the learner skips algebra's new topic every day and finishes everything else planned.
    for (const block of planned.blocks) {
      const task = tasks.find((item) => item.id === block.taskId)!;
      const suggestion = suggestions.find((item) => item.id === task.id);
      const skip = suggestion?.kind === "new_skill" && suggestion.courseId === algebra;
      task.status = skip ? "skipped" : "done";
      if (!skip) {
        const courseId = taskCourseId(task);
        if (courseId) minutesThisWeek[courseId] = (minutesThisWeek[courseId] ?? 0) + task.minutes;
        if (suggestion?.kind === "weak_skill" && suggestion.skillLabel === "极限") {
          limitSkill = { ...limitSkill, status: "observed_independent", recentAssistance: ["independent", ...limitSkill.recentAssistance] };
        }
        if (suggestion?.kind === "review_cards") dueCards = 0;
      }
    }
    dueCards += 3;
  }
  return records;
}

const minutesOf = (block: { start: string; end: string }) => (Date.parse(block.end) - Date.parse(block.start)) / 60_000;

describe("adaptive learning loop — 7-day simulation (copilot)", () => {
  const days = simulate("copilot");

  it("never plans past free time, and suggestions stay within 80% minus committed work", () => {
    for (const day of days) {
      expect(day.blocks.reduce((sum, block) => sum + minutesOf(block), 0)).toBeLessThanOrEqual(CAPACITY);
      const suggested = day.suggestions.reduce((sum, item) => sum + item.minutes, 0);
      expect(suggested).toBeLessThanOrEqual(Math.max(0, Math.floor(CAPACITY * 0.8) - day.committedMinutes));
      expect(day.suggestions.length).toBeLessThanOrEqual(3);
    }
  });

  it("puts today's deadline first in the order and in time", () => {
    const first = days[0]!;
    expect(first.orderedTaskIds[0]).toBe("00000000-0000-4000-8000-000000000001");
    expect(first.reasons[first.orderedTaskIds[0]!]?.code).toBe("deadline");
    expect(first.blocks.slice().sort((a, b) => a.start.localeCompare(b.start))[0]?.taskId).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("suggests the weak skill on day one and stops once it is observed independent", () => {
    const weak = (day: (typeof days)[number]) => day.suggestions.filter((s) => s.kind === "weak_skill" && s.skillLabel === "极限");
    expect(weak(days[0]!)).toHaveLength(1);
    const fixedOn = days.findIndex((day) => weak(day).length > 0 && day.blocks.some((block) => block.taskId === weak(day)[0]!.id));
    for (const day of days.slice(fixedOn + 1)) expect(weak(day)).toEqual([]);
  });

  it("schedules exactly one card review on every day with at least five due cards", () => {
    let dueCards = 12;
    for (const day of days) {
      const reviews = day.suggestions.filter((s) => s.kind === "review_cards");
      expect(reviews).toHaveLength(dueCards >= 5 ? 1 : 0);
      const done = reviews.length && day.blocks.some((block) => block.taskId === reviews[0]!.id);
      dueCards = (done ? 0 : dueCards) + 3;
    }
  });

  it("never orders three items of one course in a row outside the deadline group", () => {
    for (const day of days) {
      const courseOf = new Map(day.suggestions.map((s) => [s.id, s.courseId]));
      const sequence = day.orderedTaskIds.filter((taskId) => day.reasons[taskId]?.code !== "deadline").map((taskId) => courseOf.get(taskId) ?? null);
      for (let index = 2; index < sequence.length; index += 1) {
        const run = sequence.slice(index - 2, index + 1);
        expect(run[0] !== null && run.every((courseId) => courseId === run[0])).toBe(false);
      }
    }
  });

  it("halves a twice-skipped suggestion and drops it after three skips", () => {
    const algebraNew = (day: (typeof days)[number]) => day.suggestions.find((s) => s.kind === "new_skill" && s.courseId === algebra);
    const offered = days.map(algebraNew);
    const firstThree = offered.filter(Boolean).slice(0, 3);
    expect(firstThree.map((s) => s!.minutes)).toEqual([25, 25, 13]);
    expect(firstThree[2]?.reasonCode).toBe("repeatedly_skipped");
    const thirdIndex = offered.indexOf(firstThree[2]);
    expect(offered[thirdIndex + 1]).toBeUndefined();
  });

  it("gives every ordered item a reason and keeps the strategy version", () => {
    expect(ADAPTIVE_STRATEGY_VERSION).toBe("adaptive-2");
    for (const day of days) {
      for (const taskId of day.orderedTaskIds) expect(day.reasons[taskId]?.label.length).toBeGreaterThan(0);
    }
  });

  it("is deterministic", () => {
    expect(simulate("copilot")).toEqual(days);
  });
});

describe("adaptive learning loop — mode guards over 7 days", () => {
  it("manual mode never proposes a task", () => {
    for (const day of simulate("manual")) expect(day.suggestions).toEqual([]);
  });

  it("copilot never auto-accepts; coach adds at most its budget of scheduled suggestions", () => {
    for (const day of simulate("copilot")) expect(day.coachAcceptKeys).toBeNull();
    for (const day of simulate("coach")) {
      expect(day.coachAcceptKeys).not.toBeNull();
      const minutes = day.suggestions.filter((s) => day.coachAcceptKeys!.includes(s.key)).reduce((sum, s) => sum + s.minutes, 0);
      expect(minutes).toBeLessThanOrEqual(30);
      for (const key of day.coachAcceptKeys!) {
        const suggestion = day.suggestions.find((s) => s.key === key)!;
        expect(day.blocks.some((block) => block.taskId === suggestion.id)).toBe(true);
      }
    }
  });
});
