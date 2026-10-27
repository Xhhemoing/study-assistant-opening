import type { TeachingActivity } from "@aistudy/contracts";
import type { TodayResumeState } from "../planning/today-read";
import { pickCurrentTeachingActivity } from "../teaching/today-activity";
import type { StartSuggestion } from "./start-composer";

/** Only persisted resume, due counts and exam dates can become suggestions. */
export function startSuggestions({ state, activities = [], reviewCount, today }: {
  state: TodayResumeState; activities?: TeachingActivity[]; reviewCount?: number | null; today: string;
}): StartSuggestion[] {
  const suggestions: StartSuggestion[] = [];
  const activity = pickCurrentTeachingActivity(activities);
  if (activity?.courseId) suggestions.push({ id: `activity:${activity.id}`, label: `继续：${activity.intentSummary}`,
    href: `/opening/courses/${encodeURIComponent(activity.courseId)}/study?activity=${encodeURIComponent(activity.id)}` });
  else if (state.continueItem) suggestions.push({ id: `conversation:${state.continueItem.conversationId}`, label: `继续：${state.continueItem.title}`,
    meta: state.continueItem.currentPage ? `第 ${state.continueItem.currentPage} 页` : undefined,
    href: `/opening/assistant?conversation=${encodeURIComponent(state.continueItem.conversationId)}` });
  if (reviewCount != null && reviewCount > 0) suggestions.push({ id: "review", label: `复习 ${reviewCount} 项`, href: "/opening/review" });
  const exam = state.courses?.status === "ready" ? state.courses.items
    .filter(course => !course.archivedAt && course.learningMode === "exam" && course.targetDate && course.targetDate >= today)
    .sort((left, right) => left.targetDate!.localeCompare(right.targetDate!))[0] : null;
  if (exam?.targetDate) suggestions.push({ id: `exam:${exam.id}`, label: `${exam.title} · ${exam.targetDate} 考试`, meta: "冲刺",
    href: `/opening/sprint?courseId=${encodeURIComponent(exam.id)}` });
  return suggestions.slice(0, 3);
}
