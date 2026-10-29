import { previousRecordQuestion } from "@aistudy/contracts";
export { makeTutorInstruction } from "@aistudy/domain";
import {
  providerOutputSchema,
  type MemoryItem,
  type ProviderOutput,
  type ProviderInput,
  type SourceChunk,
  type TutorMode,
  type ConversationPlanningContext,
  type StudyContextAnchor,
  type TutorLearnerContext,
} from "@aistudy/contracts";
import { OpeningProviderError, OpeningModelRoutingError, BudgetedCallError, canProposeTask, renumberInlineCitations, resolveCitations, selectContext, type SystemQueryService, tutorCitationsFromMarkdown } from "@aistudy/ai";
import {
  assertCitationsForPage,
  classifyTutorHelpKind,
  composerMessageText,
  makeStudyLanguageSupport,
  studyIntentInstruction,
  instructionWithMemories,
  makeTutorInstruction,
  PageCitationClarifyError,
  preferCitationsForPage,
  resolveStrategyTemplate,
  conversationPlanningInstruction,
  CONVERSATION_PLANNING_CONTEXT_UNAVAILABLE,
  tutorFailureForDisplay,
  tutorLearnerContextInstruction,
} from "@aistudy/domain";
import type {
  ContextSourceRef,
  OpeningBudgetRepository,
  OpeningTutorJobsRepository,
  OpeningStudyExposureInput,
  OpeningTutorTimingInput,
} from "@aistudy/database";
import { mergeContextSourceRefs, OpeningBudgetError } from "@aistudy/database";
import { randomUUID } from "node:crypto";
import { assertCurrentEpoch } from "../runtime/privacy-guard";
import {
  actualCentsForOutput,
  isNotSentFailure,
  reservationCentsForInput,
  reservationTerms,
  withModelFallback,
  type ReservationTerms,
  type ResolvedTaskModel,
  type ParentInteractionBudget,
} from "@aistudy/ai";
import type { TutorStreamWriter } from "../runtime/tutor-stream";
import { chunksAtSnapshots } from "./tutor-chunks";
import { prepareTutorNextAction, type TutorNextActionService } from "./tutor-next-action";
import { withJobHeartbeat } from "../runtime/lifecycle";
import {
  isBudgetReplayError,
  runBudgetedCall,
  type BudgetedProvider,
  type BudgetedRepository,
} from "@aistudy/ai";


type Scope = { workspaceId: string; ownerUserId: string };

