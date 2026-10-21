import type { OpeningModelSnapshot, ProviderInput, ProviderOutput } from "@aistudy/contracts";
import { OpeningProviderError, type ProviderTextDelta } from "./provider";
import { assertParentInteractionBudget, hasMediaInput, mediaInputCostBound, mediaInputBytes, type ParentInteractionBudget } from "./parent-interaction-budget";

export type BudgetedProvider = {
  complete(input: ProviderInput, signal?: AbortSignal, onTextDelta?: ProviderTextDelta): Promise<ProviderOutput>;
};

export type OverageAudit = {
  reservationId: string;
  reservedCents: number;
  actualCents: number;
  settledCents: number;
};

export type BudgetedRepository = {
  reserve(input: {
    purpose: string;
    parentBudget?: ParentInteractionBudget;
    modelSnapshot?: OpeningModelSnapshot;
    amountCents: number;
    requestId: string;
    requestCapPerDay?: number;
  }): Promise<BudgetedReservation>;
  release(requestId: string, reason?: "not_sent" | "cancelled"): Promise<unknown>;
  /**
   * Atomically claim the single right to call the provider for this
   * reservation. Exactly one concurrent caller gets true.
   */
  claimExecution(reservationId: string): Promise<boolean>;
  settle(reservationId: string, actualCents: number, options?: { resultRef?: string; costBasis?: "usage_pricing" | "media_usage_upper_bound" | "vendor_receipt" }): Promise<unknown>;
  markUnknown(reservationId: string): Promise<unknown>;
  /** Optional notification; settle must persist any overage audit atomically. */
  noteOverage?(audit: OverageAudit): Promise<void>;
};

/** Minimal reservation view; extra fields come from the real ledger. */
export type BudgetedReservation = {
  id: string;
  state?: string;
  replayed?: boolean;
  outcomeUnknownAt?: Date | null;
  releaseReason?: string | null;
  resultRef?: string | null;
  reconciledAt?: Date | null;
  pendingReconcileCents?: number;
};

export type BudgetReplayDisposition =
  | { kind: "completed"; reservationId: string; resultRef: string | null }
  | { kind: "released"; reservationId: string; reason: string | null }
  | { kind: "unknown"; reservationId: string; pendingReconcileCents: number; reconciled: boolean }
  | { kind: "in_flight"; reservationId: string };

/**
 * Decide from a reserve() result whether this caller may proceed. Returns
 * null for a fresh/claimable reserved row. Never fabricates success.
 */
export function replayDisposition(reservation: BudgetedReservation): BudgetReplayDisposition | null {
  const id = reservation.id;
  if (reservation.state === undefined || reservation.state === "reserved") {
    if (reservation.outcomeUnknownAt) {
      return { kind: "unknown", reservationId: id, pendingReconcileCents: 0, reconciled: false };
    }
    return null;
  }
  if (reservation.state === "released") {
    return { kind: "released", reservationId: id, reason: reservation.releaseReason ?? null };
  }
  if (reservation.reconciledAt && (reservation.pendingReconcileCents ?? 0) > 0) {
    return { kind: "unknown", reservationId: id, pendingReconcileCents: reservation.pendingReconcileCents ?? 0, reconciled: true };
  }
  return { kind: "completed", reservationId: id, resultRef: reservation.resultRef ?? null };
}

const REPLAY_CODES = {
  completed: "BUDGET_REPLAY_COMPLETED",
  released: "BUDGET_REPLAY_RELEASED",
  unknown: "BUDGET_OUTCOME_UNKNOWN",
  in_flight: "BUDGET_EXECUTION_CLAIMED",
} as const;

export type BudgetCallOutcomeCode = (typeof REPLAY_CODES)[keyof typeof REPLAY_CODES];

/** Replay of an existing ledger key: no provider call, no extra charge. */
export class BudgetReplayError extends Error {
  readonly code: BudgetCallOutcomeCode;
  readonly disposition: BudgetReplayDisposition;

  constructor(disposition: BudgetReplayDisposition) {
    super(`budget replay: ${disposition.kind}`);
    this.name = "BudgetReplayError";
    this.code = REPLAY_CODES[disposition.kind];
    this.disposition = disposition;
  }
}

export function isBudgetReplayError(error: unknown): error is BudgetReplayError {
  return error instanceof BudgetReplayError;
}

