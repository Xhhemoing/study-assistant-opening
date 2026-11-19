import type { DayAdjustmentCapacitySummary, PlannedBlock, TimeBlock } from "@aistudy/contracts";
import { availableTimeSlots } from "./planning-time";

/** One workspace cap. Accepted work remains fixed even when it exceeds a newly reduced cap. */
export function allocateLearningCapacity(input: {
  dailyMinutes: number;
  bufferMinutes: number;
  spentMinutes: number;
  free: readonly TimeBlock[];
  accepted: readonly PlannedBlock[];
  reservations: readonly { key: string; minutes: number }[];
  acceptedTaskIds?: ReadonlySet<string>;
  /** Optional active day-exception ceiling for remaining work after the declaration instant. */
  exceptionCapMinutes?: number | null;
}) {
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
  const dailyRemaining = Math.max(0, input.dailyMinutes - input.bufferMinutes - committedMinutes);
  const effectiveRemaining = input.exceptionCapMinutes == null
    ? dailyRemaining
    : Math.max(0, Math.min(dailyRemaining, input.exceptionCapMinutes));
  let remaining = effectiveRemaining;
  const free: TimeBlock[] = [];
  const slots = availableTimeSlots([...input.free, ...input.accepted.map(block => ({ start: block.start, end: block.end, kind: "locked" as const }))]);
  for (const slot of slots) {
    const from = Date.parse(slot.start), until = Math.min(Date.parse(slot.end), from + remaining * 60000);
    if (until > from) { free.push({ start: slot.start, end: new Date(until).toISOString(), kind: "free" }); remaining -= (until - from) / 60000; }
  }
  return {
    committedMinutes,
    remainingMinutes: effectiveRemaining,
    overcommittedMinutes: Math.max(0, committedMinutes + input.bufferMinutes - input.dailyMinutes),
    free,
  };
}

export function learningRecoveryChoice(input: { activityId: string | null; taskId: string | null; pending: boolean }) {
  return { kind: input.activityId ? "continue" as const : input.pending ? "replan" as const : "none" as const, activityId: input.activityId, taskId: input.taskId };
}

function roundMinutes(value: number): number {
  return Math.round(Math.max(0, value) * 1000) / 1000;
}

/**
 * Exact [minAfter, maxAfter] bounds for an activity whose only known time metric
 * is total duration `minutes`, relative to a day-exception `effectiveAtMs`.
 */
export function straddlingUsageBounds(input: {
  minutes: number;
  startMs: number | null;
  endMs: number | null;
  effectiveAtMs: number;
}): { minAfter: number; maxAfter: number } {
  const total = Math.max(0, input.minutes);
  if (total === 0) return { minAfter: 0, maxAfter: 0 };
  const startMs = input.startMs !== null && Number.isFinite(input.startMs) ? input.startMs : null;
  const endMs = input.endMs !== null && Number.isFinite(input.endMs) ? input.endMs : null;
  if (startMs !== null && startMs >= input.effectiveAtMs) {
    return { minAfter: total, maxAfter: total };
  }
  if (endMs !== null && endMs <= input.effectiveAtMs) {
    return { minAfter: 0, maxAfter: 0 };
  }
  // Straddles effectiveAt (or lacks boundary timestamps) with only total elapsed minutes.
  const wallBefore = startMs !== null ? Math.max(0, (input.effectiveAtMs - startMs) / 60_000) : Infinity;
  const wallAfter = endMs !== null ? Math.max(0, (endMs - input.effectiveAtMs) / 60_000) : Infinity;
  if (Number.isFinite(wallBefore) && Number.isFinite(wallAfter) && wallBefore + wallAfter + 1e-6 < total) {
    // Clock skew or paused/non-wall elapsed duration: stay conservatively within [0, total].
    return { minAfter: 0, maxAfter: total };
  }
  const minAfter = Number.isFinite(wallBefore) ? Math.max(0, Math.min(total, total - wallBefore)) : 0;
  const maxAfter = Number.isFinite(wallAfter) ? Math.max(minAfter, Math.min(total, wallAfter)) : total;
  return { minAfter: roundMinutes(minAfter), maxAfter: roundMinutes(maxAfter) };
}

/**
 * Post-replacement capacity formula:
 * available = max(0, min(D - B - Sday, remainingMinutes - Safter))
 * shortfall = max(0, F - available)
 * Returns usageUncertain=true ONLY when straddling usage bounds change feasibility of F.
 */
