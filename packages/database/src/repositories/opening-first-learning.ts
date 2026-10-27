import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { DEFAULT_OPENING_ADAPTIVE_PREFS, calendarDateSchema, firstLearningInputSchema, isoDateTimeSchema,
  openingAdaptivePrefsSchema, type FirstLearningInput, type Scope, type TaskItem, type TeachingActivity } from "@aistudy/contracts";
import type { Sql, TransactionSql } from "postgres";
import { ADAPTIVE_STRATEGY_VERSION, localDateKeyInZone, nextLearningStep, resolveGoalLearningContext } from "@aistudy/domain";
import { admitLearningSources, learningError, lockWorkspaceLearningHistory, nextWorkspaceLearningHistoryRevision } from "./opening-learning-facts";
import { createOpeningTeachingActivityInTransaction, mapTeachingActivity } from "./opening-teaching-activities";
import { projectOpeningAdaptiveGoals, writeOpeningCourseGoalInTx } from "./opening-learning-goal-bridge";
import { withTaskPlanningFields } from "./opening-task-fields";

const daySeedSchema = z.object({ date: calendarDateSchema, title: z.string().min(1).max(240),
  minutes: z.number().int().min(1).max(180), notBefore: isoDateTimeSchema, dueAt: isoDateTimeSchema }).strict();
export type FirstLearningDaySeed = z.infer<typeof daySeedSchema>;
export type FirstLearningInitializationInput = {
  intent: FirstLearningInput; startDate: string; planTimeZone: string; days: FirstLearningDaySeed[];
};
export type FirstLearningInitializationResult = {
  courseId: string | null; activity: TeachingActivity; tasks: TaskItem[]; firstTaskId: string | null;
  startDate: string; endDate: string; replayed: boolean; legacy: boolean;
};
const savedPlanSchema = z.object({ startDate: calendarDateSchema, endDate: calendarDateSchema,
  timeZone: z.string().min(1).max(80), taskKeys: z.array(z.string()).max(28) }).strict();

function mapTask(row: Record<string, unknown>): TaskItem {
  return withTaskPlanningFields({ id: String(row.id), version: Number(row.version), title: String(row.title),
    minutes: Number(row.minutes), dueAt: row.due_at ? new Date(row.due_at as Date).toISOString() : null,
    priority: Number(row.priority), status: row.status as TaskItem["status"] }, row);
}

async function readTasks(tx: TransactionSql, scope: Scope, keys: string[]) {
  const rows = await tx`SELECT * FROM opening_tasks WHERE workspace_id=${scope.workspaceId}
    AND owner_user_id=${scope.ownerUserId} AND client_key=ANY(${keys}::text[])`;
  const byKey = new Map(rows.map(row => [String(row.client_key), row]));
  return { tasks: keys.flatMap(key => byKey.has(key) ? [mapTask(byKey.get(key)!)] : []),
    firstTaskId: byKey.has(keys[0]!) ? String(byKey.get(keys[0]!)!.id) : null };
}

