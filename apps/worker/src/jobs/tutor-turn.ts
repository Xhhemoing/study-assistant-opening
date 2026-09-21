import {
  providerOutputSchema,
  type ProviderOutput,
  type ProviderInput,
  type SourceChunk,
  type TutorMode,
} from "@aistudy/contracts";
import { OpeningProviderError, resolveCitations, selectContext, usageFromOutput } from "@aistudy/ai";
import type {
  OpeningBudgetRepository,
  OpeningTutorJobsRepository,
} from "@aistudy/database";
import { randomUUID } from "node:crypto";
import { assertCurrentEpoch } from "../runtime/privacy-guard";
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
    getWorkspaceEpoch(scope: { workspaceId: string; ownerUserId: string }): Promise<number>;
    listExcludedSourceIds(scope: { workspaceId: string; ownerUserId: string }): Promise<string[]>;
  };
  /** L01: record delivered help in the tutor completion transaction. */
  learning?: {
    insertHelpExposure(
      scope: { workspaceId: string; ownerUserId: string },
      exposure: {
        id: string;
        sessionId: string;
        problemId: string | null;
        turnId: string;
        level: "hinted" | "revealed";
        delivered: true;
      },
    ): Promise<unknown>;
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
        ? (await Promise.all(
            allowedSourceIds.map(async (sourceId) => {
              const version = turn.sourceVersions[sourceId];
              if (version === undefined) {
                throw new Error(`source material is unavailable: missing snapshot for ${sourceId}`);
              }
              const sourceChunks = await deps.chunks.listChunksAtVersion(scope, sourceId, version);
              if (!sourceChunks.length) {
                throw new Error(`source material is unavailable: missing chunks for ${sourceId}@${version}`);
              }
              return sourceChunks;
            }),
          )).flat()
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
      const history = await deps.tutorJobs.loadHistory(scope, claimed.userTurnId);
      const mode = claimed.mode as TutorMode;
      const input: ProviderInput = {
        instruction: makeTutorInstruction(mode), text: turn.text, history,
        chunks: context, mode, maxOutputTokens: deps.config.maxOutputTokens,
        mediaCapability: "text_only", imageParts: [],
      };
      // UTF-8 bytes conservatively bound ordinary text tokenization; allow protocol overhead.
      // This is a local estimate, not a guarantee of a vendor's billing rules.
      const inputTokenBound = Buffer.byteLength(JSON.stringify(input), "utf8") + 4096;
      const maximumCost = Math.ceil((inputTokenBound * deps.config.inputCentsPerMillion +
        input.maxOutputTokens * deps.config.outputCentsPerMillion) / 1_000_000);
      const output = await runBudgetedCall({
        provider: deps.provider,
        budget: scopedBudget,
        input,
        requestId: `tutor:${claimed.id}`,
        reservedCents: Math.max(deps.config.reservedCents, maximumCost),
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
      const citedSourceIds = [...new Set(citations.map((c) => c.sourceId))].filter(
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
        candidates: validated.candidates.map((payload) => ({
          payload,
          sourceIds: citedSourceIds,
        })),
        ...(helpExposure ? { helpExposure } : {}),
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
