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
const weekRange = /\d+(?:\s*[-－至]\s*\d+)?/.source;
const weekListPattern = `(${weekRange}(?:\\s*[,，、]\\s*${weekRange})*)`;
const paritySuffix = /(?:\s*[(（]?([单双])周?[)）]?)?/.source;
const inlineWeeks = new RegExp(`第?\\s*${weekListPattern}\\s*([单双])?周(?!次|[一二三四五六日天0-9])${paritySuffix}`);
const labeledWeeks = new RegExp(`(?:周次\\s*[:：]?|周\\s*[:：])\\s*第?\\s*${weekListPattern}\\s*([单双])?周?${paritySuffix}`);
// A bare 周1 can name a weekday. Require a range or list after the prefix.
const leadingWeeks = new RegExp(`周\\s*(?=\\d+\\s*[-－至,，、]\\s*\\d)${weekListPattern}\\s*([单双])?周?${paritySuffix}`);
// Consume one complete list and its delimiter so a parity suffix applies to the whole list.
const columnSegment = new RegExp(
  /((?:\s*[[（【(])*)(?:\s*(周次|周)\s*[:：]?)?\s*第?\s*/.source + weekListPattern
  + /\s*([单双])?周?(?:\s*([单双])周?)?/.source
  + /((?:\s*[)）】\]])*)\s*([,，、;；]|$)/.source,
  "y",
);
const matchingClose: Record<string, string> = { "(": ")", "（": "）", "[": "]", "【": "】" };
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

function addWeeks(result: Set<number>, list: string, parity?: string): boolean {
  for (const part of list.split(/[,，、]/)) {
    const pieces = part.split(/[-－至]/).map(Number);
    const first = pieces[0] ?? NaN;
    const last = pieces[1] ?? first;
    if (!Number.isSafeInteger(last) || first < 1 || first > last) return false;
    for (let week = first; week <= last; week++) {
      if (!parity || week % 2 === (parity === "单" ? 1 : 0)) result.add(week);
      if (result.size > 60) return false; // WeekSession accepts at most 60 distinct weeks.
    }
  }
  return true;
}

function columnWeekList(value: string): number[] | undefined {
  // Resolve parenthesized parity suffixes before matching wrappers around week lists.
  const source = value.replace(/\s+/g, " ").replace(/^周次\s*[:：]?\s*/, "")
    .replace(/\(\s*([单双]周?)\s*\)|（\s*([单双]周?)\s*）/g, "$1$2");
  const result = new Set<number>();
  const closers: string[] = [];
  const segments = new RegExp(columnSegment);
  while (true) {
    const match = segments.exec(source);
    if (!match) return undefined;
    const [, open, prefix, list, beforeWeek, afterWeek, close, separator] = match;
    for (const char of open!.replace(/\s/g, "")) closers.push(matchingClose[char]!);
    for (const char of close!.replace(/\s/g, "")) {
      if (closers.pop() !== char) return undefined;
    }
    if (prefix === "周" && Number(list) > 60) return undefined;
    if (!addWeeks(result, list!, beforeWeek ?? afterWeek)) return undefined;
    if (!separator) break;
  }
  return !closers.length && result.size ? [...result] : undefined;
}

function inlineWeekList(match: RegExpMatchArray | null): number[] | undefined {
  if (!match) return undefined;
  const result = new Set<number>();
  return addWeeks(result, match[1]!, match[2] ?? match[3]) && result.size ? [...result] : undefined;
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
          const withoutPeriods = line.replace(periodPattern, "");
          const annotation = withoutPeriods.match(labeledWeeks) ?? withoutPeriods.match(leadingWeeks) ?? withoutPeriods.match(inlineWeeks);
          const weekText = annotation?.[0].trim() ?? "";
          const courseName = line
            // Keep a parenthesized parity suffix attached until the whole week annotation is removed.
            .replace(/\s*[(（][^)）]*(?:周|节)[^)）]*[)）]/, group => weekText.includes(group.trim()) ? group : "")
            .replace(weekText, "")
            .replace(/\s+[0-9]+\s*[-－至]\s*[0-9]+\s*节\s*$/, "")
            .trim();
          const weekCell = weekColumn >= 0 ? text(rows[r]![weekColumn]!) : "";
          const weekList = weekCell ? columnWeekList(weekCell) : inlineWeekList(annotation);
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