export type TutorTurnDeps = {
  /** Course-scoped span orchestration; the adapter owns grant and transaction checks. */
  nextAction?: TutorNextActionService;
  retrieveContext?: import("@aistudy/ai").MaterialRetriever;
  learnerContext?: { read(scope: Scope, input: { courseId?: string | null; sourceIds: readonly string[] }): Promise<TutorLearnerContext | null>;
    assertCurrent(scope: Scope, context: TutorLearnerContext): Promise<void> };
  proposals?: { reply(scope: Scope, input: { sourceTurnId: string; purpose: "plan" | "teach"; question: string; courseId?: string | null;
    jobLease?: { jobId: string; claimToken: string }; parentBudget?: ParentInteractionBudget }): Promise<{ text: string; proposal: unknown; privacyEpoch: number; contextSourceRefs: ContextSourceRef[] }> };
  systemQuery?: SystemQueryService;
  stream?: Pick<TutorStreamWriter, "begin"> & { append: (...args: Parameters<TutorStreamWriter["append"]>) => Promise<number | void> };
  timing?: { record(scope: Scope, input: OpeningTutorTimingInput): Promise<unknown> };
  onTimingUnavailable?: (error: unknown) => void;
  streamExposures?: { generate(scope: Scope, input: OpeningStudyExposureInput): Promise<{ id: string }> };
  onStreamUnavailable?: (error: unknown) => void;
  tutorJobs: OpeningTutorJobsRepository;
  chunks: {
    listForSources(scope: { workspaceId: string; ownerUserId: string }, sourceIds: string[]): Promise<SourceChunk[]>;
    listChunksAtVersion(scope: { workspaceId: string; ownerUserId: string }, sourceId: string, sourceVersion: number): Promise<SourceChunk[]>;
  };
  budget: Pick<OpeningBudgetRepository, "reserve" | "release" | "claimExecution" | "settle" | "markUnknown">;
  provider: BudgetedProvider | null;
  resolveModel?: (scope: Scope, mode: TutorMode) => Promise<ResolvedTaskModel>;
  /** The user's explicit fallback for this mode's task; used only after a not-sent failure. */
  resolveFallbackModel?: (scope: Scope, mode: TutorMode) => Promise<ResolvedTaskModel | null>;
  pageImages?: (scope: Scope, input: { sourceIds: string[]; sourceVersions: Record<string, number>; physicalPage: number }) => Promise<ProviderInput["imageParts"]>;
  config: {
    maxContextCharacters: number;
    reservedCents: number;
    maxOutputTokens: number;
    inputCentsPerMillion: number;
    outputCentsPerMillion: number;
  };
  /** M02 privacy: epoch + exclusions. Optional for unit tests without DB privacy tables. */
  privacy?: {
    getWorkspaceEpoch(scope: Scope): Promise<number>;
    listExcludedSourceIds(scope: Scope): Promise<string[]>;
  };
  /** M01: confirmed/unexpired temporary memories only. Optional. */
  memories?: { listContext(scope: Scope, now: string): Promise<{ memories: MemoryItem[]; sourceRefs: ContextSourceRef[] }> };
  /** Optional, feature-gated, read-only summary; failure leaves ordinary conversation available. */
  planningContext?: { read(scope: Scope, now: Date): Promise<ConversationPlanningContext> };
  /** L01: record delivered help in the tutor completion transaction. */
  learning?: {
    insertHelpExposure(scope: Scope, exposure: {
      id: string; sessionId: string; problemId: string | null; turnId: string;
      kind: "instruction" | "hint" | "solution";
      level: "hinted" | "revealed"; delivered: true;
    }): Promise<unknown>;
  };
};


const MAX_PROVIDER_CHUNKS = 64;

/** True when every chunk is an image page with no usable text (photo sources). */
export function isImageOnlySourceChunks(chunks: SourceChunk[]): boolean {
  if (!chunks.length) return false;
  return chunks.every(
    (chunk) => chunk.imageObjectKey != null && chunk.imageObjectKey !== "" && !chunk.text.trim(),
  );
}

export const VISION_REQUIRED_MESSAGE = "当前模型不能看图，请在设置中选择支持图片的模型";

/**
 * Durable tutor turn: claim CAS, gather authorized chunks, build delimited
 * context (T02), call the provider through the budget ledger (T01), then
 * persist the assistant turn + pending candidates ONCE with program-assigned
 * provenance. The model never chooses citation targets or candidate ids.
 */
