import type { TaskCreateInput, TaskItem, TaskOrigin } from "@aistudy/contracts";
import type { TransactionSql } from "postgres";
import type { OpeningScope } from "./opening-sources";
import { OpeningPlanError } from "./opening-plan-error";

/** 0061 planning columns on a mapped task; omitted when unset so older payloads keep their shape. */
export function withTaskPlanningFields(task: TaskItem, row: Record<string, unknown>): TaskItem {
  const out: TaskItem = { ...task };
  if (typeof row.course_id === "string") out.courseId = row.course_id;
  if (typeof row.skill_label === "string") out.skillLabel = row.skill_label;
  if (typeof row.requirement_key === "string") out.requirementKey = row.requirement_key;
  if (typeof row.origin === "string" && row.origin !== "manual") out.origin = row.origin as TaskOrigin;
  if (row.not_before) out.notBefore = new Date(row.not_before as string | Date).toISOString();
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
