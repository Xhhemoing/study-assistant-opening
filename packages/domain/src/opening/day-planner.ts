import {
  taskItemSchema,
  type PlannedBlock,
  type TaskItem,
  type TimeBlock,
} from "@aistudy/contracts";
import { availableTimeSlots } from "./planning-time";

export type DayPlanResult = {
  blocks: PlannedBlock[];
  unscheduledTaskIds: string[];
};

export type PlanDayOptions = {
  /** Inclusive end of the planning day. Retests with recommendedAt after this are skipped. */
  dayEnd?: string;
  /**
   * When set, schedule pending tasks in this order (unknown ids fall back to
   * deadline/priority sort after preferred ones). Used by daily auto-draft carry-over.
   */
  preferredOrder?: readonly string[];
};

function deadline(task: TaskItem): number {
  return task.dueAt === null ? Infinity : Date.parse(task.dueAt);
}

function compareTasks(a: TaskItem, b: TaskItem): number {
  const dueA = deadline(a);
  const dueB = deadline(b);
  if (dueA !== dueB) return dueA < dueB ? -1 : 1;
  if (a.priority !== b.priority) return a.priority > b.priority ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function resolveDayEndMs(free: readonly TimeBlock[], dayEnd?: string): number {
  if (dayEnd) return Date.parse(dayEnd);
  const freeStarts = free.filter((block) => block.kind === "free").map((block) => Date.parse(block.start));
  if (!freeStarts.length) return Infinity;
  const day = new Date(Math.min(...freeStarts)).toISOString().slice(0, 10);
  return Date.parse(`${day}T23:59:59.999Z`);
}

function isRetestNotYetDue(task: TaskItem, dayEndMs: number): boolean {
  const recommendedAt = task.retest?.recommendedAt;
  if (!recommendedAt) return false;
  return Date.parse(recommendedAt) > dayEndMs;
}

/**
 * Proposes only; never changes task status or accepts a plan. Higher priority
 * numbers sort first after confirmed deadlines. Tasks remain indivisible;
 * impossible/overdue tasks are surfaced for a user-reviewed adjustment.
 * Pass confirmed free blocks AND all applicable class/sleep/meal/locked blocks.
 * Retest tasks with recommendedAt after the planning day end are skipped (not
 * listed as unscheduled) so delayed retests stay out of today's proposal.
 */
export function planDay(
  tasks: readonly TaskItem[],
  free: readonly TimeBlock[],
  options: PlanDayOptions = {},
): DayPlanResult {
  const dayEndMs = resolveDayEndMs(free, options.dayEnd);
  const ids = new Set<string>();
  const pending = tasks.map((raw) => {
    const task = taskItemSchema.parse(raw);
    if (ids.has(task.id)) throw new Error(`duplicate task id: ${task.id}`);
    ids.add(task.id);
    return task;
  }).filter((task) => task.status === "pending" && !isRetestNotYetDue(task, dayEndMs));
  const preferred = options.preferredOrder;
  if (preferred && preferred.length) {
    const rank = new Map(preferred.map((id, index) => [id, index]));
    pending.sort((a, b) => {
      const ra = rank.get(a.id);
      const rb = rank.get(b.id);
      if (ra !== undefined && rb !== undefined) return ra - rb;
      if (ra !== undefined) return -1;
      if (rb !== undefined) return 1;
      return compareTasks(a, b);
    });
  } else {
    pending.sort(compareTasks);
  }
  const slots = availableTimeSlots(free).map((slot) => ({
    start: Date.parse(slot.start), end: Date.parse(slot.end),
  }));
  const result: DayPlanResult = { blocks: [], unscheduledTaskIds: [] };
  for (const task of pending) {
    const duration = task.minutes * 60_000;
    const due = deadline(task);
    const slot = slots.find((candidate) => candidate.start + duration <= Math.min(candidate.end, due));
    if (!slot) {
      result.unscheduledTaskIds.push(task.id);
      continue;
    }
    const end = slot.start + duration;
    result.blocks.push({
      taskId: task.id,
      start: new Date(slot.start).toISOString(),
      end: new Date(end).toISOString(),
      reason: task.dueAt !== null
        ? "按已确认截止时间优先安排，预计用时不侵占固定安排。"
        : "按任务优先级安排在已确认空闲时间内，用时为估计。",
    });
    slot.start = end;
  }
  result.blocks.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return result;
}
