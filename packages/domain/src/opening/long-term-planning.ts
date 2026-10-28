import type { PlannedBlock, TimeBlock } from "@aistudy/contracts";
import { availableTimeSlots } from "./planning-time";

/** One workspace cap. Accepted work remains fixed even when it exceeds a newly reduced cap. */
export function allocateLearningCapacity(input: { dailyMinutes: number; bufferMinutes: number; spentMinutes: number; free: readonly TimeBlock[]; accepted: readonly PlannedBlock[]; reservations: readonly { key: string; minutes: number }[]; acceptedTaskIds?: ReadonlySet<string> }) {
  const accepted = [...input.accepted].map(block => [Date.parse(block.start), Date.parse(block.end)] as const).sort((a, b) => a[0] - b[0]);
  let acceptedMs = 0, end = -Infinity;
  for (const [start, until] of accepted) { acceptedMs += Math.max(0, until - Math.max(start, end)); end = Math.max(end, until); }
  const acceptedIds = input.acceptedTaskIds ?? new Set(input.accepted.map(block => block.taskId));
  const reservations = new Map<string, number>();
  for (const item of input.reservations) {
    if (item.key.startsWith("task:") && acceptedIds.has(item.key.slice(5))) continue;
    reservations.set(item.key, Math.max(reservations.get(item.key) ?? 0, item.minutes));
  }
  const committedMinutes = acceptedMs / 60000 + input.spentMinutes + [...reservations.values()].reduce((sum, value) => sum + value, 0);
  let remaining = Math.max(0, input.dailyMinutes - input.bufferMinutes - committedMinutes);
  const free: TimeBlock[] = [];
  const slots = availableTimeSlots([...input.free, ...input.accepted.map(block => ({ start: block.start, end: block.end, kind: "locked" as const }))]);
  for (const slot of slots) {
    const from = Date.parse(slot.start), until = Math.min(Date.parse(slot.end), from + remaining * 60000);
    if (until > from) { free.push({ start: slot.start, end: new Date(until).toISOString(), kind: "free" }); remaining -= (until - from) / 60000; }
  }
  return { committedMinutes, remainingMinutes: Math.max(0, input.dailyMinutes - input.bufferMinutes - committedMinutes), overcommittedMinutes: Math.max(0, committedMinutes + input.bufferMinutes - input.dailyMinutes), free };
}
export function learningRecoveryChoice(input: { activityId: string | null; taskId: string | null; pending: boolean }) {
  return { kind: input.activityId ? "continue" as const : input.pending ? "replan" as const : "none" as const, activityId: input.activityId, taskId: input.taskId };
}
