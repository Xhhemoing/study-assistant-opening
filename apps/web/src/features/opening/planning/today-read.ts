export type TodayResumeState = {
  kind: "continue" | "confirm" | "empty" | "error" | "loggedOut";
  continueItem?: {
    conversationId: string;
    title: string;
    lastUserText?: string;
    courseId?: string | null;
    sourceVersions?: Record<string, number>;
    currentPage?: number | null;
  };
  confirmCount?: number;
};

export type TodayConfirmCandidate = {
  id: string;
  payload: { kind?: string } | null;
};

/** One real confirmation entry. Mixed task/memory payloads use the candidate list. */
export function todayConfirmHref(candidates: TodayConfirmCandidate[]): string {
  const kinds = new Set(
    candidates
      .map((candidate) => candidate.payload?.kind)
      .filter((kind): kind is string => kind === "memory" || kind === "task"),
  );
  if (kinds.size !== 1 || candidates.length !== 1) return "/api/opening/candidates";
  const only = candidates[0]!;
  if (only.payload?.kind === "memory") {
    return `/api/opening/candidates/${only.id}/memory-decision`;
  }
  return `/api/opening/retests/${only.id}/accept`;
}

export type TodayResumeInput = {
  hasSession: boolean;
  loadFailed: boolean;
  lastConversation?: {
    id: string;
    title: string;
    lastUserText?: string;
    courseId?: string | null;
    sourceVersions?: Record<string, number>;
    currentPage?: number | null;
  };
  pendingConfirmations?: number;
};

/** Classifies today-page resume from already-fetched facts. No HTTP or DB. */
export function resolveTodayResume(input: TodayResumeInput): TodayResumeState {
  if (!input.hasSession) return { kind: "loggedOut" };
  if (input.loadFailed) return { kind: "error" };

  const confirmCount = input.pendingConfirmations ?? 0;
  const continueItem = input.lastConversation
    ? {
        conversationId: input.lastConversation.id,
        title: input.lastConversation.title,
        lastUserText: input.lastConversation.lastUserText,
        courseId: input.lastConversation.courseId,
        sourceVersions: input.lastConversation.sourceVersions,
        currentPage: input.lastConversation.currentPage,
      }
    : undefined;

  if (confirmCount > 0) return { kind: "confirm", confirmCount, continueItem };
  if (continueItem) return { kind: "continue", continueItem };
  return { kind: "empty" };
}
