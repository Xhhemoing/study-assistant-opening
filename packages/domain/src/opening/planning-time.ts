import { timeBlockSchema, type TimeBlock } from "@aistudy/contracts";

type Interval = { start: number; end: number };

function merge(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start || a.end - b.end);
  const result: Interval[] = [];
  for (const interval of sorted) {
    const last = result.at(-1);
    if (last && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
    } else {
      result.push({ ...interval });
    }
  }
  return result;
}

/**
 * Only explicitly supplied free time can be used. Every other kind is a hard
 * exclusion, even when it overlaps a free block. Inputs are absolute instants;
 * academic-week/timezone conversion and confirmation belong to the caller.
 */
export function availableTimeSlots(blocks: readonly TimeBlock[]): TimeBlock[] {
  const free: Interval[] = [];
  const hard: Interval[] = [];
  for (const raw of blocks) {
    const block = timeBlockSchema.parse(raw);
    const interval = { start: Date.parse(block.start), end: Date.parse(block.end) };
    if (interval.end <= interval.start) {
      throw new RangeError("time block must end after it starts");
    }
    (block.kind === "free" ? free : hard).push(interval);
  }

  const exclusions = merge(hard);
  const remaining: Interval[] = [];
  for (const slot of merge(free)) {
    let cursor = slot.start;
    for (const exclusion of exclusions) {
      if (exclusion.end <= cursor) continue;
      if (exclusion.start >= slot.end) break;
      if (exclusion.start > cursor) {
        remaining.push({ start: cursor, end: exclusion.start });
      }
      cursor = Math.max(cursor, exclusion.end);
      if (cursor >= slot.end) break;
    }
    if (cursor < slot.end) remaining.push({ start: cursor, end: slot.end });
  }
  return remaining.map(({ start, end }) => ({
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    kind: "free",
  }));
}
