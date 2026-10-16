import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { localReplanInputSchema, localReplanExplicitFreeSchema, type LocalReplanInput, type LocalReplanResult, type Scope, type SuggestedTask, type TaskItem, type TimeBlock } from "@aistudy/contracts";
import { buildLocalReplan, deriveDayBlocks, localDateKeyInZone, resolveLocalDayBounds, resolveWorkspaceTimeZone } from "@aistudy/domain";
import { createOpeningPlansRepository, dailyDraftAdvisoryLockKeys, fingerprintHardBlocks, mapOpeningPlanDraft } from "./opening-plans";
import { createOpeningPlanningSettingsRepository } from "./opening-planning-settings";
import { lockWorkspaceLearningHistory } from "./opening-learning-facts";
import { OpeningPlanError } from "./opening-plan-error";

export type LocalPlanAdditional = {
  tasks: TaskItem[]; suggestedTasks: SuggestedTask[]; snapshot: Record<string, unknown>; origin: "agent";
};
export type LocalPlanOptions = {
  now?: Date; intent?: Record<string, unknown>; preserveAll?: boolean;
  admitReplay?: (tx: TransactionSql) => Promise<void>;
  additional?: (tx: TransactionSql) => Promise<LocalPlanAdditional>;
  /** Internal source-revision adapter. Not accepted by the public route. */
  taskIds?: string[];
  /** Internal adapters only. Public request schema does not admit either option. */
  allowOtherDay?: boolean;
  free?: readonly TimeBlock[];
};

