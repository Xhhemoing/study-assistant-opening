import type { TransactionSql } from "postgres";
import { openingPlanningSettingsSchema, weekSessionSchema, type PlannedBlock, type Scope, type TimeBlock } from "@aistudy/contracts";
import { deriveDayBlocks } from "@aistudy/domain";
import { OpeningPlanError } from "./opening-plan-error";

/** An explicit manual window can extend daily availability, but cannot erase a class, meal or sleep. */
export function plannedBlocksFitConstraints(blocks: readonly PlannedBlock[], constraints: readonly TimeBlock[], requireFreeWindow: boolean): boolean {
  return blocks.every(block => {
    const start = Date.parse(block.start), end = Date.parse(block.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return false;
    if (constraints.some(item => item.kind !== "free" && start < Date.parse(item.end) && end > Date.parse(item.start))) return false;
    return !requireFreeWindow || constraints.some(item => item.kind === "free" && start >= Date.parse(item.start) && end <= Date.parse(item.end));
  });
}

/** Called while holding the workspace lock shared with settings and timetable writes. */
export async function assertOpeningPlanConstraints(tx: TransactionSql, scope: Scope, day: string, blocks: readonly PlannedBlock[], autoDraft: boolean) {
  const [preferences] = await tx`SELECT planning_settings FROM workspace_preferences WHERE workspace_id=${scope.workspaceId}`;
  const stored = preferences?.planning_settings;
  if (stored == null && !autoDraft) return; // Existing explicit-time planning needs no saved semester settings.
  const parsed = openingPlanningSettingsSchema.safeParse(stored);
  const conflict = () => new OpeningPlanError("CONFLICT", "planning constraints changed; refresh", "stale_version");
  if (!parsed.success) throw conflict();
  const sessions = await tx`SELECT course_name, course_id, weekday, weeks, start_period, end_period
    FROM opening_timetable_sessions WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
    ORDER BY weekday, start_period`;
  let constraints: TimeBlock[];
  try {
    constraints = deriveDayBlocks(day, parsed.data, sessions.map(row => weekSessionSchema.parse({
      courseName: row.course_name, courseId: row.course_id ?? null, weekday: Number(row.weekday),
      weeks: row.weeks, startPeriod: Number(row.start_period), endPeriod: Number(row.end_period),
    })));
  } catch {
    throw conflict();
  }
  if (!plannedBlocksFitConstraints(blocks, constraints, autoDraft)) throw conflict();
}
