import type { PlannedBlock, TaskItem } from "@aistudy/contracts";

/** DL3 attaches recommendedAt for retest tasks; ordinary tasks omit it. */
export type TodayQueueTask = TaskItem & {
  recommendedAt?: string | null;
};

export type TodayQueueGroups = {
  confirmed: TodayQueueTask[];
  dueRetests: TodayQueueTask[];
  overdue: TodayQueueTask[];
  other: TodayQueueTask[];
  upcomingRetestCount: number;
  done: TodayQueueTask[];
};

function calendarDateKey(instant: Date, timeZone: string): string {
  // en-CA yields YYYY-MM-DD in the given zone.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

function recommendedAtOf(task: TodayQueueTask): string | null {
  if (task.recommendedAt != null && task.recommendedAt !== "") return task.recommendedAt;
  const nested = task.retest?.recommendedAt;
  if (nested != null && nested !== "") return nested;
  return null;
}

function isDueRetest(task: TodayQueueTask, now: Date): boolean {
  const at = recommendedAtOf(task);
  if (at == null) return false;
  return new Date(at).getTime() <= now.getTime();
}

function isFutureRetest(task: TodayQueueTask, now: Date): boolean {
  const at = recommendedAtOf(task);
  if (at == null) return false;
  return new Date(at).getTime() > now.getTime();
}

function isOverdue(task: TodayQueueTask, now: Date): boolean {
  if (task.dueAt == null) return false;
  return new Date(task.dueAt).getTime() < now.getTime();
}

/**
 * Groups today's queue for display. Confirmed plan membership wins over retest/overdue.
 * Future retests are counted only; they stay out of selectable lists until due.
 */
export function groupTodayQueue(
  tasks: TodayQueueTask[],
  acceptedBlocks: PlannedBlock[],
  now: Date,
  timeZone: string,
): TodayQueueGroups {
  const todayKey = calendarDateKey(now, timeZone);
  const confirmedIds = new Set(
    acceptedBlocks
      .filter((block) => calendarDateKey(new Date(block.start), timeZone) === todayKey)
      .map((block) => block.taskId),
  );

  const confirmed: TodayQueueTask[] = [];
  const dueRetests: TodayQueueTask[] = [];
  const overdue: TodayQueueTask[] = [];
  const other: TodayQueueTask[] = [];
  const done: TodayQueueTask[] = [];
  let upcomingRetestCount = 0;

  for (const task of tasks) {
    if (task.status === "done" || task.status === "skipped") {
      done.push(task);
      continue;
    }
    if (task.status !== "pending") continue;

    if (isFutureRetest(task, now)) {
      upcomingRetestCount += 1;
      // Future retests are not selectable in today's lists.
      continue;
    }

    if (confirmedIds.has(task.id)) {
      confirmed.push(task);
      continue;
    }
    if (isDueRetest(task, now)) {
      dueRetests.push(task);
      continue;
    }
    if (isOverdue(task, now)) {
      overdue.push(task);
      continue;
    }
    other.push(task);
  }

  return { confirmed, dueRetests, overdue, other, upcomingRetestCount, done };
}
