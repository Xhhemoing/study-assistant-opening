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
  /**
   * Planning clock. Blocks must not start before this instant (in addition to
   * slot start and any retest recommendedAt / not-before).
   */
  planningNow?: string;
};

type MutableSlot = { start: number; end: number };

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

/** Earliest allowable start: retest recommendedAt acts as not-before. */
function taskNotBeforeMs(task: TaskItem): number {
  const recommendedAt = task.retest?.recommendedAt;
  return recommendedAt ? Date.parse(recommendedAt) : Number.NEGATIVE_INFINITY;
}

/**
 * Place `duration` inside `slot` no earlier than `earliest`, ending by `due`.
 * Returns null when the window does not fit. On success, mutates `slots` so any
 * empty prefix before the chosen start stays available for later tasks.
 */
function tryPlaceInSlot(
  slots: MutableSlot[],
  index: number,
  duration: number,
  earliest: number,
  due: number,
): { start: number; end: number } | null {
  const slot = slots[index];
  if (!slot) return null;
  const start = Math.max(slot.start, earliest);
  const end = start + duration;
  if (end > Math.min(slot.end, due)) return null;

  const originalEnd = slot.end;
  if (start > slot.start) {
    // Keep [slot.start, start) for other tasks; remainder after the block if any.
    slot.end = start;
    if (end < originalEnd) {
      slots.splice(index + 1, 0, { start: end, end: originalEnd });
    }
  } else {
    slot.start = end;
  }
  return { start, end };
}

/**
 * Proposes only; never changes task status or accepts a plan. Higher priority
 * numbers sort first after confirmed deadlines. Tasks remain indivisible;
 * impossible/overdue tasks are surfaced for a user-reviewed adjustment.
 * Pass confirmed free blocks AND all applicable class/sleep/meal/locked blocks.
 * Retest tasks with recommendedAt after the planning day end are skipped (not
 * listed as unscheduled) so delayed retests stay out of today's proposal.
 * Within a day, retest recommendedAt is a not-before: start is
 * max(slot.start, recommendedAt, planningNow) and any empty slot prefix is kept.
 */
export function planDay(
  tasks: readonly TaskItem[],
  free: readonly TimeBlock[],
  options: PlanDayOptions = {},
): DayPlanResult {
  const dayEndMs = resolveDayEndMs(free, options.dayEnd);
  const planningNowMs = options.planningNow
    ? Date.parse(options.planningNow)
    : Number.NEGATIVE_INFINITY;
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
  const slots: MutableSlot[] = availableTimeSlots(free).map((slot) => ({
    start: Date.parse(slot.start), end: Date.parse(slot.end),
  }));
  const result: DayPlanResult = { blocks: [], unscheduledTaskIds: [] };
  for (const task of pending) {
    const duration = task.minutes * 60_000;
    const due = deadline(task);
    const earliest = Math.max(taskNotBeforeMs(task), planningNowMs);
    let placed: { start: number; end: number } | null = null;
    for (let i = 0; i < slots.length; i += 1) {
      placed = tryPlaceInSlot(slots, i, duration, earliest, due);
      if (placed) break;
    }
    if (!placed) {
      result.unscheduledTaskIds.push(task.id);
      continue;
    }
    result.blocks.push({
      taskId: task.id,
      start: new Date(placed.start).toISOString(),
      end: new Date(placed.end).toISOString(),
      reason: task.dueAt !== null
        ? "按已确认截止时间优先安排，预计用时不侵占固定安排。"
        : "按任务优先级安排在已确认空闲时间内，用时为估计。",
    });
  }
  result.blocks.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return result;
}