export type BudgetedCallOptions = {
  parentBudget?: ParentInteractionBudget;
  modelSnapshot?: OpeningModelSnapshot;
  provider: BudgetedProvider | null;
  budget: BudgetedRepository;
  input: ProviderInput;
  requestId: string;
  reservedCents: number;
  actualCents: (output: ProviderOutput) => number;
  signal?: AbortSignal;
  onTextDelta?: ProviderTextDelta;
  /** Runs after reservation, before any Provider request is authorized. */
  beforeSend?: () => Promise<void>;
  /**
   * Optional logical operation id (worker-side, BC1 medium).
   * When set, used as the ledger reserve/release idempotency key so retries
   * of the same operation reuse one reservation instead of stacking a second
   * full reserve while a prior attempt is still unknown.
   * Additive; not yet in shared contracts — flag Integrator if promoting.
   */
  operationId?: string;
  /**
   * Ledger purpose string. Defaults to "tutor" for back-compat with tutor-turn.
   * Teaching generation passes "compile-teaching-unit".
   */
  purpose?: string;
  /** Optional persisted result reference stored on settle and replayed later. */
  resultRef?: string;
  /** Save a recoverable response before settlement; failure keeps the spend unknown. */
  persistResult?: (output: ProviderOutput, receipt: { reservationId: string; settledCents: number | null }) => Promise<void>;
  /**
   * Free-tier model: reserve at zero cost under this per-day request cap
   * (reservedCents must then be 0). Paid models leave it unset.
   */
  requestCapPerDay?: number;
};

export class BudgetedCallError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BudgetedCallError";
    this.code = code;
  }
}

export type LedgerAction = "release" | "markUnknown";

/**
 * BC1 v1 code→ledger action table (Integrator Accept).
 * - AUTH / RATE_LIMIT / MEDIA_UNSUPPORTED / PAYLOAD_TOO_LARGE (413) → release
 * - REQUEST not-sent/client → release; already-sent failed → markUnknown
 * - UNAVAILABLE / timeout / network / response / refusal / default → markUnknown
 * Missing usage is handled separately in runBudgetedCall (always markUnknown).
 */
export function ledgerActionForProviderError(
  code: string,
  options?: { requestSent?: boolean },
): LedgerAction {
  switch (code) {
    case "PROVIDER_AUTH":
    case "PROVIDER_RATE_LIMIT":
    case "PROVIDER_MEDIA_UNSUPPORTED":
    case "PROVIDER_PAYLOAD_TOO_LARGE":
      return "release";
    case "PROVIDER_REQUEST":
      return options?.requestSent ? "markUnknown" : "release";
    case "PROVIDER_UNAVAILABLE":
    case "PROVIDER_TIMEOUT":
    case "PROVIDER_NETWORK":
    case "PROVIDER_RESPONSE":
    case "PROVIDER_REFUSAL":
    case "PROVIDER_ABORTED":
    default:
      return "markUnknown";
  }
}

/**
 * The reservation is a pre-send bound, never a ceiling on recorded spend.
 * Preserve actual cost so settlement can audit it and enforce remaining budgets.
 */
export function settleCentsForActual(reservedCents: number, actualCents: number): {
  settledCents: number;
  overage: boolean;
} {
  if (!Number.isSafeInteger(actualCents) || actualCents <= 0) {
    return { settledCents: actualCents, overage: false };
  }
  if (actualCents > reservedCents) {
    return { settledCents: actualCents, overage: true };
  }
  return { settledCents: actualCents, overage: false };
}

