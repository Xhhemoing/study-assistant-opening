import { randomUUID } from "node:crypto";
import { EphemeralProvenanceError, mergeContextSourceRefs, type EphemeralProvenanceRepository } from "@aistudy/database";
import {
  providerOutputSchema,
  type StudyContextAnchor,
  type StudyExposureReceipt,
  type StudyIntentEvent,
  type EphemeralTurnInput,
  type EphemeralTurnResponse,
  type ProviderInput,
  type OpeningModelSnapshot,
  type ProviderOutput,
  type SourceChunk,
  type TutorMode,
} from "@aistudy/contracts";
import { composerMessageText, inferComposerIntent, makeStudyLanguageSupport, studyIntentForMessage, studyIntentInstruction } from "@aistudy/domain";
import type { SystemQueryService } from "@aistudy/ai";
import { replyEphemeralSystemQuery } from "./ephemeral-system-query";
import { EphemeralServiceError } from "./ephemeral-error";
export { EphemeralServiceError } from "./ephemeral-error";
import {
  assertEphemeralInput,
  canProposeTask,
  ConversationPolicyError,
  pickSourceIds,
  renumberInlineCitations,
  resolveCitations,
  selectContext,
  shouldAutoPickSources,
  stripEphemeralCandidates,
  tutorCitationsFromMarkdown,
} from "@aistudy/ai";
import { OpeningProviderError } from "@aistudy/ai";
import {
  actualCentsForOutput,
  isNotSentFailure,
  isBudgetReplayError,
  reservationCentsForInput,
  reservationTerms,
  runBudgetedCall,
  withModelFallback,
  type BudgetedRepository,
  type ReservationTerms,
  type ResolvedTaskModel,
  type ParentInteractionBudget,
} from "@aistudy/ai";
import {
  isImageOnlySourceChunks,
  makeTutorInstruction,
  VISION_REQUIRED_MESSAGE,
} from "../../../../../worker/src/jobs/tutor-turn";
import {
  validatePageSelection,
  type AuthorizedChunk,
} from "./page-selection";

export type EphemeralScope = { workspaceId: string; ownerUserId: string };

type CompleteWithSignal = (
  input: ProviderInput,
  signal?: AbortSignal,
  onTextDelta?: (delta: string) => void | Promise<void>,
) => Promise<ProviderOutput>;

export type EphemeralProvider = {
  complete: CompleteWithSignal;
};

export type EphemeralTutorDeps = {
  studyContext?: { resolve(scope: EphemeralScope, anchor: StudyContextAnchor, expected?: { courseId?: string | null; sourceIds?: readonly string[] }): Promise<StudyContextAnchor>; languageSupport?(scope: EphemeralScope, anchor: StudyContextAnchor): Promise<string | null>; sessionIntent?(scope: EphemeralScope, anchor: StudyContextAnchor): Promise<StudyIntentEvent | null> };
  exposures?: { deliver(scope: EphemeralScope, input: { releaseKey: string; contextAnchor: StudyContextAnchor; origin: "assistant"; kind: "hint" | "solution"; level: "hinted" | "revealed"; supportDomain: "unknown" | "language" }): Promise<StudyExposureReceipt> };
  systemQuery?: SystemQueryService;
  sources: { listOwnedIds(scope: EphemeralScope, sourceIds: string[]): Promise<string[]> };
  chunks: { listForSources(scope: EphemeralScope, sourceIds: string[]): Promise<SourceChunk[]>; listChunksAtVersion?(scope: EphemeralScope, sourceId: string, version: number): Promise<SourceChunk[]> };
  privacy: {
    snapshot(scope: EphemeralScope): Promise<{ epoch: number; excludedSourceIds: string[] }>;
    currentEpoch(scope: EphemeralScope): Promise<number>;
  };
  provenance?: EphemeralProvenanceRepository;
  budget: BudgetedRepository;
  provider: EphemeralProvider | null;
  modelSnapshot?: OpeningModelSnapshot;
  resolveModel?: (scope: EphemeralScope, mode: TutorMode) => Promise<ResolvedTaskModel>;
  /** The user's explicit fallback for this mode's task; used only after a not-sent failure. */
  resolveFallbackModel?: (scope: EphemeralScope, mode: TutorMode) => Promise<ResolvedTaskModel | null>;
  pageImages?: (scope: EphemeralScope, input: { sourceIds: string[]; sourceVersions: Record<string, number>; physicalPage: number }) => Promise<ProviderInput["imageParts"]>;
  /** Package B/C: course membership ready pool when client sourceIds empty + courseId. */
  listReadySourceIdsForCourse?(scope: EphemeralScope, courseId: string): Promise<string[]>;
  config: {
    maxContextCharacters: number;
    reservedCents: number;
    maxOutputTokens: number;
    inputCentsPerMillion: number;
    outputCentsPerMillion: number;
  };
  now?: () => number;
  requestKey?: () => string;
};

