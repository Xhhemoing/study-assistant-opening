export { makeTutorInstruction } from "@aistudy/domain";
import {
  providerOutputSchema,
  type MemoryItem,
  type ProviderOutput,
  type ProviderInput,
  type SourceChunk,
  type TutorMode,
} from "@aistudy/contracts";
import { OpeningProviderError, canProposeTask, renumberInlineCitations, resolveCitations, selectContext } from "@aistudy/ai";
import {
  assertCitationsForPage,
  classifyTutorHelpKind,
  instructionWithMemories,
  makeTutorInstruction,
  PageCitationClarifyError,
  preferCitationsForPage,
  resolveStrategyTemplate,
} from "@aistudy/domain";
import type {
  ContextSourceRef,
  OpeningBudgetRepository,
  OpeningTutorJobsRepository,
} from "@aistudy/database";
import { mergeContextSourceRefs } from "@aistudy/database";
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
} from "@aistudy/ai";
import { chunksAtSnapshots } from "./tutor-chunks";
import {
  isBudgetReplayError,
  runBudgetedCall,
  type BudgetedProvider,
  type BudgetedRepository,
} from "@aistudy/ai";


type Scope = { workspaceId: string; ownerUserId: string };

export type TutorTurnDeps = {
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
    const scope = {
      workspaceId: claimed.workspaceId,
      ownerUserId: claimed.ownerUserId ?? "",
    };
    const scopedBudget: BudgetedRepository = {
      reserve: (input) => deps.budget.reserve(scope, input),
      release: (requestId, reason) => deps.budget.release(scope, requestId, reason),
      claimExecution: (reservationId) => deps.budget.claimExecution(scope, reservationId),
      settle: (...args) => deps.budget.settle(scope, ...args),
      markUnknown: (reservationId) => deps.budget.markUnknown(scope, reservationId),
    };
    try {
      const turn = await deps.tutorJobs.getUserTurn(claimed.userTurnId, claimed.workspaceId);
      if (!turn) throw new Error("user turn for tutor job is missing");
      const jobEpoch = deps.privacy
        ? await deps.privacy.getWorkspaceEpoch(scope)
        : null;
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
      // Package C thin pick runs only at submit (tutor-service / ephemeral) when
      // client sourceIds were empty and pool > K. Worker turns already carry the
      // effective persisted sourceIds — never re-narrow explicit large selections.
      const context = selectContext({
        chunks,
        query: turn.text,
        maxCharacters: deps.config.maxContextCharacters,
        preferChunkId: turn.chunkId ?? undefined,
        preferPage,
      }).slice(0, MAX_PROVIDER_CHUNKS);
      const { history, sourceRefs: historySourceRefs } = await deps.tutorJobs.loadHistoryContext(scope, claimed.userTurnId);
      const contextNow = new Date().toISOString();
      const memoryContext = deps.memories
        ? await deps.memories.listContext(scope, contextNow)
        : { memories: [], sourceRefs: [] };
      const contextSourceRefs = mergeContextSourceRefs(
        context.map(({ sourceId, sourceVersion }) => ({ sourceId, sourceVersion })),
        historySourceRefs, memoryContext.sourceRefs,
      );
      const mode = claimed.mode as TutorMode;
      const baseInstruction = instructionWithMemories(
        makeTutorInstruction(mode),
        memoryContext.memories,
        contextNow,
      );
      const strategyTemplate = resolveStrategyTemplate(turn.strategyTemplateId);
      const instruction = `${baseInstruction}`+"\n"+`${strategyTemplate.instructionSuffix}`;
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
        throw new Error(VISION_REQUIRED_MESSAGE);
      }
      // Photo sources default to page 1 when the learner did not pick a page.
      const pageForImages = turn.currentPage ?? (imageOnlySources ? 1 : null);
      const imageParts = supportsVision && pageForImages != null && deps.pageImages
        ? await deps.pageImages(scope, { sourceIds: allowedSourceIds, sourceVersions: turn.sourceVersions, physicalPage: pageForImages }) : [];
      const input: ProviderInput = {
        instruction, text: turn.text, history,
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
          requestId: operationId,
          operationId,
          // Persisted result reference: the assistant turn this call fills.
          resultRef: `opening_turn:${claimed.assistantTurnId}`,
          reservedCents: terms.reservedCents,
          actualCents: terms.actualCents,
          ...(terms.requestCapPerDay ? { requestCapPerDay: terms.requestCapPerDay } : {}),
          beforeSend: deps.privacy && jobEpoch !== null
            ? async () => assertCurrentEpoch(jobEpoch, await deps.privacy!.getWorkspaceEpoch(scope))
            : undefined,
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
            && await deps.tutorJobs.completeFromReplay(scope, claimed.id, persisted.id)
          ) {
            return { skipped: false, replayed: true };
          }
          await deps.tutorJobs.markUnknown(
            scope,
            claimed.id,
            "budget replay: provider call already settled but its result is not persisted; not re-sending",
          );
          return { skipped: false, replayed: true };
        }
        throw error;
      }
      const validated: ProviderOutput = providerOutputSchema.parse(output);
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
      // L01: carry delivered help into the same transaction as the assistant turn.
      const helpExposure = turn.learningSessionId && (mode === "hint" || mode === "explain")
        ? {
            id: randomUUID(),
            sessionId: turn.learningSessionId,
            problemId: null,
            attemptId: turn.attemptId ?? null,
            turnId: claimed.assistantTurnId,
            kind: classifyTutorHelpKind({
              mode,
              attemptId: turn.attemptId ?? null,
              problemId: null,
            }),
            level: mode === "explain" ? "revealed" as const : "hinted" as const,
            delivered: true as const,
          }
        : undefined;
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
        expectedPrivacyEpoch: jobEpoch ?? undefined,
      });
      return { skipped: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : "tutor turn failed";
      const unknownOutcome =
        (error instanceof OpeningProviderError &&
          ["PROVIDER_TIMEOUT", "PROVIDER_NETWORK"].includes(error.code)) ||
        // Replay of an unknown / in-flight ledger key: never fake success or re-send.
        (isBudgetReplayError(error) && (error.code === "BUDGET_OUTCOME_UNKNOWN" || error.code === "BUDGET_EXECUTION_CLAIMED"));
      if (unknownOutcome) {
        await deps.tutorJobs.markUnknown(scope, claimed.id, "provider outcome unknown; usage reconciliation pending");
      } else if (error instanceof PageCitationClarifyError) {
        // LAB-A01/U01: a page refusal fails the job with a Clarify route; the
        // repository ends the assistant turn as 'clarify'.
        await deps.tutorJobs.fail(scope, claimed.id, error.message, {
          code: error.code,
          nextAction: error.nextAction,
        });
      } else {
        await deps.tutorJobs.fail(scope, claimed.id, message);
      }
      throw error;
    }
  };
}
