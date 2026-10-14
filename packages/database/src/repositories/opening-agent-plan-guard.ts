import { createHash } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import type { Scope, PlannedBlock } from "@aistudy/contracts";
import { OpeningPlanError } from "./opening-plan-error";

type Db = Sql | TransactionSql;
export type AgentPlanGuard = { stateHash: string; epoch: number; expiresAt: string };
function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, canonical(v)]));
  return value;
}
export function agentStateHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
/** Called in the same transaction as the guarded draft insert/accept. */
export async function readAgentPlanStateHash(db: Db, scope: Scope, day: string): Promise<string> {
  const tasks = await db`SELECT t.id,t.version,t.status,t.title,t.minutes,t.due_at,t.priority,t.course_id,t.source_ids,
    a.status AS retest_status,a.recommended_at FROM opening_tasks t
    LEFT JOIN opening_retest_activities a ON a.task_id=t.id AND a.workspace_id=t.workspace_id AND a.owner_user_id=t.owner_user_id
    WHERE t.workspace_id=${scope.workspaceId} AND t.owner_user_id=${scope.ownerUserId} ORDER BY t.id,a.id`;
  const settings = await db`SELECT planning_settings,guidance_settings,opening_onboarding FROM workspace_preferences WHERE workspace_id=${scope.workspaceId}`;
  const timetable = await db`SELECT course_name,course_id,weekday,weeks,start_period,end_period FROM opening_timetable_sessions
    WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} ORDER BY id`;
  const hard = await db`SELECT * FROM opening_hard_blocks WHERE workspace_id=${scope.workspaceId} AND day=${day}::date ORDER BY id`;
  const state = await db`SELECT accepted_version,accepted_blocks FROM opening_plan_state WHERE workspace_id=${scope.workspaceId} AND day=${day}::date`;
  return agentStateHash({ tasks: [...tasks], settings: [...settings], timetable: [...timetable], hard: [...hard], state: [...state] });
}
export async function assertAgentPlanCurrent(db: Db, scope: Scope, day: string, guard: AgentPlanGuard,
  proposedBlocks?: PlannedBlock[], originalBlocks?: PlannedBlock[]) {
  const owner = await db`SELECT privacy_epoch FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
  if (!owner.length || Number(owner[0]!.privacy_epoch) !== guard.epoch || !Number.isFinite(Date.parse(guard.expiresAt)) || Date.now() > Date.parse(guard.expiresAt)
    || await readAgentPlanStateHash(db, scope, day) !== guard.stateHash) {
    throw new OpeningPlanError("CONFLICT", "任务、课表或隐私已变化，或草稿已过期；请重新规划后确认。");
  }
  if (proposedBlocks && originalBlocks) {
    const proposed = new Set(proposedBlocks.map(block => JSON.stringify(block)));
    if (originalBlocks.some(block => Date.parse(block.start) <= Date.now() && !proposed.has(JSON.stringify(block)))) {
      throw new OpeningPlanError("CONFLICT", "原计划已有任务开始，不能重写已开始的安排。");
    }
  }
}
