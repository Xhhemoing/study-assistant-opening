import type { CourseRouteActionResult, TaskItem, TeachingActivity } from "@aistudy/contracts";
import type { CourseRouteClient } from "./course-route-client";
import type { OpeningApi } from "../client/api";
import { buildStartLearningCreateInput } from "../teaching/today-activity";
import { assertCourseStudyActivity, buildCourseStudyInput, courseStudyTasks, currentCourseActivity } from "./course-study-model";

export type CompletedRetestTask = TaskItem & { retest: NonNullable<TaskItem["retest"]> };
export type CourseStudyEntry = { kind: "static-lesson"; activity: TeachingActivity; href: string } | { kind: "activity"; activity: TeachingActivity } | { kind: "practice"; task?: TaskItem } | { kind: "cards"; task: TaskItem } | { kind: "retest-review"; task: CompletedRetestTask } | { kind: "route-choice"; choice: Extract<CourseRouteActionResult, { kind: "choice" }> };

function assertStaticLessonAvailable(activity: TeachingActivity): void {
  if (activity.staticLessonUnavailable) throw new Error("原延迟复测已取消或关联不可用，原活动与记录保留；未创建替代活动。");
}
function activityEntry(activity: TeachingActivity): CourseStudyEntry {
  assertStaticLessonAvailable(activity);
  return activity.staticLesson && activity.courseId
    ? { kind: "static-lesson", activity, href: `/opening/courses/${encodeURIComponent(activity.courseId)}/study/span?${new URLSearchParams({ lesson: activity.id,
      ...(activity.staticLesson.retestId ? { retest: activity.staticLesson.retestId } : {}) })}` }
    : { kind: "activity", activity };
}

const TASK_UNAVAILABLE = "这项任务不属于本课程、尚未到开始时间或已结束，请返回课程重新选择。";
const TARGET_CHANGED = "任务的学习目标已变化或链接不匹配，请返回课程重新选择；原活动仍保留。";
const REQUIREMENT_CHANGED = "任务的学习要求已调整，原活动仍保留；请返回今日计划核对任务后继续。";

function taskRequirement(task: TaskItem): string | null | undefined {
  return task.requirementKey !== undefined ? task.requirementKey : task.retest?.requirementKey;
}

/** A known requirement must match exactly; genuinely unbound legacy tasks remain usable. */
function assertTaskRequirement(task: TaskItem, activity: TeachingActivity): TeachingActivity {
  const expected = taskRequirement(task);
  if (expected !== undefined && (activity.learnerFocus?.requirementKey ?? null) !== expected) throw new Error(REQUIREMENT_CHANGED);
  return activity;
}

