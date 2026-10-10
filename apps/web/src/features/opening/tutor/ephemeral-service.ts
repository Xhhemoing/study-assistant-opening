import { randomUUID } from "node:crypto";
import { EphemeralProvenanceError, mergeContextSourceRefs, type EphemeralProvenanceRepository } from "@aistudy/database";
import {
  providerOutputSchema,
  type EphemeralTurnInput,
  type EphemeralTurnResponse,
  type ProviderInput,
  type OpeningModelSnapshot,
  type ProviderOutput,
  type SourceChunk,
  type TutorMode,
} from "@aistudy/contracts";
import {
  assertEphemeralInput,
  canProposeTask,
  ConversationPolicyError,
  resolveCitations,
  selectContext,
  stripEphemeralCandidates,
} from "@aistudy/ai";
import { OpeningProviderError } from "@aistudy/ai";
import { runBudgetedCall, type BudgetedRepository } from "../../../../../worker/src/runtime/budgeted-call";
import { tutorActualCents, tutorReservationCents } from "../../../../../worker/src/jobs/tutor-cost";
import { makeTutorInstruction } from "../../../../../worker/src/jobs/tutor-turn";
import {
  validatePageSelection,
  type AuthorizedChunk,
} from "./page-selection";

export type EphemeralScope = { workspaceId: string; ownerUserId: string };

export class EphemeralServiceError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "EphemeralServiceError";
    this.code = code;
    this.status = status;
  }
}

type CompleteWithSignal = (
  input: ProviderInput,
  signal?: AbortSignal,
) => Promise<ProviderOutput>;

export type EphemeralProvider = {
  complete: CompleteWithSignal;
};

