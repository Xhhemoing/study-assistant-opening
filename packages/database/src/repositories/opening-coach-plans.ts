import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { coachPlanAcceptanceSchema, coachPlanUndoInputSchema, coachPlanUndoResultSchema, openingAdaptivePrefsSchema,
  openingPlanningSettingsSchema, plannedBlockSchema, suggestedTaskSchema, uuidSchema,
  type CoachPlanAcceptance, type CoachPlanUndoInput, type CoachPlanUndoResult, type PlannedBlock, type Scope } from "@aistudy/contracts";
import { decideCoachAutoAccept, localDateKeyInZone } from "@aistudy/domain";
import type { Sql, TransactionSql } from "postgres";
import { OpeningPlanError } from "./opening-plan-error";
import { lockWorkspaceLearningHistory } from "./opening-learning-facts";
import { plannerSuggestionKind } from "./opening-task-fields";

const versionsSchema = z.record(uuidSchema, z.number().int().positive());
const blocksSchema = z.array(plannedBlockSchema).max(200);
const minutes = (blocks: readonly PlannedBlock[]) => blocks.reduce((sum, block) => sum + (Date.parse(block.end) - Date.parse(block.start)) / 60_000, 0);
const conflict = (message: string) => new OpeningPlanError("CONFLICT", message);

/** Called inside the ordinary acceptance transaction, after locks and replay. */
export async function assertCoachAcceptance(tx: TransactionSql, scope: Scope, input: {
  day: string; draft: Record<string, unknown>; state: Record<string, unknown>;
  blocks: readonly PlannedBlock[]; now: Date; expectedDraftVersion?: number;
}): Promise<{ acceptKeys: string[]; scheduledMinutes: number }> {
  const [stored] = await tx`SELECT adaptive_planning,planning_settings FROM workspace_preferences WHERE workspace_id=${scope.workspaceId}`;
  const prefs = openingAdaptivePrefsSchema.safeParse(stored?.adaptive_planning);
  const settings = openingPlanningSettingsSchema.safeParse(stored?.planning_settings);
  if (!prefs.success || prefs.data.autonomy !== "coach" || prefs.data.coachAutoAcceptEnabled !== true) throw conflict("教练自动安排未启用。");
  if (!settings.success || input.day !== localDateKeyInZone(input.now, settings.data.timeZone)) throw conflict("教练只能安排工作区的今天。");
  if (Number(input.state.accepted_version) !== 0 || Number(input.draft.base_version) !== 0) throw conflict("今天已有确认计划，请手动调整。");
  if (input.draft.status !== "draft" || input.draft.origin !== "auto_draft"
    || input.expectedDraftVersion === undefined || Number(input.draft.version) !== input.expectedDraftVersion) throw conflict("草案已变化，请重新读取。");
  const suggestions = suggestedTaskSchema.array().max(10).parse(input.draft.suggested_tasks ?? []);
  const suggestionIds = new Set(suggestions.map(item => item.id));
  const existingBlocks = input.blocks.filter(block => !suggestionIds.has(block.taskId));
  const existingIds = [...new Set(existingBlocks.map(block => block.taskId))];
  if (existingIds.length) {
    const existing = await tx`SELECT origin,client_key FROM opening_tasks WHERE workspace_id=${scope.workspaceId}
      AND owner_user_id=${scope.ownerUserId} AND id IN ${tx(existingIds)}`;
    if (existing.some(task => plannerSuggestionKind(task) === "review_cards")) throw conflict("卡片复习仍需由你确认安排。");
  }
  const existingMinutes = minutes(existingBlocks);
  if (!Number.isFinite(existingMinutes) || existingMinutes > prefs.data.coachBudgetMinutes) throw conflict("已有安排超过教练时间预算。");
  const decision = decideCoachAutoAccept({ autonomy: "coach", date: input.day, today: input.day, acceptedVersion: 0, acceptedOrigin: null,
    draft: { status: "draft", origin: "auto_draft", blocks: [...input.blocks], suggestedTasks: suggestions.filter(item => item.kind !== "review_cards") },
    budgetMinutes: prefs.data.coachBudgetMinutes - existingMinutes });
  if (!decision.allow) throw conflict("该草案不能自动确认。");
  const acceptedIds = new Set(suggestions.filter(item => decision.acceptKeys.includes(item.key)).map(item => item.id));
  const selectedBlocks = input.blocks.filter(block => !suggestionIds.has(block.taskId) || acceptedIds.has(block.taskId));
  const scheduledMinutes = minutes(selectedBlocks);
  if (!selectedBlocks.length || !Number.isFinite(scheduledMinutes) || scheduledMinutes <= 0
    || scheduledMinutes > prefs.data.coachBudgetMinutes) throw conflict("没有预算内可执行的安排。");
  const selectedTaskIds = [...new Set(selectedBlocks.map(block => block.taskId))];
  const active = await tx`SELECT id FROM opening_teaching_activities WHERE workspace_id=${scope.workspaceId}
    AND owner_user_id=${scope.ownerUserId} AND status IN ('active','paused') AND create_intent->>'source'='task'
    AND lower(create_intent->>'taskId') IN ${tx(selectedTaskIds)} LIMIT 1`;
  if (active.length) throw conflict("已有任务正在学习，请手动确认安排。");
  return { acceptKeys: decision.acceptKeys, scheduledMinutes };
}

