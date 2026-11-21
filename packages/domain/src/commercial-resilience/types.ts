/**
 * Shared types and strict boundary validation helpers for the closed-core
 * commercial-resilience domain engine.
 *
 * Monetary values are represented exclusively in exact BigInt micro-currency
 * units (10^-6 currency units, e.g. 1_000_000n === 1.00 USD/CNY). No
 * floating-point arithmetic is permitted on monetary quantities.
 */

export type MicroCurrency = bigint;
export type CurrencyCode = string;

export const MICROS_PER_UNIT: MicroCurrency = 1_000_000n;
export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;

export type CommercialResilienceErrorCode =
  | "INVALID_MONETARY_AMOUNT"
  | "MISSING_OR_ZERO_COST_ESTIMATE"
  | "INVALID_TIMESTAMP"
  | "INVALID_IDENTIFIER"
  | "INVALID_CURRENCY"
  | "INVALID_COUNT"
  | "INVALID_RATE"
  | "CURRENCY_MISMATCH"
  | "LEDGER_KIND_MISMATCH"
  | "BYOK_PLATFORM_DEBIT_FORBIDDEN"
  | "IDEMPOTENCY_CONFLICT"
  | "DUPLICATE_ENTRY_ID"
  | "INSUFFICIENT_LEARNER_CREDITS"
  | "REFUND_EXCEEDS_CONSUMPTION"
  | "INVALID_REFERENCE_ENTRY"
  | "ESCROW_NOT_MATURED"
  | "ROYALTY_ALREADY_RELEASED"
  | "ROYALTY_NOT_RELEASED"
  | "ROYALTY_CLAWBACK_EXHAUSTED"
  | "RELEASE_ALREADY_SETTLED"
  | "CLAWBACK_ALREADY_SETTLED"
  | "ROYALTY_VOIDED"
  | "ROYALTY_EXCLUDED"
  | "PURCHASE_NOT_FOUND"
  | "SLIDING_OR_INVALID_WEEK_WINDOW"
  | "COHORT_WEEK_NOT_FINALIZED"
  | "COHORT_WEEK_ALREADY_PUBLISHED"
  | "INVALID_COHORT_COUNTS";

export class CommercialResilienceError extends Error {
  readonly code: CommercialResilienceErrorCode;

  constructor(code: CommercialResilienceErrorCode, message: string) {
    super(message);
    this.name = "CommercialResilienceError";
    this.code = code;
  }
}

export function assertNonNegativeMicros(
  value: MicroCurrency,
  field: string,
): MicroCurrency {
  if (typeof value !== "bigint" || value < 0n) {
    throw new CommercialResilienceError(
      "INVALID_MONETARY_AMOUNT",
      `${field} must be a non-negative BigInt micro-currency amount`,
    );
  }
  return value;
}

export function assertPositiveMicros(
  value: MicroCurrency,
  field: string,
): MicroCurrency {
  if (typeof value !== "bigint" || value <= 0n) {
    throw new CommercialResilienceError(
      "INVALID_MONETARY_AMOUNT",
      `${field} must be a positive BigInt micro-currency amount`,
    );
  }
  return value;
}

export function assertSafeTimestampMs(value: number, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new CommercialResilienceError(
      "INVALID_TIMESTAMP",
      `${field} must be a non-negative safe integer UTC millisecond timestamp`,
    );
  }
  return value;
}

export function assertNonNegativeSafeInteger(
  value: number,
  field: string,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new CommercialResilienceError(
      "INVALID_COUNT",
      `${field} must be a non-negative safe integer`,
    );
  }
  return value;
}

export function assertUnitIntervalRate(value: number, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new CommercialResilienceError(
      "INVALID_RATE",
      `${field} must be a finite number in [0, 1]`,
    );
  }
  return value;
}

export function normalizeIdentifier(value: string, field: string): string {
  if (typeof value !== "string") {
    throw new CommercialResilienceError(
      "INVALID_IDENTIFIER",
      `${field} must be a non-empty string`,
    );
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new CommercialResilienceError(
      "INVALID_IDENTIFIER",
      `${field} must not be empty or whitespace`,
    );
  }
  return trimmed;
}

export function normalizeCurrency(value: CurrencyCode, field = "currency"): CurrencyCode {
  if (typeof value !== "string") {
    throw new CommercialResilienceError(
      "INVALID_CURRENCY",
      `${field} must be a valid currency code`,
    );
  }
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new CommercialResilienceError(
      "INVALID_CURRENCY",
      `${field} must be a 3-letter ISO currency code`,
    );
  }
  return normalized;
}
