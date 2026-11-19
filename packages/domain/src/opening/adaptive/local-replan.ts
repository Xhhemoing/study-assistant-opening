import type { LocalReplanMetadata, PlannedBlock, TaskItem, TimeBlock } from "@aistudy/contracts";
import { planDay, type PlanDayOptions } from "../day-planner";
import { isInstantOnLocalDay, resolveLocalDayBounds } from "../local-day-bounds";

export function samePlannedBlocks(left: readonly PlannedBlock[], right: readonly PlannedBlock[]): boolean {
  const key = (block: PlannedBlock) => JSON.stringify([block.taskId, block.start, block.end, block.reason]);
  const a = left.map(key).sort(), b = right.map(key).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function isBlockWithinLocalDay(
  startMs: number,
  endMs: number,
  localDate: string,
  timeZone: string,
): boolean {
  try {
    const { dayStart, nextDayStart } = resolveLocalDayBounds(localDate, timeZone);
    const dayStartMs = dayStart.getTime();
    const nextDayStartMs = nextDayStart.getTime();
    return startMs >= dayStartMs && startMs < nextDayStartMs && endMs <= nextDayStartMs;
  } catch {
    return false;
  }
}

function matchesScheduledDay(task: TaskItem, localDate?: string, timeZone?: string): boolean {
  const scheduled = task.retest?.scheduledStartAt;
  if (!scheduled || !localDate || !timeZone) return true;
  try {
    return isInstantOnLocalDay(scheduled, localDate, timeZone);
  } catch {
    return false;
  }
}

function blockFitsRetestWindow(
  block: PlannedBlock,
  task: TaskItem,
  localDate?: string,
  timeZone?: string,
): boolean {
  if (!task.retest) return true;
  const startMs = Date.parse(block.start);
  const endMs = Date.parse(block.end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return false;
  const retestStart = task.retest.scheduledStartAt ?? task.retest.recommendedAt;
  if (retestStart && startMs < Date.parse(retestStart)) return false;
  if (task.dueAt !== null && endMs > Date.parse(task.dueAt)) return false;
  if (task.retest.scheduledStartAt && localDate && timeZone) {
    if (!matchesScheduledDay(task, localDate, timeZone)) return false;
    if (!isBlockWithinLocalDay(startMs, endMs, localDate, timeZone)) return false;
  }
  return true;
}

export function localReplanFixedBlocks(input: {
  acceptedBlocks: readonly PlannedBlock[];
  tasks: readonly TaskItem[];
  now: Date;
  preserveAll?: boolean;
  localDate?: string;
  timeZone?: string;
  inactiveRetestTaskIds?: ReadonlySet<string>;
}) {
  const byId = new Map(input.tasks.map(task => [task.id, task]));
  const inactiveRetestIds = input.inactiveRetestTaskIds?.size
    ? new Set([...input.inactiveRetestTaskIds].map(id => id.toLowerCase()))
    : undefined;
  const releasedTaskVersions: LocalReplanMetadata["releasedTaskVersions"] = [];
  const recordReleased = (task: TaskItem | undefined) => {
    if (task?.version && !releasedTaskVersions.some(item => item.id === task.id)) {
      releasedTaskVersions.push({ id: task.id, version: task.version, status: task.status });
    }
  };
  const fixedBlocks = input.acceptedBlocks.filter(block => {
    if (Date.parse(block.start) <= input.now.getTime()) return true;
    const task = byId.get(block.taskId);
    if (inactiveRetestIds?.has(block.taskId.toLowerCase())) {
      recordReleased(task);
      return false;
    }
    if (input.preserveAll) {
      if (
        !task?.retest
        || task.status !== "pending"
        || (
          blockFitsRetestWindow(block, task, input.localDate, input.timeZone)
          && (!task.notBefore || Date.parse(task.notBefore) <= Date.parse(block.start))
        )
      ) {
        return true;
      }
      recordReleased(task);
      return false;
    }
    // An unknown task remains visible; it cannot silently disappear in a replan.
    if (
      !task
      || (
        task.status === "pending"
        && (!task.notBefore || Date.parse(task.notBefore) <= input.now.getTime())
        && blockFitsRetestWindow(block, task, input.localDate, input.timeZone)
      )
    ) {
      return true;
    }
    recordReleased(task);
    return false;
  });
  return { fixedBlocks, releasedTaskVersions };
}

/** Only unused future space is scheduled; accepted history and unaffected work stay put. */
export function buildLocalReplan(input: {
  acceptedBlocks: readonly PlannedBlock[]; tasks: readonly TaskItem[];
  constraints: readonly TimeBlock[]; now: Date; options: PlanDayOptions; preserveAll?: boolean;
  excludedTaskIds?: ReadonlySet<string>; inactiveRetestTaskIds?: ReadonlySet<string>; candidateTaskIds?: ReadonlySet<string>;
}) {
  const { fixedBlocks, releasedTaskVersions } = localReplanFixedBlocks({
    ...input,
    localDate: input.options.localDate,
    timeZone: input.options.timeZone,
  });
  const fixedFutureIds = new Set(fixedBlocks.filter(block => Date.parse(block.end) > input.now.getTime()).map(block => block.taskId));
  const inactiveRetestIds = input.inactiveRetestTaskIds?.size
    ? new Set([...input.inactiveRetestTaskIds].map(id => id.toLowerCase()))
    : undefined;
  const candidates = input.tasks.filter(task => task.status === "pending"
    && (!input.candidateTaskIds || input.candidateTaskIds.has(task.id))
    && !fixedFutureIds.has(task.id)
    && !input.excludedTaskIds?.has(task.id)
    && !inactiveRetestIds?.has(task.id.toLowerCase())
    && (!task.notBefore || Date.parse(task.notBefore) <= input.now.getTime())
    && matchesScheduledDay(task, input.options.localDate, input.options.timeZone));
  const locked: TimeBlock[] = fixedBlocks.map(block => ({ start: block.start, end: block.end, kind: "locked" }));
  const planned = planDay(candidates, [...input.constraints, ...locked], input.options);
  const blocks = [...fixedBlocks, ...planned.blocks].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return { blocks, unscheduledTaskIds: planned.unscheduledTaskIds, fixedBlocks, releasedTaskVersions,
    changed: !samePlannedBlocks(blocks, input.acceptedBlocks) };
}
