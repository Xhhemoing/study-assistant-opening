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
   * Within each deadline band, prefer tasks in this order, then fall back to
   * deadline and priority. Deadlines within the planning day take precedence.
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

function resolveReservationDayBounds(
  free: readonly TimeBlock[],
  options: PlanDayOptions,
  dayEnd: DayEndResolution,
): { startMs: number; endMs: number } | null {
  if (options.localDate && options.timeZone) {
    const { dayStart, nextDayStart } = resolveLocalDayBounds(options.localDate, options.timeZone);
    return { startMs: dayStart.getTime(), endMs: nextDayStart.getTime() };
  }
  if (options.dayEnd && Number.isFinite(dayEnd.endMs)) {
    const utcDay = new Date(dayEnd.endMs).toISOString().slice(0, 10);
    const { dayStart, nextDayStart } = resolveLocalDayBounds(utcDay, "UTC");
    return { startMs: dayStart.getTime(), endMs: nextDayStart.getTime() };
  }
  const freeStarts = free.filter((block) => block.kind === "free").map((block) => Date.parse(block.start));
  if (!freeStarts.length) return null;
  const utcDay = new Date(Math.min(...freeStarts)).toISOString().slice(0, 10);
  const { dayStart, nextDayStart } = resolveLocalDayBounds(utcDay, "UTC");
  return { startMs: dayStart.getTime(), endMs: nextDayStart.getTime() };
}

/**
 * Earliest allowable start: the later of a retest's active start target
 * (`scheduledStartAt ?? recommendedAt`) and a task's `notBefore`.
 * Null when neither is set.
 */
