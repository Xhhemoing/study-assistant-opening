import { isDeepStrictEqual } from "node:util";
import { readOpeningLearningAgenda } from "./opening-learning-agenda";
import { learningManagementCommandSchema, learningManagementOverviewSchema, learningManagementSettingsSchema,
  learningRecoveryCommandSchema, learningLifecycleCommandSchema, type Scope, type TaskItem } from "@aistudy/contracts";
import { allocateLearningCapacity, deriveDayBlocks, learningRecoveryChoice, localDateKeyInZone, resolveLocalDayBounds } from "@aistudy/domain";
import type { Sql, TransactionSql } from "postgres";
import { readLearningGoals, updateLearningGoalInTx } from "./opening-learning-goals";
import { createOpeningPlansRepository, dailyDraftAdvisoryLockKeys, mapOpeningPlanDraft } from "./opening-plans";
import { proposeOpeningLocalPlan } from "./opening-local-replan";
import { calculateSpanTutorBudgetUsage } from "./opening-learning-capacity-usage";
import { readOpeningLearningCapacity, reserveOpeningLearningActivityBudget } from "./opening-learning-capacity";
import { learningError, lockWorkspaceLearningHistory } from "./opening-learning-facts";
import { readLearningCardSessions } from "./opening-long-term-card-session";
import { createOpeningSpanSessionRepository } from "./opening-span-session";
import { readOpeningSpanTutorOriginChange } from "./opening-span-tutor-origin";
import { buildLongTermSuggestions } from "./opening-long-term-maintenance";
import { assertOpeningCourseRouteCurrent } from "./opening-course-route-origin";
import { createOpeningTeachingActivityInTransaction } from "./opening-teaching-activities";

