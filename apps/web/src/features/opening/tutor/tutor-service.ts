import {
  conversationCreateInputSchema,
  isRecordFollowup,
  shouldCreateLearningSession,
  turnInputSchema,
  type ConversationCreateInput,
  type ConversationResume,
  type ConversationSummary,
  type TurnInput,
  type TurnRecord,
  type StudyContextAnchor,
  type StudyIntentEvent,
} from "@aistudy/contracts";
import { composerMessageText, inferComposerIntent } from "@aistudy/domain";
import { pickSourceIds, shouldAutoPickSources } from "@aistudy/ai";
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
  systemQueryEnabled?: () => boolean;
  conversations: OpeningConversationRepository;
  sourceChunks: OpeningSourceChunksRepository;
  studyContext?: { sessionIntent(scope: OpeningConversationScope, anchor: StudyContextAnchor): Promise<StudyIntentEvent | null> };
  attempts?: { assertAccess(scope: OpeningConversationScope, id: string): Promise<{ id: string; sessionId: string }> };
  readSelection(scope: OpeningConversationScope, conversationId: string): Promise<PageSelectionInput | null>;
  /** Course membership ready pool (Data). Caps 32 + privacy exclusions inside Data. */
  listReadySourceIdsForCourse?(
    scope: OpeningConversationScope,
    courseId: string,
  ): Promise<string[]>;
}) {
  async function authorizedChunksFor(
    scope: OpeningConversationScope,
    sourceIds: readonly string[],
    anchor?: StudyContextAnchor,
  ): Promise<AuthorizedChunk[]> {
    if (sourceIds.length === 0) return [];
    let chunks = await deps.sourceChunks.listForSources(scope, [...sourceIds]);
    if (anchor?.sourceId && anchor.sourceVersion != null && sourceIds.includes(anchor.sourceId)) {
      const pinned = await deps.sourceChunks.listChunksAtVersion(scope, anchor.sourceId, anchor.sourceVersion);
      chunks = [...chunks.filter(chunk => chunk.sourceId !== anchor.sourceId), ...pinned];
    }
    // Allow image-only chunks (photo sources) for cite/selection; worker enforces VISION_REQUIRED.
    return chunks
      .filter((chunk) => Boolean(chunk.text.trim()) || Boolean(chunk.imageObjectKey?.trim()))
      .map(({ id, sourceId, page }) => ({ id, sourceId, page }));
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
      const returnedTurns = built.resume.boundedHistory.length ? turns.slice(-built.resume.boundedHistory.length) : [];
      const returnedIds = returnedTurns.flatMap(turn => turn.id ? [turn.id] : []);
      if (deps.conversations.releaseReturnedTurnIds) await deps.conversations.releaseReturnedTurnIds(scope, conversationId, returnedIds);
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
      const request = turnInputSchema.parse(body);
      if (request.privacy !== "saved") {
        throw new TutorServiceError(
          "VALIDATION",
          "only privacy=saved is accepted on this path",
          400,
        );
      }

      const owned = await deps.conversations.getOwned(scope, request.conversationId);
      const existing = await deps.conversations.findTurnByClientKey(scope, request.clientKey, request.conversationId);
      const queryHistory = isRecordFollowup(composerMessageText(request.text)) ? await deps.conversations.loadContinuityTurns(scope, request.conversationId) : [];
      const resolved = inferComposerIntent({ ...request, history: queryHistory,
        mode: request.mode ?? existing?.mode,
        practiceMode: Boolean(request.attemptId || request.contextAnchor?.attemptId || request.contextAnchor?.activityId),
      });
      // A retry reuses the original resolved defaults even if history/preferences changed.
      if (existing?.mode && request.purpose === undefined && request.querySystem === undefined) {
        resolved.purpose = existing.purpose ?? "answer";
        resolved.querySystem = existing.querySystem === true || ["query", "explain_state"].includes(resolved.purpose);
      }
      const purpose = request.purpose ?? (existing?.mode ? existing.purpose : resolved.purpose === "answer" ? undefined : resolved.purpose);
      let input = { ...request, mode: resolved.mode, purpose };
      if (resolved.querySystem) {
        if (!deps.systemQueryEnabled?.()) throw new TutorServiceError("VALIDATION", "系统记录查询暂未开启。", 409);
        const saved = await deps.conversations.appendSavedTurn({ scope, conversationId: input.conversationId, text: composerMessageText(input.text), mode: input.mode,
          clientKey: input.clientKey, privacy: "saved", querySystem: true, sourceIds: input.sourceSelection !== "none" && /哪页|原文|材料|source|page/i.test(input.text) ? input.sourceIds : [],
          contextAnchor: input.contextAnchor, purpose: input.purpose === "explain_state" ? "explain_state" : "query",
          learningSessionId: null, attemptId: null, currentPage: input.currentPage ?? null, chunkId: null });
        return { jobId: saved.jobId, turnId: saved.turnId, learningSessionId: null };
      }
      if (request.mode === undefined && !existing?.mode && deps.studyContext) {
        const anchor = request.contextAnchor ?? (request.attemptId ? { purpose: "learning_help" as const, attemptId: request.attemptId } : undefined);
        if (anchor) input = { ...input, mode: inferComposerIntent({ ...request, history: queryHistory,
          practiceMode: Boolean(request.attemptId || anchor.attemptId || anchor.activityId),
          studyIntent: await deps.studyContext.sessionIntent(scope, anchor),
        }).mode };
      }

      // Explicit client sourceIds outrank course pool. Empty + courseId → Data ready membership fill.
      const clientSourceIds = [...input.sourceIds];
      let effectiveSourceIds = input.sourceSelection === "none" ? [] : clientSourceIds.length === 0 && input.contextAnchor?.sourceId ? [input.contextAnchor.sourceId] : [...clientSourceIds];
      if (
        effectiveSourceIds.length === 0
        && input.sourceSelection !== "none" && input.sourceSelection !== "selected"
        && owned.courseId
        && deps.listReadySourceIdsForCourse
      ) {
        effectiveSourceIds = await deps.listReadySourceIdsForCourse(
          scope,
          owned.courseId,
        );
      }

      if (!existing) {
        let authorized = await authorizedChunksFor(scope, effectiveSourceIds, input.contextAnchor);
        if (clientSourceIds.length === 0) {
          // Auto/course-pool: drop unreadables; then keyword top-K when pool is large.
          effectiveSourceIds = effectiveSourceIds.filter(id =>
            authorized.some(chunk => chunk.sourceId === id),
          );
          if (shouldAutoPickSources(clientSourceIds, effectiveSourceIds)) {
            const poolChunks = await deps.sourceChunks.listForSources(scope, effectiveSourceIds);
            effectiveSourceIds = pickSourceIds({
              chunks: poolChunks,
              query: input.text,
              sourceIds: effectiveSourceIds,
            });
            authorized = authorized.filter(chunk =>
              effectiveSourceIds.includes(chunk.sourceId),
            );
          }
        } else if (effectiveSourceIds.some(id => !authorized.some(chunk => chunk.sourceId === id))) {
          throw new TutorServiceError("SOURCE_UNAVAILABLE", "所选材料尚无可读正文，请检查解析内容或取消选择后重试。", 422);
        }
        const selection = validatePageSelection(
          {
            sourceIds: effectiveSourceIds,
            currentPage: input.currentPage ?? input.contextAnchor?.page,
            chunkId: input.chunkId ?? input.contextAnchor?.chunkId,
          },
          authorized,
        );
        if (!selection.ok) {
          throw mapPageSelectionToHttp(selection.code);
        }
      }

      const attemptId = input.attemptId ?? input.contextAnchor?.attemptId;
      if (input.attemptId && input.contextAnchor?.attemptId && input.attemptId !== input.contextAnchor.attemptId) throw new TutorServiceError("VALIDATION", "context attempt mismatch", 400);
      const attempt = attemptId && deps.attempts ? await deps.attempts.assertAccess(scope, attemptId) : null;
      if (attemptId && !attempt) throw new TutorServiceError("NOT_FOUND", "attempt not found", 404);
      if (attempt && input.learningSessionId && input.learningSessionId !== attempt.sessionId) throw new TutorServiceError("VALIDATION", "attempt/session mismatch", 400);
      let learningSessionId = attempt?.sessionId ?? existing?.learningSessionId ?? input.learningSessionId ?? null;
      if (!attempt && !shouldCreateLearningSession(input.mode)) {
        learningSessionId = null;
      }

      const saved = await deps.conversations.appendSavedTurn({
        scope,
        conversationId: input.conversationId,
        text: input.text,
        mode: input.mode,
        clientKey: input.clientKey,
        privacy: "saved",
        sourceIds: effectiveSourceIds,
        learningSessionId,
        contextAnchor: input.contextAnchor, purpose: input.purpose,
        attemptId: attemptId ?? null,
        currentPage: input.currentPage ?? input.contextAnchor?.page ?? null,
        chunkId: input.chunkId ?? input.contextAnchor?.chunkId ?? null,
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
