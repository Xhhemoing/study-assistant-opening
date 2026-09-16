import type { TimeBlock, WeekSession } from "@aistudy/contracts";
import { expandWeekSessions } from "@aistudy/domain";

export type PeriodTimes = Record<number, { start: string; end: string }>;
const clock = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parsePeriodTimes(input: unknown): PeriodTimes {
  if (!input || typeof input !== "object") throw new RangeError("periodTimes must be a period-to-clock mapping to configure timetable expansion");
  const result: PeriodTimes = {};
  for (const [key, value] of Object.entries(input)) {
    if (!/^\d+$/.test(key) || !value || typeof value !== "object") throw new RangeError(`period ${key} must configure start and end as HH:mm`);
    const clocks = value as { start?: unknown; end?: unknown };
    for (const edge of ["start", "end"] as const) if (typeof clocks[edge] !== "string" || !clock.test(clocks[edge])) throw new RangeError(`period ${key} ${edge} must use HH:mm`);
    result[Number(key)] = { start: clocks.start as string, end: clocks.end as string };
  }
  if (!Object.keys(result).length) throw new RangeError("periodTimes must contain at least one configured period");
  return result;
}

export function expandToTimeBlocks(rows: WeekSession[], options: { weekOneMonday?: string; periodTimes?: unknown; timeZone: string }): TimeBlock[] {
  if (!options.weekOneMonday) throw new Error("weekOneMonday is required: configure the Monday date of academic week one");
  const date = new Date(`${options.weekOneMonday}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.weekOneMonday) || Number.isNaN(date.getTime())) throw new RangeError("weekOneMonday must be a valid YYYY-MM-DD Monday; configure a Monday date");
  if (date.getUTCDay() !== 1) throw new RangeError("weekOneMonday must be a Monday; configure the Monday date of academic week one");
  const periodTimes = parsePeriodTimes(options.periodTimes);
  try { return expandWeekSessions(rows, { weekOneMonday: options.weekOneMonday, periodTimes, timeZone: options.timeZone }); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/DST|nonexistent|ambiguous/i.test(message)) throw new RangeError(`Timetable session has an ambiguous or nonexistent local time/date in ${options.timeZone}: ${message}`);
    throw error;
  }
}