export function learningTransactionClient(tx: TransactionSql): Sql {
  return new Proxy(tx, { get(target, key, receiver) {
    if (key === "begin") return (...args: unknown[]) => target.savepoint(nested => (args.at(-1) as (value: TransactionSql) => Promise<unknown>)(nested));
    return Reflect.get(target, key, receiver);
  } }) as unknown as Sql;
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function selectLearningRecoveryTask(tasks: readonly TaskItem[], activity?: Record<string, unknown>): TaskItem | undefined {
  if (!activity) return tasks.find(task => task.status === "pending");
  const intent = object(activity.create_intent), checkpoint = object(object(activity.checkpoint_json).spanLesson), recovery = object(object(activity.goal_json).recovery);
  const taskId = intent.taskId ?? recovery.taskId;
  return tasks.find(task => task.status === "pending" && (!activity.course_id || (task.courseId ?? task.retest?.courseId) === activity.course_id)
    && (task.id === taskId || task.teachingTarget?.activityId === activity.id || Boolean(checkpoint.retestId && [task.retest?.activityId, task.retest?.candidateId].includes(String(checkpoint.retestId)))));
}
async function lockOwner(tx: TransactionSql, scope: Scope) {
  await lockWorkspaceLearningHistory(tx, scope);
  const [owner] = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
  if (!owner) throw learningError("NOT_FOUND", "工作区不存在。");
}
function targetDate(date: string | undefined, timeZone: string, now: Date) {
  return date ? resolveLocalDayBounds(date, timeZone).dayStart : now;
}
function activityHref(row: Record<string, unknown>) {
  if (!row.course_id) return `/opening/today`;
  const base = `/opening/courses/${row.course_id}/study`;
  return object(row.create_intent).protocol === "span-lesson-v1" ? `${base}/span?lesson=${row.id}${object(object(row.checkpoint_json).spanLesson).retestId ? `&retest=${object(object(row.checkpoint_json).spanLesson).retestId}` : ""}` : `${base}?activity=${row.id}`;
}
async function overview(db: Sql, scope: Scope, date: string | undefined, now: Date) {
  const current = await readOpeningLearningCapacity(db, scope, now);
  const state = date && date !== current.localDate ? await readOpeningLearningCapacity(db, scope, targetDate(date, current.timeZone, now)) : current;
  const plans = createOpeningPlansRepository(db), accepted = await plans.getToday(scope, state.localDate);
  const [tasks, sessions, active, goals, maintenance] = await Promise.all([
    plans.listTasks(scope), readLearningCardSessions(db, scope),
    db`SELECT a.* FROM opening_teaching_activities a JOIN courses c ON c.id=a.course_id AND c.workspace_id=a.workspace_id AND c.archived_at IS NULL
      WHERE a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId} AND a.status IN ('active','paused')
        AND a.create_intent->>'protocol' IS DISTINCT FROM 'card-review-session-v1' AND COALESCE(a.create_intent->>'legacy','false')<>'true'
      ORDER BY a.updated_at DESC,a.id LIMIT 1`, readLearningGoals(db, scope),
    db`SELECT id,version,client_key FROM opening_tasks WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND status='pending' AND client_key LIKE 'planner:%:maintenance:%'`,
  ]);
  const activity = active[0], task = selectLearningRecoveryTask(tasks, activity);
  const agenda = activity ? await readOpeningLearningAgenda(db as unknown as TransactionSql, scope, String(activity.course_id), String(activity.id)) : null;
  const recovery = learningRecoveryChoice({ activityId: activity ? String(activity.id) : null, taskId: task?.id ?? null, pending: Boolean(task) });
  const warnings = ["共同预算包含已接受任务、复测与本次活动。缺席不代表能力下降；已接受安排保持原样。"];
  if (!state.budget) warnings.push("请明确设置工作区每日共同预算后生成计划；课程周预算不会自动相加成可用时间。");
  if (state.budget && state.usedMinutes > state.budget.dailyMinutes - state.budget.bufferMinutes) warnings.push("已承诺事项超过当前预算；保留原记录，请明确选择调整，当前不再追加安排。");
  if (goals.some(goal => ["paused", "archived", "stopped"].includes(goal.lifecycle))) warnings.push("暂停、归档和停止目标不生成新建议；已接受事项保留，取消请使用原任务操作。");
  return learningManagementOverviewSchema.parse({ date: state.localDate, timeZone: state.timeZone, budget: state.budget, acceptedVersion: accepted?.acceptedVersion ?? 0,
    acceptedBlocks: accepted?.blocks ?? [], committedMinutes: state.usedMinutes,
    remainingMinutes: state.budget ? Math.max(0, state.budget.dailyMinutes - state.budget.bufferMinutes - state.usedMinutes) : 0,
    overcommittedMinutes: state.budget ? Math.max(0, state.usedMinutes + state.budget.bufferMinutes - state.budget.dailyMinutes) : 0,
    tasks, recovery: { ...recovery, agenda, href: activity ? activityHref(activity) : task ? `/opening/today?task=${task.id}` : null }, warnings, cardSessions: sessions,
    maintenanceTasks: maintenance.flatMap(row => { const match = /^planner:\d{4}-\d{2}-\d{2}:maintenance:([a-f0-9-]{36}):([a-f0-9-]{36})$/.exec(String(row.client_key));
      return match ? [{ taskId: row.id, version: Number(row.version), goalId: match[1], requirementId: match[2] }] : []; }) });
}
export function createOpeningLongTermPlanningRepository(sql: Sql, clock = () => new Date(), options: { compilerEnabled?: boolean } = {}) {
  return {
    read: (scope: Scope, date?: string) => sql.begin("isolation level repeatable read read only", tx => overview(learningTransactionClient(tx), scope, date, clock())),
    async command(scope: Scope, raw: unknown) {
      const input = learningManagementCommandSchema.parse(raw), now = clock();
      if (input.action === "confirm") {
        const draft = await createOpeningPlansRepository(sql, { now: () => now }).acceptPlan(scope, input);
        return { overview: await overview(sql, scope, draft.date, now), draft };
      }
      if (input.action === "settings") return sql.begin(async tx => {
        await lockOwner(tx, scope);
        const state = await readOpeningLearningCapacity(tx, scope, now);
        if ((state.budget?.revision ?? 0) !== input.expectedRevision) throw learningError("CONFLICT", "工作区预算已更新，请读取当前预算。");
        const settings = learningManagementSettingsSchema.parse({ dailyMinutes: input.dailyMinutes, bufferMinutes: input.bufferMinutes, revision: input.expectedRevision + 1, updatedAt: now.toISOString() });
        await tx`INSERT INTO workspace_preferences(workspace_id,learning_management) VALUES(${scope.workspaceId},${tx.json(settings)})
          ON CONFLICT(workspace_id) DO UPDATE SET learning_management=EXCLUDED.learning_management,updated_at=now()`;
        return { overview: await overview(learningTransactionClient(tx), scope, undefined, now), draft: null };
      });
      return sql.begin(async tx => {
        const [a, b] = dailyDraftAdvisoryLockKeys(scope.workspaceId, input.date);
        await tx`SELECT pg_advisory_xact_lock(${a},${b})`;
        await lockOwner(tx, scope);
        const db = learningTransactionClient(tx), repo = createOpeningPlansRepository(db);
        const [prior] = await tx`SELECT * FROM opening_plan_drafts WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND propose_client_key=${input.clientKey}`;
        if (prior) {
          if (!isDeepStrictEqual(object(prior.input_snapshot).learningManagementIntent, input)) throw learningError("CONFLICT", "原预览请求已变化，请保留同一次请求。");
          return { overview: await overview(db, scope, input.date, now), draft: mapOpeningPlanDraft(prior) };
        }
        const current = await readOpeningLearningCapacity(tx, scope, now), state = await readOpeningLearningCapacity(tx, scope, targetDate(input.date, current.timeZone, now));
        if (input.date < localDateKeyInZone(now, state.timeZone)) throw learningError("VALIDATION", "不能为已过去的日期生成新安排。");
        if (!state.budget || state.budget.revision !== input.expectedBudgetRevision) throw learningError("CONFLICT", "共同预算未设置或已变化，请读取后重新选择。");
        if (!state.settings) throw learningError("VALIDATION", "请先保存可用时间与工作区时区。");
        const goals = await readLearningGoals(tx, scope), allowed = goals.filter(goal => ["active", "maintenance", "reduced"].includes(goal.lifecycle));
        const courses = await tx`SELECT id FROM courses WHERE workspace_id=${scope.workspaceId} AND archived_at IS NULL`;
        const activeCourses = new Set(courses.map(row => String(row.id)));
        const tasks = await repo.listTasks(scope), baseline = (await repo.getToday(scope, input.date))?.blocks ?? [];
        const activeTasks = await tx`SELECT create_intent->>'taskId' AS task_id FROM opening_teaching_activities WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND status IN ('active','paused') AND create_intent->>'source'='task'`;
        const candidates = tasks.filter(task => task.status === "pending" && (!task.courseId || activeCourses.has(task.courseId)) && !activeTasks.some(row => row.task_id === task.id)
          && (!task.courseId || !goals.some(goal => goal.courseIds.includes(task.courseId!)) || allowed.some(goal => goal.courseIds.includes(task.courseId!))));
        const acceptedIds = new Set(baseline.map(block => block.taskId));
        const fixedTasks = state.tasks.filter(task => task.status === "done" || acceptedIds.has(String(task.id)));
        const fixedMinutes = calculateSpanTutorBudgetUsage(state, state.activities, fixedTasks, state.blocks);
        const constraints = [...deriveDayBlocks(input.date, state.settings, await repo.listTimetable(scope)), ...(await repo.listHardBlocks(scope, input.date)).filter(block => block.kind === "locked")];
        const planningNow = Math.max(now.getTime() + 60000, state.bounds.dayStart.getTime());
        const future = constraints.map(block => block.kind === "free" ? { ...block, start: new Date(Math.max(Date.parse(block.start), planningNow)).toISOString() } : block)
          .filter(block => Date.parse(block.end) > Date.parse(block.start));
        const capacity = allocateLearningCapacity({ dailyMinutes: state.budget.dailyMinutes, bufferMinutes: state.budget.bufferMinutes, spentMinutes: fixedMinutes,
          free: [...future, ...state.blocks.map(block => ({ start: block.start, end: block.end, kind: "locked" as const }))], accepted: [], reservations: [] });
        const free = capacity.free;
        if (!free.length) return { overview: await overview(db, scope, input.date, now), draft: null };
        const extra = await buildLongTermSuggestions(tx, scope, { date: input.date, timeZone: state.timeZone, now, goals: allowed, tasks });
        const allRefs = allowed.filter(goal => [...candidates, ...extra.tasks].some(task => task.courseId && goal.courseIds.includes(task.courseId))).map(goal => ({ goalId: goal.id, revision: goal.revision }));
        const result = await proposeOpeningLocalPlan(db, scope, { date: input.date, expectedAcceptedVersion: input.expectedAcceptedVersion, clientKey: input.clientKey }, { now, allowOtherDay: true, preserveAll: true, free,
          taskIds: candidates.map(task => task.id), additional: async () => ({ tasks: extra.tasks, suggestedTasks: extra.suggestions, origin: "user", snapshot: {
            ...extra.snapshot, learningManagement: { budgetRevision: state.budget!.revision, localDate: input.date, goalRevisions: allRefs }, learningManagementIntent: input } }) });
        return { overview: await overview(db, scope, input.date, now), draft: result.kind === "draft" ? result.draft : null };
      });
    },
    async lifecycle(scope: Scope, raw: unknown) {
      const input = learningLifecycleCommandSchema.parse(raw);
      return sql.begin(async tx => {
        const goal = await updateLearningGoalInTx(tx, scope, { goalId: input.goalId, expectedRevision: input.expectedRevision, lifecycle: input.lifecycle,
          ...(input.maintenanceIntervalDays === undefined ? {} : { maintenanceIntervalDays: input.maintenanceIntervalDays }) });
        return { goal, acceptedPolicy: "keep" as const, message: "目标状态已保存，已接受任务和历史活动保留；恢复后请先核对旧位置或选择适量抽查。" };
      });
    },
    async recover(scope: Scope, raw: unknown) {
      const input = learningRecoveryCommandSchema.parse(raw), now = clock();
      if (input.action === "replan") return this.command(scope, { action: "preview", date: input.date, expectedAcceptedVersion: input.expectedAcceptedVersion, expectedBudgetRevision: input.expectedBudgetRevision, clientKey: input.clientKey });
      return sql.begin(async tx => {
        await lockOwner(tx, scope);
        const db = learningTransactionClient(tx);
        if (input.action === "shorten") {
          const [prior] = await tx`SELECT * FROM opening_teaching_activities WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
            AND client_key IN (${`recovery:${input.clientKey}`},${`span-lesson:recovery:${input.clientKey}`})`;
          if (prior) {
            if (!isDeepStrictEqual(object(prior.goal_json).recoveryIntent, input)) throw learningError("CONFLICT", "原恢复请求已变化，请保留同一次请求。");
            return { href: activityHref(prior), activityId: prior.id, taskId: input.taskId };
          }
        }
        const [activity] = input.activityId ? await tx`SELECT * FROM opening_teaching_activities WHERE id=${input.activityId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}` : [];
        const [task] = input.taskId ? await tx`SELECT * FROM opening_tasks WHERE id=${input.taskId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}` : [];
        if (input.activityId && !activity || input.taskId && (!task || task.status !== "pending")) throw learningError("NOT_FOUND", "原活动或待办不存在，请重新读取。");
        if (activity && task && selectLearningRecoveryTask(await createOpeningPlansRepository(db).listTasks(scope), activity)?.id !== input.taskId) throw learningError("CONFLICT", "所选任务不属于原活动，请重新读取真实恢复位置。");
        if (activity && await readOpeningSpanTutorOriginChange(db, scope, String(activity.id))) throw learningError("CONFLICT", "原活动依据已变化，请打开原活动按最新记录重新选择。");
        if (input.action === "continue") {
          const agenda = activity ? await readOpeningLearningAgenda(tx, scope, String(activity.course_id), String(activity.id)) : null;
          if (agenda && !agenda.resumable) throw learningError("CONFLICT", `原学习位置需重新确认：${agenda.invalidationReasons.join("、") || agenda.status}`);
          return { href: activity ? activityHref(activity) : task ? `/opening/today?task=${task.id}` : "/opening/today", activityId: activity?.id ?? null, taskId: task?.id ?? null };
        }
        const capacity = await readOpeningLearningCapacity(tx, scope, now);
        if ((capacity.budget?.revision ?? 0) !== input.expectedBudgetRevision) throw learningError("CONFLICT", "共同预算已变化，请重新读取后选择更短的本次学习。");
        if (!activity) throw learningError("VALIDATION", "请先打开原活动选择更短的本次学习；原任务与已接受时间不会被覆盖。");
        if (!input.minutes) throw learningError("VALIDATION", "请明确本次缩短后的时长。");
        if (object(activity.create_intent).protocol !== "span-lesson-v1") {
          const context = await assertOpeningCourseRouteCurrent(tx, scope, String(activity.id));
          if (!context) throw learningError("VALIDATION", "原活动没有可验证的课程要求，不能猜测缩短后的教学目标。请打开原活动调整本次学习。");
          if (!options.compilerEnabled) throw learningError("CONFLICT", "教学内容生成尚未开启，原活动保留，未创建空白活动。");
          const originalBudget = object(object(activity.goal_json).learningBudget);
          if (typeof originalBudget.minutes !== "number" || input.minutes >= originalBudget.minutes) throw learningError("VALIDATION", "缩短后的本次时长应小于原活动。");
          const goal = { ...object(activity.goal_json) }; delete goal.learningBudget; delete goal.tutorBudget;
          const created = await createOpeningTeachingActivityInTransaction(tx, scope, { clientKey: `recovery:${input.clientKey}`, courseId: String(activity.course_id),
            intentKind: "goal", intentSummary: `恢复原课程要求；本次缩短为 ${input.minutes} 分钟。${String(activity.intent_summary)}`.slice(0, 2000), sourceIds: activity.source_ids as string[],
            createIntent: { source: "recovery", activityId: String(activity.id), minutes: input.minutes },
            goalJson: { ...goal, recovery: { activityId: activity.id, taskId: input.taskId, minutes: input.minutes }, recoveryIntent: input } }, { enqueueCompile: true });
          await reserveOpeningLearningActivityBudget(tx, scope, { activityId: created.id, minutes: input.minutes, goalId: context.goalId, expectedGoalRevision: context.goalRevision }, now);
          return { href: activityHref({ ...activity, id: created.id }), activityId: created.id, taskId: input.taskId };
        }
        const sessions = createOpeningSpanSessionRepository(db), original = await sessions.get(scope, String(activity.id));
        if (!original) throw learningError("NOT_FOUND", "原学习位置不可读取。");
        if (input.minutes >= original.intent.timeBudgetMinutes) throw learningError("VALIDATION", "缩短后的本次时长应小于原活动。");
        const created = await sessions.create(scope, { courseId: original.courseId, sourceIds: original.sourceIds, clientKey: `recovery:${input.clientKey}`, intent: { ...original.intent, timeBudgetMinutes: input.minutes } });
        await tx`UPDATE opening_teaching_activities SET goal_json=goal_json || ${tx.json({ recovery: { activityId: original.activityId, taskId: input.taskId }, recoveryIntent: input })} WHERE id=${created.activityId}`;
        await reserveOpeningLearningActivityBudget(tx, scope, { activityId: created.activityId, minutes: input.minutes }, now);
        return { href: `/opening/courses/${created.courseId}/study/span?lesson=${created.activityId}`, activityId: created.activityId, taskId: input.taskId };
      });
    },
  };
}
