import { createHash, randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { planningAgentResultSchema, type PlanningAgentInput, type PlanningAgentResult, type Scope } from "@aistudy/contracts";
import { createOpeningPlansRepository, type ProposePlanInput } from "./opening-plans";
import { createOpeningPlanningSettingsRepository } from "./opening-planning-settings";
import { assertAgentPlanCurrent, readAgentPlanStateHash, type AgentPlanGuard } from "./opening-agent-plan-guard";
import type { PlannedBlock } from "@aistudy/contracts";
import { createOpeningGuidanceSettingsRepository } from "./opening-guidance-settings";
import { OpeningPlanError } from "./opening-plan-error";

/** A run is never automatically restarted after a timeout or uncertain provider outcome. */
export function createOpeningPlanningAgentRepository(sql: Sql) {
  return {
    async snapshot(scope: Scope, day: string) {
      return sql.begin("isolation level repeatable read read only", async tx => {
        const db = tx as unknown as Sql;
        const repo = createOpeningPlansRepository(db);
        const preference = await createOpeningPlanningSettingsRepository(db).get(scope);
        const tasks = await repo.listTasks(scope);
        const timetable = await repo.listTimetable(scope);
        const state = await repo.getToday(scope, day);
        const hard = await repo.listHardBlocks(scope, day);
        const guidance = await createOpeningGuidanceSettingsRepository(db).get(scope);
        const preferences = await tx`SELECT opening_onboarding FROM workspace_preferences WHERE workspace_id=${scope.workspaceId}`;
        const goal = (preferences[0]?.opening_onboarding as { goal?: unknown } | null)?.goal ?? null;
        return { tasks, timetable, preference, guidance, goal, state, hard, stateHash: await readAgentPlanStateHash(tx, scope, day) };
      });
    },
    async saveDraft(scope: Scope, input: ProposePlanInput, guard: AgentPlanGuard, originalBlocks: PlannedBlock[]) {
      return sql.begin(async tx => {
        const owner = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
        if (!owner.length) throw new OpeningPlanError("NOT_FOUND", "workspace not found");
        const repo = createOpeningPlansRepository(tx as unknown as Sql);
        const existing = await repo.findDraftByProposeClientKey(scope, input.date, input.clientKey!);
        if (existing) return existing;
        await assertAgentPlanCurrent(tx, scope, input.date, guard);
        const draft = await repo.proposePlan(scope, input);
        await tx`UPDATE opening_plan_drafts SET input_snapshot = input_snapshot || ${tx.json({ agentGuard: guard, originalBlocks })}::jsonb
          WHERE id=${draft.id} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
        return draft;
      });
    },
    async start(scope: Scope, input: PlanningAgentInput, epoch: number): Promise<
      { kind: "new"; id: string } | { kind: "replayed"; result: PlanningAgentResult }
    > {
      const hash = createHash("sha256").update(JSON.stringify({ text: input.text, courseId: input.courseId })).digest("hex");
      return sql.begin(async tx => {
        const owner = await tx`SELECT id, privacy_epoch FROM workspaces
          WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
        if (!owner.length) throw new OpeningPlanError("NOT_FOUND", "workspace not found");
        if (Number(owner[0]!.privacy_epoch) !== epoch) throw new OpeningPlanError("CONFLICT", "privacy changed");
        const prior = await tx`SELECT * FROM opening_planning_agent_runs
          WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND client_key=${input.clientKey}`;
        if (prior.length) {
          const row = prior[0]!;
          if (row.input_hash !== hash || Number(row.privacy_epoch) !== epoch) throw new OpeningPlanError("CONFLICT", "clientKey payload or privacy changed");
          if (row.status === "completed") return { kind: "replayed" as const, result: planningAgentResultSchema.parse(row.result) };
          throw new OpeningPlanError("CONFLICT", "规划仍在执行或结果不确定；不会重发已计费的模型调用。");
        }
        // Expiry frees concurrency only, never authorizes replay of the old run.
        await tx`UPDATE opening_planning_agent_runs SET status='unknown', updated_at=now()
          WHERE workspace_id=${scope.workspaceId} AND status='running' AND created_at < now() - interval '90 seconds'`;
        const active = await tx`SELECT id FROM opening_planning_agent_runs
          WHERE workspace_id=${scope.workspaceId} AND status='running' LIMIT 1`;
        const recent = await tx`SELECT count(*)::int AS n FROM opening_planning_agent_runs
          WHERE workspace_id=${scope.workspaceId} AND created_at > now() - interval '1 minute'`;
        if (active.length || Number(recent[0]!.n) >= 3) throw new OpeningPlanError("CONFLICT", "已有规划在运行或请求过于频繁，请稍后查看。");
        const id = randomUUID();
        await tx`INSERT INTO opening_planning_agent_runs(id,workspace_id,owner_user_id,client_key,input_hash,privacy_epoch,status)
          VALUES(${id},${scope.workspaceId},${scope.ownerUserId},${input.clientKey},${hash},${epoch},'running')`;
        return { kind: "new" as const, id };
      });
    },
    async complete(scope: Scope, id: string, result: PlanningAgentResult, epoch: number) {
      const safe = planningAgentResultSchema.parse(result);
      const rows = await sql`UPDATE opening_planning_agent_runs r SET status='completed',result=${sql.json(safe)},updated_at=now()
        FROM workspaces w WHERE r.id=${id} AND r.workspace_id=${scope.workspaceId} AND r.owner_user_id=${scope.ownerUserId}
          AND r.status='running' AND w.id=r.workspace_id AND w.owner_user_id=r.owner_user_id AND w.privacy_epoch=${epoch}
        RETURNING r.id`;
      if (!rows.length) throw new OpeningPlanError("CONFLICT", "规划结果过期或隐私设置已变化。");
    },
    async fail(scope: Scope, id: string) {
      await sql`UPDATE opening_planning_agent_runs SET status='unknown',updated_at=now()
        WHERE id=${id} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND status='running'`;
    },
  };
}
