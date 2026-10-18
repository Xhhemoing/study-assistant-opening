import type { TaskItem, TeachingActivity } from "@aistudy/contracts";
import type { OpeningApi } from "../opening/client/api";
import { buildStartLearningCreateInput } from "../opening/teaching/today-activity";
import { assertCourseStudyActivity, buildCourseStudyInput, courseStudyTasks, currentCourseActivity } from "./course-study-model";

export type CourseStudyEntry = { kind: "activity"; activity: TeachingActivity } | { kind: "practice"; task?: TaskItem } | { kind: "cards"; task: TaskItem };

/** Course/task matching is re-read before any creation; failed resume never creates a replacement. */
export async function openCourseStudy(api: Pick<OpeningApi, "getTeachingActivity" | "listTeachingActivities" | "listTasks" | "createTeachingActivity">, options: {
  courseId: string; courseTitle: string; activityId?: string; taskId?: string; retestId?: string;
  compilerEnabled: boolean; teachingEnabled?: boolean; archived: boolean; sourceIds: readonly string[];
}): Promise<CourseStudyEntry> {
  if (options.archived) return { kind: "practice" };
  const enabled = options.teachingEnabled !== false;
  if (options.activityId && enabled) {
    const activity = assertCourseStudyActivity(await api.getTeachingActivity(options.activityId), options.courseId);
    return { kind: "activity", activity };
  }
  const activities = enabled ? await api.listTeachingActivities() : [];
  if (!options.taskId && !options.retestId) {
    const current = currentCourseActivity(activities, options.courseId);
    if (current) return { kind: "activity", activity: current };
  }
  let task: TaskItem | undefined;
  if (options.taskId || options.retestId) {
    const result = await api.listTasks();
    task = courseStudyTasks(result.tasks, options.courseId).find(row => options.taskId ? row.id === options.taskId : row.retest?.candidateId === options.retestId);
    if (!task) throw new Error("这项任务不属于本课程、尚未到开始时间或已结束，请返回课程重新选择。");
    const taskKey = `task:${task.id}`;
    const taskActivity = activities.find(row => row.courseId === options.courseId && (row.clientKey === taskKey || row.clientKey.startsWith(`${taskKey}:next:`)) && (row.status === "active" || row.status === "paused"));
    if (taskActivity) {
      if (task.requirementKey !== undefined && taskActivity.learnerFocus?.requirementKey !== undefined
        && task.requirementKey !== taskActivity.learnerFocus.requirementKey) {
        throw new Error("任务的学习要求已调整，原活动仍保留；请返回今日计划核对任务后继续。");
      }
      return { kind: "activity", activity: taskActivity };
    }
    if (task.suggestionKind === "review_cards") return { kind: "cards", task };
    if (task.retest) return { kind: "practice", task };
  }
  if (!enabled || !options.compilerEnabled) return { kind: "practice", ...(task ? { task } : {}) };
  const input = task ? buildStartLearningCreateInput({ localDate: "", courseId: options.courseId, taskId: task.id, courseTitle: task.title })
    : buildCourseStudyInput(options.courseId, options.courseTitle, activities, options.sourceIds);
  return { kind: "activity", activity: assertCourseStudyActivity(await api.createTeachingActivity(input), options.courseId) };
}
