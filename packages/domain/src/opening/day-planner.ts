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

/**
 * Proposes only; never changes task status or accepts a plan. Higher priority
 * numbers sort first after confirmed deadlines. Tasks remain indivisible;
 * impossible/overdue tasks are surfaced for a user-reviewed adjustment.
 * Pass confirmed free blocks AND all applicable class/sleep/meal/locked blocks.
 */
export function planDay(tasks: readonly TaskItem[], free: readonly TimeBlock[]): DayPlanResult {
  const ids = new Set<string>();
  const pending = tasks.map((raw) => {
    const task = taskItemSchema.parse(raw);
    if (ids.has(task.id)) throw new Error(`duplicate task id: ${task.id}`);
    ids.add(task.id);
    return task;
  }).filter((task) => task.status === "pending").sort(compareTasks);
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