/** Generation is read-only for accepted blocks. Confirmation remains a separate OCC transaction. */
export async function proposeOpeningLocalPlan(sql: Sql, scope: Scope, raw: LocalReplanInput, options: LocalPlanOptions = {}): Promise<LocalReplanResult> {
  const input = localReplanInputSchema.parse(raw);
  const explicitFree = options.free === undefined ? undefined : localReplanExplicitFreeSchema.parse(options.free);
  const intent = { ...input, intent: options.intent ?? null, preserveAll: options.preserveAll ?? false, taskIds: options.taskIds ?? null,
    ...(options.allowOtherDay ? { allowOtherDay: true } : {}), ...(explicitFree ? { explicitFree } : {}) };
  return sql.begin(async tx => {
    const [a, b] = dailyDraftAdvisoryLockKeys(scope.workspaceId, input.date);
    await tx`SELECT pg_advisory_xact_lock(${a}, ${b})`;
    await lockWorkspaceLearningHistory(tx, scope);
    const owners = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
    if (!owners.length) throw new OpeningPlanError("NOT_FOUND", "workspace not found");
    const [prior] = await tx`SELECT * FROM opening_plan_drafts WHERE workspace_id=${scope.workspaceId}
      AND owner_user_id=${scope.ownerUserId} AND propose_client_key=${input.clientKey} ORDER BY created_at LIMIT 1`;
    if (prior) {
      const saved = (prior.input_snapshot as { localPlanIntent?: unknown } | null)?.localPlanIntent;
      if (!isDeepStrictEqual(saved, intent)) throw new OpeningPlanError("CONFLICT", "clientKey intent differs", "selection_mismatch");
      await options.admitReplay?.(tx);
      return { kind: "draft" as const, draft: mapOpeningPlanDraft(prior) };
    }
    const repo = createOpeningPlansRepository(tx as unknown as Sql);
    const state = await repo.getToday(scope, input.date);
    const base = state?.acceptedVersion ?? 0;
    if (base !== input.expectedAcceptedVersion) throw new OpeningPlanError("CONFLICT", "accepted plan changed", "stale_version");
    const preference = await createOpeningPlanningSettingsRepository(tx as unknown as Sql).get(scope);
    if (preference.invalidStoredSettings || (!preference.settings && !explicitFree)) throw new OpeningPlanError("VALIDATION", "请先保存有效的学期与可用时间设置。");
    const now = options.now ?? new Date();
    const zone = resolveWorkspaceTimeZone(preference.settings?.timeZone);
    const { dayStart, nextDayStart } = resolveLocalDayBounds(input.date, zone);
    const insideDay = now >= dayStart && now < nextDayStart;
    if ((!options.allowOtherDay && !insideDay) || (options.allowOtherDay && input.date < localDateKeyInZone(now, zone))) {
      throw new OpeningPlanError("VALIDATION", "局部重排不支持已过去的日期；公开入口仅支持今天。");
    }
    if (explicitFree?.some(block => Date.parse(block.start) < dayStart.getTime() || Date.parse(block.end) > nextDayStart.getTime())) {
      throw new OpeningPlanError("VALIDATION", "显式规划窗口必须位于目标工作区日期内。");
    }
    const tasks = await repo.listTasks(scope);
    if (options.taskIds && options.taskIds.some(id => !tasks.some(task => task.id === id))) throw new OpeningPlanError("NOT_FOUND", "delta task not found");
    const active = await tx`SELECT lower(create_intent->>'taskId') AS task_id FROM opening_teaching_activities
      WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND status IN ('active','paused')
        AND create_intent->>'source'='task'`;
    const activeIds = new Set(active.map(row => String(row.task_id)));
    const configured = preference.settings ? deriveDayBlocks(input.date, preference.settings, await repo.listTimetable(scope)) : [];
    const constraints = [...(explicitFree ?? configured), ...(explicitFree ? configured.filter(block => block.kind !== "free") : []),
      ...(await repo.listHardBlocks(scope, input.date)).filter(block => block.kind !== "free" && (!preference.settings || block.kind === "locked"))];
    const additional = await options.additional?.(tx);
    const baseline = state?.blocks ?? [];
    const planningTasks = options.taskIds ? tasks.filter(task => options.taskIds!.includes(task.id) || baseline.some(block => block.taskId === task.id)) : tasks;
    const planned = buildLocalReplan({ acceptedBlocks: baseline, tasks: [...planningTasks, ...(additional?.tasks ?? [])], excludedTaskIds: activeIds,
      constraints, now, preserveAll: options.preserveAll,
      candidateTaskIds: options.taskIds ? new Set([...options.taskIds, ...(additional?.tasks ?? []).map(task => task.id)]) : undefined, options: { localDate: input.date, timeZone: zone,
        ...(insideDay ? { planningNow: new Date(Math.ceil((now.getTime() + 60_000) / 60_000) * 60_000).toISOString() } : {}),
        ...(options.taskIds ? { preferredOrder: options.taskIds } : {}) } });
    if (!planned.changed) return { kind: "no_change" as const };
    if (planned.blocks.length > 200) throw new OpeningPlanError("VALIDATION", "计划时间块过多，请先整理任务。");
    const snapshot = { ...additional?.snapshot, tasks: [...tasks, ...(additional?.tasks ?? [])], free: constraints,
      localPlanIntent: intent, localReplan: { kind: "local_replan_v1", baseAcceptedVersion: base,
        baselineBlocks: baseline, fixedBlocks: planned.fixedBlocks, releasedTaskVersions: planned.releasedTaskVersions,
        proposedAt: now.toISOString(), preserveAll: options.preserveAll ?? false, ...(explicitFree ? { explicitFree } : {}) } };
    const [row] = await tx`INSERT INTO opening_plan_drafts
      (id, workspace_id, owner_user_id, day, version, base_version, status, blocks, unscheduled_task_ids,
       input_snapshot, hard_blocks_fingerprint, propose_client_key, origin, strategy_version, suggested_tasks)
      VALUES (${randomUUID()}, ${scope.workspaceId}, ${scope.ownerUserId}, ${input.date}::date, 0, ${base}, 'draft',
       ${tx.json(planned.blocks)}, ${tx.json(planned.unscheduledTaskIds)}, ${tx.json(snapshot as never)},
       ${fingerprintHardBlocks(constraints)}, ${input.clientKey}, ${additional?.origin ?? "user"}, 'local-replan-v1',
       ${tx.json(additional?.suggestedTasks ?? [])}) RETURNING *`;
    return { kind: "draft" as const, draft: mapOpeningPlanDraft(row!) };
  });
}