export function evaluateDayExceptionCapacity(input: {
  dailyMinutes: number | null;
  bufferMinutes: number | null;
  dayUsedMinutes: number;
  exceptionRemainingMinutes: number | null;
  afterLowerMinutes: number;
  afterUpperMinutes: number;
  requiredMinutes: number;
}): DayAdjustmentCapacitySummary {
  const dailyCap = input.dailyMinutes !== null ? input.dailyMinutes - (input.bufferMinutes ?? 0) : null;
  const dayRemaining = dailyCap !== null ? Math.max(0, dailyCap - input.dayUsedMinutes) : null;
  const excUpper = input.exceptionRemainingMinutes !== null
    ? Math.max(0, input.exceptionRemainingMinutes - input.afterLowerMinutes)
    : null;
  const excLower = input.exceptionRemainingMinutes !== null
    ? Math.max(0, input.exceptionRemainingMinutes - input.afterUpperMinutes)
    : null;

  let availableUpperMinutes: number;
  let availableLowerMinutes: number;
  if (dayRemaining !== null && excUpper !== null && excLower !== null) {
    availableUpperMinutes = Math.max(0, Math.min(dayRemaining, excUpper));
    availableLowerMinutes = Math.max(0, Math.min(dayRemaining, excLower));
  } else if (excUpper !== null && excLower !== null) {
    availableUpperMinutes = Math.max(0, excUpper);
    availableLowerMinutes = Math.max(0, excLower);
  } else if (dayRemaining !== null) {
    availableUpperMinutes = Math.max(0, dayRemaining);
    availableLowerMinutes = availableUpperMinutes;
  } else {
    availableUpperMinutes = 1440;
    availableLowerMinutes = 1440;
  }

  const requiredMinutes = roundMinutes(input.requiredMinutes);
  const availLower = roundMinutes(availableLowerMinutes);
  const availUpper = roundMinutes(availableUpperMinutes);
  const feasibleLower = requiredMinutes <= availLower + 1e-6;
  const feasibleUpper = requiredMinutes <= availUpper + 1e-6;
  const usageUncertain = !feasibleLower && feasibleUpper;
  const shortfallMinutes = feasibleUpper ? 0 : roundMinutes(Math.max(0, requiredMinutes - availUpper));

  return {
    dailyMinutes: input.dailyMinutes,
    bufferMinutes: input.bufferMinutes,
    dayUsedMinutes: roundMinutes(input.dayUsedMinutes),
    exceptionRemainingMinutes: input.exceptionRemainingMinutes,
    afterLowerMinutes: roundMinutes(input.afterLowerMinutes),
    afterUpperMinutes: roundMinutes(input.afterUpperMinutes),
    availableLowerMinutes: availLower,
    availableUpperMinutes: availUpper,
    requiredMinutes,
    shortfallMinutes,
    usageUncertain,
  };
}

/**
 * Finds one indivisible continuous slot of `durationMinutes` inside `freeSlots`.
 * Never truncates or splits a task duration.
 */
export function findContinuousFreeSlot(input: {
  freeSlots: readonly TimeBlock[];
  durationMinutes: number;
  earliestMs: number;
  dueMs?: number | null;
  preferredStartMs?: number | null;
}): TimeBlock | null {
  const durationMs = input.durationMinutes * 60_000;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
  const dueMs = input.dueMs != null && Number.isFinite(input.dueMs) ? input.dueMs : Number.POSITIVE_INFINITY;
  const sorted = [...input.freeSlots]
    .filter((slot) => slot.kind === "free")
    .map((slot) => ({ start: Date.parse(slot.start), end: Date.parse(slot.end) }))
    .filter((slot) => Number.isFinite(slot.start) && Number.isFinite(slot.end) && slot.end > slot.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  if (input.preferredStartMs != null && Number.isFinite(input.preferredStartMs)) {
    const start = input.preferredStartMs;
    const end = start + durationMs;
    if (start >= input.earliestMs && end <= dueMs) {
      const fits = sorted.some((slot) => start >= slot.start && end <= slot.end);
      return fits ? { start: new Date(start).toISOString(), end: new Date(end).toISOString(), kind: "free" } : null;
    }
    return null;
  }

  for (const slot of sorted) {
    const start = Math.max(slot.start, input.earliestMs);
    const end = start + durationMs;
    if (end <= Math.min(slot.end, dueMs)) {
      return { start: new Date(start).toISOString(), end: new Date(end).toISOString(), kind: "free" };
    }
  }
  return null;
}
