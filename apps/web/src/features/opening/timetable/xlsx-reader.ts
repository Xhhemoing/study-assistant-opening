import type { WeekSession } from "@aistudy/contracts";
import { normalizeWeekSessions } from "@aistudy/domain";

type CellValue = string | number | boolean | null;
export type RawCell = { text: string; sheet: string; address: string };
export type TimetableParseWarning = { message: string; raw: string; sheet: string; address: string };
export type ParsedTimetable = { sessions: WeekSession[]; warnings: TimetableParseWarning[]; raw: RawCell[] };

/** One workbook sheet as produced by read-excel-file (node or browser). */
export type TimetableSheet = { sheet: string; data: CellValue[][] };

const dayMap: Record<string, number> = {
  "周一": 1, "星期一": 1, "周二": 2, "星期二": 2, "周三": 3, "星期三": 3,
  "周四": 4, "星期四": 4, "周五": 5, "星期五": 5, "周六": 6, "星期六": 6,
  "周日": 7, "星期日": 7,
};
const weekPattern = /(?:周次?[:：]?\s*)?([0-9]+(?:\s*[-－]\s*[0-9]+)?(?:\s*[,，]\s*[0-9]+(?:\s*[-－]\s*[0-9]+)?)*)周?/;
const periodPattern = /([0-9]+)\s*[-－至]\s*([0-9]+)\s*节/;

function text(value: CellValue): string {
  return value == null ? "" : String(value).trim();
}

function address(row: number, column: number): string {
  let n = column + 1;
  let result = "";
  while (n) {
    const remainder = (n - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    n = Math.floor((n - 1) / 26);
  }
  return `${result}${row + 1}`;
}

function weeks(value: string): number[] | undefined {
  const match = value.match(weekPattern);
  if (!match) return undefined;
  const result: number[] = [];
  for (const part of match[1]!.split(/[,，]/)) {
    const pieces = part.split(/[-－]/).map(Number);
    const first = pieces[0] ?? NaN;
    const last = pieces[1] ?? first;
    if (!Number.isInteger(first) || !Number.isInteger(last) || first > last) return undefined;
    for (let week = first; week <= last; week++) result.push(week);
  }
  return result;
}

function day(value: string): number | undefined {
  const clean = value.replace(/\s/g, "");
  if (dayMap[clean]) return dayMap[clean];
  const number = Number(clean);
  return Number.isInteger(number) && number >= 1 && number <= 7 ? number : undefined;
}

function period(value: string): [number, number] | undefined {
  const match = value.match(periodPattern);
  return match ? [Number(match[1]), Number(match[2])] : undefined;
}

function asSheets(value: unknown): TimetableSheet[] {
  if (!Array.isArray(value)) return [];
  if (value.length === 0) return [];
  const first = value[0];
  if (first && typeof first === "object" && "data" in first && "sheet" in first) {
    return value as TimetableSheet[];
  }
  // Single-sheet row matrix from older/single-sheet calls.
  return [{ sheet: "Sheet1", data: value as CellValue[][] }];
}

/**
 * Pure mapping: workbook sheets → WeekSession rows (plus warnings/raw cells).
 * Shared by Node path and browser File import; does not touch the filesystem.
 */
export function parseTimetableSheets(sheets: TimetableSheet[]): ParsedTimetable {
  const sessions: WeekSession[] = [];
  const warnings: TimetableParseWarning[] = [];
  const raw: RawCell[] = [];
  for (const sheet of sheets) {
    const rows = sheet.data;
    const header = (rows[0] ?? []).map((value) => text(value));
    const find = (names: string[]) => header.findIndex((value) => names.some((name) => value.includes(name)));
    const courseColumn = find(["课程", "科目", "Course"]);
    const dayColumn = find(["星期", "周几", "Weekday"]);
    const weekColumn = find(["周次", "Weeks"]);
    const periodColumn = find(["节", "时段", "Period"]);
    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < rows[r]!.length; c++) {
        const value = text(rows[r]![c] ?? null);
        if (!value) continue;
        const cell = { text: value, sheet: sheet.sheet, address: address(r, c) };
        raw.push(cell);
        if (r === 0) continue;
        if (courseColumn >= 0 && c !== courseColumn) continue;
        const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        for (const line of lines) {
          const courseName = line
            .replace(/\s*\([^)]*(?:周|节)[^)]*\)/, "")
            .replace(/\s+[0-9]+\s*[-－至]\s*[0-9]+\s*节\s*$/, "")
            .trim();
          const weekList = weeks(line) ?? (weekColumn >= 0 ? weeks(text(rows[r]![weekColumn]!)) : undefined);
          const weekday = day(dayColumn >= 0 ? text(rows[r]![dayColumn]!) : header[c]!);
          const range = period(line) ?? (periodColumn >= 0 ? period(text(rows[r]![periodColumn]!)) : undefined);
          if (!weekList || weekday === undefined || !range) {
            warnings.push({
              message: "Could not fully parse timetable cell; correction is required",
              raw: line,
              sheet: cell.sheet,
              address: cell.address,
            });
            continue;
          }
          sessions.push({
            courseName: courseName || line,
            weekday,
            weeks: weekList,
            startPeriod: range[0],
            endPeriod: range[1],
          });
        }
      }
    }
  }
  return { sessions: normalizeWeekSessions(sessions), warnings, raw };
}

/**
 * Browser: read a user-selected xlsx File/Blob locally.
 * Does not upload the raw workbook; callers PUT only WeekSession JSON after confirm.
 */
export async function parseTimetableFile(file: File | Blob | ArrayBuffer): Promise<ParsedTimetable> {
  const { default: readXlsx } = await import("read-excel-file/browser");
  const sheets = asSheets(await readXlsx(file));
  return parseTimetableSheets(sheets);
}
