import {
  plannedBlockSchema,
  taskItemSchema,
  timeBlockSchema,
  uuidSchema,
  type PlannedBlock,
  type TaskItem,
  type TimeBlock,
} from "@aistudy/contracts";
import { taskCourseId } from "./adaptive/types";
import { addLocalDays, localDateKeyInZone } from "./daily-draft";
import { planDay, taskNotBeforeAt, type UnscheduledReasonCode } from "./day-planner";
import { assertValidLocalDate, resolveLocalDayBounds } from "./local-day-bounds";
import { availableTimeSlots } from "./planning-time";

export type SprintBudgetForecastInput = {
  tasks: readonly TaskItem[];
  days: readonly {
    date: string;
    blocks: readonly TimeBlock[];
    accepted: readonly PlannedBlock[];
  }[];
  courseId: string;
  examDate: string;
  dailyMinutes: number;
  timeZone: string;
  now: Date;
  horizonTruncated: boolean;
};

export type SprintBudgetUnscheduledReason = UnscheduledReasonCode
  | "no_available_time"
  | "daily_budget_exceeded"
  | "exam_eve_review_only"
  | "exam_date_reached";

export type SprintBudgetForecastDay = {
  date: string;
  /** Total daily cap, not the remaining budget or an assertion of free time. */
  budgetMinutes: number;
  /** Union of this course's accepted intervals on this local day, including elapsed time. */
  committedMinutes: number;
  /** Newly proposed minutes only; accepted blocks are not returned as new proposals. */
  plannedMinutes: number;
  blocks: PlannedBlock[];
};

export type SprintBudgetForecast = {
  days: SprintBudgetForecastDay[];
  unscheduled: { taskId: string; reason: SprintBudgetUnscheduledReason }[];
  deferredTaskIds: string[];
  /** Newly proposed task ids, in chronological block order (not accepted task ids). */
  scheduledTaskIds: string[];
  warnings: string[];
};

type ValidatedDay = {
  date: string;
  start: number;
  end: number;
  blocks: TimeBlock[];
  accepted: PlannedBlock[];
};

const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const dueMs = (task: TaskItem) => task.dueAt === null ? Infinity : Date.parse(task.dueAt);

/** Same deadline / descending priority / stable id order as planDay. */
function compareTasks(a: TaskItem, b: TaskItem): number {
  const aDue = dueMs(a), bDue = dueMs(b);
  if (aDue !== bDue) return aDue < bDue ? -1 : 1;
  if (a.priority !== b.priority) return a.priority > b.priority ? -1 : 1;
  return compareText(a.id, b.id);
}

function assertInstant(value: string): void {
  assertValidLocalDate(value.slice(0, 10));
  if (!Number.isFinite(Date.parse(value))) throw new RangeError(`invalid instant: ${value}`);
}

function assertInterval(block: { start: string; end: string }): void {
  assertInstant(block.start);
  assertInstant(block.end);
  if (Date.parse(block.end) <= Date.parse(block.start)) {
    throw new RangeError("time block must end after it starts");
  }
}

function validateTasks(tasks: readonly TaskItem[]): TaskItem[] {
  const ids = new Set<string>();
  return tasks.map(raw => {
    const task = taskItemSchema.parse(raw);
    if (ids.has(task.id)) throw new Error(`duplicate task id: ${task.id}`);
    ids.add(task.id);
    for (const value of [task.dueAt, task.notBefore, task.retest?.recommendedAt]) {
      if (value != null) assertInstant(value);
    }
    return task;
  });
}

function validateDays(input: SprintBudgetForecastInput): ValidatedDay[] {
  const dates = new Set<string>();
  return input.days.map(day => {
    const { dayStart, nextDayStart } = resolveLocalDayBounds(day.date, input.timeZone);
    if (dates.has(day.date)) throw new Error(`duplicate planning day: ${day.date}`);
    dates.add(day.date);
    const blocks = day.blocks.map(raw => {
      const block = timeBlockSchema.parse(raw);
      assertInterval(block);
      return block;
    });
    const accepted = day.accepted.map(raw => {
      const block = plannedBlockSchema.parse(raw);
      assertInterval(block);
      return block;
    });
    return { date: day.date, start: dayStart.getTime(), end: nextDayStart.getTime(), blocks, accepted };
  }).sort((a, b) => compareText(a.date, b.date));
}

