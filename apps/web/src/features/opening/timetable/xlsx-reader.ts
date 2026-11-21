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
const paritySuffix = /(?:\s*(?:\(\s*([单双])周?\s*\)|（\s*([单双])周?\s*）|([单双])周?))?/.source;
const inlineWeeks = new RegExp(`第?\\s*${weekListPattern}\\s*([单双])?周(?!次|[一二三四五六日天0-9])${paritySuffix}`, "y");
const labeledWeeks = new RegExp(`(?:周次\\s*[:：]?|周\\s*[:：])\\s*第?\\s*${weekListPattern}\\s*([单双])?周?${paritySuffix}`, "y");
// A bare 周1 can name a weekday. Require a range or list after the prefix.
const leadingWeeks = new RegExp(`周\\s*(?=\\d+\\s*[-－至,，、]\\s*\\d)${weekListPattern}\\s*([单双])?周?${paritySuffix}`, "y");
const inlineWeekMatchers = [labeledWeeks, leadingWeeks, inlineWeeks];
// Consume one complete list and its delimiter so a parity suffix applies to the whole list.
const columnSegment = new RegExp(
  /((?:\s*(?:(?:周次\s*[:：]?|周\s*[:：])\s*)?[[（【(])*)/.source
  + "(" + /(?:\s*(周次|周)\s*[:：]?)?\s*第?\s*/.source + weekListPattern
  + /\s*([单双])?周?(?:\s*([单双])周?)?/.source
  + ")" + /((?:\s*[)）】\]])*)\s*([,，、;；]|$)/.source,
  "y",
);
const matchingClose: Record<string, string> = { "(": ")", "（": "）", "[": "]", "【": "】" };
const closeBracketChars = new Set(Object.values(matchingClose));
const periodPattern = /([0-9]+)\s*[-－至]\s*([0-9]+)\s*节/;
const wrappedPeriodPattern = /\s*(?:\(\s*[0-9]+\s*[-－至]\s*[0-9]+\s*节\s*\)|（\s*[0-9]+\s*[-－至]\s*[0-9]+\s*节\s*）|\[\s*[0-9]+\s*[-－至]\s*[0-9]+\s*节\s*\]|【\s*[0-9]+\s*[-－至]\s*[0-9]+\s*节\s*】)/g;
const globalPeriodPattern = /[0-9]+\s*[-－至]\s*[0-9]+\s*节/g;
const weekPrefixBeforeBracket = /^(?:周次\s*[:：]?|周\s*[:：])\s*/;
const weekMarkerHint = /周次|第\s*(?:[^\s()（）[\]【】]{0,16}|[\d\s\-－至,，、?？]{1,24})\s*周(?!期|围|边|年|末|转|折|密|全|到|游|旋|长|率|律)|\d\s*[单双]?周|周\s*[:：\d一二三四五六日天]|[单双]周/;
const weekPlaceholder = /(?:[?？]|待定|暂定|另行|未定|TBD\b)/.source;
const malformedListTail = `(?:(?:第\\s*)?${weekPlaceholder}|\\d+(?:\\s*[-－至]\\s*\\d+)?\\s*(?:${weekPlaceholder}|[~～至]|[-－—–/]\\s*(?:$|${weekPlaceholder})|[,，、;；]\\s*${weekPlaceholder}))`;
const malformedBareWeekTail = new RegExp(`^\\s*(?:[-－至~～—–/]|[,，、;；]\\s*${malformedListTail})`, "i");
const malformedCompletedWeekTail = new RegExp(
  `^\\s*(?:`
  + `[~～至]`
  + `|[,，、;；]\\s*${malformedListTail}`
  + `|[-－—–/]\\s*(?:$`
    + `|(?:第\\s*)?${weekPlaceholder}`
    + `|(?:第\\s*)?\\d+(?:\\s*[-－至]\\s*\\d+)?\\s*[单双]?周(?!期|围|边|年|末|转|折|密|全|到|游|旋|长|率|律)`
    + `|\\d+(?:\\s*[-－至]\\s*\\d+)?\\s*(?:${weekPlaceholder}|[~～至]|[-－—–/]\\s*(?:$|${weekPlaceholder})|[,，、;；]\\s*${weekPlaceholder})`
  + `))`,
  "i",
);
const bracketWeekIndicator = /(?:[0-9A-Za-z?？\-－至~～—–,，、;；:：/]|待定|暂定|另行|未定|全|(?:第|前|后)\s*[一二三四五六七八九十百零两]+)/;

function hasMalformedWeekTail(tail: string, completedUnit: boolean): boolean {
  return (completedUnit ? malformedCompletedWeekTail : malformedBareWeekTail).test(tail);
}

function looksLikeMalformedWeekBracket(segment: string): boolean {
  if (weekMarkerHint.test(segment)) return true;
  const match = /^[[（【(]\s*([\s\S]*?)周\s*[)）】\]]?$/.exec(segment.trim());
  return match !== null && bracketWeekIndicator.test(match[1]!);
}

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
    const [, open, expression, prefix, list, beforeWeek, afterWeek, close, separator] = match;
    for (const char of open!) {
      const closer = matchingClose[char];
      if (closer) closers.push(closer);
    }
    for (const char of close!.replace(/\s/g, "")) {
      if (closers.pop() !== char) return undefined;
    }
    // Inspect the matched segment after its wrappers and label have been consumed.
    if (/^周\s*[1-7]$/.test(expression!.trim())) return undefined;
    if (prefix === "周" && Number(list) > 60) return undefined;
    if (!addWeeks(result, list!, beforeWeek ?? afterWeek)) return undefined;
    if (!separator) break;
  }
  return !closers.length && result.size ? [...result] : undefined;
}

