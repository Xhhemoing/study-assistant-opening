import {
  taskItemSchema,
  type PlannedBlock,
  type TaskItem,
  type TimeBlock,
} from "@aistudy/contracts";
import { availableTimeSlots } from "./planning-time";
import { resolveLocalDayBounds } from "./local-day-bounds";

/**
 * Machine-readable reason why planDay left a pending task unscheduled.
 * - `deadline_passed`: confirmed dueAt is at/before the earliest allowed start
 *   (overdue); kept visible for a user-reviewed adjustment, never dropped.
 * - `no_compliant_slot_after_not_before`: some free slot is long enough, but none
 *   fits after the task's not-before (retest recommendedAt / planningNow).
 * - `duration_exceeds_free_slots`: no free slot is long enough for the indivisible task.
 * - `no_slot_before_deadline`: a slot is long enough, but none ends before the confirmed dueAt.
 * - `free_time_exhausted`: slots would fit, but earlier tasks consumed the capacity.
 */
export type UnscheduledReasonCode =
  | "deadline_passed"
  | "no_compliant_slot_after_not_before"
  | "duration_exceeds_free_slots"
  | "no_slot_before_deadline"
  | "free_time_exhausted";

export type UnscheduledTask = { taskId: string; reason: UnscheduledReasonCode };

export type DayPlanResult = {
  blocks: PlannedBlock[];
  unscheduledTaskIds: string[];
  /**
   * Additive (contract-compatible): one entry per unscheduledTaskIds item, same order,
   * with an explicit reason code. Consumers that only read unscheduledTaskIds are unaffected.
   */
  unscheduled: UnscheduledTask[];
};

export type PlanDayOptions = {
  /** Inclusive end of the planning day. Retests with recommendedAt after this are skipped. */
  dayEnd?: string;
  /**
   * Local calendar day (YYYY-MM-DD) with workspace IANA timeZone.
   * When both set (and dayEnd omitted), day end is the exclusive nextDayStart
   * from resolveLocalDayBounds — half-open [dayStart, nextDayStart).
   * Available slots are clipped to that local day before placing tasks.
   * Priority: dayEnd > localDate+timeZone > UTC free-start fallback.
   */
  localDate?: string;
  timeZone?: string;
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

type DayEndResolution = { endMs: number; exclusive: boolean; startMs?: number };

/**
 * Priority: explicit dayEnd (inclusive) > localDate+timeZone (exclusive nextDayStart)
 * > UTC date of earliest free start + 23:59:59.999Z (legacy fallback; §5.3 risk).
 */
function resolveDayEnd(free: readonly TimeBlock[], options: PlanDayOptions): DayEndResolution {
  if (options.dayEnd) {
    const endMs = Date.parse(options.dayEnd);
    if (!Number.isFinite(endMs)) throw new RangeError(`invalid dayEnd: ${options.dayEnd}`);
    return { endMs, exclusive: false };
  }
  if (options.localDate && options.timeZone) {
    const { dayStart, nextDayStart } = resolveLocalDayBounds(options.localDate, options.timeZone);
    return { startMs: dayStart.getTime(), endMs: nextDayStart.getTime(), exclusive: true };
  }
  const freeStarts = free.filter((block) => block.kind === "free").map((block) => Date.parse(block.start));
  if (!freeStarts.length) return { endMs: Infinity, exclusive: false };
  const day = new Date(Math.min(...freeStarts)).toISOString().slice(0, 10);
  return { endMs: Date.parse(`${day}T23:59:59.999Z`), exclusive: false };
}

/**
 * Earliest allowable start: the later of a retest's recommendedAt and a deferral's
 * notBefore. Null when neither is set.
 */
export function taskNotBeforeAt(task: TaskItem): string | null {
  const candidates = [task.retest?.recommendedAt, task.notBefore].filter(
    (value): value is string => typeof value === "string" && value !== "",
  );
  if (!candidates.length) return null;
  return candidates.reduce((latest, value) => (Date.parse(value) > Date.parse(latest) ? value : latest));
}

function isRetestNotYetDue(task: TaskItem, endMs: number, exclusive: boolean): boolean {
  const notBefore = taskNotBeforeAt(task);
  if (!notBefore) return false;
  const t = Date.parse(notBefore);
  return exclusive ? t >= endMs : t > endMs;
}

function taskNotBeforeMs(task: TaskItem): number {
  const notBefore = taskNotBeforeAt(task);
  return notBefore ? Date.parse(notBefore) : Number.NEGATIVE_INFINITY;
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
 * Explains a placement failure against the day's ORIGINAL free slots (before any
 * task consumed capacity). Pure classification; never changes placement.
 */
function unscheduledReason(
  originalSlots: readonly MutableSlot[],
  duration: number,
  earliest: number,
  due: number,
): UnscheduledReasonCode {
  const firstStart = originalSlots.length
    ? Math.min(...originalSlots.map((slot) => slot.start))
    : Number.POSITIVE_INFINITY;
  if (Number.isFinite(due) && (due <= earliest || (originalSlots.length > 0 && due <= firstStart))) {
    return "deadline_passed";
  }
  const longEnough = originalSlots.some((slot) => slot.end - slot.start >= duration);
  if (!longEnough) return "duration_exceeds_free_slots";
  const fitsAfterNotBefore = originalSlots.some(
    (slot) => Math.max(slot.start, earliest) + duration <= Math.min(slot.end, due),
  );
  if (!fitsAfterNotBefore) {
    const fitsIgnoringNotBefore = originalSlots.some(
      (slot) => slot.start + duration <= Math.min(slot.end, due),
    );
    return fitsIgnoringNotBefore ? "no_compliant_slot_after_not_before" : "no_slot_before_deadline";
  }
  return "free_time_exhausted";
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
  const { startMs: dayStartMs, endMs: dayEndMs, exclusive: dayEndExclusive } = resolveDayEnd(free, options);
  const planningNowMs = options.planningNow
    ? Date.parse(options.planningNow)
    : Number.NEGATIVE_INFINITY;
  const ids = new Set<string>();
  const pending = tasks.map((raw) => {
    const task = taskItemSchema.parse(raw);
    if (ids.has(task.id)) throw new Error(`duplicate task id: ${task.id}`);
    ids.add(task.id);
    return task;
  }).filter((task) => task.status === "pending" && !isRetestNotYetDue(task, dayEndMs, dayEndExclusive));
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
    start: Math.max(Date.parse(slot.start), dayStartMs ?? Number.NEGATIVE_INFINITY),
    end: Math.min(Date.parse(slot.end), dayStartMs === undefined ? Number.POSITIVE_INFINITY : dayEndMs),
  })).filter(slot => slot.start < slot.end);
  const originalSlots = slots.map((slot) => ({ ...slot }));
  const result: DayPlanResult = { blocks: [], unscheduledTaskIds: [], unscheduled: [] };
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
      result.unscheduled.push({
        taskId: task.id,
        reason: unscheduledReason(originalSlots, duration, earliest, due),
      });
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
