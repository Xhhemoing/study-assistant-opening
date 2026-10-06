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
  OpeningSourceChunksRepository,
} from "@aistudy/database";
import {
  buildConversationResume, revalidateSavedSelection,
  toConversationSummary,
} from "./conversation-continuity";
import {
  validatePageSelection,
  type AuthorizedChunk, type PageSelectionInput,
  type PageSelectionCode,
} from "./page-selection";

export type TutorHttpErrorCode =
  | PageSelectionCode
  | "NOT_FOUND"
  | "SOURCE_UNAVAILABLE"
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
  sourceChunks: OpeningSourceChunksRepository;
  attempts?: { assertAccess(scope: OpeningConversationScope, id: string): Promise<{ id: string; sessionId: string }> };
  readSelection(scope: OpeningConversationScope, conversationId: string): Promise<PageSelectionInput | null>;
}) {
  async function authorizedChunksFor(
    scope: OpeningConversationScope,
    sourceIds: readonly string[],
  ): Promise<AuthorizedChunk[]> {
    if (sourceIds.length === 0) return [];
    const chunks = await deps.sourceChunks.listForSources(scope, [...sourceIds]);
    return chunks.filter(chunk => chunk.text.trim()).map(({ id, sourceId, page }) => ({ id, sourceId, page }));
  }

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
      },
    ): Promise<ConversationResume> {
      const owned = await deps.conversations.getOwned(scope, conversationId);
      const turns = await deps.conversations.loadContinuityTurns(
        scope,
        conversationId,
      );
      const saved = opts?.sticky ?? await deps.readSelection(scope, conversationId);
      const authorizedChunks = await authorizedChunksFor(scope, saved?.sourceIds ?? []);
      const sticky = opts?.sticky ?? revalidateSavedSelection(saved, authorizedChunks);
      const sourceIds = sticky.sourceIds;
      const built = buildConversationResume({
        conversationId,
        courseId: owned.courseId,
        sourceIds,
        turns,
        sticky,
        authorizedChunks,
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
    ): Promise<{ jobId: string; turnId: string; learningSessionId: string | null }> {
      const input = turnInputSchema.parse(body) as TurnInput;
      if (input.privacy !== "saved") {
        throw new TutorServiceError(
          "VALIDATION",
          "only privacy=saved is accepted on this path",
          400,
        );
      }

      await deps.conversations.getOwned(scope, input.conversationId);
      const existing = await deps.conversations.findTurnByClientKey(
        scope,
        input.clientKey,
        input.conversationId,
      );

      if (!existing) {
        const authorized = await authorizedChunksFor(scope, input.sourceIds);
        if (input.sourceIds.some(id => !authorized.some(chunk => chunk.sourceId === id))) {
          throw new TutorServiceError("SOURCE_UNAVAILABLE", "所选材料尚无可读正文，请检查解析内容或取消选择后重试。", 422);
        }
        const selection = validatePageSelection(
          {
            sourceIds: input.sourceIds,
            currentPage: input.currentPage,
            chunkId: input.chunkId,
          },
          authorized,
        );
        if (!selection.ok) {
          throw mapPageSelectionToHttp(selection.code);
        }
      }

      const attempt = input.attemptId && deps.attempts ? await deps.attempts.assertAccess(scope, input.attemptId) : null;
      if (input.attemptId && !attempt) throw new TutorServiceError("NOT_FOUND", "attempt not found", 404);
      if (attempt && input.learningSessionId && input.learningSessionId !== attempt.sessionId) throw new TutorServiceError("VALIDATION", "attempt/session mismatch", 400);
      let learningSessionId = attempt?.sessionId ?? existing?.learningSessionId ?? input.learningSessionId ?? null;
      if (!shouldCreateLearningSession(input.mode)) {
        learningSessionId = null;
      }

      const saved = await deps.conversations.appendSavedTurn({
        scope,
        conversationId: input.conversationId,
        text: input.text,
        mode: input.mode,
        clientKey: input.clientKey,
        privacy: input.privacy,
        sourceIds: input.sourceIds,
        learningSessionId,
        attemptId: input.attemptId ?? null,
        currentPage: input.currentPage ?? null,
        chunkId: input.chunkId ?? null,
        strategyTemplateId: input.strategyTemplateId ?? null,
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
