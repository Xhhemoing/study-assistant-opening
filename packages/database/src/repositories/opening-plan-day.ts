import { OpeningPlanError } from "./opening-plan-error";

// This unaccepted plan-state row carries the workspace's timetable revision through backup/restore.
export const TIMETABLE_REVISION_DAY = "1900-01-01";

export function assertPlanningDay(day: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day === TIMETABLE_REVISION_DAY) {
    throw new OpeningPlanError("VALIDATION", "请选择有效的计划日期（YYYY-MM-DD）。");
  }
}
