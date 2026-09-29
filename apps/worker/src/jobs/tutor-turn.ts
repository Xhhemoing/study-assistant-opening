import {
  providerOutputSchema,
  type MemoryItem,
  type ProviderOutput,
  type ProviderInput,
  type SourceChunk,
  type TutorMode,
} from "@aistudy/contracts";
import { OpeningProviderError, resolveCitations, selectContext } from "@aistudy/ai";
import { instructionWithMemories } from "@aistudy/domain";
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

export function makeTutorInstruction(mode: TutorMode): string {
  switch (mode) {
    case "listen":
      return "倾听并确认理解；不要自动创建任务，不要擅自规划。";
    case "hint":
      return "提供下一步提示，不直接给出完整答案；引导学习者自己完成。";
    case "explain":
      return "解释概念并允许给出完整答案，同时标明依据。";
    case "think_together":
      return "与学习者共同思考，提出问题和候选路径，不直接改变计划。";
  }
}

type Scope = { workspaceId: string; ownerUserId: string };

export type TutorTurnDeps = {
  tutorJobs: OpeningTutorJobsRepository;
  chunks: {
    listForSources(scope: { workspaceId: string; ownerUserId: string }, sourceIds: string[]): Promise<SourceChunk[]>;
    listChunksAtVersion(scope: { workspaceId: string; ownerUserId: string }, sourceId: string, sourceVersion: number): Promise<SourceChunk[]>;
  };
  budget: Pick<OpeningBudgetRepository, "reserve" | "release" | "settle" | "markUnknown">;
  provider: BudgetedProvider | null;
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
      const context = selectContext({
        chunks,
        query: turn.text,
        maxCharacters: deps.config.maxContextCharacters,
        preferChunkId: turn.chunkId ?? undefined,
        preferPage: turn.currentPage ?? undefined,
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
      const instruction = instructionWithMemories(
        makeTutorInstruction(mode),
        memoryContext.memories,
        contextNow,
      );
      const input: ProviderInput = {
        instruction, text: turn.text, history,
        chunks: context, mode, maxOutputTokens: deps.config.maxOutputTokens,
        mediaCapability: "text_only", imageParts: [],
      };
      const rates = {
        inputCentsPerMillion: deps.config.inputCentsPerMillion,
        outputCentsPerMillion: deps.config.outputCentsPerMillion,
      };
      const output = await runBudgetedCall({
        provider: deps.provider,
        budget: scopedBudget,
        input,
        requestId: `tutor:${claimed.id}`,
        reservedCents: Math.max(deps.config.reservedCents, tutorReservationCents(JSON.stringify(input), input.maxOutputTokens, rates)),
        actualCents: (settled) => tutorActualCents(settled, rates),
        beforeSend: deps.privacy && jobEpoch !== null
          ? async () => assertCurrentEpoch(jobEpoch, await deps.privacy!.getWorkspaceEpoch(scope))
          : undefined,
      });
      const validated: ProviderOutput = providerOutputSchema.parse(output);
      const citations = resolveCitations(validated.citedChunkIds, context);
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
