import {
  providerOutputSchema,
  type EphemeralTurnInput,
  type ProviderInput,
  type ProviderOutput,
  type SourceChunk,
  type TutorMode,
} from "@aistudy/contracts";
import {
  assertEphemeralInput,
  canProposeTask,
  ConversationPolicyError,
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
  budget: BudgetedRepository;
  provider: EphemeralProvider | null;
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
    ): Promise<ProviderOutput> {
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
      const chunks = input.sourceIds.length
        ? await deps.chunks.listForSources(scope, input.sourceIds)
        : [];
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
      const providerInput: ProviderInput = {
        instruction: instructionFor(input.mode),
        text: input.text,
        history: input.history,
        chunks: context,
        mode: input.mode,
        maxOutputTokens: deps.config.maxOutputTokens,
        mediaCapability: "text_only",
        imageParts: [],
      };
      const rates = {
        inputCentsPerMillion: deps.config.inputCentsPerMillion,
        outputCentsPerMillion: deps.config.outputCentsPerMillion,
      };
      const requestId = deps.requestKey?.() ?? `eph:${deps.now?.() ?? Date.now()}:${scope.workspaceId}`;
      let output: ProviderOutput;
      try {
        output = await runBudgetedCall({
          provider: deps.provider,
          budget: deps.budget,
          input: providerInput,
          requestId,
          reservedCents: Math.max(
            deps.config.reservedCents,
            tutorReservationCents(JSON.stringify(providerInput), providerInput.maxOutputTokens, rates),
          ),
          actualCents: (settled) => Math.max(1, tutorActualCents(settled, rates)),
          signal,
        });
      } catch (error) {
        if (error instanceof OpeningProviderError) throw error;
        throw error;
      }
      const validated = providerOutputSchema.parse(output);
      const allowed = new Set(context.map((chunk) => chunk.id));
      return stripEphemeralCandidates({
        ...validated,
        citedChunkIds: validated.citedChunkIds.filter((id) => allowed.has(id)),
      });
    },
  };
}

export type EphemeralTutorService = ReturnType<typeof createEphemeralTutorService>;
