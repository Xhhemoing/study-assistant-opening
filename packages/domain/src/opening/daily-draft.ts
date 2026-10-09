import type { PlannedBlock, TaskItem, TimeBlock } from "@aistudy/contracts";
import { availableTimeSlots } from "./planning-time";

/** Machine-readable reason codes for daily auto-draft explanations. */
export type DailyDraftReasonCode =
  | "carry_over_yesterday"
  | "prefer_tomorrow"
  | "shorten_duration";

export type DailyDraftReason = {
  code: DailyDraftReasonCode;
  /** Short Chinese label for UI. */
  label: string;
};

export type BuildDailyDraftInputArgs = {
  tasks: readonly TaskItem[];
  /** Yesterday's accepted plan blocks (task order preserved for carry-over). */
  yesterdayAccepted: readonly PlannedBlock[];
  /** Retest tasks already known to be due (merged with tasks; still filtered). */
  dueRetests: readonly TaskItem[];
  freeBlocks: readonly TimeBlock[];
  now: Date;
  timeZone: string;
  /** When set, used as the local calendar day instead of deriving from now+timeZone. */
  date?: string;
};

export type BuildDailyDraftInputResult = {
  orderedTaskIds: string[];
  reasons: Record<string, DailyDraftReason>;
};

const REASON_LABELS: Record<DailyDraftReasonCode, string> = {
  carry_over_yesterday: "顺延自昨天",
  prefer_tomorrow: "明天优先",
  shorten_duration: "缩短时长",
};

function partsAt(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((all, part) => {
      all[part.type] = part.value;
      return all;
    }, {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function localDateOf(instant: Date | string, timeZone: string): string {
  const date = typeof instant === "string" ? new Date(instant) : instant;
  return partsAt(date, timeZone).slice(0, 10);
}

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

function isRetestNotYetDue(task: TaskItem, localDate: string, timeZone: string): boolean {
  const recommendedAt = task.retest?.recommendedAt;
  if (!recommendedAt) return false;
  return localDateOf(recommendedAt, timeZone) > localDate;
}

function maxFreeSlotMinutes(freeBlocks: readonly TimeBlock[]): number {
  let max = 0;
  for (const slot of availableTimeSlots(freeBlocks)) {
    const minutes = (Date.parse(slot.end) - Date.parse(slot.start)) / 60_000;
    if (minutes > max) max = minutes;
  }
  return max;
}

function overflowReason(taskMinutes: number, maxSlotMinutes: number): DailyDraftReason {
  if (maxSlotMinutes > 0 && maxSlotMinutes < taskMinutes) {
    return { code: "shorten_duration", label: REASON_LABELS.shorten_duration };
  }
  return { code: "prefer_tomorrow", label: REASON_LABELS.prefer_tomorrow };
}

/**
 * Builds the preferred task order and explanation reasons for the daily auto draft.
 * Carry-over (yesterday accepted + still pending) comes first. Not-yet-due retests
 * are omitted. Overflow tasks get prefer_tomorrow / shorten_duration suggestions.
 * Does not invent free time — only freeBlocks capacity is considered (never sleep/meal).
 */
export function buildDailyDraftInput(
  args: BuildDailyDraftInputArgs,
): BuildDailyDraftInputResult {
  const { tasks, yesterdayAccepted, dueRetests, freeBlocks, now, timeZone, date } = args;
  const localDate = date ?? localDateOf(now, timeZone);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
    throw new RangeError("date must be YYYY-MM-DD");
  }

  const byId = new Map<string, TaskItem>();
  for (const task of tasks) byId.set(task.id, task);
  for (const task of dueRetests) byId.set(task.id, task);

  const pending = [...byId.values()].filter(
    (task) => task.status === "pending" && !isRetestNotYetDue(task, localDate, timeZone),
  );

  const carryIds: string[] = [];
  const carrySet = new Set<string>();
  for (const block of yesterdayAccepted) {
    const task = byId.get(block.taskId);
    if (!task || task.status !== "pending") continue;
    if (isRetestNotYetDue(task, localDate, timeZone)) continue;
    if (carrySet.has(block.taskId)) continue;
    carrySet.add(block.taskId);
    carryIds.push(block.taskId);
  }

  const rest = pending
    .filter((task) => !carrySet.has(task.id))
    .sort(compareTasks)
    .map((task) => task.id);

  const orderedTaskIds = [...carryIds, ...rest];
  const reasons: Record<string, DailyDraftReason> = {};
  for (const id of carryIds) {
    reasons[id] = {
      code: "carry_over_yesterday",
      label: REASON_LABELS.carry_over_yesterday,
    };
  }

  const slots = availableTimeSlots(freeBlocks).map((slot) => ({
    start: Date.parse(slot.start),
    end: Date.parse(slot.end),
  }));
  const maxSlot = maxFreeSlotMinutes(freeBlocks);

  for (const id of orderedTaskIds) {
    const task = byId.get(id);
    if (!task) continue;
    const duration = task.minutes * 60_000;
    const due = deadline(task);
    const slot = slots.find(
      (candidate) => candidate.start + duration <= Math.min(candidate.end, due),
    );
    if (slot) {
      slot.start += duration;
      continue;
    }
    // Carry-over keeps its primary reason even when unscheduled.
    if (reasons[id]?.code === "carry_over_yesterday") continue;
    reasons[id] = overflowReason(task.minutes, maxSlot);
  }

  return { orderedTaskIds, reasons };
}

export function dailyDraftClientKey(date: string): string {
  return `auto-draft:${date}`;
}

export function localDateKeyInZone(instant: Date, timeZone: string): string {
  return localDateOf(instant, timeZone);
}

export function addLocalDays(date: string, days: number): string {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(ms)) throw new RangeError(`invalid date: ${date}`);
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}
