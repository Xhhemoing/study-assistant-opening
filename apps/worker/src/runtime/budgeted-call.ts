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
 * Only known pre-generation failures release; malformed responses may be billed.
 */
const UNSENT_CODES = new Set(["PROVIDER_AUTH", "PROVIDER_RATE_LIMIT", "PROVIDER_MEDIA_UNSUPPORTED"]);

export async function runBudgetedCall(options: BudgetedCallOptions): Promise<ProviderOutput> {
  if (!options.provider) {
    throw new BudgetedCallError("PROVIDER_DISABLED", "opening provider is disabled");
  }
  const reservation = await options.budget.reserve({
    purpose: "tutor",
    amountCents: options.reservedCents,
    requestId: options.requestId,
  });
  let output: ProviderOutput;
  try {
    output = await options.provider.complete(options.input);
  } catch (error) {
    if (error instanceof OpeningProviderError && UNSENT_CODES.has(error.code)) {
      await options.budget.release(options.requestId);
    } else {
      await options.budget.markUnknown(reservation.id);
    }
    throw error;
  }
  // Missing usage is not a zero-cost call. Keep the pessimistic reservation.
  if (output.inputTokens === null || output.outputTokens === null) {
    await options.budget.markUnknown(reservation.id);
  } else {
    // Settlement failures must leave the reservation intact, never release it.
    await options.budget.settle(reservation.id, options.actualCents(output));
  }
  return output;
}