export async function runBudgetedCall(options: BudgetedCallOptions): Promise<ProviderOutput> {
  if (!options.provider) {
    throw new BudgetedCallError("PROVIDER_DISABLED", "opening provider is disabled");
  }
  if (options.parentBudget && hasMediaInput(options.input)) {
    const bound = mediaInputCostBound(options.modelSnapshot ?? {});
    if (!bound) throw new BudgetedCallError("BUDGET_MEDIA_COST_UNBOUNDED", "当前模型未配置可核验的媒体计费上界，请改用文本或先完成材料解析。");
    let bytes: number;
    try { bytes = mediaInputBytes(options.input); }
    catch { throw new BudgetedCallError("BUDGET_MEDIA_INPUT_INVALID", "媒体内容编码无效。"); }
    if (bytes > bound.mediaMaxInputBytes) throw new BudgetedCallError("BUDGET_MEDIA_INPUT_TOO_LARGE", "媒体内容超过已配置计费上界适用的大小限制。");
  }
  // Family 1: illegal per-call reserve never reaches provider or ledger reserve.
  const freeTier = options.requestCapPerDay !== undefined;
  if (!Number.isSafeInteger(options.reservedCents) || options.reservedCents < 0 || (options.reservedCents === 0) !== freeTier) {
    throw new BudgetedCallError(
      "BUDGET_INVALID_RESERVE",
      "reservedCents must be a positive integer",
    );
  }
  if (options.parentBudget) assertParentInteractionBudget(options.parentBudget);
  // operationId (when present) is the ledger idempotency key; requestId stays caller-visible.
  const ledgerRequestId = options.operationId ?? options.requestId;
  const reservation = await options.budget.reserve({
    purpose: options.purpose ?? "tutor",
    ...(options.parentBudget ? { parentBudget: options.parentBudget } : {}),
    ...(options.modelSnapshot ? { modelSnapshot: options.modelSnapshot } : {}),
    amountCents: options.reservedCents,
    requestId: ledgerRequestId,
    ...(freeTier ? { requestCapPerDay: options.requestCapPerDay } : {}),
  });
  const disposition = replayDisposition(reservation);
  if (disposition) throw new BudgetReplayError(disposition);
  // Execution eligibility is claimed independently and atomically: a replayed
  // reserved row (another worker in flight, or a crashed one) never re-sends.
  if (!(await options.budget.claimExecution(reservation.id))) {
    throw new BudgetReplayError({ kind: "in_flight", reservationId: reservation.id });
  }
  try {
    await options.beforeSend?.();
  } catch (error) {
    // No Provider call has started: this reservation cannot have incurred usage.
    await options.budget.release(ledgerRequestId, "not_sent");
    throw error;
  }
  let output: ProviderOutput;
  try {
    output = options.onTextDelta
      ? await options.provider.complete(options.input, options.signal, options.onTextDelta)
      : await options.provider.complete(options.input, options.signal);
  } catch (error) {
    if (error instanceof OpeningProviderError) {
      const action = ledgerActionForProviderError(error.code, { requestSent: error.requestSent });
      if (action === "release") {
        await options.budget.release(ledgerRequestId, "not_sent");
      } else {
        await options.budget.markUnknown(reservation.id);
      }
    } else {
      await options.budget.markUnknown(reservation.id);
    }
    throw error;
  }
  const actual = output.inputTokens === null || output.outputTokens === null ? null : options.actualCents(output);
  if (actual !== null && (!Number.isSafeInteger(actual) || actual < 0 || (actual === 0 && !freeTier))) {
    await options.budget.markUnknown(reservation.id);
    throw new BudgetedCallError("BUDGET_INVALID_ACTUAL", "provider usage cannot be priced safely");
  }
  const settlement = actual === null ? null : settleCentsForActual(options.reservedCents, actual);
  try {
    await options.persistResult?.(output, { reservationId: reservation.id, settledCents: settlement?.settledCents ?? null });
  } catch (error) {
    // The provider already ran. Never release or retry it when durable storage failed.
    await options.budget.markUnknown(reservation.id);
    throw error;
  }
  // Missing usage is not a zero-cost call. Keep the pessimistic reservation.
  if (output.inputTokens === null || output.outputTokens === null) {
    await options.budget.markUnknown(reservation.id);
  } else {
    const { settledCents, overage } = settlement!;
    // Settlement failures must leave the reservation intact, never release it.
    await options.budget.settle(
      reservation.id,
      settledCents,
      ...(options.resultRef || hasMediaInput(options.input) ? [{
        ...(options.resultRef ? { resultRef: options.resultRef } : {}),
        ...(hasMediaInput(options.input) ? { costBasis: "media_usage_upper_bound" as const } : {}),
      }] : []),
    );
    if (overage) {
      await options.budget.noteOverage?.({
        reservationId: reservation.id,
        reservedCents: options.reservedCents,
        actualCents: actual!,
        settledCents,
      });
    }
  }
  return output;
}
