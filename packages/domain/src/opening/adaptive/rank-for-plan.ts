import type { PlanBlockReason, PlannedBlock, SuggestedTask, TaskItem } from "@aistudy/contracts";
import { localDateKeyInZone } from "../daily-draft";
import { taskNotBeforeAt } from "../day-planner";
import { taskCourseId } from "./types";

export type RankForPlanInput = {
  tasks: readonly TaskItem[];
  suggestions: readonly SuggestedTask[];
  yesterdayAccepted: readonly PlannedBlock[];
  /** Local YYYY-MM-DD being planned. */
  date: string;
  timeZone: string;
  now: Date;
};

export type RankForPlanResult = {
  orderedTaskIds: string[];
  reasons: Record<string, PlanBlockReason>;
};

/** At most this many items of one course in a row (deadline items excluded). */
export const MAX_SAME_COURSE_RUN = 2;

type Ranked = { id: string; courseId: string | null; reason: PlanBlockReason };

function deadlineMs(task: TaskItem): number {
  return task.dueAt === null ? Number.POSITIVE_INFINITY : Date.parse(task.dueAt);
}

function compareOwnTasks(a: TaskItem, b: TaskItem): number {
  const dueA = deadlineMs(a), dueB = deadlineMs(b);
  if (dueA !== dueB) return dueA < dueB ? -1 : 1;
  if (a.priority !== b.priority) return a.priority > b.priority ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function deferredPastDay(task: TaskItem, date: string, timeZone: string): boolean {
  const notBefore = taskNotBeforeAt(task);
  return notBefore !== null && localDateKeyInZone(new Date(notBefore), timeZone) > date;
}

/**
 * Pull a later item forward whenever appending would make a run of more than
 * MAX_SAME_COURSE_RUN items from one course; keeps order otherwise (stable).
 */
export function interleaveCourses(items: readonly Ranked[]): Ranked[] {
  const rest = [...items];
  const out: Ranked[] = [];
  while (rest.length) {
    let index = 0;
    const tail = out.slice(-MAX_SAME_COURSE_RUN);
    const runCourse = tail.length === MAX_SAME_COURSE_RUN && tail.every((item) => item.courseId !== null && item.courseId === tail[0]!.courseId)
      ? tail[0]!.courseId
      : null;
    if (runCourse !== null && rest[0]!.courseId === runCourse) {
      const alternative = rest.findIndex((item) => item.courseId !== runCourse);
      if (alternative > 0) index = alternative;
    }
    out.push(rest.splice(index, 1)[0]!);
  }
  return out;
}

/**
 * Order for planDay's preferredOrder: deadlines (fixed, earliest first), due retests,
 * yesterday's carry-over, the learner's own pending tasks, then suggestions; courses
 * interleaved within each post-deadline band (never across bands). Every id gets a structured reason.
 */
export function rankForPlan(input: RankForPlanInput): RankForPlanResult {
  const { date, timeZone } = input;
  const pending = input.tasks.filter((task) => task.status === "pending" && !deferredPastDay(task, date, timeZone));
  const byId = new Map(pending.map((task) => [task.id, task]));
  const placed = new Set<string>();
  const take = (task: TaskItem, reason: PlanBlockReason): Ranked => {
    placed.add(task.id);
    return { id: task.id, courseId: taskCourseId(task), reason };
  };
  const nowMs = input.now.getTime();

  const deadlines = pending
    .filter((task) => task.dueAt !== null && localDateKeyInZone(new Date(task.dueAt), timeZone) <= date)
    .sort(compareOwnTasks)
    .map((task) => take(task, {
      code: "deadline",
      label: Date.parse(task.dueAt!) <= nowMs ? "已逾期，优先处理" : "今天截止",
    }));

  const retests = pending
    .filter((task) => !placed.has(task.id) && task.retest?.recommendedAt
      && localDateKeyInZone(new Date(task.retest.recommendedAt), timeZone) <= date)
    .sort((a, b) => Date.parse(a.retest!.recommendedAt!) - Date.parse(b.retest!.recommendedAt!) || compareOwnTasks(a, b))
    .map((task) => take(task, { code: "retest_due", label: "补测已到期" }));

  const carry: Ranked[] = [];
  for (const block of input.yesterdayAccepted) {
    const task = byId.get(block.taskId);
    if (!task || placed.has(task.id)) continue;
    carry.push(take(task, { code: "carry_over", label: "顺延自昨天" }));
  }

  const own = pending
    .filter((task) => !placed.has(task.id))
    .sort(compareOwnTasks)
    .map((task) => take(task, {
      code: "pending_task",
      label: task.dueAt !== null ? "按截止时间排序" : "你的待办",
    }));

  const suggested: Ranked[] = input.suggestions
    .filter((suggestion) => !byId.has(suggestion.id))
    .map((suggestion) => ({
      id: suggestion.id,
      courseId: suggestion.courseId,
      reason: { code: suggestion.reasonCode, label: suggestion.reason },
    }));

  // Interleave only within each priority band so a lower-band course swap
  // cannot jump ahead of a higher-band item (e.g. suggestion past a retest).
  const ordered = [
    ...deadlines,
    ...interleaveCourses(retests),
    ...interleaveCourses(carry),
    ...interleaveCourses(own),
    ...interleaveCourses(suggested),
  ];
  return {
    orderedTaskIds: ordered.map((item) => item.id),
    reasons: Object.fromEntries(ordered.map((item) => [item.id, item.reason])),
  };
}

/** Planner tasks for planDay; ids come from the suggestion so draft blocks can reference them. */
export function suggestionsAsTasks(suggestions: readonly SuggestedTask[]): TaskItem[] {
  return suggestions.map((suggestion) => ({
    id: suggestion.id,
    title: suggestion.title,
    minutes: suggestion.minutes,
    dueAt: null,
    priority: 1,
    status: "pending" as const,
    ...(suggestion.courseId ? { courseId: suggestion.courseId } : {}),
    ...(suggestion.skillLabel ? { skillLabel: suggestion.skillLabel } : {}),
    ...(suggestion.requirementKey !== undefined ? { requirementKey: suggestion.requirementKey } : {}),
    origin: "planner" as const,
  }));
}
