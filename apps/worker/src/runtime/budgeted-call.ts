import type { ProviderInput, ProviderOutput } from "@aistudy/contracts";
import { OpeningProviderError } from "@aistudy/ai";

export type BudgetedProvider = {
  complete(input: ProviderInput): Promise<ProviderOutput>;
};

export type BudgetedRepository = {
  reserve(input: {
    purpose: string;
    amountCents: number;
    requestId: string;
  }): Promise<{ id: string }>;
  release(requestId: string): Promise<unknown>;
  settle(reservationId: string, actualCents: number): Promise<unknown>;
  markUnknown(reservationId: string): Promise<unknown>;
};

export type BudgetedCallOptions = {
  provider: BudgetedProvider | null;
  budget: BudgetedRepository;
  input: ProviderInput;
  requestId: string;
  reservedCents: number;
  actualCents: (output: ProviderOutput) => number;
};

export class BudgetedCallError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BudgetedCallError";
    this.code = code;
  }
}

/**
 * Deferred-failure codes: the request may have REACHED the provider, so the
 * reservation retains its cap space (markUnknown) until reconciliation.
 * Definitive outcomes (auth, rate limit, refusal, response shape) release.
 */
const UNKNOWN_OUTCOME_CODES = new Set(["PROVIDER_TIMEOUT", "PROVIDER_NETWORK"]);

export async function runBudgetedCall(options: BudgetedCallOptions): Promise<ProviderOutput> {
  if (!options.provider) {
    throw new BudgetedCallError("PROVIDER_DISABLED", "opening provider is disabled");
  }
  const reservation = await options.budget.reserve({
    purpose: "tutor",
    amountCents: options.reservedCents,
    requestId: options.requestId,
  });
  try {
    const output = await options.provider.complete(options.input);
    await options.budget.settle(reservation.id, options.actualCents(output));
    return output;
  } catch (error) {
    const unknownOutcome =
      error instanceof OpeningProviderError && UNKNOWN_OUTCOME_CODES.has(error.code);
    if (unknownOutcome) {
      await options.budget.markUnknown(reservation.id);
    } else {
      await options.budget.release(options.requestId);
    }
    throw error;
  }
}
