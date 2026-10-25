import type { OpeningModelSnapshot, ProviderInput, ProviderOutput } from "@aistudy/contracts";
import {
  isBudgetReplayError,
  ledgerActionForProviderError,
  runBudgetedCall,
  type BudgetedProvider,
  type BudgetedRepository,
  type BudgetedCallOptions,
} from "./budgeted-call";
import { hasMediaInput, mediaInputCostBound, type MediaInputCostBound, type ParentInteractionBudget } from "./parent-interaction-budget";
import { OpeningModelRoutingError } from "./model-routing";
import { modelTaskSpec, type ModelTaskKey } from "./model-tasks";
import { OpeningProviderError, openingProviderRequestBody } from "./provider";
import { actualCentsForOutput, reservationCentsForInput } from "./usage";

export type GatewayScope = { workspaceId: string; ownerUserId: string };

/** One selection supplies the provider, the ledger snapshot and the prices. */
export type ResolvedTaskModel = Partial<MediaInputCostBound> & {
  provider: BudgetedProvider;
  modelSnapshot: OpeningModelSnapshot;
  inputCentsPerMillion: number;
  outputCentsPerMillion: number;
  supportsVision?: boolean;
  supportsAudio?: boolean;
  billing?: "metered" | "free_tier";
  dailyRequestCap?: number | null;
};

export type ModelGatewayCallOptions = {
  parentBudget?: ParentInteractionBudget;
  budget: BudgetedRepository;
  input: ProviderInput;
  /** Durable ledger key: retries of one logical operation reuse one reservation. */
  operationId: string;
  resultRef?: string;
  persistResult?: BudgetedCallOptions["persistResult"];
  /** Reservation floor for paid models, e.g. a configured per-call minimum. */
  minReservedCents?: number;
  signal?: AbortSignal;
  beforeSend?: () => Promise<void>;
  onTextDelta?: BudgetedCallOptions["onTextDelta"];
  /** Told which model answered (e.g. to label a fallback answer). */
  onModel?: (model: ResolvedTaskModel, info: { fallback: boolean }) => void;
};

export type ReservationTerms = {
  reservedCents: number;
  actualCents: (output: ProviderOutput) => number;
  requestCapPerDay?: number;
};

/**
 * How one call is reserved and settled. Paid models reserve the estimated token
 * cost (at least the floor); free-tier models reserve zero under their request cap.
 */
export function reservationTerms(model: Omit<ResolvedTaskModel, "provider">, input: ProviderInput, floorCents = 1): ReservationTerms {
  if (model.billing === "free_tier") {
    if (!model.dailyRequestCap) {
      throw new OpeningModelRoutingError("免费额度模型缺少每日请求上限，请到设置补全。");
    }
    return { reservedCents: 0, actualCents: () => 0, requestCapPerDay: model.dailyRequestCap };
  }
  const media = hasMediaInput(input);
  const bound = media ? mediaInputCostBound(model) ?? mediaInputCostBound(model.modelSnapshot) : null;
  const rates = { inputCentsPerMillion: bound ? Math.max(bound.mediaInputCentsPerMillion, model.inputCentsPerMillion) : model.inputCentsPerMillion, outputCentsPerMillion: model.outputCentsPerMillion };
  // Encoded media bytes are transport, not text tokens. A verified provider
  // context limit supplies the media bound; all textual frames remain priced.
  const pricedInput = media ? { ...input, imageParts: input.imageParts.map(part => ({ ...part, data: "" })),
    ...(input.audioParts ? { audioParts: input.audioParts.map(part => ({ ...part, data: "" })) } : {}) } : input;
  const textReservation = reservationCentsForInput(JSON.stringify(openingProviderRequestBody(pricedInput, { model: model.modelSnapshot.modelName, answerStyle: true })), input.maxOutputTokens, rates);
  const mediaReservation = bound ? Math.ceil(bound.mediaInputTokenUpperBound * rates.inputCentsPerMillion / 1_000_000) : 0;
  return {
    reservedCents: Math.max(floorCents, textReservation + mediaReservation),
    actualCents: (output) => actualCentsForOutput(output, rates),
  };
}

/**
 * True only when the provider certainly did not receive the request, so trying the
 * user's fallback model cannot double-send: the route was unusable, the ledger refused
 * (cents cap, request cap) or released the reservation, or the provider rejected it
 * before processing (auth, rate limit, unsupported media). Timeouts and network
 * failures are unknown outcomes and never fall back.
 */
