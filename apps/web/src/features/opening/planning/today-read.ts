export type TodayResumeState = {
  kind: "ready" | "empty" | "error" | "loggedOut";
  continueItem?: { conversationId: string; title: string; lastUserText?: string; courseId?: string | null;
    sourceVersions?: Record<string, number>; currentPage?: number | null; manualSourceCount?: number };
  pendingReviews?: { count: number; href: "/opening/review" };
};
export type TodayConfirmCandidate = { id: string; payload: { kind?: string } | null };
/** Compatibility helper: review navigation always opens the product page, never a write API. */
export function todayConfirmHref(_candidates: TodayConfirmCandidate[] = []): string { return "/opening/review"; }
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
  return { kind: "ready", continueItem, pendingReviews: { count, href: "/opening/review" } };
}