/** One activity creation receipt covers the whole initialization; replay never restores mutable defaults. */
export function createOpeningFirstLearningRepository(sql: Sql) {
  return {
    async initialize(scope: Scope, raw: FirstLearningInitializationInput,
      options: { replayOnly?: boolean } = {}): Promise<FirstLearningInitializationResult> {
      const intent = firstLearningInputSchema.parse(raw.intent);
      const courseId = intent.clientKey.toLowerCase();
      const clientKey = `first-learning:${intent.clientKey}:activity`;
      const createIntent = { source: "onboarding", ...intent };
      return sql.begin(async tx => {
        await lockWorkspaceLearningHistory(tx, scope);
        const [owner] = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
        if (!owner) throw learningError("NOT_FOUND", "workspace not found");
        // Sources are admitted before any course, goal or task is created, including on replay.
        await admitLearningSources(tx, scope, intent.sourceIds);
        const [existing] = await tx`SELECT * FROM opening_teaching_activities WHERE workspace_id=${scope.workspaceId}
          AND owner_user_id=${scope.ownerUserId} AND client_key=${clientKey} FOR UPDATE`;
        if (existing) {
          const stored = existing.create_intent as Record<string, unknown>;
          const { firstLearningPlan, ...originalIntent } = stored;
          if (!isDeepStrictEqual(originalIntent, createIntent)) throw learningError("CONFLICT", "first learning clientKey payload conflict");
          const activity = mapTeachingActivity(existing);
          const firstKey = `first-learning-activity:${activity.id}`;
          // Old activities did not create a course. Do not undo a learner's later association or removal.
          if (firstLearningPlan === undefined) {
            const tasks = await readTasks(tx, scope, [firstKey]);
            const startDate = localDateKeyInZone(new Date(activity.createdAt), intent.timeZone);
            return { courseId: activity.courseId, activity, ...tasks, startDate, endDate: startDate, replayed: true, legacy: true };
          }
          const plan = savedPlanSchema.parse(firstLearningPlan);
          const tasks = await readTasks(tx, scope, plan.taskKeys);
          return { courseId, activity, ...tasks, startDate: plan.startDate, endDate: plan.endDate, replayed: true, legacy: false };
        }
        if (options.replayOnly) throw learningError("VALIDATION", "目标日期已过去，且没有可恢复的同一学习意图");
        const startDate = calendarDateSchema.parse(raw.startDate), days = daySeedSchema.array().max(28).parse(raw.days);
        const scheduled = intent.startTime !== null;
        if (scheduled ? days.length === 0 : days.length > 0) throw learningError("VALIDATION", "首次学习日程与所选模式不一致");
        if ((days.length > 0 && days[0]!.date !== startDate) || days.some((day, index) => Date.parse(day.notBefore) >= Date.parse(day.dueAt)
          || (index > 0 && day.date <= days[index - 1]!.date))) throw learningError("VALIDATION", "首次学习计划日期无效");
        try { new Intl.DateTimeFormat("en", { timeZone: raw.planTimeZone }); }
        catch { throw learningError("VALIDATION", "首次学习计划时区无效"); }
        const [preferences] = await tx`SELECT adaptive_planning FROM workspace_preferences WHERE workspace_id=${scope.workspaceId}`;
        const parsed = openingAdaptivePrefsSchema.safeParse(preferences?.adaptive_planning ?? DEFAULT_OPENING_ADAPTIVE_PREFS);
        if (!parsed.success) throw learningError("CONFLICT", "已保存的规划偏好无法读取，未修改任何数据。");
        const [collision] = await tx`SELECT id FROM courses WHERE id=${courseId}`;
        if (collision) throw learningError("CONFLICT", "首次学习课程标识已使用，请重新开始");
        await tx`INSERT INTO courses(id,workspace_id,title,slug,description)
          VALUES(${courseId},${scope.workspaceId},${intent.topic},${`study-${courseId}`},${intent.goal})`;
        for (const [index, sourceId] of intent.sourceIds.entries()) {
          await tx`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,sort_order,visibility)
            VALUES(${scope.workspaceId},${courseId},'source',${sourceId},'reference',${index},'private')`;
        }
        const dailyMinutes = scheduled ? intent.minutes : intent.dailyMinutes;
        const prefs = await writeOpeningCourseGoalInTx(tx, scope, parsed.data, { courseId, expectedRevision: 0,
          goal: { targetDate: intent.targetDate, weeklyMinutes: (dailyMinutes ?? 0) * 7, learningMode: "auto", priority: 1 } });
        const goal = (await projectOpeningAdaptiveGoals(tx, scope, prefs)).prefs.courseGoals[courseId]!;
        await tx`INSERT INTO workspace_preferences(workspace_id,adaptive_planning) VALUES(${scope.workspaceId},${tx.json(prefs)})
          ON CONFLICT(workspace_id) DO UPDATE SET adaptive_planning=EXCLUDED.adaptive_planning,updated_at=now()`;
        // The activity id must be known to retain the established first-task -> activity shortcut.
        const summary = [intent.topic, intent.goal && `希望做到：${intent.goal}`, intent.targetDate && `目标日期：${intent.targetDate}`,
          scheduled ? `每天可用 ${intent.minutes} 分钟` : `本次学习 ${intent.minutes} 分钟`,
          !scheduled && dailyMinutes !== undefined ? `每天可用 ${dailyMinutes} 分钟` : null].filter(Boolean).join("\n");
        const provisionalPlan = { startDate, endDate: days.at(-1)?.date ?? startDate, timeZone: raw.planTimeZone };
        const learnerFocus = { skillLabel: intent.topic, ...nextLearningStep({ status: "unobserved", observations: [], wantsFullExplanation: false }),
          goalContext: resolveGoalLearningContext(goal, startDate), recentAssistance: [], strategyVersion: ADAPTIVE_STRATEGY_VERSION };
        const activity = await createOpeningTeachingActivityInTransaction(tx, scope, {
          clientKey, courseId, intentKind: intent.goal || intent.targetDate ? "goal" : "topic",
          intentSummary: summary, sourceIds: intent.sourceIds,
          goalJson: { learningGoal: intent.goal, targetDate: intent.targetDate,
            ...(scheduled ? { dailyMinutes: intent.minutes } : { sessionMinutes: intent.minutes, ...(dailyMinutes !== undefined ? { dailyMinutes } : {}) }),
            learnerFocus }, createIntent,
        }, { enqueueCompile: true });
        const taskKeys = days.map((day, index) => index === 0 ? `first-learning-activity:${activity.id}` : `first-learning:${intent.clientKey}:day:${day.date}`);
        for (const [index, day] of days.entries()) {
          const inserted = await tx`INSERT INTO opening_tasks(id,workspace_id,owner_user_id,title,minutes,due_at,not_before,priority,status,version,
            candidate_id,client_key,course_id,skill_label,origin)
            VALUES(${randomUUID()},${scope.workspaceId},${scope.ownerUserId},${day.title},${day.minutes},${day.dueAt},${day.notBefore},1,'pending',1,
              NULL,${taskKeys[index]!},${courseId},${intent.topic},'course_seed')
            ON CONFLICT(workspace_id,owner_user_id,client_key) WHERE client_key IS NOT NULL DO NOTHING RETURNING id`;
          if (!inserted.length) throw learningError("CONFLICT", "首次学习任务标识已使用，未创建本次计划");
        }
        const plan = savedPlanSchema.parse({ ...provisionalPlan, taskKeys });
        await tx`UPDATE opening_teaching_activities SET create_intent=${tx.json({ ...createIntent, firstLearningPlan: plan })}
          WHERE id=${activity.id} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
        await nextWorkspaceLearningHistoryRevision(tx, scope);
        const tasks = await readTasks(tx, scope, taskKeys);
        return { courseId, activity, ...tasks, startDate, endDate: plan.endDate, replayed: false, legacy: false };
      }) as Promise<FirstLearningInitializationResult>;
    },
  };
}
export type OpeningFirstLearningRepository = ReturnType<typeof createOpeningFirstLearningRepository>;
