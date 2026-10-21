import type { TaskItem, TeachingActivity, TeachingActivityCreateInput } from "@aistudy/contracts";

/** Course membership is authoritative; a workspace's latest activity is never a fallback. */
export function courseStudyActivities(rows: readonly TeachingActivity[], courseId: string): TeachingActivity[] {
  return rows.filter(row => row.courseId === courseId && !(row.intentKind === "course_continue" && row.contentVersion === 0))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

export function assertCourseStudyActivity(activity: TeachingActivity, courseId: string): TeachingActivity {
  if (activity.courseId !== courseId) throw new Error("该学习活动不属于本课程，请返回课程重新进入。");
  return activity;
}

export function currentCourseActivity(rows: readonly TeachingActivity[], courseId: string): TeachingActivity | null {
  return courseStudyActivities(rows, courseId).find(row => row.status === "active" || row.status === "paused") ?? null;
}

export function courseStudyTasks(rows: readonly TaskItem[], courseId: string, now = new Date()): TaskItem[] {
  return rows.filter(row => row.courseId === courseId && row.status === "pending"
    && (!row.notBefore || Date.parse(row.notBefore) <= now.getTime())
    && (!row.retest?.recommendedAt || Date.parse(row.retest.recommendedAt) <= now.getTime()))
    .sort((a, b) => b.priority - a.priority || (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999") || a.id.localeCompare(b.id));
}

export function courseStudyHref(courseId: string, activityId?: string | null): string {
  const base = `/opening/courses/${encodeURIComponent(courseId)}/study`;
  return activityId ? `${base}?activity=${encodeURIComponent(activityId)}` : base;
}

export function courseActivityNextStep(activity: TeachingActivity): string {
  if (activity.status === "completed") return "本次学习已结束，可以回顾或开始下一次。";
  if (activity.status === "skipped") return "上次活动已跳过，可以重新选择任务。";
  if (activity.generateStatus === "queued" || activity.generateStatus === "generating") return "讲解正在准备，进入后可刷新状态或先独立练习。";
  if (activity.generateStatus === "failed" || activity.generateStatus === "cancelled" || activity.generateStatus === "stale") return "讲解暂不可用，进入后可恢复生成或先独立练习。";
  if (activity.generateStatus === "unknown") return "讲解状态待确认，进入后可重新读取。";
  if (activity.generateStatus === "needs_check") return "讲解需要核查，可恢复原学习位置并查看提醒。";
  if (activity.contentVersion === 0) return "当前还没有讲解内容，可以先独立练习。";
  return activity.status === "paused" ? "从已保存的学习位置继续。" : "继续当前学习单元，保留原回答与帮助记录。";
}

/** A retry reuses this course's current chain; another course can never replay it. */
export function buildCourseStudyInput(courseId: string, courseTitle: string, activities: readonly TeachingActivity[], sourceIds: readonly string[]): TeachingActivityCreateInput {
  const previous = courseStudyActivities(activities, courseId)[0];
  const afterActivityId = previous?.id ?? null;
  return {
    clientKey: `course-study:${courseId}:${afterActivityId ?? "first"}`,
    intentKind: "topic",
    intentSummary: `${courseTitle.trim() || "课程"} · 本次学习`.slice(0, 2000),
    courseId,
    sourceIds: [...new Set(sourceIds)].sort().slice(0, 32),
    createIntent: { source: "course", intentKind: "topic", courseId, afterActivityId },
    continueAfterCompleted: true,
  };
}
