import { courseGoalSchema } from "@aistudy/contracts";
import { localDateKeyInZone, resolveWorkspaceTimeZone } from "@aistudy/domain";
import type { TodayCourse } from "./today-read";

export function todayCourseGoalSummary(course: TodayCourse | null | undefined, timeZone?: string, now = new Date()): string | null {
  if (!course) return null;
  const parts: string[] = [];
  if (course.targetDate && courseGoalSchema.shape.targetDate.safeParse(course.targetDate).success) {
    const today = localDateKeyInZone(now, resolveWorkspaceTimeZone(timeZone));
    const days = Math.round((Date.parse(`${course.targetDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
    const label = course.learningMode === "exam" ? "考试" : "目标";
    parts.push(days > 0 ? `距${label} ${days} 天` : days === 0 ? `${label}就在今天` : `${label}日期已过 ${-days} 天`);
  }
  if (course.weeklyMinutes !== undefined && Number.isInteger(course.weeklyMinutes) && course.weeklyMinutes >= 0 && course.weeklyMinutes <= 3000) {
    const approximate = course.weeklyMinutes % 7 !== 0;
    parts.push(`每天${approximate ? "约" : ""} ${Number((course.weeklyMinutes / 7).toFixed(1))} 分钟`);
  }
  return parts.length ? parts.join(" · ") : null;
}
