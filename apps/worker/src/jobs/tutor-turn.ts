export { makeTutorInstruction } from "@aistudy/domain";
import {
  providerOutputSchema,
  type MemoryItem,
  type OpeningModelSnapshot,
  type ProviderOutput,
  type ProviderInput,
  type SourceChunk,
  type TutorMode,
} from "@aistudy/contracts";
import { OpeningProviderError, resolveCitations, selectContext } from "@aistudy/ai";
import {
  assertCitationsForPage,
  instructionWithMemories,
  makeTutorInstruction,
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
import { tutorActualCents, tutorReservationCents } from "./tutor-cost";
import { chunksAtSnapshots } from "./tutor-chunks";
import {
  runBudgetedCall,
  type BudgetedProvider,
  type BudgetedRepository,
} from "../runtime/budgeted-call";


type Scope = { workspaceId: string; ownerUserId: string };

export type TutorTurnDeps = {
  tutorJobs: OpeningTutorJobsRepository;
  chunks: {
    listForSources(scope: { workspaceId: string; ownerUserId: string }, sourceIds: string[]): Promise<SourceChunk[]>;
    listChunksAtVersion(scope: { workspaceId: string; ownerUserId: string }, sourceId: string, sourceVersion: number): Promise<SourceChunk[]>;
  };
  budget: Pick<OpeningBudgetRepository, "reserve" | "release" | "settle" | "markUnknown">;
  provider: BudgetedProvider | null;
  resolveModel?: (scope: Scope, mode: TutorMode) => Promise<{ provider: BudgetedProvider; modelSnapshot: OpeningModelSnapshot; inputCentsPerMillion: number; outputCentsPerMillion: number; supportsVision?: boolean }>;
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
  return async function processTutorTurn(tutorJobId: string): Promise<{ skipped: boolean }> {
    const claimed = await deps.tutorJobs.claim(tutorJobId);
    if (!claimed) return { skipped: true };
    const scope = {
      workspaceId: claimed.workspaceId,
      ownerUserId: claimed.ownerUserId ?? "",
    };
    const scopedBudget: BudgetedRepository = {
      reserve: (input) => deps.budget.reserve(scope, input),
      release: (requestId) => deps.budget.release(requestId),
      settle: (reservationId, actualCents) => deps.budget.settle(reservationId, actualCents),
      markUnknown: (reservationId) => deps.budget.markUnknown(reservationId),
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
      const selected = await deps.resolveModel?.(scope, mode);
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
      const rates = {
        inputCentsPerMillion: selected?.inputCentsPerMillion ?? deps.config.inputCentsPerMillion,
        outputCentsPerMillion: selected?.outputCentsPerMillion ?? deps.config.outputCentsPerMillion,
      };
      // BC1: operationId = durable tutor job id so BullMQ retries reuse one ledger
      // reservation. requestId stays the same string today (attempt-scoped ids are
      // a future option). Ephemeral (apps/web) wiring deferred — Experience out of scope.
      const tutorOperationId = `tutor:${claimed.id}`;
      const output = await runBudgetedCall({
        provider: selected?.provider ?? deps.provider,
        modelSnapshot: selected?.modelSnapshot,
        budget: scopedBudget,
        input,
        requestId: tutorOperationId,
        operationId: tutorOperationId,
        reservedCents: Math.max(deps.config.reservedCents, tutorReservationCents(JSON.stringify(input), input.maxOutputTokens, rates)),
        actualCents: (settled) => tutorActualCents(settled, rates),
        beforeSend: deps.privacy && jobEpoch !== null
          ? async () => assertCurrentEpoch(jobEpoch, await deps.privacy!.getWorkspaceEpoch(scope))
          : undefined,
      });
      const validated: ProviderOutput = providerOutputSchema.parse(output);
      const citations = resolveCitations(validated.citedChunkIds, context);
      // Strategy guard: strict page anchoring happens after citation
      // resolution and before any successful writeback or help exposure.
      if (turn.currentPage != null && turn.sourceIds.length > 0) {
        assertCitationsForPage(
          citations.map((citation) => ({
            page: context.find((chunk) => chunk.id === citation.chunkId)?.page ?? null,
          })),
          turn.currentPage,
        );
      }
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
            level: mode === "explain" ? "revealed" as const : "hinted" as const,
            delivered: true as const,
          }
        : undefined;
      await deps.tutorJobs.completeTurn({
        scope,
        jobId: claimed.id,
        assistantTurnId: claimed.assistantTurnId,
        text: validated.text,
        citations,
        contextSourceRefs,
        candidates: validated.candidates.map((payload) => ({
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
        error instanceof OpeningProviderError &&
        ["PROVIDER_TIMEOUT", "PROVIDER_NETWORK"].includes(error.code);
      if (unknownOutcome) {
        await deps.tutorJobs.markUnknown(scope, claimed.id, "provider outcome unknown; usage reconciliation pending");
      } else {
        await deps.tutorJobs.fail(scope, claimed.id, message);
      }
      throw error;
    }
  };
}