/** Course/task admission precedes every targeted resume; failed resume never creates a replacement. */
export async function openCourseStudy(api: Pick<OpeningApi, "getTeachingActivity" | "listTeachingActivities" | "listTasks" | "createTeachingActivity">, options: {
  courseId: string; courseTitle: string; activityId?: string; taskId?: string; retestId?: string;
  compilerEnabled: boolean; teachingEnabled?: boolean; archived: boolean; sourceIds: readonly string[];
}, routeApi?: Pick<CourseRouteClient, "task" | "start">): Promise<CourseStudyEntry> {
  if (options.archived) return { kind: "practice" };
  const enabled = options.teachingEnabled !== false;
  let task: TaskItem | undefined;
  if (options.taskId || options.retestId) {
    const result = await api.listTasks();
    const selected = result.tasks.find(row => row.courseId === options.courseId
      && (options.taskId ? row.id === options.taskId : row.retest?.candidateId === options.retestId));
    if (options.retestId && selected?.retest?.candidateId !== options.retestId) throw new Error(TASK_UNAVAILABLE);
    if (selected?.retest && selected.retest.courseId !== options.courseId) throw new Error("这项补测不属于本课程，请返回课程重新选择。");
    if (selected?.retest && selected.requirementKey !== undefined
      && selected.requirementKey !== (selected.retest.requirementKey ?? null)) throw new Error(REQUIREMENT_CHANGED);
    if (selected?.status === "done" && selected.retest) return { kind: "retest-review", task: { ...selected, retest: selected.retest } };
    task = selected ? courseStudyTasks([selected], options.courseId)[0] : undefined;
    if (!task) throw new Error(TASK_UNAVAILABLE);
  }
  if (task) {
    if (task.teachingTargetUnavailable) throw new Error(task.teachingTargetUnavailable === "conflicting_binding"
      ? "任务关联了多个学习活动，暂不可继续；请返回课程核对，原任务与记录保留。"
      : "任务原先关联的学习活动暂不可用；请返回课程核对，未创建替代活动，原任务与记录保留。");
    // Only the freshly read server projection can bind an explicit activity to this task.
    // Client-key prefixes alone are not binding evidence (onboarding also uses a different key).
    const target = task.teachingTarget;
    if (options.activityId && (task.suggestionKind === "review_cards" || target?.activityId !== options.activityId)) throw new Error(TARGET_CHANGED);
    if (enabled && routeApi && task.suggestionKind !== "review_cards") {
      const context = await routeApi.task(options.courseId, task.id);
      if (context.managed) {
        if (context.courseId !== options.courseId || context.taskId !== task.id) throw new Error(TARGET_CHANGED);
        if (!context.available) throw new Error(context.reason ?? "这项路线任务暂不可开始，原任务与记录保留。");
        if (!target) {
          if (!options.compilerEnabled) throw new Error("当前环境暂不可开始课程路线教学，请返回课程核对资料与配置；原任务保留。");
          const result = await routeApi.start(options.courseId, { goalId: context.goalId, expectedGoalRevision: context.expectedGoalRevision,
            requirementId: context.requirementId, expectedRequirementRevision: context.expectedRequirementRevision,
            taskId: task.id, expectedTaskVersion: context.expectedTaskVersion, minutes: context.minutes,
            clientKey: `course-route-task:${task.id}:${context.expectedTaskVersion}` });
          if (result.kind === "choice") return { kind: "route-choice", choice: result };
          return activityEntry(assertTaskRequirement(task, assertCourseStudyActivity(result.activity, options.courseId)));
        }
      }
    }
    if (target) {
      if (target.courseId !== options.courseId) throw new Error(TARGET_CHANGED);
      const expectedRequirement = taskRequirement(task);
      if (expectedRequirement !== undefined && target.requirementKey !== expectedRequirement) throw new Error(REQUIREMENT_CHANGED);
      if (enabled && task.suggestionKind !== "review_cards") {
        const activity = assertCourseStudyActivity(await api.getTeachingActivity(target.activityId), options.courseId);
        if (!currentCourseActivity([activity], options.courseId, [target.activityId, ...(options.activityId ? [options.activityId] : [])])) throw new Error(TARGET_CHANGED);
        if ((activity.learnerFocus?.requirementKey ?? null) !== target.requirementKey) throw new Error(REQUIREMENT_CHANGED);
        return activityEntry(assertTaskRequirement(task, activity));
      }
    }
    if (task.suggestionKind === "review_cards") return { kind: "cards", task };
    if (task.retest) return { kind: "practice", task };
    // A genuinely unbound task retains its explicit task-key creation boundary;
    // unrelated course progress must not be substituted for this task.
    if (!enabled || !options.compilerEnabled) return { kind: "practice", task };
    const input = buildStartLearningCreateInput({ localDate: "", courseId: options.courseId, taskId: task.id, courseTitle: task.title });
    const created = assertCourseStudyActivity(await api.createTeachingActivity(input), options.courseId);
    return activityEntry(assertTaskRequirement(task, created));
  }
  // Standalone history links retain their existing behavior, but never take precedence over a task.
  if (options.activityId && enabled) {
    const activity = assertCourseStudyActivity(await api.getTeachingActivity(options.activityId), options.courseId);
    return activityEntry(activity);
  }
  const activities = enabled ? await api.listTeachingActivities() : [];
  // A workspace list may contain another course's unavailable association. Only
  // the selected course can block this entry; never erase its identity into create.
  for (const activity of activities) {
    if (activity.courseId === options.courseId && (activity.status === "active" || activity.status === "paused")) assertStaticLessonAvailable(activity);
  }
  const current = currentCourseActivity(activities, options.courseId);
  if (current) return activityEntry(current);
  if (!enabled || !options.compilerEnabled) return { kind: "practice" };
  const input = buildCourseStudyInput(options.courseId, options.courseTitle, activities, options.sourceIds);
  return activityEntry(assertCourseStudyActivity(await api.createTeachingActivity(input), options.courseId));
}
