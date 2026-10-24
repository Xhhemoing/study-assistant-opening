import {
  openingAdaptivePrefsResponseSchema, openingPlanningSettingsResponseSchema, sprintBudgetResponseSchema,
  uuidSchema, type OpeningAdaptivePrefsResponse, type OpeningPlanningSettingsResponse,
  type PlannedBlock, type Scope, type SprintBudgetResponse, type TaskItem, type TimeBlock, type WeekSession,
} from "@aistudy/contracts";
import { addLocalDays, deriveDayBlocks, forecastSprintBudget, localDateKeyInZone, resolveLocalDayBounds, resolveWorkspaceTimeZone, taskCourseId } from "@aistudy/domain";

export type SprintBudgetReader = {
  assertCourse(scope: Scope, courseId: string): Promise<void>;
  preferences(scope: Scope): Promise<OpeningAdaptivePrefsResponse>;
  settings(scope: Scope): Promise<OpeningPlanningSettingsResponse>;
  tasks(scope: Scope): Promise<TaskItem[]>;
  timetable(scope: Scope): Promise<WeekSession[]>;
  constraints(scope: Scope, input: { windowStart: string; windowEnd: string; now: string; taskIds: readonly string[] }): Promise<{ accepted: PlannedBlock[]; locked: TimeBlock[] }>;
};

/** The reader exposes no write/model operation: opening this preview must never accept a plan. */
export function createSprintBudgetService(reader: SprintBudgetReader, clock = () => new Date()) {
  return { async read(scope: Scope, rawCourseId: string): Promise<SprintBudgetResponse> {
    const courseId = uuidSchema.parse(rawCourseId).toLowerCase(), now = clock();
    await reader.assertCourse(scope, courseId);
    const [prefsRaw, settingsRaw] = await Promise.all([reader.preferences(scope), reader.settings(scope)]);
    const prefs = openingAdaptivePrefsResponseSchema.parse(prefsRaw), settings = openingPlanningSettingsResponseSchema.parse(settingsRaw);
    const goal = prefs.prefs.courseGoals[courseId];
    const result: SprintBudgetResponse = {
      courseId, generatedAt: now.toISOString(), status: "ready", examDate: goal?.targetDate ?? null,
      timeZone: null, dailyMinutes: goal ? Math.floor(goal.weeklyMinutes / 7) : null,
      horizonTruncated: false, tasks: [], days: [], unscheduled: [], deferredTaskIds: [], scheduledTaskIds: [],
      warnings: ["仅预估已有待办任务，不代表教材覆盖、诊断结论或已确认安排；不会自动改写计划。", "每日预算按课程周预算除以七并向下取整；其他课程未确认的任务尚未预留。"],
    };
    if (prefs.invalidStoredPrefs || settings.invalidStoredSettings) return { ...result, status: "invalid_settings" };
    if (!goal?.targetDate || result.dailyMinutes === null || result.dailyMinutes < 1) return { ...result, status: "needs_goal" };
    if (!settings.saved || !settings.settings) return { ...result, status: "needs_settings" };
    try { result.timeZone = resolveWorkspaceTimeZone(settings.settings.timeZone); }
    catch { return { ...result, status: "invalid_settings" }; }
    const startDate = localDateKeyInZone(now, result.timeZone);
    if (goal.targetDate <= startDate) return { ...result, status: "deadline_reached" };
    const dates: string[] = [];
    for (let date = startDate; date < goal.targetDate && dates.length < 28; date = addLocalDays(date, 1)) dates.push(date);
    result.horizonTruncated = addLocalDays(dates.at(-1)!, 1) < goal.targetDate;
    const [tasks, timetable] = await Promise.all([reader.tasks(scope), reader.timetable(scope)]);
    if (tasks.length > 2000) throw new RangeError("任务过多，无法提供完整冲刺预估；请先整理旧任务。");
    const days: { date: string; blocks: TimeBlock[]; accepted: PlannedBlock[] }[] = [];
    for (const date of dates) {
      let derived: TimeBlock[];
      try { derived = deriveDayBlocks(date, settings.settings, timetable); }
      catch { return { ...result, status: "invalid_settings" }; }
      days.push({ date, blocks: derived, accepted: [] });
    }
    // A bounded output horizon must not hide crossing intervals or later accepts.
    const constraints = await reader.constraints(scope, {
      windowStart: resolveLocalDayBounds(startDate, result.timeZone).dayStart.toISOString(),
      windowEnd: resolveLocalDayBounds(dates.at(-1)!, result.timeZone).nextDayStart.toISOString(),
      now: now.toISOString(),
      taskIds: tasks.filter(task => taskCourseId(task) === courseId && task.status === "pending").map(task => task.id),
    });
    const forecast = forecastSprintBudget({ tasks, days, courseId, examDate: goal.targetDate,
      dailyMinutes: result.dailyMinutes!, timeZone: result.timeZone, now, horizonTruncated: result.horizonTruncated, constraints });
    return sprintBudgetResponseSchema.parse({ ...result, ...forecast,
      tasks: tasks.filter(task => taskCourseId(task) === courseId && task.status === "pending").map(({ id, title }) => ({ id, title })),
      warnings: [...result.warnings, ...forecast.warnings],
    });
  } };
}
