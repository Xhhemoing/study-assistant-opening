import type { TransactionSql } from "postgres";
import { openingPlanningSettingsSchema, weekSessionSchema, type PlannedBlock, type Scope, type TimeBlock } from "@aistudy/contracts";
import { deriveDayBlocks, resolveLocalDayBounds, resolveWorkspaceTimeZone } from "@aistudy/domain";
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
export async function assertOpeningPlanConstraints(tx: TransactionSql, scope: Scope, day: string, blocks: readonly PlannedBlock[], autoDraft: boolean,
  explicitFree?: readonly TimeBlock[]) {
  const [preferences] = await tx`SELECT planning_settings FROM workspace_preferences WHERE workspace_id=${scope.workspaceId}`;
  const stored = preferences?.planning_settings;
  const parsed = openingPlanningSettingsSchema.safeParse(stored);
  const conflict = () => new OpeningPlanError("CONFLICT", "planning constraints changed; refresh", "stale_version");
  if ((!parsed.success && stored != null) || (stored == null && autoDraft && !explicitFree)) throw conflict();
  let constraints: TimeBlock[] = [];
  try {
    if (parsed.success) {
      const sessions = await tx`SELECT course_name, course_id, weekday, weeks, start_period, end_period
        FROM opening_timetable_sessions WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
        ORDER BY weekday, start_period`;
      constraints = deriveDayBlocks(day, parsed.data, sessions.map(row => weekSessionSchema.parse({
        courseName: row.course_name, courseId: row.course_id ?? null, weekday: Number(row.weekday),
        weeks: row.weeks, startPeriod: Number(row.start_period), endPeriod: Number(row.end_period),
      })));
    }
    if (explicitFree) {
      const bounds = resolveLocalDayBounds(day, resolveWorkspaceTimeZone(parsed.success ? parsed.data.timeZone : undefined));
      if (explicitFree.some(block => Date.parse(block.start) < bounds.dayStart.getTime() || Date.parse(block.end) > bounds.nextDayStart.getTime())
        || !plannedBlocksFitConstraints(blocks, explicitFree, true)) throw conflict();
    }
  } catch {
    throw conflict();
  }
  // Without saved settings, retained hard rows remain authoritative; manual windows
  // must not turn a missing preference row into permission to overlap them.
  const locked = await tx`SELECT start_at, end_at, kind FROM opening_hard_blocks
    WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND day=${day}::date
      AND kind<>'free' AND (kind='locked' OR ${stored == null})`;
  constraints.push(...locked.map(row => ({ start: new Date(row.start_at as string | Date).toISOString(),
    end: new Date(row.end_at as string | Date).toISOString(), kind: (row.kind ?? "locked") as TimeBlock["kind"] })));
  if (!plannedBlocksFitConstraints(blocks, constraints, autoDraft && explicitFree === undefined)) throw conflict();
}