export function isNotSentFailure(error: unknown): boolean {
  if (error instanceof OpeningModelRoutingError) return true;
  if (error instanceof OpeningProviderError) return ledgerActionForProviderError(error.code, { requestSent: error.requestSent }) === "release";
  if (isBudgetReplayError(error)) return error.disposition.kind === "released";
  const code = (error as { code?: unknown } | null)?.code;
  return code === "BUDGET_EXCEEDED" || code === "REQUEST_CAP_EXCEEDED" || code === "BUDGET_MEDIA_COST_UNBOUNDED" || code === "BUDGET_MEDIA_INPUT_TOO_LARGE";
}

/**
 * Run with the primary model; on a not-sent failure, run once more with the user's
 * explicit fallback under its own ledger key. Without a fallback the primary error stands.
 */
export async function withModelFallback<T>(input: {
  primary: () => Promise<ResolvedTaskModel>;
  fallback: () => Promise<ResolvedTaskModel | null>;
  operationId: string;
  run: (model: ResolvedTaskModel, operationId: string, info: { fallback: boolean }) => Promise<T>;
}): Promise<T> {
  try {
    const primary = await input.primary();
    return await input.run(primary, input.operationId, { fallback: false });
  } catch (error) {
    if (!isNotSentFailure(error)) throw error;
    const fallback = await input.fallback();
    if (!fallback) throw error;
    return input.run(fallback, `${input.operationId}:fallback`, { fallback: true });
  }
}

export type ModelGateway = ReturnType<typeof createModelGateway>;

/** Single entry point for model calls: task → configured model (or fallback) → budgeted call. */
export function createModelGateway(deps: {
  resolve(scope: GatewayScope, task: ModelTaskKey): Promise<ResolvedTaskModel>;
  resolveFallback?(scope: GatewayScope, task: ModelTaskKey): Promise<ResolvedTaskModel | null>;
}) {
  const resolveFallback = (scope: GatewayScope, task: ModelTaskKey) =>
    deps.resolveFallback ? deps.resolveFallback(scope, task) : Promise.resolve(null);

  async function call(scope: GatewayScope, task: ModelTaskKey, options: ModelGatewayCallOptions): Promise<ProviderOutput> {
    return withModelFallback({
      primary: () => deps.resolve(scope, task),
      fallback: () => resolveFallback(scope, task),
      operationId: options.operationId,
      run: (model, operationId, info) => {
        options.onModel?.(model, info);
        const terms = reservationTerms(model, options.input, options.minReservedCents ?? 1);
        if (!Number.isSafeInteger(terms.reservedCents) || terms.reservedCents < 0) {
          // Pricing failed before any reservation or provider call. The explicit
          // fallback remains eligible under the existing not-sent route rules.
          throw new OpeningModelRoutingError("模型费用无法安全估算，请检查价格或选择备用模型。");
        }
        return runBudgetedCall({
          provider: model.provider,
          modelSnapshot: model.modelSnapshot,
          budget: options.budget,
          input: options.input,
          requestId: operationId,
          operationId,
          purpose: modelTaskSpec(task).purpose,
          parentBudget: options.parentBudget ?? { id: options.operationId },
          ...(options.resultRef ? { resultRef: options.resultRef } : {}),
          ...(options.persistResult ? { persistResult: options.persistResult } : {}),
          reservedCents: terms.reservedCents,
          actualCents: terms.actualCents,
          ...(terms.requestCapPerDay ? { requestCapPerDay: terms.requestCapPerDay } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.beforeSend ? { beforeSend: options.beforeSend } : {}),
          ...(options.onTextDelta ? { onTextDelta: options.onTextDelta } : {}),
        });
      },
    });
  }
  return {
    resolve: deps.resolve,
    resolveFallback,
    call,
    /** Adapter for handlers that take a `{ complete(input) }` provider. */
    budgetedProvider(
      scope: GatewayScope,
      task: ModelTaskKey,
      options: Omit<ModelGatewayCallOptions, "input" | "signal">,
    ): BudgetedProvider {
      return {
        complete: (input, signal, onTextDelta) => call(scope, task, { ...options, input, ...(signal ? { signal } : {}), ...(onTextDelta ? { onTextDelta } : {}) }),
      };
    },
  };
}
