import {
  parseTimetableSheets,
  type ParsedTimetable,
  type TimetableSheet,
} from "./xlsx-reader";

type CellValue = string | number | boolean | null;

function asSheets(value: unknown): TimetableSheet[] {
  if (!Array.isArray(value)) return [];
  if (value.length === 0) return [];
  const first = value[0];
  if (first && typeof first === "object" && "data" in first && "sheet" in first) {
    return value as TimetableSheet[];
  }
  return [{ sheet: "Sheet1", data: value as CellValue[][] }];
}

/** Node-only path reader used by fixtures and tooling. Keep out of client bundles. */
export async function parseTimetable(path: string): Promise<ParsedTimetable> {
  const { default: readXlsx } = await import("read-excel-file/node");
  const sheets = asSheets(await readXlsx(path));
  return parseTimetableSheets(sheets);
}
