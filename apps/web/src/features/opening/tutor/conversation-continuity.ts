/** RU-02: discovery + server-assembled bounded history for provider continuity. */

import type { Citation } from "@aistudy/contracts";
import {
  type AuthorizedChunk,
  type PageSelectionInput,
  type PageSelectionResult,
  validatePageSelection,
} from "./page-selection";

export const PROVIDER_HISTORY_MAX_TURNS = 40;

export type ContinuityTurn = {
  role: "user" | "assistant";
  text: string;
  citations?: readonly Citation[];
};

export type ResumeHistoryTurn = {
  role: "user" | "assistant";
  text: string;
  citations: Citation[];
};

export type ConversationSummaryInput = {
  id: string;
  title: string;
  courseId: string | null;
  updatedAt: string;
  lastTurnPreview: string | null;
};

export type ConversationSummary = ConversationSummaryInput;

export type ConversationResume = {
  conversationId: string;
  courseId: string | null;
  currentPage?: number | null;
  chunkId?: string | null;
  sourceIds: string[];
  boundedHistory: ResumeHistoryTurn[];
  historyTruncated: boolean;
};

function toResumeHistoryTurn(turn: ContinuityTurn): ResumeHistoryTurn {
  return {
    role: turn.role,
    text: turn.text,
    citations: turn.citations ? [...turn.citations] : [],
  };
}

export function buildBoundedHistory(
  turns: readonly ContinuityTurn[],
  maxTurns: number = PROVIDER_HISTORY_MAX_TURNS,
): { boundedHistory: ResumeHistoryTurn[]; historyTruncated: boolean } {
  const limit = Math.max(0, maxTurns);
  if (turns.length <= limit) {
    return {
      boundedHistory: turns.map(toResumeHistoryTurn),
      historyTruncated: false,
    };
  }
  const sliced = turns.slice(turns.length - limit);
  return {
    boundedHistory: sliced.map(toResumeHistoryTurn),
    historyTruncated: true,
  };
}

export function toConversationSummary(
  input: ConversationSummaryInput,
): ConversationSummary {
  return {
    id: input.id,
    title: input.title,
    courseId: input.courseId,
    updatedAt: input.updatedAt,
    lastTurnPreview: input.lastTurnPreview,
  };
}

export type BuildResumeInput = {
  conversationId: string;
  courseId: string | null;
  sourceIds: string[];
  turns: readonly ContinuityTurn[];
  /** Sticky selection from last turn / client hint — must be re-validated. */
  sticky?: PageSelectionInput;
  authorizedChunks?: readonly AuthorizedChunk[];
  maxTurns?: number;
};

export type BuildResumeResult =
  | { ok: true; resume: ConversationResume }
  | { ok: false; selection: PageSelectionResult & { ok: false } };

/**
 * Assemble ConversationResume for GET .../conversations/[id]/resume.
 * Sticky currentPage/chunkId are re-checked; never trusted as already valid.
 */
export function buildConversationResume(
  input: BuildResumeInput,
): BuildResumeResult {
  const { boundedHistory, historyTruncated } = buildBoundedHistory(
    input.turns,
    input.maxTurns ?? PROVIDER_HISTORY_MAX_TURNS,
  );

  let currentPage: number | null | undefined;
  let chunkId: string | null | undefined;
  const sourceIds = input.sticky?.sourceIds ?? input.sourceIds;

  if (input.sticky) {
    const chunks = input.authorizedChunks ?? [];
    const selection = validatePageSelection(
      {
        sourceIds,
        currentPage: input.sticky.currentPage,
        chunkId: input.sticky.chunkId,
      },
      chunks,
    );
    if (!selection.ok) {
      return { ok: false, selection };
    }
    currentPage = input.sticky.currentPage;
    chunkId = input.sticky.chunkId;
  }

  return {
    ok: true,
    resume: {
      conversationId: input.conversationId,
      courseId: input.courseId,
      currentPage,
      chunkId,
      sourceIds,
      boundedHistory,
      historyTruncated,
    },
  };
}

/** Saved context is a convenience: discard invalid selection, never block history. */
export function revalidateSavedSelection(saved: PageSelectionInput | null, chunks: readonly AuthorizedChunk[]): PageSelectionInput {
  const available = new Set(chunks.map((chunk) => chunk.sourceId));
  const sourceIds = (saved?.sourceIds ?? []).filter((id) => available.has(id));
  const selection = { sourceIds, currentPage: saved?.currentPage ?? null, chunkId: saved?.chunkId ?? null };
  return validatePageSelection(selection, chunks).ok
    ? selection
    : { sourceIds, currentPage: null, chunkId: null };
}
