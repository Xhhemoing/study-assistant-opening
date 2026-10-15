import type { TaskCreateInput, TaskItem, TaskOrigin } from "@aistudy/contracts";
import type { TransactionSql } from "postgres";
import type { OpeningScope } from "./opening-sources";
import { OpeningPlanError } from "./opening-plan-error";

/** 0061 planning columns on a mapped task; omitted when unset so older payloads keep their shape. */
export function withTaskPlanningFields(task: TaskItem, row: Record<string, unknown>): TaskItem {
  const out: TaskItem = { ...task };
  if (typeof row.course_id === "string") out.courseId = row.course_id;
  if (typeof row.skill_label === "string") out.skillLabel = row.skill_label;
  if (typeof row.origin === "string" && row.origin !== "manual") out.origin = row.origin as TaskOrigin;
  if (row.not_before) out.notBefore = new Date(row.not_before as string | Date).toISOString();
  const slot = readPlanSlot(row.plan_slot);
  if (slot) out.studyPlan = { kind: slot.kind, localDate: slot.localDate, lessonNumbers: slot.lessonIndexes.map((index) => index + 1) };
  return out;
}

export type TaskPlanningColumns = { courseId: string | null; skillLabel: string | null; origin: TaskOrigin };

/** Course must belong to the workspace and be unarchived; a skill label only travels with a course. */
export async function resolveTaskPlanningColumns(
  tx: TransactionSql,
  scope: OpeningScope,
  input: Pick<TaskCreateInput, "courseId" | "skillLabel" | "origin">,
): Promise<TaskPlanningColumns> {
  const courseId = input.courseId ?? null;
  if (courseId) {
    const rows = await tx`SELECT 1 FROM courses
      WHERE id = ${courseId} AND workspace_id = ${scope.workspaceId} AND archived_at IS NULL`;
    if (!rows.length) throw new OpeningPlanError("NOT_FOUND", "course not found");
  }
  return {
    courseId,
    skillLabel: courseId ? input.skillLabel ?? null : null,
    origin: input.origin ?? "manual",
  };
}

/** Server-written study-plan slot (0065). Unreadable shapes read as no slot. */
export type TaskPlanSlot = {
  v: 1;
  kind: "lesson" | "review";
  localDate: string;
  lessonIndexes: number[];
  chunkIds: string[];
  note?: string;
};

export function readPlanSlot(value: unknown): TaskPlanSlot | null {
  if (!value || typeof value !== "object") return null;
  const slot = value as Record<string, unknown>;
  const ints = (list: unknown) => Array.isArray(list) && list.every((n) => Number.isInteger(n) && (n as number) >= 0);
  const strings = (list: unknown) => Array.isArray(list) && list.every((id) => typeof id === "string");
  if (slot.v !== 1 || (slot.kind !== "lesson" && slot.kind !== "review")) return null;
  if (typeof slot.localDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(slot.localDate)) return null;
  if (!ints(slot.lessonIndexes) || !strings(slot.chunkIds)) return null;
  return {
    v: 1,
    kind: slot.kind,
    localDate: slot.localDate,
    lessonIndexes: slot.lessonIndexes as number[],
    chunkIds: slot.chunkIds as string[],
    ...(typeof slot.note === "string" && slot.note ? { note: slot.note.slice(0, 2000) } : {}),
  };
}