async function dayLock(tx: TransactionSql, scope: Scope, date: string) {
  const digest = createHash("sha256").update(`opening-daily-draft:${scope.workspaceId}:${date}`).digest();
  await tx`SELECT pg_advisory_xact_lock(${digest.readInt32BE(0)},${digest.readInt32BE(4)})`;
  await lockWorkspaceLearningHistory(tx, scope);
  await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
}

/** Undo is a new plan version and system closure, never deletion or a learner skip. */
export async function undoOpeningCoachPlan(sql: Sql, scope: Scope, raw: CoachPlanUndoInput, now = new Date()): Promise<CoachPlanUndoResult> {
  const input = coachPlanUndoInputSchema.parse(raw);
  return sql.begin(async tx => {
    await dayLock(tx, scope, input.date);
    const [state] = await tx`SELECT accepted_version,accepted_blocks FROM opening_plan_state
      WHERE workspace_id=${scope.workspaceId} AND day=${input.date}::date FOR UPDATE`;
    const [receipt] = await tx`SELECT a.*,d.blocks AS draft_blocks,d.input_snapshot,d.suggested_tasks FROM opening_plan_acceptances a
      JOIN opening_plan_drafts d ON d.id=a.draft_id AND d.workspace_id=a.workspace_id AND d.owner_user_id=${scope.ownerUserId}
      WHERE a.workspace_id=${scope.workspaceId} AND a.client_key=${input.acceptanceClientKey} AND a.day=${input.date}::date FOR UPDATE OF a,d`;
    if (!receipt) throw new OpeningPlanError("NOT_FOUND", "教练安排记录不存在。");
    if (receipt.source !== "coach") throw conflict("只有教练自动安排可以撤销。");
    if (receipt.undone_at) {
      if (receipt.undo_client_key !== input.clientKey || !isDeepStrictEqual(receipt.undo_intent, input)) throw conflict("该安排已撤销，请重新读取。");
      return { ...coachPlanUndoResultSchema.parse(receipt.undo_result), replayed: true };
    }
    const [used] = await tx`SELECT 1 FROM opening_plan_acceptances WHERE workspace_id=${scope.workspaceId} AND undo_client_key=${input.clientKey}`;
    if (used) throw conflict("撤销请求标识已被使用。");
    if (!state || Number(state.accepted_version) !== input.expectedAcceptedVersion
      || Number(receipt.accepted_version) !== input.expectedAcceptedVersion
      || !isDeepStrictEqual(state.accepted_blocks, receipt.draft_blocks)) throw conflict("计划已被调整，不能整批撤销。");
    const blocks = blocksSchema.parse(receipt.draft_blocks), before = blocksSchema.parse(receipt.before_blocks);
    const created = versionsSchema.parse(receipt.created_task_versions);
    const taskIds = [...new Set(blocks.map(block => block.taskId))].sort();
    if (before.length || blocks.some(block => Date.parse(block.start) <= now.getTime())
      || Object.keys(created).some(id => !taskIds.includes(id))) throw conflict("安排已经开始或撤销记录不完整。");
    const tasks = taskIds.length ? await tx`SELECT id,version,status,origin,client_key,course_id,requirement_key FROM opening_tasks
      WHERE id IN ${tx(taskIds)} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} ORDER BY id FOR UPDATE` : [];
    const snapshot = z.object({ tasks: z.array(z.object({ id: uuidSchema, version: z.number().int().positive().optional() }).passthrough()) })
      .passthrough().parse(receipt.input_snapshot);
    if (tasks.length !== taskIds.length || tasks.some(task => task.status !== "pending"
      || Number(task.version) !== (created[String(task.id)] ?? snapshot.tasks.find(item => item.id === task.id)?.version))) {
      throw conflict("任务已经修改或关闭，不能整批撤销。");
    }
    const suggestions = suggestedTaskSchema.array().max(10).parse(receipt.suggested_tasks ?? []);
    if (Object.keys(created).some(id => {
      const task = tasks.find(item => item.id === id), suggestion = suggestions.find(item => item.id === id);
      return !task || !suggestion || task.origin !== "planner" || task.client_key !== suggestion.key
        || task.course_id !== suggestion.courseId || task.requirement_key !== (suggestion.requirementKey ?? null);
    })) throw conflict("教练新增任务的来源记录不一致，未撤销任何任务。");
    const started = taskIds.length ? await tx`SELECT id FROM opening_teaching_activities
      WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
        AND lower(create_intent->>'taskId') IN ${tx(taskIds)} LIMIT 1` : [];
    if (started.length) throw conflict("已有任务开始学习，不能整批撤销。");
    const closedTaskIds = Object.keys(created).sort();
    if (closedTaskIds.length) await tx`UPDATE opening_tasks SET status='skipped',close_source='system',version=version+1,updated_at=now()
      WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND id IN ${tx(closedTaskIds)}`;
    const result: CoachPlanUndoResult = { acceptedVersion: input.expectedAcceptedVersion + 1, blocks: before, closedTaskIds, replayed: false };
    await tx`UPDATE opening_plan_state SET accepted_version=${result.acceptedVersion},accepted_blocks=${tx.json(before)},updated_at=now()
      WHERE workspace_id=${scope.workspaceId} AND day=${input.date}::date`;
    await tx`UPDATE opening_plan_acceptances SET undone_at=clock_timestamp(),undo_client_key=${input.clientKey},
      undo_intent=${tx.json(input)},undo_result=${tx.json(result)},undo_result_version=${result.acceptedVersion}
      WHERE workspace_id=${scope.workspaceId} AND client_key=${input.acceptanceClientKey}`;
    return result;
  });
}

