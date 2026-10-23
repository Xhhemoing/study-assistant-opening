import type { TeachingActivity } from "@aistudy/contracts";
import { localDateKey } from "./today-view";

/** 今天（按工作区时区）在当前课程里已经学完的最近一节；没有则为 null。只读活动状态，不推断掌握程度。 */
export function finishedTodayActivity(activities: readonly Pick<TeachingActivity, "id" | "courseId" | "status" | "intentSummary" | "updatedAt">[], courseId: string | null | undefined, timeZone?: string, now = new Date()) {
  if (!courseId) return null;
  const today = localDateKey(now, timeZone);
  const finished = activities
    .filter(row => row.courseId === courseId && row.status === "completed" && localDateKey(new Date(row.updatedAt), timeZone) === today)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
  return finished[0] ? { id: finished[0].id, title: finished[0].intentSummary, count: finished.length } : null;
}
