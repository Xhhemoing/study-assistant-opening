import { randomUUID } from "node:crypto";
import {
  conversationCreateInputSchema,
  shouldCreateLearningSession,
  turnInputSchema,
  type ConversationCreateInput,
  type ConversationResume,
  type ConversationSummary,
  type TurnInput,
  type TurnRecord,
} from "@aistudy/contracts";
import type {
  OpeningConversationRepository,
  OpeningConversationScope,
} from "@aistudy/database";
import {
  buildConversationResume,
  toConversationSummary,
} from "./conversation-continuity";
import {
  validatePageSelection,
  type AuthorizedChunk,
  type PageSelectionCode,
} from "./page-selection";

export type TutorHttpErrorCode =
  | PageSelectionCode
  | "NOT_FOUND"
  | "VALIDATION"
  | "CONFLICT";

export class TutorServiceError extends Error {
  readonly code: TutorHttpErrorCode;
  readonly status: number;
  constructor(code: TutorHttpErrorCode, message: string, status = 422) {
    super(message);
    this.name = "TutorServiceError";
    this.code = code;
    this.status = status;
  }
}

export function mapPageSelectionToHttp(code: PageSelectionCode): TutorServiceError {
  return new TutorServiceError(code, code, 422);
}

/** Pure helper for L01 HelpExposure persistence later. */
export function exposureLevelForMode(
  mode: TurnInput["mode"],
  delivered: boolean,
): "hinted" | "revealed" | null {
  if (!delivered) return null;
  if (mode === "explain") return "revealed";
  if (mode === "hint") return "hinted";
  return null;
}

export function createTutorService(deps: {
  conversations: OpeningConversationRepository;
}) {
  return {
    async listConversations(
      scope: OpeningConversationScope,
    ): Promise<ConversationSummary[]> {
      const rows = await deps.conversations.listSummaries(scope);
      return rows.map((row) => toConversationSummary(row));
    },

    async createConversation(
      scope: OpeningConversationScope,
      body: unknown,
    ): Promise<{ id: string; title: string; courseId: string | null }> {
      const input = conversationCreateInputSchema.parse(
        body,
      ) as ConversationCreateInput;
      return deps.conversations.create(scope, input);
    },

    async resumeConversation(
      scope: OpeningConversationScope,
      conversationId: string,
      opts?: {
        sticky?: {
          sourceIds: string[];
          currentPage?: number | null;
          chunkId?: string | null;
        };
        authorizedChunks?: readonly AuthorizedChunk[];
      },
    ): Promise<ConversationResume> {
      const owned = await deps.conversations.getOwned(scope, conversationId);
      const turns = await deps.conversations.loadContinuityTurns(
        scope,
        conversationId,
      );
      const built = buildConversationResume({
        conversationId,
        courseId: owned.courseId,
        sourceIds: opts?.sticky?.sourceIds ?? [],
        turns,
        sticky: opts?.sticky,
        authorizedChunks: opts?.authorizedChunks ?? [],
      });
      if (!built.ok) {
        throw mapPageSelectionToHttp(built.selection.code);
      }
      return built.resume;
    },

    async listTurns(
      scope: OpeningConversationScope,
      conversationId: string,
    ): Promise<TurnRecord[]> {
      return deps.conversations.listTurns(scope, conversationId);
    },

    async submitTurn(
      scope: OpeningConversationScope,
      body: unknown,
      opts?: { authorizedChunks?: readonly AuthorizedChunk[] },
    ): Promise<{ jobId: string; turnId: string; learningSessionId: string | null }> {
      const input = turnInputSchema.parse(body) as TurnInput;
      if (input.privacy !== "saved") {
        throw new TutorServiceError(
          "VALIDATION",
          "only privacy=saved is accepted on this path",
          400,
        );
      }

      const selection = validatePageSelection(
        {
          sourceIds: input.sourceIds,
          currentPage: input.currentPage,
          chunkId: input.chunkId,
        },
        opts?.authorizedChunks ?? [],
      );
      if (!selection.ok) {
        throw mapPageSelectionToHttp(selection.code);
      }

      await deps.conversations.getOwned(scope, input.conversationId);

      let learningSessionId = input.learningSessionId ?? null;
      if (shouldCreateLearningSession(input.mode) && !learningSessionId) {
        learningSessionId = randomUUID();
      }
      if (!shouldCreateLearningSession(input.mode)) {
        learningSessionId = null;
      }

      const saved = await deps.conversations.appendSavedTurn({
        scope,
        conversationId: input.conversationId,
        text: input.text,
        mode: input.mode,
        clientKey: input.clientKey,
        sourceIds: input.sourceIds,
        learningSessionId,
        currentPage: input.currentPage ?? null,
        chunkId: input.chunkId ?? null,
      });

      return {
        jobId: saved.jobId,
        turnId: saved.turnId,
        learningSessionId,
      };
    },
  };
}

export type TutorService = ReturnType<typeof createTutorService>;