function instructionFor(mode: TutorMode): string {
  const base = makeTutorInstruction(mode);
  if (!canProposeTask(mode)) return `${base} Do not create tasks.`;
  return base;
}

export function createEphemeralTutorService(deps: EphemeralTutorDeps) {
  return {
    async replyEphemeral(
      scope: EphemeralScope,
      request: EphemeralTurnInput,
      signal?: AbortSignal,
      onTextDelta?: (delta: string) => void | Promise<void>,
    ): Promise<EphemeralTurnResponse> {
      try {
        assertEphemeralInput(request);
      } catch (error) {
        if (error instanceof ConversationPolicyError) {
          throw new EphemeralServiceError("VALIDATION", error.message, error.status);
        }
        throw error;
      }
      if (signal?.aborted) {
        throw new EphemeralServiceError("ABORTED", "ephemeral request aborted", 499);
      }
      const resolved = inferComposerIntent({ ...request,
        practiceMode: Boolean(request.contextAnchor?.attemptId || request.contextAnchor?.activityId),
      });
      let input = { ...request, ...resolved };
      if (["plan", "teach"].includes(resolved.purpose)) throw new EphemeralServiceError("VALIDATION", "规划与教学提案需要切换到保存的对话后创建。", 409);
      if (resolved.querySystem) {
        if (!deps.systemQuery?.enabled() || !deps.provenance) throw new EphemeralServiceError("SYSTEM_QUERY_DISABLED", "系统记录查询暂未开启。", 409);
        return replyEphemeralSystemQuery({ systemQuery: deps.systemQuery, provenance: deps.provenance, requestId: deps.requestKey }, scope, { ...input, text: composerMessageText(input.text) }, signal);
      }
      if (input.contextAnchor && !deps.studyContext) throw new EphemeralServiceError("VALIDATION", "study context resolver unavailable", 409);
      const contextAnchor = input.contextAnchor ? await deps.studyContext!.resolve(scope, input.contextAnchor, { courseId: input.courseId }) : undefined;
      const sessionIntent = contextAnchor ? await deps.studyContext?.sessionIntent?.(scope, contextAnchor) : null;
      if (request.mode === undefined) input = { ...input, mode: inferComposerIntent({ ...request,
        practiceMode: Boolean(contextAnchor?.attemptId || contextAnchor?.activityId), studyIntent: sessionIntent,
      }).mode };
      if (contextAnchor?.attemptId && !deps.exposures) throw new EphemeralServiceError("VALIDATION", "help delivery recorder unavailable", 409);
      if (contextAnchor?.purpose === "language_support") {
        if (!deps.exposures) throw new EphemeralServiceError("VALIDATION", "language delivery recorder unavailable", 409);
        const canonicalQuestion = await deps.studyContext?.languageSupport?.(scope, contextAnchor) ?? null;
        const privacy = await deps.privacy.snapshot(scope);
        const exposureReceipt = await deps.exposures.deliver(scope, { releaseKey: `ephemeral:${input.clientKey ?? deps.requestKey?.() ?? randomUUID()}`,
          contextAnchor, origin: "assistant", supportDomain: "language", kind: "hint", level: "hinted" });
        return { text: makeStudyLanguageSupport(canonicalQuestion), contextAnchor, exposureReceipt, citedChunkIds: [], candidates: [],
          requestId: null, inputTokens: 0, outputTokens: 0, citations: [], provenanceId: null, privacyEpoch: privacy.epoch, historyDiscarded: input.history.length > 0 };
      }
      const clientSourceIds = [...input.sourceIds];
      // Explicit client sourceIds outrank course pool. Empty + courseId → membership fill.
      let resolvedSourceIds = input.sourceSelection === "none" ? [] : clientSourceIds.length === 0 && contextAnchor?.sourceId ? [contextAnchor.sourceId] : [...clientSourceIds];
      if (
        resolvedSourceIds.length === 0
        && input.sourceSelection !== "none" && input.sourceSelection !== "selected"
        && input.courseId
        && deps.listReadySourceIdsForCourse
      ) {
        resolvedSourceIds = await deps.listReadySourceIdsForCourse(scope, input.courseId);
      }
      const owned = new Set(resolvedSourceIds.length
        ? await deps.sources.listOwnedIds(scope, resolvedSourceIds)
        : []);
      const missing = resolvedSourceIds.filter((id) => !owned.has(id));
      if (missing.length) {
        throw new EphemeralServiceError("NOT_FOUND", "source is not in this workspace", 404);
      }
      const privacy = await deps.privacy.snapshot(scope);
      const excluded = new Set(privacy.excludedSourceIds.map(id => id.toLowerCase()));
      let allowedSourceIds = resolvedSourceIds.filter(id => !excluded.has(id.toLowerCase()));
      if (resolvedSourceIds.length && !allowedSourceIds.length) {
        throw new EphemeralServiceError("SOURCE_EXCLUDED", "所选材料已停止供 AI 使用，请取消选择后重试。", 409);
      }
      const epochChanged = input.history.length > 0 && input.historyPrivacyEpoch !== privacy.epoch;
      let chunks = (allowedSourceIds.length
        ? await deps.chunks.listForSources(scope, allowedSourceIds)
        : []).filter((chunk) => Boolean(chunk.text.trim()) || Boolean(chunk.imageObjectKey?.trim()));
      if (contextAnchor?.sourceId && contextAnchor.sourceVersion != null) {
        if (!allowedSourceIds.includes(contextAnchor.sourceId)) throw new EphemeralServiceError("CONFLICT", "selected anchor material is outside request sources", 409);
        if (chunks.some(chunk => chunk.sourceId === contextAnchor.sourceId && chunk.sourceVersion !== contextAnchor.sourceVersion) || !chunks.some(chunk => chunk.sourceId === contextAnchor.sourceId)) {
          if (!deps.chunks.listChunksAtVersion) throw new EphemeralServiceError("CONFLICT", "selected material version unavailable", 409);
          const pinned = await deps.chunks.listChunksAtVersion(scope, contextAnchor.sourceId, contextAnchor.sourceVersion);
          if (!pinned.length || pinned.some(chunk => chunk.sourceVersion !== contextAnchor.sourceVersion)) throw new EphemeralServiceError("CONFLICT", "selected material version unavailable", 409);
          chunks = [...chunks.filter(chunk => chunk.sourceId !== contextAnchor.sourceId), ...pinned];
        }
      }
      const selectedPage = input.currentPage ?? contextAnchor?.page;
      const selectedChunk = input.chunkId ?? contextAnchor?.chunkId;
      if (input.currentPage != null && contextAnchor?.page != null && input.currentPage !== contextAnchor.page
        || input.chunkId != null && contextAnchor?.chunkId != null && input.chunkId !== contextAnchor.chunkId) throw new EphemeralServiceError("CONFLICT", "page selection differs from study context", 409);
      if (clientSourceIds.length === 0) {
        // Auto/course-pool path: drop unreadables instead of failing the whole pool.
        allowedSourceIds = allowedSourceIds.filter(id =>
          chunks.some(chunk => chunk.sourceId === id),
        );
      } else if (allowedSourceIds.some(id => !chunks.some(chunk => chunk.sourceId === id))) {
        throw new EphemeralServiceError("SOURCE_UNAVAILABLE", "所选材料尚无可读正文，请检查解析内容或取消选择后重试。", 422);
      }
      // Auto path only: narrow a large course pool by keyword before selectContext.
      if (shouldAutoPickSources(clientSourceIds, allowedSourceIds)) {
        allowedSourceIds = pickSourceIds({
          chunks,
          query: input.text,
          sourceIds: allowedSourceIds,
        });
        chunks = chunks.filter(chunk => allowedSourceIds.includes(chunk.sourceId));
      }
      const authorized: AuthorizedChunk[] = chunks.map(({ id, sourceId, page }) => ({ id, sourceId, page }));
      const selection = validatePageSelection(
        { ...input, sourceIds: allowedSourceIds, currentPage: selectedPage, chunkId: selectedChunk },
        authorized,
      );
      if (!selection.ok) {
        throw new EphemeralServiceError(selection.code, selection.code, 422);
      }
      const imageOnlySources = isImageOnlySourceChunks(chunks);
      const preferPage = selectedPage ?? (imageOnlySources ? 1 : undefined);
      const context = selectContext({
        chunks,
        query: input.text,
        maxCharacters: deps.config.maxContextCharacters,
        preferChunkId: selectedChunk ?? undefined,
        preferPage,
      });
      const historyToResolve = epochChanged ? [] : input.history;
      const historyRefs = historyToResolve.length ? await deps.provenance?.resolveHistory(scope, historyToResolve, privacy.epoch) ?? null : [];
      const historyDiscarded = epochChanged || historyRefs === null;
      const history = historyDiscarded ? [] : historyToResolve;
      const contextSourceRefs = mergeContextSourceRefs(
        context.map(({ sourceId, sourceVersion }) => ({ sourceId, sourceVersion })), historyRefs ?? [],
      );
      const requestId = input.clientKey ? `eph:${input.clientKey}` : deps.requestKey?.() ?? `eph:${randomUUID()}`;
      const parentBudget: ParentInteractionBudget = { id: `study-ephemeral:${scope.workspaceId}:${input.clientKey ?? requestId}` };
      let streamedExposure: StudyExposureReceipt | undefined;
      const deliverHelp = async () => {
        if (!streamedExposure && contextAnchor && deps.exposures) streamedExposure = await deps.exposures.deliver(scope, {
          releaseKey: `ephemeral:${input.clientKey ?? requestId}`, contextAnchor, origin: "assistant", supportDomain: "unknown",
          kind: input.mode === "explain" ? "solution" : "hint", level: input.mode === "explain" ? "revealed" : "hinted",
        });
        return streamedExposure;
      };
      const emitText = onTextDelta ? async (delta: string) => {
        if (!delta) return;
        if (signal?.aborted) throw new EphemeralServiceError("ABORTED", "ephemeral request aborted", 499);
        if (await deps.privacy.currentEpoch(scope) !== privacy.epoch) {
          throw new EphemeralServiceError("PRIVACY_CHANGED", "隐私设置已变化，本次回答已停止。", 409);
        }
        // A partial hint already shown to the learner must count even if the stream later fails.
        await deliverHelp();
        await onTextDelta(delta);
      } : undefined;
      let selected: ResolvedTaskModel | undefined;
      let selectedRequestId = requestId;
      try {
        selected = await deps.resolveModel?.(scope, input.mode);
      } catch (error) {
        const fallback = isNotSentFailure(error) && deps.resolveFallbackModel ? await deps.resolveFallbackModel(scope, input.mode) : null;
        if (!fallback) throw error;
        selected = fallback;
        selectedRequestId = `${requestId}:fallback`;
      }
      if (imageOnlySources && selected?.supportsVision !== true) {
        throw new EphemeralServiceError("VISION_REQUIRED", VISION_REQUIRED_MESSAGE, 422);
      }
      const pageForImages = selectedPage ?? (imageOnlySources ? 1 : null);
      const imageParts = selected?.supportsVision && pageForImages != null && deps.pageImages
        ? await deps.pageImages(scope, { sourceIds: allowedSourceIds, sourceVersions: Object.fromEntries(chunks.map(chunk => [chunk.sourceId, chunk.sourceVersion])), physicalPage: pageForImages }) : [];
      const providerInput: ProviderInput = {
        instruction: instructionFor(input.mode)+studyIntentInstruction(studyIntentForMessage(sessionIntent, composerMessageText(input.text))),
        text: input.text,
        history: history.map(({ role, text }) => ({ role, text })),
        chunks: context,
        mode: input.mode,
        maxOutputTokens: deps.config.maxOutputTokens,
        mediaCapability: imageParts.length ? "text_plus_page_images" : "text_only",
        imageParts,
        ...(onTextDelta ? { outputFormat: "markdown" as const } : {}),
      };
      let completedRequestId = requestId;
      const callWith = async (model: ResolvedTaskModel | undefined, callRequestId: string) => {
        const terms: ReservationTerms = model
          ? reservationTerms(model, providerInput, deps.config.reservedCents)
          : (() => {
              const rates = { inputCentsPerMillion: deps.config.inputCentsPerMillion, outputCentsPerMillion: deps.config.outputCentsPerMillion };
              return {
                reservedCents: Math.max(deps.config.reservedCents, reservationCentsForInput(JSON.stringify(providerInput), providerInput.maxOutputTokens, rates)),
                actualCents: (settled: ProviderOutput) => actualCentsForOutput(settled, rates),
              };
            })();
        const output = await runBudgetedCall({
          provider: model?.provider ?? deps.provider,
          modelSnapshot: model?.modelSnapshot ?? deps.modelSnapshot,
          budget: deps.budget,
          input: providerInput,
          parentBudget,
          requestId: callRequestId,
          // Ephemeral turns persist provenance keyed by requestId.
          resultRef: `ephemeral:${requestId}`,
          reservedCents: terms.reservedCents,
          // Paid calls settle at least 1 cent; free-tier calls settle at zero.
          actualCents: (settled) => terms.requestCapPerDay ? 0 : Math.max(1, terms.actualCents(settled)),
          ...(terms.requestCapPerDay ? { requestCapPerDay: terms.requestCapPerDay } : {}),
          signal,
          ...(emitText ? { onTextDelta: emitText } : {}),
          beforeSend: async () => {
            const epoch = await deps.privacy.currentEpoch(scope);
            if (epoch !== privacy.epoch) {
              throw new EphemeralServiceError("PRIVACY_CHANGED", "隐私设置已变化，本次未发送。请确认材料后重新提问。", 409);
            }
            if (signal?.aborted) {
              throw new EphemeralServiceError("ABORTED", "ephemeral request aborted before sending", 499);
            }
          },
        });
        completedRequestId = callRequestId;
        return output;
      };
      let output: ProviderOutput;
      try {
        output = selected && deps.resolveFallbackModel && selectedRequestId === requestId
          ? await withModelFallback({
              primary: async () => selected!,
              fallback: () => deps.resolveFallbackModel!(scope, input.mode),
              operationId: requestId,
              run: (model, operationId) => callWith(model, operationId),
            })
          : await callWith(selected, selectedRequestId);
      } catch (error) {
        if (isBudgetReplayError(error)) throw new EphemeralServiceError(error.code,
          error.disposition.kind === "completed" ? "这次临时请求已完成；为保护临时内容，服务器未保存可重放的正文。请确认后另发一条新请求。" : "这次临时请求已发送或结果尚未确认，请勿自动重发。", 409);
        if (error instanceof OpeningProviderError) throw error;
        throw error;
      }
      const validated = providerOutputSchema.parse(output);
      const streamedCitations = onTextDelta ? tutorCitationsFromMarkdown(validated.text, context) : null;
      if (signal?.aborted) throw new EphemeralServiceError("ABORTED", "ephemeral request aborted", 499);
      let provenanceId: string | null = null;
      try {
        provenanceId = await deps.provenance?.record(scope, { requestId: completedRequestId, privacyEpoch: privacy.epoch, contextSourceRefs }) ?? null;
      } catch (error) {
        if (error instanceof EphemeralProvenanceError) {
          throw new EphemeralServiceError(error.code, error.code === "PRIVACY_CHANGED" ? "隐私设置已变化，本轮内容未保存。请确认材料后重新提问。" : "临时来源凭据不可用。", error.code === "NOT_FOUND" ? 404 : 409);
        }
        throw error;
      }
      const allowed = new Set(context.map((chunk) => chunk.id));
      const citedChunkIds = (streamedCitations?.citedChunkIds ?? validated.citedChunkIds).filter((id) => allowed.has(id));
      // Soft-filter unknown ids first; resolve only authorized context chunks (never fabricate).
      const citations = resolveCitations(citedChunkIds, context);
      // Echo effectiveSourceIds only when server changed selection vs client input.
      const selectionChanged =
        clientSourceIds.length === 0 && allowedSourceIds.length > 0;
      const exposureReceipt = await deliverHelp();
      return {
        ...(contextAnchor ? { contextAnchor } : {}),
        ...(exposureReceipt ? { exposureReceipt } : {}),
        ...stripEphemeralCandidates({
          ...validated,
          // Model markers index its own (unfiltered) list.
          text: streamedCitations?.text ?? renumberInlineCitations(validated.text, validated.citedChunkIds, citations),
          citedChunkIds,
        }),
        citations,
        provenanceId,
        privacyEpoch: privacy.epoch,
        historyDiscarded,
        ...(selectionChanged ? { effectiveSourceIds: allowedSourceIds } : {}),
      };
    },
  };
}

export type EphemeralTutorService = ReturnType<typeof createEphemeralTutorService>;
