import type { CourseGoal } from "@aistudy/contracts";

export type TodayCourse = { id: string; title: string; archivedAt: string | null;
  targetDate?: CourseGoal["targetDate"]; weeklyMinutes?: number; learningMode?: CourseGoal["learningMode"] };

export type TodayResumeState = {
  kind: "ready" | "empty" | "error" | "loggedOut";
  continueItem?: { conversationId: string; title: string; lastUserText?: string; courseId?: string | null;
    sourceVersions?: Record<string, number>; currentPage?: number | null; manualSourceCount?: number };
  pendingReviews?: { count: number; href: "/opening/suggestions" };
  courses?: { status: "ready"; items: TodayCourse[] } | { status: "error" };
};

/** Existing context wins; an unbound activity/chat must not borrow another course's goal. */
export function currentTodayCourse(state: TodayResumeState, activity?: { courseId: string | null } | null): TodayCourse | null {
  if (state.courses?.status !== "ready") return null;
  if (activity || state.continueItem) {
    const id = activity ? activity.courseId : state.continueItem?.courseId;
    return state.courses.items.find(course => course.id === id) ?? null;
  }
  const active = state.courses.items.filter(course => !course.archivedAt);
  // 有目标的课程优先；没有目标时用第一门进行中的课程，避免有课却显示「选择课程」。
  return active.find(course => course.targetDate != null || course.weeklyMinutes !== undefined) ?? active[0] ?? null;
}
export function hasNoTodayCourses(state: TodayResumeState): boolean {
  return (state.kind === "ready" || state.kind === "empty") && state.courses?.status === "ready" && state.courses.items.length === 0;
}
export type TodayConfirmCandidate = { id: string; payload: { kind?: string } | null };
/** Compatibility helper: review navigation always opens the product page, never a write API. */
export function todayConfirmHref(_candidates: TodayConfirmCandidate[] = []): string { return "/opening/suggestions"; }
export type TodayResumeInput = {
  hasSession: boolean; loadFailed: boolean;
  lastConversation?: { id: string; title: string; lastUserText?: string; courseId?: string | null;
    sourceVersions?: Record<string, number>; currentPage?: number | null; manualSourceCount?: number };
  pendingConfirmations?: number;
};
export function resolveTodayResume(input: TodayResumeInput): TodayResumeState {
  if (!input.hasSession) return { kind: "loggedOut" };
  if (input.loadFailed) return { kind: "error" };
  const count = input.pendingConfirmations ?? 0;
  const continueItem = input.lastConversation ? { conversationId: input.lastConversation.id,
    title: input.lastConversation.title, lastUserText: input.lastConversation.lastUserText,
    courseId: input.lastConversation.courseId, sourceVersions: input.lastConversation.sourceVersions,
    currentPage: input.lastConversation.currentPage, manualSourceCount: input.lastConversation.manualSourceCount } : undefined;
  if (!continueItem && count === 0) return { kind: "empty" };
  return { kind: "ready", continueItem, pendingReviews: { count, href: "/opening/suggestions" } };
}
