import type { TimeBlock, WeekSession } from "@aistudy/contracts";

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

function partsAt(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
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
  const matches = [...offsets].map((offset) => new Date(wall - offset)).filter((date) => partsAt(date, timeZone) === local);
  if (matches.length === 0) throw new RangeError(`nonexistent DST or invalid local time: ${local} in ${timeZone}`);
  if (matches.length > 1) throw new RangeError(`ambiguous DST local time: ${local} in ${timeZone}`);
  const first = matches[0];
  if (!first) throw new RangeError(`no resolution for local time: ${local} in ${timeZone}`);
  return first;
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
    const from = zonedInstant(`${date}T${start.start}`, options.timeZone);
    const to = zonedInstant(`${date}T${end.end}`, options.timeZone);
    if (to <= from) throw new RangeError("period end must be after period start");
    return { start: from.toISOString(), end: to.toISOString(), kind: "class" as const };
  }));
}