function clipBlocks(blocks: readonly TimeBlock[], start: number, end: number): TimeBlock[] {
  return blocks.flatMap(block => {
    const from = Math.max(start, Date.parse(block.start));
    const to = Math.min(end, Date.parse(block.end));
    return from < to ? [{ start: new Date(from).toISOString(), end: new Date(to).toISOString(), kind: block.kind }] : [];
  });
}

function isReview(task: TaskItem): boolean {
  return task.suggestionKind === "review_cards" || task.origin === "retest" || task.retest != null;
}

/** Prefer a witnessed fit blocked by budget, then protection, over later-day deadline failures. */
function explainFailure(reasons: ReadonlySet<SprintBudgetUnscheduledReason>): SprintBudgetUnscheduledReason {
  const order: SprintBudgetUnscheduledReason[] = [
    "daily_budget_exceeded", "exam_eve_review_only", "no_slot_before_deadline",
    "no_compliant_slot_after_not_before", "duration_exceeds_free_slots", "free_time_exhausted",
  ];
  return order.find(reason => reasons.has(reason)) ?? "no_available_time";
}

/**
 * Pure, proposal-only forecast over caller-supplied days (the service owns the 28-day cap).
 * Only today/future local days strictly before the exam appear in the result. No free
 * time, task splitting, deadline extensions, task status changes or acceptance is invented.
 *
 * All accepted blocks, including unknown/other-course tasks and blocks supplied under
 * another day, remain hard exclusions. Known same-course intervals consume the full day's
 * budget, even if now is later; duplicates/overlaps consume their union, not double minutes.
 * Every accepted task id is excluded globally from new proposals. Conflicting historical
 * accepts are preserved and warned about, never silently moved or counted as new coverage.
 */