function findMatchingClose(source: string, start: number): number {
  const stack: string[] = [];
  for (let i = start; i < source.length; i++) {
    const ch = source[i]!;
    const closer = matchingClose[ch];
    if (closer) {
      stack.push(closer);
    } else if (closeBracketChars.has(ch)) {
      if (stack.pop() !== ch) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

function hasUnbalancedBrackets(source: string): boolean {
  const stack: string[] = [];
  for (const ch of source) {
    const closer = matchingClose[ch];
    if (closer) {
      stack.push(closer);
    } else if (closeBracketChars.has(ch) && stack.pop() !== ch) {
      return true;
    }
  }
  return stack.length > 0;
}

function matchInlineWeekToken(source: string, index: number) {
  for (const matcher of inlineWeekMatchers) {
    matcher.lastIndex = index;
    const match = matcher.exec(source);
    if (match) {
      return {
        end: matcher.lastIndex,
        list: match[1]!,
        parity: match[2] ?? match[3] ?? match[4] ?? match[5],
      };
    }
  }
  return null;
}

function parseInlineCourseLine(line: string): { courseName: string; weeks: number[] | undefined; invalid: boolean } {
  const withoutPeriods = line
    .replace(wrappedPeriodPattern, "")
    .replace(globalPeriodPattern, "");
  const weeks = new Set<number>();
  const matchedSpans: Array<{ start: number; end: number }> = [];
  let invalid = false;

  for (let i = 0; i < withoutPeriods.length;) {
    const ch = withoutPeriods[i]!;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    const precededByDigit = i > 0 && /\d/.test(withoutPeriods[i - 1]!);
    if (!precededByDigit) {
      const token = matchInlineWeekToken(withoutPeriods, i);
      if (token) {
        const completedUnit = /(?:周|[单双]周?|[)）])$/.test(withoutPeriods.slice(i, token.end));
        if (!addWeeks(weeks, token.list, token.parity) || hasMalformedWeekTail(withoutPeriods.slice(token.end), completedUnit)) {
          invalid = true;
        }
        matchedSpans.push({ start: i, end: token.end });
        i = token.end;
        continue;
      }
    }

    const prefixMatch = weekPrefixBeforeBracket.exec(withoutPeriods.slice(i));
    const bracketStart = i + (prefixMatch?.[0].length ?? 0);
    if (bracketStart < withoutPeriods.length && matchingClose[withoutPeriods[bracketStart]!]) {
      const closeIdx = findMatchingClose(withoutPeriods, bracketStart);
      if (closeIdx < 0) {
        if (looksLikeMalformedWeekBracket(withoutPeriods.slice(i))) {
          invalid = true;
          break;
        }
        i += 1;
        continue;
      }
      const segment = withoutPeriods.slice(i, closeIdx + 1);
      if (segment.includes("周")) {
        const parsed = columnWeekList(segment);
        if (parsed) {
          for (const week of parsed) {
            weeks.add(week);
            if (weeks.size > 60) {
              invalid = true;
              break;
            }
          }
          if (hasMalformedWeekTail(withoutPeriods.slice(closeIdx + 1), true)) {
            invalid = true;
          }
          matchedSpans.push({ start: i, end: closeIdx + 1 });
        } else if (looksLikeMalformedWeekBracket(segment)) {
          invalid = true;
        }
      }
      i = closeIdx + 1;
      continue;
    }

    i += 1;
  }

  const merged: Array<{ start: number; end: number }> = [];
  for (const span of matchedSpans) {
    const prev = merged.at(-1);
    if (prev && /^[\s,，、;；]*$/.test(withoutPeriods.slice(prev.end, span.start))) {
      prev.end = span.end;
    } else {
      merged.push({ ...span });
    }
  }
  const lastSpan = merged.at(-1);
  if (lastSpan && /^[\s,，、;；]+$/.test(withoutPeriods.slice(lastSpan.end))) {
    lastSpan.end = withoutPeriods.length;
  }

  let cursor = 0;
  let residual = "";
  for (const span of merged) {
    residual += withoutPeriods.slice(cursor, span.start);
    if (residual && !/\s$/.test(residual)) residual += " ";
    cursor = span.end;
  }
  residual += withoutPeriods.slice(cursor);
  const courseName = residual.replace(/\s+/g, " ").trim();

  if (
    weekMarkerHint.test(courseName)
    || ((matchedSpans.length > 0 || courseName.includes("周")) && hasUnbalancedBrackets(courseName))
  ) {
    invalid = true;
  }

  return {
    courseName,
    weeks: !invalid && weeks.size > 0 ? [...weeks] : undefined,
    invalid,
  };
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
          const inline = parseInlineCourseLine(line);
          const courseName = inline.courseName;
          const weekCell = weekColumn >= 0 ? text(rows[r]![weekColumn]!) : "";
          const weekList = inline.invalid ? undefined : weekCell ? columnWeekList(weekCell) : inline.weeks;
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
