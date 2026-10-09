import type {
  OpeningPlanningSettings,
  TimeBlock,
  WeekSession,
} from "@aistudy/contracts";
import { availableTimeSlots } from "./planning-time";
import { expandWeekSessions } from "./timetable";

type ClockRange = { start: string; end: string };

function partsAt(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).reduce<Record<string, string>>((all, part) => {
    all[part.type] = part.value;
    return all;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function zonedInstant(local: string, timeZone: string): Date {
  const wall = Date.parse(`${local}Z`);
  if (!Number.isFinite(wall)) throw new RangeError(`invalid local date/time: ${local}`);
  const offsets = new Set<number>();
  for (let hour = -48; hour <= 48; hour += 6) {
    const sample = new Date(wall + hour * 3_600_000);
    const displayed = partsAt(sample, timeZone);
    offsets.add(Date.parse(`${displayed}Z`) - sample.getTime());
  }
  const matches = [...offsets]
    .map((offset) => new Date(wall - offset))
    .filter((date) => partsAt(date, timeZone) === local);
  if (matches.length === 0) {
    throw new RangeError(`nonexistent DST or invalid local time: ${local} in ${timeZone}`);
  }
  if (matches.length > 1) {
    throw new RangeError(`ambiguous DST local time: ${local} in ${timeZone}`);
  }
  const first = matches[0];
  if (!first) throw new RangeError(`no resolution for local time: ${local} in ${timeZone}`);
  return first;
}

function localDateOf(iso: string, timeZone: string): string {
  return partsAt(new Date(iso), timeZone).slice(0, 10);
}

function addDays(date: string, days: number): string {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(ms)) throw new RangeError(`invalid date: ${date}`);
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}

function toPeriodTimes(
  record: OpeningPlanningSettings["periodTimes"],
): { [period: number]: ClockRange } {
  const out: { [period: number]: ClockRange } = {};
  for (const [key, value] of Object.entries(record)) {
    out[Number(key)] = value;
  }
  return out;
}

function crossesMidnight(range: ClockRange): boolean {
  return range.end <= range.start;
}

function rangeBlocks(
  date: string,
  range: ClockRange,
  kind: TimeBlock["kind"],
  timeZone: string,
): TimeBlock[] {
  if (!crossesMidnight(range)) {
    const start = zonedInstant(`${date}T${range.start}`, timeZone);
    const end = zonedInstant(`${date}T${range.end}`, timeZone);
    if (end <= start) throw new RangeError(`${kind} end must be after start`);
    return [{ start: start.toISOString(), end: end.toISOString(), kind }];
  }
  // Overnight: previous evening→this morning, and this evening→next morning.
  const prev = addDays(date, -1);
  const next = addDays(date, 1);
  const morningEnd = zonedInstant(`${date}T${range.end}`, timeZone);
  const eveningStart = zonedInstant(`${date}T${range.start}`, timeZone);
  return [
    {
      start: zonedInstant(`${prev}T${range.start}`, timeZone).toISOString(),
      end: morningEnd.toISOString(),
      kind,
    },
    {
      start: eveningStart.toISOString(),
      end: zonedInstant(`${next}T${range.end}`, timeZone).toISOString(),
      kind,
    },
  ];
}

/**
 * Builds class/meal/sleep hard blocks and free slots for one local calendar day.
 * Free = dailyWindow minus class, meals, sleep, and any caller hard blocks.
 * Missing periodTimes for a session period throws (does not guess).
 */
export function deriveDayBlocks(
  date: string,
  settings: OpeningPlanningSettings,
  sessions: readonly WeekSession[],
  hardBlocks: readonly TimeBlock[] = [],
): TimeBlock[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new RangeError("date must be YYYY-MM-DD");
  }
  const { timeZone } = settings;
  const periodTimes = toPeriodTimes(settings.periodTimes);
  const classBlocks =
    sessions.length === 0
      ? []
      : expandWeekSessions([...sessions], {
          weekOneMonday: settings.weekOneMonday,
          periodTimes,
          timeZone,
        }).filter((block) => localDateOf(block.start, timeZone) === date);

  const mealBlocks = [
    ...rangeBlocks(date, settings.lunch, "meal", timeZone),
    ...rangeBlocks(date, settings.dinner, "meal", timeZone),
  ];
  const sleepBlocks = rangeBlocks(date, settings.sleep, "sleep", timeZone);

  const windowStart = zonedInstant(`${date}T${settings.dailyWindow.start}`, timeZone);
  const windowEnd = zonedInstant(`${date}T${settings.dailyWindow.end}`, timeZone);
  if (windowEnd <= windowStart) {
    throw new RangeError("dailyWindow end must be after start");
  }
  const window: TimeBlock = {
    start: windowStart.toISOString(),
    end: windowEnd.toISOString(),
    kind: "free",
  };

  const hard = [...classBlocks, ...mealBlocks, ...sleepBlocks, ...hardBlocks];
  const freeSlots = availableTimeSlots([window, ...hard]);
  return [...freeSlots, ...hard];
}
