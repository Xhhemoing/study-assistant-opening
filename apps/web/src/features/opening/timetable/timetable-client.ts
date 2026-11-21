import { weekSessionSchema, type WeekSession } from "@aistudy/contracts";
import { z } from "zod";

const sessionsSchema = weekSessionSchema.array();
const snapshotSchema = z.object({ sessions: sessionsSchema, revision: z.string().min(1) });
const url = "/api/opening/timetable";

export async function readTimetable() {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error("暂时无法读取已保存的课表，请稍后重试。");
  return snapshotSchema.parse(await response.json());
}

export async function defaultPutTimetable(sessions: WeekSession[], expectedRevision: string): Promise<WeekSession[]> {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessions, expectedRevision }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(typeof body?.error?.message === "string" ? body.error.message : "课表保存失败，请重试。");
  return sessionsSchema.parse(body.sessions);
}

export function sameTimetable(left: WeekSession[], right: WeekSession[]): boolean {
  // Storage orders rows by time and returns null for an unbound course.
  const rowKeys = (rows: WeekSession[]) => rows.map(row => JSON.stringify([
    row.courseName, row.courseId ?? null, row.weekday, row.startPeriod, row.endPeriod,
    [...row.weeks].sort((a, b) => a - b),
  ])).sort();
  if (left.length !== right.length) return false;
  const expected = rowKeys(right);
  return rowKeys(left).every((row, i) => row === expected[i]);
}
