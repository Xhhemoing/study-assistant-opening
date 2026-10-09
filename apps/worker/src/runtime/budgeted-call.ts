import type { OpeningModelSnapshot, ProviderInput, ProviderOutput } from "@aistudy/contracts";
import { OpeningProviderError } from "@aistudy/ai";

export type BudgetedProvider = {
  complete(input: ProviderInput, signal?: AbortSignal): Promise<ProviderOutput>;
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
    modelSnapshot?: OpeningModelSnapshot;
    amountCents: number;
    requestId: string;
  }): Promise<{ id: string }>;
  release(requestId: string): Promise<unknown>;
  settle(reservationId: string, actualCents: number): Promise<unknown>;
  markUnknown(reservationId: string): Promise<unknown>;
  /** Optional audit hook when settle caps actual spend to the reservation. */
  noteOverage?(audit: OverageAudit): Promise<void>;
};

export type BudgetedCallOptions = {
  modelSnapshot?: OpeningModelSnapshot;
  provider: BudgetedProvider | null;
  budget: BudgetedRepository;
  input: ProviderInput;
  requestId: string;
  reservedCents: number;
  actualCents: (output: ProviderOutput) => number;
  signal?: AbortSignal;
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
 * - AUTH / RATE_LIMIT / MEDIA_UNSUPPORTED → release
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
 * Cap actual settle amount to the reservation; forbid unpolicied over-booking.
 * Policy: cap-to-reserved + audit (NOT markUnknown for overage).
 */
export function settleCentsForActual(reservedCents: number, actualCents: number): {
  settledCents: number;
  overage: boolean;
} {
  if (!Number.isSafeInteger(actualCents) || actualCents <= 0) {
    return { settledCents: actualCents, overage: false };
  }
  if (actualCents > reservedCents) {
    return { settledCents: reservedCents, overage: true };
  }
  return { settledCents: actualCents, overage: false };
}

export async function runBudgetedCall(options: BudgetedCallOptions): Promise<ProviderOutput> {
  if (!options.provider) {
    throw new BudgetedCallError("PROVIDER_DISABLED", "opening provider is disabled");
  }
  // Family 1: illegal per-call reserve never reaches provider or ledger reserve.
  if (!Number.isSafeInteger(options.reservedCents) || options.reservedCents <= 0) {
    throw new BudgetedCallError(
      "BUDGET_INVALID_RESERVE",
      "reservedCents must be a positive integer",
    );
  }
  // operationId (when present) is the ledger idempotency key; requestId stays caller-visible.
  const ledgerRequestId = options.operationId ?? options.requestId;
  const reservation = await options.budget.reserve({
    purpose: "tutor",
    ...(options.modelSnapshot ? { modelSnapshot: options.modelSnapshot } : {}),
    amountCents: options.reservedCents,
    requestId: ledgerRequestId,
  });
  try {
    await options.beforeSend?.();
  } catch (error) {
    // No Provider call has started: this reservation cannot have incurred usage.
    await options.budget.release(ledgerRequestId);
    throw error;
  }
  let output: ProviderOutput;
  try {
    output = await options.provider.complete(options.input, options.signal);
  } catch (error) {
    if (error instanceof OpeningProviderError) {
      const action = ledgerActionForProviderError(error.code);
      if (action === "release") {
        await options.budget.release(ledgerRequestId);
      } else {
        await options.budget.markUnknown(reservation.id);
      }
    } else {
      await options.budget.markUnknown(reservation.id);
    }
    throw error;
  }
  // Missing usage is not a zero-cost call. Keep the pessimistic reservation.
  if (output.inputTokens === null || output.outputTokens === null) {
    await options.budget.markUnknown(reservation.id);
  } else {
    const actual = options.actualCents(output);
    const { settledCents, overage } = settleCentsForActual(options.reservedCents, actual);
    // Settlement failures must leave the reservation intact, never release it.
    await options.budget.settle(reservation.id, settledCents);
    if (overage) {
      await options.budget.noteOverage?.({
        reservationId: reservation.id,
        reservedCents: options.reservedCents,
        actualCents: actual,
        settledCents,
      });
    }
  }
  return output;
}