export function createTutorTurnHandler(deps: TutorTurnDeps) {
  return async function processTutorTurn(tutorJobId: string): Promise<{ skipped: boolean; replayed?: boolean }> {
    const claimed = await deps.tutorJobs.claim(tutorJobId);
    if (!claimed) return { skipped: true };
    const claimObservedAt = performance.now();
    return withJobHeartbeat(
      () => claimed.claimToken ? deps.tutorJobs.heartbeat(claimed.id, claimed.claimToken) : Promise.resolve(),
      async () => {
    const scope = {
      workspaceId: claimed.workspaceId,
      ownerUserId: claimed.ownerUserId ?? "",
    };
    const timingWrites: Promise<void>[] = [];
    const reportTimingUnavailable = (error: unknown) => {
      try {
        if (deps.onTimingUnavailable) deps.onTimingUnavailable(error);
        else console.error("tutor timing write failed", error instanceof Error ? error.name : "unknown error");
      } catch {
        // An observer must never replace the original provider outcome.
        console.error("tutor timing error reporter failed");
      }
    };
    let timingFlush: Promise<void> | undefined;
    const flushTiming = () => {
      // One bounded tail for this execution, including a later business-error path.
      timingFlush ??= timingWrites.length ? new Promise<void>(resolve => {
        const timeout = setTimeout(() => {
          reportTimingUnavailable(new Error("tutor timing flush timed out after 100ms"));
          resolve();
        }, 100);
        void Promise.all(timingWrites).then(() => { clearTimeout(timeout); resolve(); });
      }) : Promise.resolve();
      return timingFlush;
    };
    const recordTiming = (kind: OpeningTutorTimingInput["kind"], observedAt: Date, durationMs: number) => {
      if (!deps.timing || !claimed.executionId || !claimed.claimToken) return;
      const input: OpeningTutorTimingInput = { jobId: claimed.id, executionId: claimed.executionId, claimToken: claimed.claimToken, kind, observedAt, durationMs };
      // Keep rejection handlers attached after a flush timeout. Late writes still
      // need the repository's current execution/lease checks to be accepted.
      timingWrites.push(Promise.resolve().then(() => deps.timing!.record(scope, input)).then(() => undefined).catch(reportTimingUnavailable));
    };
    const scopedBudget: BudgetedRepository = {
      reserve: (input) => deps.budget.reserve(scope, input),
      release: (requestId, reason) => deps.budget.release(scope, requestId, reason),
      claimExecution: (reservationId) => deps.budget.claimExecution(scope, reservationId),
      settle: (...args) => deps.budget.settle(scope, ...args),
      markUnknown: (reservationId) => deps.budget.markUnknown(scope, reservationId),
    };
    const parentBudget: ParentInteractionBudget = { id: `study-turn:${claimed.userTurnId}` };
    try {
      // The repository verifies the persisted user-role turn belongs to this job.
      // Worker execution and tutor mode are not evidence of a hint-ladder stage.
      const turn = await deps.tutorJobs.getUserTurn(claimed.userTurnId, claimed.workspaceId, claimed.id);
      if (!turn) throw new Error("user turn for tutor job is missing");
      const jobEpoch = deps.privacy
        ? await deps.privacy.getWorkspaceEpoch(scope)
        : null;
      const nextActionCourseId = turn.courseId ?? turn.contextAnchor?.courseId;
      if (deps.nextAction && nextActionCourseId && turn.purpose === "teach" && !turn.querySystem
        && !turn.attemptId && !turn.contextAnchor?.activityId && turn.contextAnchor?.purpose !== "language_support") {
        const prepared = await prepareTutorNextAction(deps.nextAction, scope, {
          courseId: nextActionCourseId, sourceIds: turn.sourceIds, sourceVersions: turn.sourceVersions,
          userTurnId: claimed.userTurnId, question: composerMessageText(turn.text), operationId: `tutor-next:${claimed.userTurnId}`,
          ...(jobEpoch === null ? {} : { expectedPrivacyEpoch: jobEpoch }),
          ...(claimed.claimToken ? { jobLease: { jobId: claimed.id, claimToken: claimed.claimToken } } : {}),
        });
        if (prepared) {
          await deps.nextAction.assertCurrent(scope, prepared.context);
          if (deps.privacy && jobEpoch !== null) assertCurrentEpoch(jobEpoch, await deps.privacy.getWorkspaceEpoch(scope));
          const label = prepared.resumed ? "继续上次未完成的学习" : {
            full_explain: "先看一个完整示例", targeted_explain: "针对刚才的错误继续学习",
            reduced_help_practice: "用一道新题减少帮助再试一次", transfer_check: "独立完成一道新题",
            diagnose: "从一道短诊断题开始",
          }[prepared.decision.activityKind];
          await deps.tutorJobs.completeTurn({ scope, jobId: claimed.id, assistantTurnId: claimed.assistantTurnId,
            text: prepared.action ? `[${label}](${prepared.action.href})` : `${prepared.choice.message}\n\n[${prepared.choice.label}](${prepared.choice.href})`, citations: [], candidates: [],
            contextSourceRefs: prepared.context.sourceRefs, expectedPrivacyEpoch: prepared.context.privacyEpoch, claimToken: claimed.claimToken });
          return { skipped: false };
        }
      }
      if (turn.purpose === "plan" || turn.purpose === "teach" && !turn.attemptId && !turn.contextAnchor?.activityId && turn.contextAnchor?.purpose !== "language_support") {
        if (!deps.proposals) throw new Error("proposal service unavailable");
        const reply = await deps.proposals.reply(scope, { sourceTurnId: claimed.userTurnId, purpose: turn.purpose, question: turn.text,
          courseId: turn.courseId, parentBudget, ...(claimed.claimToken ? { jobLease: { jobId: claimed.id, claimToken: claimed.claimToken } } : {}) });
        if (jobEpoch !== null && reply.privacyEpoch !== jobEpoch) throw new Error("proposal privacy changed");
        await deps.tutorJobs.completeTurn({ scope, jobId: claimed.id, assistantTurnId: claimed.assistantTurnId,
          text: reply.text, citations: [], candidates: [], contextSourceRefs: reply.contextSourceRefs,
          expectedPrivacyEpoch: reply.privacyEpoch, claimToken: claimed.claimToken });
        return { skipped: false };
      }
      if (turn.querySystem || turn.purpose === "query" || turn.purpose === "explain_state") {
        if (!deps.systemQuery?.enabled()) throw new Error("系统记录查询暂未开启，请保留问题后重试。");
        const sourceId = turn.sourceIds.length === 1 ? turn.sourceIds[0] : undefined;
        const reply = await deps.systemQuery.reply(scope, { question: turn.text, resolvePreviousQuestion: async () => previousRecordQuestion((await deps.tutorJobs.loadHistoryContext(scope, claimed.userTurnId, "record_referents")).history), parentBudget, ...(claimed.claimToken ? { jobLease: { jobId: claimed.id, claimToken: claimed.claimToken } } : {}), focus: {
          courseId: turn.courseId ?? turn.contextAnchor?.courseId, sourceId, sourceIds: turn.sourceIds, sourceVersion: sourceId ? turn.sourceVersions[sourceId] : undefined, physicalPage: turn.currentPage,
        } });
        if (jobEpoch !== null && reply.privacyEpoch !== jobEpoch) throw new Error("query privacy changed");
        await deps.tutorJobs.completeTurn({ scope, jobId: claimed.id, assistantTurnId: claimed.assistantTurnId, text: reply.text,
          citations: [], candidates: [], contextSourceRefs: reply.contextSourceRefs, systemQuery: reply.receipt,
          expectedPrivacyEpoch: reply.privacyEpoch, claimToken: claimed.claimToken });
        return { skipped: false };
      }
      if (turn.contextAnchor?.purpose === "language_support") {
        const text = makeStudyLanguageSupport(turn.languageSupportQuestion ?? null);
        const generatedExposure = { releaseKey: `assistant:${claimed.assistantTurnId}`, contextAnchor: turn.contextAnchor,
          origin: "assistant" as const, turnId: claimed.assistantTurnId, supportDomain: "language" as const, kind: "hint" as const, level: "hinted" as const,
          hintStage: null, initiatedBy: "user" as const,
          ...(turn.learningSessionId ? { sessionId: turn.learningSessionId } : {}) };
        await deps.tutorJobs.completeTurn({ scope, jobId: claimed.id, assistantTurnId: claimed.assistantTurnId, text,
          citations: [], candidates: [], contextSourceRefs: [], generatedExposure, expectedPrivacyEpoch: jobEpoch ?? undefined, claimToken: claimed.claimToken });
        return { skipped: false };
      }
      const helpInputSnapshot = await deps.tutorJobs.freezeHelpInputSnapshot(scope,
        { userTurnId: claimed.userTurnId, jobId: claimed.id, claimToken: claimed.claimToken });
      const currentStudyIntent = helpInputSnapshot.studyIntent;
      const excluded = new Set(
        deps.privacy ? await deps.privacy.listExcludedSourceIds(scope) : [],
      );
      const allowedSourceIds = turn.sourceIds.filter((id) => !excluded.has(id));
      if (excluded.size && allowedSourceIds.length === 0 && turn.sourceIds.length > 0) {
        throw new Error("all requested source material is privacy-excluded");
      }
      const chunks = turn.sourceIds.length
        ? await chunksAtSnapshots(deps.chunks, scope, allowedSourceIds, turn.sourceVersions)
        : [];
      if (!chunks.length && allowedSourceIds.length > 0) {
        throw new Error("all requested source material is unavailable");
      }
      const imageOnlySources = isImageOnlySourceChunks(chunks);
      // Photo sources default to page 1 so empty-text image chunks stay preferred.
      const preferPage = turn.currentPage ?? (imageOnlySources ? 1 : undefined);
      const retrievalInput = {
        chunks,
        sourceIds: allowedSourceIds,
        query: turn.text,
        maxCharacters: deps.config.maxContextCharacters,
        preferChunkId: turn.chunkId ?? undefined,
        preferPage,
        operationId: claimed.id,
        parentBudget,
      };
      const context = (deps.retrieveContext
        ? (await deps.retrieveContext(scope, retrievalInput)).chunks
        : selectContext(retrievalInput)).slice(0, MAX_PROVIDER_CHUNKS);
      const { history, sourceRefs: historySourceRefs } = await deps.tutorJobs.loadHistoryContext(scope, claimed.userTurnId);
      const contextNow = new Date().toISOString();
      const memoryContext = deps.memories
        ? await deps.memories.listContext(scope, contextNow)
        : { memories: [], sourceRefs: [] };
      const learnerContext = await deps.learnerContext?.read(scope, { courseId: turn.courseId ?? turn.contextAnchor?.courseId,
        sourceIds: allowedSourceIds }) ?? null;
      const contextSourceRefs = mergeContextSourceRefs(
        context.map(({ sourceId, sourceVersion }) => ({ sourceId, sourceVersion })),
        historySourceRefs, memoryContext.sourceRefs, learnerContext?.sourceRefs ?? [],
      );
      const mode = helpInputSnapshot.tutorMode;
      const baseInstruction = instructionWithMemories(
        makeTutorInstruction(mode, { text: turn.text }),
        memoryContext.memories,
        contextNow,
      );
      const strategyTemplate = resolveStrategyTemplate(turn.strategyTemplateId);
      let planningInstruction = "";
      if (deps.planningContext) {
        try {
          planningInstruction = conversationPlanningInstruction(await deps.planningContext.read(scope, new Date(contextNow)));
        } catch {
          // This optional read cannot turn a DB outage into invented availability.
          planningInstruction = CONVERSATION_PLANNING_CONTEXT_UNAVAILABLE;
        }
      }
      const instruction = `${baseInstruction}`+"\n"+`${strategyTemplate.instructionSuffix}`+planningInstruction+tutorLearnerContextInstruction(learnerContext)+studyIntentInstruction(currentStudyIntent);
      const tutorOperationId = `tutor:${claimed.id}`;
      // An unusable primary route may hand over to the user's fallback before anything is sent.
      let selected: ResolvedTaskModel | undefined;
      let selectedOperationId = tutorOperationId;
      try {
        selected = await deps.resolveModel?.(scope, mode);
      } catch (error) {
        const fallback = isNotSentFailure(error) && deps.resolveFallbackModel ? await deps.resolveFallbackModel(scope, mode) : null;
        if (!fallback) throw error;
        selected = fallback;
        selectedOperationId = `${tutorOperationId}:fallback`;
      }
      const supportsVision = selected?.supportsVision === true;
      if (imageOnlySources && !supportsVision) {
        throw new BudgetedCallError("VISION_INPUT_REQUIRED", VISION_REQUIRED_MESSAGE);
      }
      // Photo sources default to page 1 when the learner did not pick a page.
      const pageForImages = turn.currentPage ?? (imageOnlySources ? 1 : null);
      const imageParts = supportsVision && pageForImages != null && deps.pageImages
        ? await deps.pageImages(scope, { sourceIds: allowedSourceIds, sourceVersions: turn.sourceVersions, physicalPage: pageForImages }) : [];
      const streamExposure: OpeningStudyExposureInput | undefined = deps.stream && (turn.contextAnchor || turn.learningSessionId && (turn.attemptId || mode === "hint" || mode === "explain"))
        ? { releaseKey: `assistant:${claimed.assistantTurnId}`,
            contextAnchor: turn.contextAnchor ?? { purpose: "learning_help", attemptId: turn.attemptId ?? null } as StudyContextAnchor,
            origin: "assistant", turnId: claimed.assistantTurnId, supportDomain: "unknown", helpInputSnapshot,
            hintStage: null, initiatedBy: "user",
            kind: turn.learningSessionId
              ? turn.attemptId && mode !== "explain" ? "hint" : classifyTutorHelpKind({ mode, attemptId: turn.attemptId ?? null, problemId: null })
              : mode === "explain" ? "solution" : "hint",
            level: mode === "explain" ? "revealed" : "hinted",
            ...(turn.learningSessionId ? { sessionId: turn.learningSessionId } : {}) }
        : undefined;
      const exposureReceipt = streamExposure
        ? await deps.streamExposures!.generate(scope, streamExposure) : null;
      let streamAvailable = Boolean(deps.stream);
      if (deps.stream) {
        try {
          await deps.stream.begin(scope.workspaceId, claimed.id, { privacyEpoch: jobEpoch ?? 0,
            contextSourceRefs, exposureReceiptId: exposureReceipt?.id ?? null, claimToken: claimed.claimToken,
            ...(claimed.executionId ? { executionId: claimed.executionId } : {}) });
        } catch (error) {
          streamAvailable = false;
          deps.onStreamUnavailable?.(error);
        }
      }
      let firstTextAt: number | null = null;
      const onTextDelta = deps.stream ? async (delta: string) => {
        if (!delta) return;
        if (firstTextAt === null) {
          const observedAt = new Date();
          firstTextAt = performance.now();
          recordTiming("tutor_first_text", observedAt, Math.round(firstTextAt - claimObservedAt));
        }
        if (!streamAvailable) return;
        try {
          const sequence = await deps.stream!.append(scope.workspaceId, claimed.id, delta, claimed.executionId);
          if (sequence === 1) recordTiming("tutor_first_chunk", new Date(), Math.round(performance.now() - firstTextAt));
        }
        catch (error) { streamAvailable = false; deps.onStreamUnavailable?.(error); }
      } : undefined;
      const input: ProviderInput = {
        instruction, text: turn.text, history,
        ...(deps.stream ? { outputFormat: "markdown" as const } : {}),
        chunks: context, mode, maxOutputTokens: deps.config.maxOutputTokens,
        mediaCapability: imageParts.length ? "text_plus_page_images" : "text_only", imageParts,
      };
      // BC1: operationId = durable tutor job id so BullMQ retries reuse one ledger
      // reservation; a fallback model runs under its own ":fallback" key.
      const callWith = (model: ResolvedTaskModel | undefined, operationId: string) => {
        const terms = model
          ? reservationTerms(model, input, deps.config.reservedCents)
          : (() => {
              const rates = { inputCentsPerMillion: deps.config.inputCentsPerMillion, outputCentsPerMillion: deps.config.outputCentsPerMillion };
              return {
                reservedCents: Math.max(deps.config.reservedCents, reservationCentsForInput(JSON.stringify(input), input.maxOutputTokens, rates)),
                actualCents: (settled: ProviderOutput) => actualCentsForOutput(settled, rates),
              } as ReservationTerms;
            })();
        return runBudgetedCall({
          provider: model?.provider ?? deps.provider,
          modelSnapshot: model?.modelSnapshot,
          budget: scopedBudget,
          input,
          ...(input.outputFormat === "markdown" && onTextDelta ? { onTextDelta } : {}),
          requestId: operationId,
          operationId,
          parentBudget,
          resultRef: `opening_turn:${claimed.assistantTurnId}`,
          reservedCents: terms.reservedCents,
          actualCents: terms.actualCents,
          ...(terms.requestCapPerDay ? { requestCapPerDay: terms.requestCapPerDay } : {}),
          beforeSend: async () => {
            if (learnerContext) await deps.learnerContext!.assertCurrent(scope, learnerContext);
            if (deps.privacy && jobEpoch !== null) assertCurrentEpoch(jobEpoch, await deps.privacy.getWorkspaceEpoch(scope));
          },
        });
      };
      let output: ProviderOutput;
      try {
      output = selected && deps.resolveFallbackModel && selectedOperationId === tutorOperationId
        ? await withModelFallback({
            primary: async () => selected!,
            fallback: () => deps.resolveFallbackModel!(scope, mode),
            operationId: tutorOperationId,
            run: (model, operationId) => callWith(model, operationId),
          })
        : await callWith(selected, selectedOperationId);
      } catch (error) {
        // PR-D: completed ledger key → load the persisted result through its
        // resultRef. Never call the provider or charge again; never fake success.
        if (isBudgetReplayError(error) && error.disposition.kind === "completed") {
          const ref = error.disposition.resultRef;
          const persisted = ref ? await deps.tutorJobs.loadReplayedTurn(scope, ref) : null;
          if (
            persisted && persisted.id === claimed.assistantTurnId && persisted.status === "complete"
            && await deps.tutorJobs.completeFromReplay(scope, claimed.id, persisted.id, claimed.claimToken)
          ) {
            return { skipped: false, replayed: true };
          }
          await deps.tutorJobs.markUnknown(
            scope,
            claimed.id,
            "budget replay: provider call already settled but its result is not persisted; not re-sending",
            claimed.claimToken,
          );
          return { skipped: false, replayed: true };
        }
        throw error;
      }
      let validated: ProviderOutput = providerOutputSchema.parse(output);
      if (deps.stream) {
        const referenced = tutorCitationsFromMarkdown(validated.text, context);
        validated = { ...validated, text: referenced.text, citedChunkIds: referenced.citedChunkIds, candidates: [] };
      }
      // Soft-filter unknown cited ids (Package D); never fabricate rows / never throw on unknowns.
      let citations = resolveCitations(validated.citedChunkIds, context, { soft: true });
      // Soft page guard: empty cites = general OK; prefer on-page cites when any match.
      if (turn.currentPage != null && turn.sourceIds.length > 0) {
        assertCitationsForPage(
          citations.map((citation) => ({ page: citation.page ?? null })),
          turn.currentPage,
        );
        citations = preferCitationsForPage(citations, turn.currentPage);
      }
      const text = renumberInlineCitations(validated.text, validated.citedChunkIds, citations);
      const contextSourceIds = [...new Set(contextSourceRefs.map((ref) => ref.sourceId))].filter(
        (id) => !excluded.has(id),
      );
      if (deps.privacy && jobEpoch !== null) {
        const currentEpoch = await deps.privacy.getWorkspaceEpoch(scope);
        assertCurrentEpoch(jobEpoch, currentEpoch);
      }
      // Generate an inert receipt with the answer; only an actual HTTP delivery releases it.
      const helpExposure = !deps.stream && turn.learningSessionId && (turn.contextAnchor || turn.attemptId || mode === "hint" || mode === "explain")
        ? {
            id: randomUUID(),
            sessionId: turn.learningSessionId,
            contextAnchor: turn.contextAnchor,
            supportDomain: "unknown" as const,
            problemId: null,
            attemptId: turn.attemptId ?? null,
            turnId: claimed.assistantTurnId,
            kind: turn.attemptId && mode !== "explain" ? "hint" as const : classifyTutorHelpKind({
              mode,
              attemptId: turn.attemptId ?? null,
              problemId: null,
            }),
            level: mode === "explain" ? "revealed" as const : "hinted" as const,
            delivered: true as const, helpInputSnapshot,
            hintStage: null, initiatedBy: "user" as const,
          }
        : undefined;
      const generatedExposure = streamExposure ?? (!turn.learningSessionId && turn.contextAnchor ? {
        releaseKey: `assistant:${claimed.assistantTurnId}`, contextAnchor: turn.contextAnchor,
        origin: "assistant" as const, turnId: claimed.assistantTurnId, supportDomain: "unknown" as const, helpInputSnapshot,
        hintStage: null, initiatedBy: "user" as const,
        kind: mode === "explain" ? "solution" as const : "hint" as const,
        level: mode === "explain" ? "revealed" as const : "hinted" as const,
      } : undefined);
      await flushTiming();
      await deps.tutorJobs.completeTurn({
        scope,
        jobId: claimed.id,
        assistantTurnId: claimed.assistantTurnId,
        text,
        citations,
        contextSourceRefs,
        candidates: (canProposeTask(mode)
          ? validated.candidates
          : validated.candidates.filter((payload) => payload.kind !== "task")
        ).map((payload) => ({
          payload,
          sourceIds: contextSourceIds,
        })),
        ...(helpExposure ? { helpExposure } : {}),
        ...(generatedExposure ? { generatedExposure } : {}),
        expectedPrivacyEpoch: jobEpoch ?? undefined,
        claimToken: claimed.claimToken,
        enqueueMetadata: Boolean(deps.stream),
      });
      // The answer and optional metadata outbox entry are durable. Release this
      // tutor worker slot; suggestions run in their own bounded queue.
      return { skipped: false };
    } catch (error) {
      await flushTiming();
      const unknownOutcome =
        (error instanceof OpeningProviderError &&
          ["PROVIDER_TIMEOUT", "PROVIDER_NETWORK"].includes(error.code)) ||
        // Replay of an unknown / in-flight ledger key: never fake success or re-send.
        (isBudgetReplayError(error) && (error.code === "BUDGET_OUTCOME_UNKNOWN" || error.code === "BUDGET_EXECUTION_CLAIMED"));
      if (unknownOutcome) {
        await deps.tutorJobs.markUnknown(scope, claimed.id, "provider outcome unknown; usage reconciliation pending", claimed.claimToken);
      } else if (error instanceof PageCitationClarifyError) {
        // LAB-A01/U01: a page refusal fails the job with a Clarify route; the
        // repository ends the assistant turn as 'clarify'.
        await deps.tutorJobs.fail(scope, claimed.id, error.message, {
          code: error.code,
          nextAction: error.nextAction,
        }, claimed.claimToken);
      } else {
        const code = error instanceof OpeningProviderError || error instanceof OpeningModelRoutingError
          || error instanceof BudgetedCallError || error instanceof OpeningBudgetError ? error.code : undefined;
        const failure = tutorFailureForDisplay("failed", { code })!;
        await deps.tutorJobs.fail(scope, claimed.id, failure.message, failure.code ? { code: failure.code } : undefined, claimed.claimToken);
      }
      throw error;
    }
      },
    );
  };
}
