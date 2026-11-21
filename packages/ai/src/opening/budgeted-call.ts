import type { OpeningModelSnapshot, ProviderInput, ProviderOutput } from "@aistudy/contracts";
import { OpeningProviderError, copyGradingDiagnostic, readGradingDiagnostic, recordGradingDiagnostic, type GradingDiagnosticPhase, type ProviderTextDelta } from "./provider";
import { assertParentInteractionBudget, hasMediaInput, mediaInputCostBound, mediaInputBytes, type ParentInteractionBudget } from "./parent-interaction-budget";
import { onFailedResponseUsage, type FailedResponseUsage } from "./provider-stream";

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
    requestFamily?: string | null;
    alternateRequestFamily?: string;
    requestCapPerDay?: number;
  }): Promise<BudgetedReservation>;
  release(requestId: string, reason?: "not_sent" | "cancelled"): Promise<unknown>;
  /** Durable proof for the entire interaction, not just the currently routed child. */
  isParentNotSent?(parentId: string): Promise<boolean>;
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
  requestId?: string;
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
   * Optional send gate that wraps synchronous provider initiation (e.g. holding DB
   * FOR SHARE locks until fetch starts, then releasing the DB connection before awaiting
   * the network response). Any error thrown before startSend() is called releases "not_sent".
   */
  authorizeAndStartSend?: <T>(startSend: () => Promise<T>) => Promise<T>;
  /**
   * Optional logical operation id (worker-side, BC1 medium).
   * When set, used as the ledger reserve/release idempotency key so retries
   * of the same operation reuse one reservation instead of stacking a second
   * full reserve while a prior attempt is still unknown.
   * Additive; not yet in shared contracts — flag Integrator if promoting.
   */
  operationId?: string;
  /** Base ledger key before attempt suffixes. Null means no siblings. */
  requestFamily?: string | null;
  /** Parent-scoped family used for keys that collide with another interaction. */
  alternateRequestFamily?: string;
  /**
   * Ledger purpose string. Defaults to "tutor" for back-compat with tutor-turn.
   * Teaching generation passes "compile-teaching-unit".
   */
  purpose?: string;
  /** Optional persisted result reference stored on settle and replayed later. */
  resultRef?: string;
  /** Save a recoverable response. Authoritative usage is settled even if this fails. */
  persistResult?: (output: ProviderOutput, receipt: {
    reservationId: string;
    settledCents: number | null;
    costBasis?: "usage_pricing" | "media_usage_upper_bound";
  }) => Promise<void>;
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

const postProviderFailures = new WeakSet<object>();

/** A persistence or accounting error may have a code normally used before sending. */
export function isPostProviderFailure(error: unknown): boolean {
  return error !== null && typeof error === "object" && postProviderFailures.has(error);
}

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
  return (await runBudgetedCallWithReceipt(options)).output;
}

