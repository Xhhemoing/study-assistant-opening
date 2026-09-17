import {
  providerOutputSchema,
  type ProviderOutput,
  type SourceChunk,
  type TutorMode,
} from "@aistudy/contracts";
import { OpeningProviderError, resolveCitations, selectContext, usageFromOutput } from "@aistudy/ai";
import type {
  OpeningBudgetRepository,
  OpeningTutorJobsRepository,
} from "@aistudy/database";
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

export type TutorTurnDeps = {
  tutorJobs: OpeningTutorJobsRepository;
  chunks: { listForSources(scope: { workspaceId: string; ownerUserId: string }, sourceIds: string[]): Promise<SourceChunk[]> };
  budget: Pick<OpeningBudgetRepository, "reserve" | "release" | "settle" | "markUnknown">;
  provider: BudgetedProvider | null;
  config: {
    maxContextCharacters: number;
    reservedCents: number;
    maxOutputTokens: number;
    inputCentsPerMillion: number;
    outputCentsPerMillion: number;
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
      const chunks = await deps.chunks.listForSources(scope, turn.sourceIds);
      if (!chunks.length && turn.sourceIds.length > 0) {
        throw new Error("all requested source material is unavailable");
      }
      const context = selectContext({
        chunks,
        query: turn.text,
        maxCharacters: deps.config.maxContextCharacters,
        preferChunkId: turn.chunkId ?? undefined,
        preferPage: turn.currentPage ?? undefined,
      }).slice(0, MAX_PROVIDER_CHUNKS);
      const mode = claimed.mode as TutorMode;
      const output = await runBudgetedCall({
        provider: deps.provider,
        budget: scopedBudget,
        input: {
          instruction: makeTutorInstruction(mode),
          text: turn.text,
          chunks: context,
          mode,
          maxOutputTokens: deps.config.maxOutputTokens,
          mediaCapability: "text_only",
          imageParts: [],
        },
        requestId: `tutor:${claimed.id}`,
        reservedCents: deps.config.reservedCents,
        actualCents: (settled) => {
          const usage = usageFromOutput(settled);
          return Math.ceil(
            (usage.inputTokens * deps.config.inputCentsPerMillion +
              usage.outputTokens * deps.config.outputCentsPerMillion) /
              1_000_000,
          );
        },
      });
      const validated: ProviderOutput = providerOutputSchema.parse(output);
      const citations = resolveCitations(validated.citedChunkIds, context);
      const citedSourceIds = [...new Set(citations.map((c) => c.sourceId))];
      await deps.tutorJobs.completeTurn({
        scope,
        jobId: claimed.id,
        assistantTurnId: claimed.assistantTurnId,
        text: validated.text,
        candidates: validated.candidates.map((payload) => ({
          payload,
          sourceIds: citedSourceIds,
        })),
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
