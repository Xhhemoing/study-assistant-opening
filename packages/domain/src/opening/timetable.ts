import type { TimeBlock, WeekSession } from "@aistudy/contracts";
import { zonedLocalInstant } from "./local-day-bounds";

type PeriodTime = { start: string; end: string };
type ExpandOptions = {
  weekOneMonday?: string;
  periodTimes?: { [period: number]: PeriodTime };
  timeZone: string;
};

const clockPattern = /^([01]\d|2[0-3]):([0-5]\d)$/;

function validateRow(row: WeekSession): WeekSession {
  if (!Number.isInteger(row.weekday) || row.weekday < 1 || row.weekday > 7) {
    throw new RangeError("weekday must be an integer from 1 to 7");
  }
  if (!Number.isInteger(row.startPeriod) || !Number.isInteger(row.endPeriod) || row.startPeriod > row.endPeriod) {
    throw new RangeError("startPeriod must be an integer <= endPeriod");
  }
  if (!row.courseName.trim() || !row.weeks.length || row.weeks.some((week) => !Number.isInteger(week) || week < 1)) {
    throw new RangeError("courseName and positive integer weeks are required");
  }
  return { ...row, weeks: [...new Set(row.weeks)].sort((a, b) => a - b) };
}

export function normalizeWeekSessions(rows: WeekSession[]): WeekSession[] {
  const seen = new Set<string>();
  const result: WeekSession[] = [];
  for (const row of rows) {
    const normalized = validateRow(row);
    const key = [normalized.courseName, normalized.weekday, normalized.startPeriod, normalized.endPeriod, normalized.weeks.join(",")].join("\u0000");
    if (!seen.has(key)) {
      seen.add(key);
      result.push(normalized);
    }
  }
  return result;
}

function validateClock(value: string, label: string): void {
  if (!clockPattern.test(value)) throw new RangeError(`${label} must use HH:mm`);
}

export function expandWeekSessions(rows: WeekSession[], options: ExpandOptions): TimeBlock[] {
  if (!options.weekOneMonday) throw new Error("weekOneMonday is required for absolute timetable expansion");
  if (!options.periodTimes || Object.keys(options.periodTimes).length === 0) {
    throw new Error("periodTimes must contain clock mappings for absolute timetable expansion");
  }
  const monday = Date.parse(`${options.weekOneMonday}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.weekOneMonday) || !Number.isFinite(monday)) throw new RangeError("weekOneMonday must be a valid YYYY-MM-DD date");
  const normalized = normalizeWeekSessions(rows);
  return normalized.flatMap((row) => row.weeks.map((week) => {
    const start = options.periodTimes![row.startPeriod];
    const end = options.periodTimes![row.endPeriod];
    if (!start || !end) throw new Error(`periodTimes is missing period ${!start ? row.startPeriod : row.endPeriod}`);
    validateClock(start.start, `period ${row.startPeriod} start`);
    validateClock(start.end, `period ${row.startPeriod} end`);
    validateClock(end.start, `period ${row.endPeriod} start`);
    validateClock(end.end, `period ${row.endPeriod} end`);
    const day = new Date(monday + ((week - 1) * 7 + row.weekday - 1) * 86_400_000);
    const date = day.toISOString().slice(0, 10);
    const from = zonedLocalInstant(`${date}T${start.start}`, options.timeZone);
    const to = zonedLocalInstant(`${date}T${end.end}`, options.timeZone);
    if (to <= from) throw new RangeError("period end must be after period start");
    return { start: from.toISOString(), end: to.toISOString(), kind: "class" as const };
  }));
}