/** Read-only summary; availability is checked again by the undo transaction. */
export async function readOpeningCoachAcceptance(sql: Sql, scope: Scope, date: string, now = new Date(), clientKey?: string): Promise<CoachPlanAcceptance | null> {
  const rows = await sql`SELECT a.*,d.blocks,d.input_snapshot FROM opening_plan_acceptances a
    JOIN opening_plan_drafts d ON d.id=a.draft_id AND d.workspace_id=a.workspace_id AND d.owner_user_id=${scope.ownerUserId}
    WHERE a.workspace_id=${scope.workspaceId} AND a.day=${date}::date AND a.source='coach'
      AND (${clientKey ?? null}::text IS NULL OR a.client_key=${clientKey ?? null}) ORDER BY a.created_at DESC LIMIT 1`;
  const receipt = rows[0];
  if (!receipt) return null;
  const blocks = blocksSchema.parse(receipt.blocks), created = versionsSchema.parse(receipt.created_task_versions);
  const [state] = await sql`SELECT accepted_version FROM opening_plan_state WHERE workspace_id=${scope.workspaceId} AND day=${date}::date`;
  const taskIds = [...new Set(blocks.map(block => block.taskId))];
  const snapshot = z.object({ tasks: z.array(z.object({ id: uuidSchema, version: z.number().int().positive().optional() }).passthrough()) })
    .passthrough().parse(receipt.input_snapshot);
  const [tasks, started] = taskIds.length ? await Promise.all([
    sql`SELECT id,version,status FROM opening_tasks WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND id IN ${sql(taskIds)}`,
    sql`SELECT id FROM opening_teaching_activities WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
      AND lower(create_intent->>'taskId') IN ${sql(taskIds)} LIMIT 1`,
  ]) : [[], []];
  const untouched = tasks.length === taskIds.length && tasks.every(task => task.status === "pending"
    && Number(task.version) === (created[String(task.id)] ?? snapshot.tasks.find(item => item.id === task.id)?.version));
  return coachPlanAcceptanceSchema.parse({ clientKey: receipt.client_key, date, acceptedVersion: Number(receipt.accepted_version),
    createdTaskIds: Object.keys(created), scheduledMinutes: minutes(blocks), undone: receipt.undone_at !== null,
    undoAvailable: receipt.undone_at === null && Number(state?.accepted_version) === Number(receipt.accepted_version)
      && untouched && !started.length && blocks.every(block => Date.parse(block.start) > now.getTime()) });
}
