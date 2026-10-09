import type {
  OpeningPlanningSettings,
  TimeBlock,
  WeekSession,
} from "@aistudy/contracts";
import { availableTimeSlots } from "./planning-time";
import { expandWeekSessions } from "./timetable";
import { assertValidLocalDate, zonedLocalInstant } from "./local-day-bounds";

type ClockRange = { start: string; end: string };

function localDateOf(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
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
    const start = zonedLocalInstant(`${date}T${range.start}`, timeZone);
    const end = zonedLocalInstant(`${date}T${range.end}`, timeZone);
    if (end <= start) throw new RangeError(`${kind} end must be after start`);
    return [{ start: start.toISOString(), end: end.toISOString(), kind }];
  }
  // Overnight: previous evening→this morning, and this evening→next morning.
  const prev = addDays(date, -1);
  const next = addDays(date, 1);
  const morningEnd = zonedLocalInstant(`${date}T${range.end}`, timeZone);
  const eveningStart = zonedLocalInstant(`${date}T${range.start}`, timeZone);
  return [
    {
      start: zonedLocalInstant(`${prev}T${range.start}`, timeZone).toISOString(),
      end: morningEnd.toISOString(),
      kind,
    },
    {
      start: eveningStart.toISOString(),
      end: zonedLocalInstant(`${next}T${range.end}`, timeZone).toISOString(),
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
  assertValidLocalDate(date);
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

  const windowStart = zonedLocalInstant(`${date}T${settings.dailyWindow.start}`, timeZone);
  const windowEnd = zonedLocalInstant(`${date}T${settings.dailyWindow.end}`, timeZone);
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