export type EphemeralTutorDeps = {
  sources: { listOwnedIds(scope: EphemeralScope, sourceIds: string[]): Promise<string[]> };
  chunks: { listForSources(scope: EphemeralScope, sourceIds: string[]): Promise<SourceChunk[]> };
  privacy: {
    snapshot(scope: EphemeralScope): Promise<{ epoch: number; excludedSourceIds: string[] }>;
    currentEpoch(scope: EphemeralScope): Promise<number>;
  };
  provenance?: EphemeralProvenanceRepository;
  budget: BudgetedRepository;
  provider: EphemeralProvider | null;
  modelSnapshot?: OpeningModelSnapshot;
  resolveModel?: (scope: EphemeralScope, mode: TutorMode) => Promise<{ provider: EphemeralProvider; modelSnapshot: OpeningModelSnapshot; inputCentsPerMillion: number; outputCentsPerMillion: number; supportsVision?: boolean }>;
  pageImages?: (scope: EphemeralScope, input: { sourceIds: string[]; sourceVersions: Record<string, number>; physicalPage: number }) => Promise<ProviderInput["imageParts"]>;
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
      input: EphemeralTurnInput,
      signal?: AbortSignal,
    ): Promise<EphemeralTurnResponse> {
      try {
        assertEphemeralInput(input);
      } catch (error) {
        if (error instanceof ConversationPolicyError) {
          throw new EphemeralServiceError("VALIDATION", error.message, error.status);
        }
        throw error;
      }
      if (signal?.aborted) {
        throw new EphemeralServiceError("ABORTED", "ephemeral request aborted", 499);
      }
      const owned = new Set(input.sourceIds.length
        ? await deps.sources.listOwnedIds(scope, input.sourceIds)
        : []);
      const missing = input.sourceIds.filter((id) => !owned.has(id));
      if (missing.length) {
        throw new EphemeralServiceError("NOT_FOUND", "source is not in this workspace", 404);
      }
      const privacy = await deps.privacy.snapshot(scope);
      const excluded = new Set(privacy.excludedSourceIds.map(id => id.toLowerCase()));
      const allowedSourceIds = input.sourceIds.filter(id => !excluded.has(id.toLowerCase()));
      if (input.sourceIds.length && !allowedSourceIds.length) {
        throw new EphemeralServiceError("SOURCE_EXCLUDED", "所选材料已停止供 AI 使用，请取消选择后重试。", 409);
      }
      const epochChanged = input.history.length > 0 && input.historyPrivacyEpoch !== privacy.epoch;
      const chunks = (allowedSourceIds.length
        ? await deps.chunks.listForSources(scope, allowedSourceIds)
        : []).filter(chunk => chunk.text.trim());
      if (allowedSourceIds.some(id => !chunks.some(chunk => chunk.sourceId === id))) {
        throw new EphemeralServiceError("SOURCE_UNAVAILABLE", "所选材料尚无可读正文，请检查解析内容或取消选择后重试。", 422);
      }
      const authorized: AuthorizedChunk[] = chunks.map(({ id, sourceId, page }) => ({ id, sourceId, page }));
      const selection = validatePageSelection(input, authorized);
      if (!selection.ok) {
        throw new EphemeralServiceError(selection.code, selection.code, 422);
      }
      const context = selectContext({
        chunks,
        query: input.text,
        maxCharacters: deps.config.maxContextCharacters,
        preferChunkId: input.chunkId ?? undefined,
        preferPage: input.currentPage ?? undefined,
      });
      const historyToResolve = epochChanged ? [] : input.history;
      const historyRefs = historyToResolve.length ? await deps.provenance?.resolveHistory(scope, historyToResolve, privacy.epoch) ?? null : [];
      const historyDiscarded = epochChanged || historyRefs === null;
      const history = historyDiscarded ? [] : historyToResolve;
      const contextSourceRefs = mergeContextSourceRefs(
        context.map(({ sourceId, sourceVersion }) => ({ sourceId, sourceVersion })), historyRefs ?? [],
      );
      const selected = await deps.resolveModel?.(scope, input.mode);
      const imageParts = selected?.supportsVision && input.currentPage != null && deps.pageImages
        ? await deps.pageImages(scope, { sourceIds: allowedSourceIds, sourceVersions: Object.fromEntries(chunks.map(chunk => [chunk.sourceId, chunk.sourceVersion])), physicalPage: input.currentPage }) : [];
      const providerInput: ProviderInput = {
        instruction: instructionFor(input.mode),
        text: input.text,
        history: history.map(({ role, text }) => ({ role, text })),
        chunks: context,
        mode: input.mode,
        maxOutputTokens: deps.config.maxOutputTokens,
        mediaCapability: imageParts.length ? "text_plus_page_images" : "text_only",
        imageParts,
      };
      const rates = {
        inputCentsPerMillion: selected?.inputCentsPerMillion ?? deps.config.inputCentsPerMillion,
        outputCentsPerMillion: selected?.outputCentsPerMillion ?? deps.config.outputCentsPerMillion,
      };
      const requestId = deps.requestKey?.() ?? `eph:${randomUUID()}`;
      let output: ProviderOutput;
      try {
        output = await runBudgetedCall({
          provider: selected?.provider ?? deps.provider,
          modelSnapshot: selected?.modelSnapshot ?? deps.modelSnapshot,
          budget: deps.budget,
          input: providerInput,
          requestId,
          reservedCents: Math.max(
            deps.config.reservedCents,
            tutorReservationCents(JSON.stringify(providerInput), providerInput.maxOutputTokens, rates),
          ),
          actualCents: (settled) => Math.max(1, tutorActualCents(settled, rates)),
          signal,
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
      } catch (error) {
        if (error instanceof OpeningProviderError) throw error;
        throw error;
      }
      const validated = providerOutputSchema.parse(output);
      if (signal?.aborted) throw new EphemeralServiceError("ABORTED", "ephemeral request aborted", 499);
      let provenanceId: string | null = null;
      try {
        provenanceId = await deps.provenance?.record(scope, { requestId, privacyEpoch: privacy.epoch, contextSourceRefs }) ?? null;
      } catch (error) {
        if (error instanceof EphemeralProvenanceError) {
          throw new EphemeralServiceError(error.code, error.code === "PRIVACY_CHANGED" ? "隐私设置已变化，本轮内容未保存。请确认材料后重新提问。" : "临时来源凭据不可用。", error.code === "NOT_FOUND" ? 404 : 409);
        }
        throw error;
      }
      const allowed = new Set(context.map((chunk) => chunk.id));
      const citedChunkIds = validated.citedChunkIds.filter((id) => allowed.has(id));
      // Soft-filter unknown ids first; resolve only authorized context chunks (never fabricate).
      const citations = resolveCitations(citedChunkIds, context);
      return {
        ...stripEphemeralCandidates({
          ...validated,
          citedChunkIds,
        }),
        citations,
        provenanceId,
        privacyEpoch: privacy.epoch,
        historyDiscarded,
      };
    },
  };
}

export type EphemeralTutorService = ReturnType<typeof createEphemeralTutorService>;