export function forecastSprintBudget(input: SprintBudgetForecastInput): SprintBudgetForecast {
  uuidSchema.parse(input.courseId);
  if (!Number.isInteger(input.dailyMinutes) || input.dailyMinutes <= 0 || input.dailyMinutes > 1440) {
    throw new RangeError("dailyMinutes must be an integer between 1 and 1440");
  }
  if (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) {
    throw new RangeError("invalid now");
  }
  if (typeof input.horizonTruncated !== "boolean") throw new TypeError("invalid horizonTruncated");
  const examStart = resolveLocalDayBounds(input.examDate, input.timeZone).dayStart.getTime();
  const nowMs = input.now.getTime();
  const today = localDateKeyInZone(input.now, input.timeZone);
  const reviewDate = addLocalDays(input.examDate, -1);
  const tasks = validateTasks(input.tasks);
  const byId = new Map(tasks.map(task => [task.id, task]));
  // Validate even ignored past/exam days; malformed constraints must not disappear silently.
  const allDays = validateDays(input);
  const days = allDays.filter(day => day.date >= today && day.date < input.examDate);
  const windowEnd = days.at(-1)?.end ?? Math.min(nowMs, examStart);
  const warnings = new Set<string>();
  if (input.horizonTruncated) {
    warnings.add("预测窗口已截断，窗口外任务尚未评估；本次结果不代表已安排完考试前全部任务。");
  }

  const acceptedIds = new Set<string>();
  const acceptedByInterval = new Map<string, PlannedBlock>();
  for (const day of allDays) {
    for (const block of day.accepted) {
      const key = JSON.stringify([block.taskId, Date.parse(block.start), Date.parse(block.end)]);
      if (acceptedByInterval.has(key)) continue;
      if (acceptedIds.has(block.taskId)) {
        warnings.add("同一任务存在多个已接受时段，保留占槽且不重复预测；请检查已有安排。");
      }
      acceptedByInterval.set(key, block);
      acceptedIds.add(block.taskId);
      if (!byId.has(block.taskId)) {
        warnings.add("部分已接受安排缺少任务归属，仅占用时间槽，未计入本课预算。");
      }
    }
  }
  const accepted = [...acceptedByInterval.values()];
  const locked: TimeBlock[] = accepted.map(block => ({ start: block.start, end: block.end, kind: "locked" }));
  const courseCommitments: TimeBlock[] = accepted
    .filter(block => {
      const task = byId.get(block.taskId);
      return task !== undefined && taskCourseId(task) === input.courseId;
    })
    .map(block => ({ start: block.start, end: block.end, kind: "free" }));
  // Absolute hard constraints also protect adjacent days when their intervals cross midnight.
  const hardBlocks = allDays.flatMap(day => day.blocks.filter(block => block.kind !== "free"));
  const pending = tasks.filter(task => task.status === "pending"
    && taskCourseId(task) === input.courseId && !acceptedIds.has(task.id)).sort(compareTasks);
  const notBefore = new Map(pending.map(task => {
    const value = taskNotBeforeAt(task);
    return [task.id, value === null ? -Infinity : Date.parse(value)] as const;
  }));
  const overdue = new Set(pending.filter(task => dueMs(task) <= nowMs).map(task => task.id));
  const deferred = new Set(pending.filter(task => !overdue.has(task.id)
    && notBefore.get(task.id)! >= windowEnd).map(task => task.id));
  const scheduled = new Set<string>();
  const failures = new Map(pending.map(task => [task.id, new Set<SprintBudgetUnscheduledReason>()]));
  const outputDays: SprintBudgetForecastDay[] = [];

  for (const day of days) {
    const committedMinutes = availableTimeSlots(clipBlocks(courseCommitments, day.start, day.end))
      .reduce((sum, block) => sum + (Date.parse(block.end) - Date.parse(block.start)) / 60_000, 0);
    const result: SprintBudgetForecastDay = {
      date: day.date, budgetMinutes: input.dailyMinutes, committedMinutes, plannedMinutes: 0, blocks: [],
    };
    if (committedMinutes > input.dailyMinutes) {
      warnings.add(`${day.date} 本课已接受安排已超过每日预算，本次不再新增任务。`);
    }
    let remainingBudget = Math.max(0, input.dailyMinutes - committedMinutes);
    let slots = availableTimeSlots(clipBlocks([...day.blocks, ...hardBlocks, ...locked], Math.max(nowMs, day.start), day.end));
    const options = {
      // Bounds were resolved in workspace TZ above. planDay's explicit dayEnd is inclusive.
      dayEnd: new Date(day.end - 1).toISOString(), planningNow: input.now.toISOString(),
    };
    for (const task of pending) {
      if (scheduled.has(task.id) || overdue.has(task.id) || deferred.has(task.id) || notBefore.get(task.id)! >= day.end) continue;
      const reasons = failures.get(task.id)!;
      if (day.date === reviewDate && !isReview(task) && dueMs(task) > Math.max(day.start, nowMs)) {
        reasons.add("exam_eve_review_only");
        continue;
      }
      // Try real placement before reserving budget: an impossible large task must not
      // consume the allowance or remove an earlier prefix needed by a smaller task.
      const plan = planDay([task], slots, options);
      const block = plan.blocks[0];
      if (!block) {
        const reason = plan.unscheduled[0]?.reason;
        // planDay uses Infinity as the first start with no slots. Do not mislabel
        // a future deadline as expired merely because this day has no free time.
        reasons.add(!slots.length ? "no_available_time"
          : reason === "deadline_passed" ? "no_slot_before_deadline"
            : reason ?? "no_available_time");
        continue;
      }
      if (task.minutes > remainingBudget) {
        reasons.add("daily_budget_exceeded");
        continue;
      }
      result.blocks.push(block);
      result.plannedMinutes += task.minutes;
      remainingBudget -= task.minutes;
      scheduled.add(task.id);
      slots = availableTimeSlots([...slots, { start: block.start, end: block.end, kind: "locked" }]);
    }
    result.blocks.sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || compareText(a.taskId, b.taskId));
    outputDays.push(result);
  }

  return {
    days: outputDays,
    unscheduled: pending.filter(task => !scheduled.has(task.id) && !deferred.has(task.id)).map(task => ({
      taskId: task.id,
      reason: overdue.has(task.id) ? "deadline_passed"
        : today >= input.examDate ? "exam_date_reached" : explainFailure(failures.get(task.id)!),
    })),
    deferredTaskIds: pending.filter(task => deferred.has(task.id)).map(task => task.id),
    scheduledTaskIds: outputDays.flatMap(day => day.blocks.map(block => block.taskId)),
    warnings: [...warnings].sort(compareText),
  };
}