export async function runBudgetedCallWithReceipt(options: BudgetedCallOptions): Promise<{
  output: ProviderOutput;
  reservation: { id: string; requestId: string };
}> {
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
    ...(options.requestFamily !== undefined ? { requestFamily: options.requestFamily } : {}),
    ...(options.alternateRequestFamily !== undefined ? { alternateRequestFamily: options.alternateRequestFamily } : {}),
    ...(freeTier ? { requestCapPerDay: options.requestCapPerDay } : {}),
  });
  const reservedRequestId = reservation.requestId ?? ledgerRequestId;
  const disposition = replayDisposition(reservation);
  if (disposition) throw new BudgetReplayError(disposition);
  // Execution eligibility is claimed independently and atomically: a replayed
  // reserved row (another worker in flight, or a crashed one) never re-sends.
  if (!(await options.budget.claimExecution(reservation.id))) {
    throw new BudgetReplayError({ kind: "in_flight", reservationId: reservation.id });
  }
  async function releaseUnsent(original: unknown) {
    try { await options.budget.release(reservedRequestId, "not_sent"); }
    catch (error) {
      // Release acknowledgement failed. Surface the ledger error itself and
      // prevent its code from authorizing fallback.
      if (error !== null && typeof error === "object") {
        postProviderFailures.add(error);
        copyGradingDiagnostic(original, error);
      }
      throw error;
    }
  }
  try {
    await options.beforeSend?.();
  } catch (error) {
    // No Provider call has started: this reservation cannot have incurred usage.
    await releaseUnsent(error);
    throw error;
  }
  let phase: GradingDiagnosticPhase = "provider";
  let transport: { attemptedFetch: boolean; httpStatus?: number } | undefined;
  let failedResponseUsage: FailedResponseUsage | undefined;
  // Both response formats report validated charges for unusable answers here.
  const onTextDelta = Object.assign(
    (delta: string) => options.onTextDelta?.(delta),
    { [onFailedResponseUsage]: (usage: FailedResponseUsage) => { failedResponseUsage = usage; } },
  );

  async function price(receipt: ProviderOutput) {
    try {
      const actual = options.actualCents(receipt);
      if (!Number.isSafeInteger(actual) || actual < 0 || (actual === 0 && !freeTier)) {
        throw new BudgetedCallError("BUDGET_INVALID_ACTUAL", "provider usage cannot be priced safely");
      }
      return { actual, ...settleCentsForActual(options.reservedCents, actual) };
    } catch (error) {
      // The request was sent. Keep the original hold and make it reconcilable.
      return await accountFailure(error, () => options.budget.markUnknown(reservation.id));
    }
  }

  async function settle(settlement: { actual: number; settledCents: number; overage: boolean }, resultRef?: string) {
    const { actual, settledCents, overage } = settlement;
    const media = hasMediaInput(options.input);
    // Settlement failures leave the reservation intact.
    await options.budget.settle(
      reservation.id,
      settledCents,
      ...(resultRef || media ? [{
        ...(resultRef ? { resultRef } : {}),
        ...(media ? { costBasis: "media_usage_upper_bound" as const } : {}),
      }] : []),
    );
    if (overage) {
      await options.budget.noteOverage?.({
        reservationId: reservation.id, reservedCents: options.reservedCents, actualCents: actual, settledCents,
      });
    }
  }

  async function accountFailure(error: unknown, account: () => Promise<unknown>): Promise<never> {
    recordGradingDiagnostic(error, phase, transport);
    try { await account(); }
    catch (ledgerError) {
      const failure = new AggregateError([error, ledgerError], "provider call and budget accounting failed", { cause: error });
      copyGradingDiagnostic(error, failure);
      throw failure;
    }
    throw error;
  }

  try {
    let output: ProviderOutput;
    let sendStarted = false;
    try {
      if (options.authorizeAndStartSend) {
        output = await options.authorizeAndStartSend(() => {
          sendStarted = true;
          return options.provider!.complete(options.input, options.signal, onTextDelta);
        });
      } else {
        sendStarted = true;
        output = await options.provider.complete(options.input, options.signal, onTextDelta);
      }
    } catch (error) {
      if (!sendStarted) {
        // Authorization failed before provider.complete was ever invoked.
        await releaseUnsent(error);
        throw error;
      }
      const usage = failedResponseUsage;
      if (usage) {
        phase = "usage";
        return await accountFailure(error, async () => {
          await settle(await price({ ...usage, text: "", candidates: [], citedChunkIds: [] }));
        });
      }
      const notSent = error instanceof OpeningProviderError
        && (readGradingDiagnostic(error)?.attemptedFetch === false
          || ledgerActionForProviderError(error.code, { requestSent: error.requestSent }) === "release");
      if (notSent) {
        recordGradingDiagnostic(error, phase, transport);
        await releaseUnsent(error);
        throw error;
      }
      return await accountFailure(error, () => options.budget.markUnknown(reservation.id));
    }
    const diagnostic = readGradingDiagnostic(output);
    if (diagnostic?.attemptedFetch != null) transport = { attemptedFetch: diagnostic.attemptedFetch, httpStatus: diagnostic.httpStatus };
    phase = "usage";
    const media = hasMediaInput(options.input);
    const settlement = output.inputTokens === null || output.outputTokens === null ? null : await price(output);
    phase = "persist";
    try {
      await options.persistResult?.(output, {
        reservationId: reservation.id,
        settledCents: settlement?.settledCents ?? null,
        ...(settlement && media ? { costBasis: "media_usage_upper_bound" as const } : {}),
      });
    } catch (error) {
      // The charge belongs in the ledger even when no result reference is safe to publish.
      return await accountFailure(error, () => settlement
        ? settle(settlement)
        : options.budget.markUnknown(reservation.id));
    }
    if (settlement) {
      phase = "settle";
      await settle(settlement, options.resultRef);
    } else {
      // Missing usage is not a zero-cost call. Keep the pessimistic reservation.
      phase = "usage";
      await options.budget.markUnknown(reservation.id);
      const missingUsage = new BudgetedCallError("USAGE_MISSING", "provider usage missing");
      recordGradingDiagnostic(missingUsage, phase, transport, "USAGE_MISSING");
      copyGradingDiagnostic(missingUsage, output);
    }
    return { output, reservation: { id: reservation.id, requestId: reservedRequestId } };
  } catch (error) {
    if (phase !== "provider" && error !== null && typeof error === "object") {
      postProviderFailures.add(error);
    }
    recordGradingDiagnostic(error, phase, transport);
    throw error;
  }
}