export function taskNotBeforeAt(task: TaskItem): string | null {
  const retestTarget = task.retest?.scheduledStartAt ?? task.retest?.recommendedAt;
  const candidates = [retestTarget, task.notBefore].filter(
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

/**
 * Explicit retest reservations (`scheduledStartAt`) are pinned to their local calendar
 * day in the workspace timeZone — neither an earlier day nor a later day may schedule them.
 */
function isReservedForDifferentDay(
  task: TaskItem,
  bounds: { startMs: number; endMs: number } | null,
): boolean {
  const scheduled = task.retest?.scheduledStartAt;
  if (!scheduled || !bounds) return false;
  const ms = Date.parse(scheduled);
  if (!Number.isFinite(ms)) return true;
  return ms < bounds.startMs || ms >= bounds.endMs;
}

function taskNotBeforeMs(task: TaskItem): number {
  const notBefore = taskNotBeforeAt(task);
  return notBefore ? Date.parse(notBefore) : Number.NEGATIVE_INFINITY;
}

/**
 * Original free windows are disjoint after subtracting hard constraints.
 * A draft partitions each window into available and occupied segments.
 */
type Work = { task: TaskItem; duration: number; earliest: number; due: number };
type Segment = MutableSlot & { window: number; work?: Work };
const MAX_REPAIR_ATTEMPTS = 8;
const MAX_RELOCATED_BLOCKS = 2;

function fits(slot: MutableSlot, work: Work): boolean {
  return Math.max(slot.start, work.earliest) + work.duration <= Math.min(slot.end, work.due);
}

function soleFeasibleWindow(windows: readonly MutableSlot[], work: Work): number | undefined {
  if (!Number.isFinite(work.due)) return undefined;
  let sole: number | undefined;
  for (const [index, slot] of windows.entries()) {
    if (!fits(slot, work)) continue;
    if (sole !== undefined) return undefined;
    sole = index;
  }
  return sole;
}

function placeAt(segments: Segment[], index: number, start: number, work: Work): void {
  const slot = segments[index]!;
  const { window } = slot;
  const end = start + work.duration;
  const parts: Segment[] = [{ start, end, window, work }];
  if (slot.start < start) parts.unshift({ start: slot.start, end: start, window });
  if (end < slot.end) parts.push({ start: end, end: slot.end, window });
  segments.splice(index, 1, ...parts);
}

/** Prefer a window that no remaining hard-deadlined task depends on exclusively. */
function placeFirstFit(segments: Segment[], work: Work, reservations: readonly number[]): boolean {
  let fallback = -1;
  for (const [index, segment] of segments.entries()) {
    if (segment.work || !fits(segment, work)) continue;
    if (fallback < 0) fallback = index;
    if (reservations[segment.window]) continue;
    fallback = index;
    break;
  }
  if (fallback < 0) return false;
  placeAt(segments, fallback, Math.max(segments[fallback]!.start, work.earliest), work);
  return true;
}

function isRelocatable(current: Work, incoming: Work): boolean {
  return current.duration < incoming.duration
    || (current.earliest <= incoming.earliest && current.due >= incoming.due);
}

/**
 * Try the earliest and latest fits in a region freed by up to two draft blocks.
 * Inspect each region once and bound the number of trial copies per task.
 * Commit a swap only if every displaced block fits again with its own bounds.
 */
function repairPlacement(segments: Segment[], incoming: Work, reservations: readonly number[]): Segment[] | null {
  let attempts = 0;
  for (const [index, first] of segments.entries()) {
    if (!first.work) continue;
    const before = segments[index - 1];
    const from = before?.window === first.window && !before.work ? index - 1 : index;
    const left = segments[from]!.start;
    const displaced: Work[] = [];
    let occupied = index;
    while (displaced.length < MAX_RELOCATED_BLOCKS) {
      const last = segments[occupied];
      if (last?.window !== first.window || !last.work || !isRelocatable(last.work, incoming)) break;
      displaced.push(last.work);

      const after = segments[occupied + 1];
      const through = after?.window === first.window && !after.work ? occupied + 1 : occupied;
      const right = segments[through]!.end;
      // Times are integral milliseconds. Require the candidate to intersect the
      // first and last displaced blocks, so each trial moves only what it needs.
      const earliest = Math.max(left, incoming.earliest, last.start - incoming.duration + 1);
      const latest = Math.min(right, incoming.due) - incoming.duration;
      const latestOverlap = Math.min(latest, first.end - 1);
      if (earliest <= latestOverlap) {
        for (const start of earliest === latestOverlap ? [earliest] : [earliest, latestOverlap]) {
          const orders = displaced.length === 1 ? [displaced] : [displaced, [...displaced].reverse()];
          for (const order of orders) {
            if (attempts >= MAX_REPAIR_ATTEMPTS) return null;
            attempts += 1;
            const trial = [
              ...segments.slice(0, from),
              { start: left, end: right, window: first.window },
              ...segments.slice(through + 1),
            ];
            placeAt(trial, from, start, incoming);
            if (order.every((item) => placeFirstFit(trial, item, reservations))) return trial;
          }
        }
      }
      occupied = through + 1;
    }
  }
  return null;
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
  const dayEnd = resolveDayEnd(free, options);
  const { startMs: dayStartMs, endMs: dayEndMs, exclusive: dayEndExclusive } = dayEnd;
  const reservationBounds = resolveReservationDayBounds(free, options, dayEnd);
  const planningNowMs = options.planningNow
    ? Date.parse(options.planningNow)
    : Number.NEGATIVE_INFINITY;
  const ids = new Set<string>();
  const pending = tasks.map((raw) => {
    const task = taskItemSchema.parse(raw);
    if (ids.has(task.id)) throw new Error(`duplicate task id: ${task.id}`);
    ids.add(task.id);
    return task;
  }).filter((task) =>
    task.status === "pending"
    && !isRetestNotYetDue(task, dayEndMs, dayEndExclusive)
    && !isReservedForDifferentDay(task, reservationBounds),
  );
  const preferred = options.preferredOrder;
  if (preferred?.length) {
    const rank = new Map(preferred.map((id, index) => [id, index]));
    const deadlineInDay = (task: TaskItem) => task.dueAt !== null && deadline(task) <= dayEndMs;
    pending.sort((a, b) => {
      const hardA = deadlineInDay(a), hardB = deadlineInDay(b);
      if (hardA !== hardB) return hardA ? -1 : 1;
      const ra = rank.get(a.id), rb = rank.get(b.id);
      if (ra !== undefined && rb !== undefined) return ra - rb;
      if (ra !== undefined) return -1;
      if (rb !== undefined) return 1;
      return compareTasks(a, b);
    });
  } else {
    pending.sort(compareTasks);
  }

  const originalSlots: MutableSlot[] = availableTimeSlots(free).map((slot) => ({
    start: Math.max(Date.parse(slot.start), dayStartMs ?? Number.NEGATIVE_INFINITY),
    end: Math.min(Date.parse(slot.end), dayStartMs === undefined ? Number.POSITIVE_INFINITY : dayEndMs),
  })).filter(slot => slot.start < slot.end);
  const reservations = originalSlots.map(() => 0);
  const workItems = pending.map((task) => {
    const work = {
      task,
      duration: task.minutes * 60_000,
      earliest: Math.max(taskNotBeforeMs(task), planningNowMs),
      due: deadline(task),
    };
    const window = soleFeasibleWindow(originalSlots, work);
    if (window !== undefined) reservations[window]! += 1;
    return { work, window };
  });

  let segments: Segment[] = originalSlots.map((slot, window) => ({ ...slot, window }));
  const result: DayPlanResult = { blocks: [], unscheduledTaskIds: [], unscheduled: [] };
  for (const { work, window } of workItems) {
    if (window !== undefined) reservations[window]! -= 1;
    if (placeFirstFit(segments, work, reservations)) continue;
    const repaired = repairPlacement(segments, work, reservations);
    if (repaired) {
      segments = repaired;
      continue;
    }
    result.unscheduledTaskIds.push(work.task.id);
    result.unscheduled.push({
      taskId: work.task.id,
      reason: unscheduledReason(originalSlots, work.duration, work.earliest, work.due),
    });
  }
  for (const { start, end, work } of segments) {
    if (!work) continue;
    result.blocks.push({
      taskId: work.task.id,
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      reason: work.task.dueAt !== null
        ? "按已确认截止时间优先安排，预计用时不侵占固定安排。"
        : "按任务优先级安排在已确认空闲时间内，用时为估计。",
    });
  }
  return result;
}
