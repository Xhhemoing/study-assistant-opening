/**
 * Micro-unit three-ledger accounting & creator royalty settlement engine.
 *
 * Strictly separates three independent append-only ledgers:
 *   1. ProviderCostLedger   (`provider_cost_entry`)  — supplier cost & BYOK isolation
 *   2. LearnerCreditLedger  (`learner_credit_entry`) — grants, consumptions, refunds/reversals (>= 0n balance)
 *   3. CreatorRoyaltyLedger (`creator_royalty_entry`) — T+14d escrow, self/related-party exclusion, 70% vs 73.5% quality share
 *
 * All monetary amounts use exact BigInt micro-currency units (10^-6).
 */

import {
  assertNonNegativeMicros,
  assertNonNegativeSafeInteger,
  assertPositiveMicros,
  assertSafeTimestampMs,
  assertUnitIntervalRate,
  CommercialResilienceError,
  DAY_MS,
  normalizeCurrency,
  normalizeIdentifier,
  type CurrencyCode,
  type MicroCurrency,
} from "./types";

export const ROYALTY_ESCROW_DAYS = 14;
export const ROYALTY_ESCROW_WINDOW_MS = ROYALTY_ESCROW_DAYS * DAY_MS;

export const ROYALTY_BASE_RATE_PERMILLE = 700n;
export const ROYALTY_QUALITY_RATE_PERMILLE = 735n; // 70% * 1.05 = 73.5%
export const ROYALTY_RATE_DENOMINATOR = 1000n;

export const MIN_QUALITY_COHORT_SIZE = 30;
export const MIN_BLIND_SEVEN_DAY_TRANSFER_RATE = 0.6;

/* ============================================================================
 * 1. Provider Cost Ledger (`provider_cost_entry`)
 * ========================================================================== */

export type ProviderFundingSource = "platform" | "byok";

export interface ProviderCostEntry {
  readonly ledgerKind: "provider_cost_entry";
  readonly entryId: string;
  readonly idempotencyKey: string;
  readonly accountId: string;
  readonly requestId: string;
  readonly provider: string;
  readonly sku: string;
  readonly fundingSource: ProviderFundingSource;
  readonly currency: CurrencyCode;
  readonly supplierCostMicros: MicroCurrency;
  /** Strictly 0n for BYOK entries; equals supplierCostMicros for platform-funded calls. */
  readonly platformCostMicros: MicroCurrency;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly recordedAtMs: number;
  readonly canMintCreatorRoyalty: false;
}

export interface CreateProviderCostEntryInput {
  readonly entryId: string;
  readonly idempotencyKey: string;
  readonly accountId: string;
  readonly requestId: string;
  readonly provider: string;
  readonly sku: string;
  readonly fundingSource: ProviderFundingSource;
  readonly currency: CurrencyCode;
  readonly supplierCostMicros: MicroCurrency;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number;
  readonly recordedAtMs: number;
}

export interface ProviderCostLedger {
  readonly ledgerKind: "provider_cost_entry";
  readonly entries: ReadonlyArray<ProviderCostEntry>;
}

export interface AppendLedgerResult<TLedger, TEntry> {
  readonly ledger: TLedger;
  readonly entry: TEntry;
  readonly idempotentReplay: boolean;
}

export interface ProviderCostSummary {
  readonly currency: CurrencyCode;
  readonly totalPlatformCostMicros: MicroCurrency;
  readonly totalByokObservedCostMicros: MicroCurrency;
  readonly platformEntryCount: number;
  readonly byokEntryCount: number;
}

export function createProviderCostLedger(): ProviderCostLedger {
  return {
    ledgerKind: "provider_cost_entry",
    entries: [],
  };
}

export function createProviderCostEntry(
  input: CreateProviderCostEntryInput,
): ProviderCostEntry {
  const entryId = normalizeIdentifier(input.entryId, "entryId");
  const idempotencyKey = normalizeIdentifier(
    input.idempotencyKey,
    "idempotencyKey",
  );
  const accountId = normalizeIdentifier(input.accountId, "accountId");
  const requestId = normalizeIdentifier(input.requestId, "requestId");
  const provider = normalizeIdentifier(input.provider, "provider");
  const sku = normalizeIdentifier(input.sku, "sku");
  const currency = normalizeCurrency(input.currency);
  const supplierCostMicros = assertNonNegativeMicros(
    input.supplierCostMicros,
    "supplierCostMicros",
  );
  const inputTokens = assertNonNegativeSafeInteger(
    input.inputTokens,
    "inputTokens",
  );
  const outputTokens = assertNonNegativeSafeInteger(
    input.outputTokens,
    "outputTokens",
  );
  const cachedInputTokens = assertNonNegativeSafeInteger(
    input.cachedInputTokens ?? 0,
    "cachedInputTokens",
  );
  const recordedAtMs = assertSafeTimestampMs(
    input.recordedAtMs,
    "recordedAtMs",
  );

  // BYOK invariant: user-funded provider calls NEVER debit platform cost.
  const platformCostMicros =
    input.fundingSource === "byok" ? 0n : supplierCostMicros;

  return {
    ledgerKind: "provider_cost_entry",
    entryId,
    idempotencyKey,
    accountId,
    requestId,
    provider,
    sku,
    fundingSource: input.fundingSource,
    currency,
    supplierCostMicros,
    platformCostMicros,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    recordedAtMs,
    canMintCreatorRoyalty: false,
  };
}

function providerEntriesEqual(a: ProviderCostEntry, b: ProviderCostEntry): boolean {
  return (
    a.entryId === b.entryId &&
    a.idempotencyKey === b.idempotencyKey &&
    a.accountId === b.accountId &&
    a.requestId === b.requestId &&
    a.provider === b.provider &&
    a.sku === b.sku &&
    a.fundingSource === b.fundingSource &&
    a.currency === b.currency &&
    a.supplierCostMicros === b.supplierCostMicros &&
    a.platformCostMicros === b.platformCostMicros &&
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.cachedInputTokens === b.cachedInputTokens &&
    a.recordedAtMs === b.recordedAtMs
  );
}

export function appendProviderCostEntry(
  ledger: ProviderCostLedger,
  entry: ProviderCostEntry,
): AppendLedgerResult<ProviderCostLedger, ProviderCostEntry> {
  if (entry.ledgerKind !== "provider_cost_entry") {
    throw new CommercialResilienceError(
      "LEDGER_KIND_MISMATCH",
      "Only provider_cost_entry records may be appended to ProviderCostLedger",
    );
  }
  assertNonNegativeMicros(entry.supplierCostMicros, "supplierCostMicros");
  assertNonNegativeMicros(entry.platformCostMicros, "platformCostMicros");

  if (entry.fundingSource === "byok" && entry.platformCostMicros !== 0n) {
    throw new CommercialResilienceError(
      "BYOK_PLATFORM_DEBIT_FORBIDDEN",
      "BYOK provider_cost_entry must record platformCostMicros === 0n",
    );
  }
  if (
    entry.fundingSource === "platform" &&
    entry.platformCostMicros !== entry.supplierCostMicros
  ) {
    throw new CommercialResilienceError(
      "INVALID_MONETARY_AMOUNT",
      "Platform provider_cost_entry must have platformCostMicros === supplierCostMicros",
    );
  }

  for (const existing of ledger.entries) {
    if (existing.idempotencyKey === entry.idempotencyKey) {
      if (providerEntriesEqual(existing, entry)) {
        return { ledger, entry: existing, idempotentReplay: true };
      }
      throw new CommercialResilienceError(
        "IDEMPOTENCY_CONFLICT",
        `Conflicting provider_cost_entry for idempotencyKey "${entry.idempotencyKey}"`,
      );
    }
    if (existing.entryId === entry.entryId) {
      throw new CommercialResilienceError(
        "DUPLICATE_ENTRY_ID",
        `Duplicate provider_cost_entry entryId "${entry.entryId}"`,
      );
    }
  }

  return {
    ledger: {
      ledgerKind: "provider_cost_entry",
      entries: [...ledger.entries, entry],
    },
    entry,
    idempotentReplay: false,
  };
}

export function summarizeProviderCostLedger(
  ledger: ProviderCostLedger,
  options: {
    readonly currency: CurrencyCode;
    readonly accountId?: string;
  },
): ProviderCostSummary {
  const currency = normalizeCurrency(options.currency);
  const accountFilter =
    options.accountId === undefined
      ? null
      : normalizeIdentifier(options.accountId, "accountId");

  let totalPlatformCostMicros = 0n;
  let totalByokObservedCostMicros = 0n;
  let platformEntryCount = 0;
  let byokEntryCount = 0;

  for (const entry of ledger.entries) {
    if (accountFilter !== null && entry.accountId !== accountFilter) {
      continue;
    }
    if (entry.currency !== currency) {
      throw new CommercialResilienceError(
        "CURRENCY_MISMATCH",
        `Provider cost entry "${entry.entryId}" has currency "${entry.currency}", expected "${currency}"`,
      );
    }
    if (entry.fundingSource === "byok") {
      if (entry.platformCostMicros !== 0n) {
        throw new CommercialResilienceError(
          "BYOK_PLATFORM_DEBIT_FORBIDDEN",
          `BYOK entry "${entry.entryId}" illegally carries non-zero platformCostMicros`,
        );
      }
      totalByokObservedCostMicros += entry.supplierCostMicros;
      byokEntryCount += 1;
    } else {
      totalPlatformCostMicros += entry.platformCostMicros;
      platformEntryCount += 1;
    }
  }

  return {
    currency,
    totalPlatformCostMicros,
    totalByokObservedCostMicros,
    platformEntryCount,
    byokEntryCount,
  };
}

/* ============================================================================
 * 2. Learner Credit Ledger (`learner_credit_entry`)
 * ========================================================================== */

export type LearnerCreditOperation =
  | "grant"
  | "consumption"
  | "refund"
  | "reversal";

export interface LearnerCreditEntry {
  readonly ledgerKind: "learner_credit_entry";
  readonly entryId: string;
  readonly idempotencyKey: string;
  readonly accountId: string;
  readonly currency: CurrencyCode;
  readonly operation: LearnerCreditOperation;
  readonly amountMicros: MicroCurrency;
  /** Signed delta applied to learner balance: positive for grant/refund, negative for consumption/reversal. */
  readonly signedDeltaMicros: bigint;
  readonly referenceEntryId: string | null;
  readonly recordedAtMs: number;
}

export type CreateLearnerCreditEntryInput =
  | {
      readonly entryId: string;
      readonly idempotencyKey: string;
      readonly accountId: string;
      readonly currency: CurrencyCode;
      readonly operation: "grant" | "consumption";
      readonly amountMicros: MicroCurrency;
      readonly referenceEntryId?: string | null;
      readonly recordedAtMs: number;
    }
  | {
      readonly entryId: string;
      readonly idempotencyKey: string;
      readonly accountId: string;
      readonly currency: CurrencyCode;
      readonly operation: "refund" | "reversal";
      readonly amountMicros: MicroCurrency;
      readonly referenceEntryId: string;
      readonly recordedAtMs: number;
    };

export interface LearnerCreditLedger {
  readonly ledgerKind: "learner_credit_entry";
  readonly entries: ReadonlyArray<LearnerCreditEntry>;
}

export function createLearnerCreditLedger(): LearnerCreditLedger {
  return {
    ledgerKind: "learner_credit_entry",
    entries: [],
  };
}

export function createLearnerCreditEntry(
  input: CreateLearnerCreditEntryInput,
): LearnerCreditEntry {
  const entryId = normalizeIdentifier(input.entryId, "entryId");
  const idempotencyKey = normalizeIdentifier(
    input.idempotencyKey,
    "idempotencyKey",
  );
  const accountId = normalizeIdentifier(input.accountId, "accountId");
  const currency = normalizeCurrency(input.currency);
  const amountMicros = assertPositiveMicros(input.amountMicros, "amountMicros");
  const recordedAtMs = assertSafeTimestampMs(
    input.recordedAtMs,
    "recordedAtMs",
  );

  let referenceEntryId: string | null;
  if (input.operation === "refund" || input.operation === "reversal") {
    if (
      typeof input.referenceEntryId !== "string" ||
      input.referenceEntryId.trim().length === 0
    ) {
      throw new CommercialResilienceError(
        "INVALID_REFERENCE_ENTRY",
        `Operation "${input.operation}" requires a non-empty backing referenceEntryId`,
      );
    }
    referenceEntryId = input.referenceEntryId.trim();
  } else {
    referenceEntryId =
      input.referenceEntryId == null
        ? null
        : normalizeIdentifier(input.referenceEntryId, "referenceEntryId");
  }

  const signedDeltaMicros =
    input.operation === "grant" || input.operation === "refund"
      ? amountMicros
      : -amountMicros;

  return {
    ledgerKind: "learner_credit_entry",
    entryId,
    idempotencyKey,
    accountId,
    currency,
    operation: input.operation,
    amountMicros,
    signedDeltaMicros,
    referenceEntryId,
    recordedAtMs,
  };
}

function learnerEntriesEqual(
  a: LearnerCreditEntry,
  b: LearnerCreditEntry,
): boolean {
  return (
    a.entryId === b.entryId &&
    a.idempotencyKey === b.idempotencyKey &&
    a.accountId === b.accountId &&
    a.currency === b.currency &&
    a.operation === b.operation &&
    a.amountMicros === b.amountMicros &&
    a.signedDeltaMicros === b.signedDeltaMicros &&
    a.referenceEntryId === b.referenceEntryId &&
    a.recordedAtMs === b.recordedAtMs
  );
}

export function getLearnerCreditBalance(
  ledger: LearnerCreditLedger,
  accountId: string,
  currency: CurrencyCode,
): MicroCurrency {
  const normalizedAccountId = normalizeIdentifier(accountId, "accountId");
  const normalizedCurrency = normalizeCurrency(currency);

  let balance = 0n;
  for (const entry of ledger.entries) {
    if (entry.accountId !== normalizedAccountId) {
      continue;
    }
    if (entry.currency !== normalizedCurrency) {
      throw new CommercialResilienceError(
        "CURRENCY_MISMATCH",
        `Account "${normalizedAccountId}" has entry in "${entry.currency}", expected "${normalizedCurrency}"`,
      );
    }
    balance += entry.signedDeltaMicros;
    if (balance < 0n) {
      throw new CommercialResilienceError(
        "INSUFFICIENT_LEARNER_CREDITS",
        `Learner credit balance invariant violated (< 0n) at entry "${entry.entryId}"`,
      );
    }
  }
  return balance;
}

export function appendLearnerCreditEntry(
  ledger: LearnerCreditLedger,
  entry: LearnerCreditEntry,
): AppendLedgerResult<LearnerCreditLedger, LearnerCreditEntry> {
  if (entry.ledgerKind !== "learner_credit_entry") {
    throw new CommercialResilienceError(
      "LEDGER_KIND_MISMATCH",
      "Only learner_credit_entry records may be appended to LearnerCreditLedger",
    );
  }
  assertPositiveMicros(entry.amountMicros, "amountMicros");

  const expectedSigned =
    entry.operation === "grant" || entry.operation === "refund"
      ? entry.amountMicros
      : -entry.amountMicros;
  if (entry.signedDeltaMicros !== expectedSigned) {
    throw new CommercialResilienceError(
      "INVALID_MONETARY_AMOUNT",
      `signedDeltaMicros does not match operation "${entry.operation}"`,
    );
  }

  // Fail-closed: refund and reversal entries MUST always carry a canonical non-empty backing referenceEntryId.
  let requiredRefId: string | null = null;
  if (entry.operation === "refund" || entry.operation === "reversal") {
    if (
      typeof entry.referenceEntryId !== "string" ||
      entry.referenceEntryId.trim().length === 0 ||
      entry.referenceEntryId.trim() !== entry.referenceEntryId
    ) {
      throw new CommercialResilienceError(
        "INVALID_REFERENCE_ENTRY",
        `Operation "${entry.operation}" requires a canonical non-empty backing referenceEntryId`,
      );
    }
    requiredRefId = entry.referenceEntryId;
  }

  for (const existing of ledger.entries) {
    if (existing.idempotencyKey === entry.idempotencyKey) {
      if (learnerEntriesEqual(existing, entry)) {
        return { ledger, entry: existing, idempotentReplay: true };
      }
      throw new CommercialResilienceError(
        "IDEMPOTENCY_CONFLICT",
        `Conflicting learner_credit_entry for idempotencyKey "${entry.idempotencyKey}"`,
      );
    }
    if (existing.entryId === entry.entryId) {
      throw new CommercialResilienceError(
        "DUPLICATE_ENTRY_ID",
        `Duplicate learner_credit_entry entryId "${entry.entryId}"`,
      );
    }
  }

  // Validate required reference linkage when refunding a consumption or reversing a grant.
  if (entry.operation === "refund" && requiredRefId !== null) {
    const target = ledger.entries.find(
      (item) =>
        item.entryId === requiredRefId &&
        item.accountId === entry.accountId &&
        item.currency === entry.currency,
    );
    if (!target || target.operation !== "consumption") {
      throw new CommercialResilienceError(
        "INVALID_REFERENCE_ENTRY",
        `Refund reference "${requiredRefId}" must refer to a prior consumption entry for the same account`,
      );
    }
    let refundedSoFar = 0n;
    for (const item of ledger.entries) {
      if (
        item.operation === "refund" &&
        item.accountId === entry.accountId &&
        item.referenceEntryId === target.entryId
      ) {
        refundedSoFar += item.amountMicros;
      }
    }
    if (refundedSoFar + entry.amountMicros > target.amountMicros) {
      throw new CommercialResilienceError(
        "REFUND_EXCEEDS_CONSUMPTION",
        `Cumulative refund exceeds original consumption amount for "${target.entryId}"`,
      );
    }
  }

  if (entry.operation === "reversal" && requiredRefId !== null) {
    const target = ledger.entries.find(
      (item) =>
        item.entryId === requiredRefId &&
        item.accountId === entry.accountId &&
        item.currency === entry.currency,
    );
    if (!target || target.operation !== "grant") {
      throw new CommercialResilienceError(
        "INVALID_REFERENCE_ENTRY",
        `Reversal reference "${requiredRefId}" must refer to a prior grant entry for the same account`,
      );
    }
    let reversedSoFar = 0n;
    for (const item of ledger.entries) {
      if (
        item.operation === "reversal" &&
        item.accountId === entry.accountId &&
        item.referenceEntryId === target.entryId
      ) {
        reversedSoFar += item.amountMicros;
      }
    }
    if (reversedSoFar + entry.amountMicros > target.amountMicros) {
      throw new CommercialResilienceError(
        "REFUND_EXCEEDS_CONSUMPTION",
        `Cumulative reversal exceeds original grant amount for "${target.entryId}"`,
      );
    }
  }

  const currentBalance = getLearnerCreditBalance(
    ledger,
    entry.accountId,
    entry.currency,
  );
  const nextBalance = currentBalance + entry.signedDeltaMicros;
  if (nextBalance < 0n) {
    throw new CommercialResilienceError(
      "INSUFFICIENT_LEARNER_CREDITS",
      `Operation "${entry.operation}" of ${entry.amountMicros.toString()} micros would drive balance below 0n`,
    );
  }

  return {
    ledger: {
      ledgerKind: "learner_credit_entry",
      entries: [...ledger.entries, entry],
    },
    entry,
    idempotentReplay: false,
  };
}

/* ============================================================================
 * 3. Creator Royalty Ledger (`creator_royalty_entry`)
 * ========================================================================== */

export type CreatorRoyaltyExclusionReason =
  | "self_or_related_party"
  | "byok_excluded";

export type CreatorRoyaltyStatus =
  | "pending_escrow"
  | "released"
  | "partially_clawed_back"
  | "clawed_back"
  | "voided"
  | "excluded";

export type CreatorRoyaltyEventType =
  | "accrual"
  | "escrow_refund_adjustment"
  | "escrow_release"
  | "post_release_clawback";

export interface TransferQualityMetrics {
  readonly eligibleCohortSize: number;
  readonly blindSevenDayTransferRate: number;
  readonly severeLeakCount: number;
}

export interface CreatorRoyaltyCalculationInput {
  readonly buyerAccountId: string;
  readonly creatorAccountId: string;
  readonly isRelatedParty?: boolean;
  readonly relatedPartyAccountIds?: ReadonlyArray<string>;
  readonly fundingSource?: "platform_purchase" | "byok";
  readonly grossReceiptsMicros: MicroCurrency;
  readonly channelFeeMicros: MicroCurrency;
  readonly refundsMicros: MicroCurrency;
  readonly quality: TransferQualityMetrics;
}

export interface CreatorRoyaltyCalculation {
  readonly netReceiptsMicros: MicroCurrency;
  readonly ratePermille: bigint;
  readonly qualityMultiplierApplied: boolean;
  readonly royaltyMicros: MicroCurrency;
  readonly excludedReason: CreatorRoyaltyExclusionReason | null;
}

export interface CreatorRoyaltyEntry {
  readonly ledgerKind: "creator_royalty_entry";
  readonly entryId: string;
  readonly idempotencyKey: string;
  readonly purchaseId: string;
  readonly creatorAccountId: string;
  readonly buyerAccountId: string;
  readonly cartridgeId: string;
  readonly currency: CurrencyCode;
  readonly eventType: CreatorRoyaltyEventType;
  readonly referenceEntryId: string | null;
  readonly statusAfterEvent: CreatorRoyaltyStatus;
  readonly excludedReason: CreatorRoyaltyExclusionReason | null;
  readonly settledPurchaseAtMs: number;
  readonly escrowReleaseAtMs: number;
  readonly recordedAtMs: number;
  readonly grossReceiptsMicros: MicroCurrency;
  readonly channelFeeMicros: MicroCurrency;
  readonly eventRefundMicros: MicroCurrency;
  readonly cumulativeRefundsMicros: MicroCurrency;
  readonly netReceiptsMicros: MicroCurrency;
  readonly ratePermille: bigint;
  readonly qualityMultiplierApplied: boolean;
  /** Signed delta on escrowed/payable royalty amount in micro-units. */
  readonly deltaRoyaltyMicros: bigint;
  /** Resulting accrued/escrowed/released royalty amount after this append-only event. */
  readonly resultingRoyaltyMicros: MicroCurrency;
}

export interface CreatorRoyaltyAccrualInput {
  readonly entryId: string;
  readonly idempotencyKey: string;
  readonly purchaseId: string;
  readonly creatorAccountId: string;
  readonly buyerAccountId: string;
  readonly cartridgeId: string;
  readonly currency: CurrencyCode;
  readonly settledPurchaseAtMs: number;
  readonly isRelatedParty?: boolean;
  readonly relatedPartyAccountIds?: ReadonlyArray<string>;
  readonly fundingSource?: "platform_purchase" | "byok";
  readonly grossReceiptsMicros: MicroCurrency;
  readonly channelFeeMicros: MicroCurrency;
  readonly refundsMicros?: MicroCurrency;
  readonly quality: TransferQualityMetrics;
}

export interface CreatorRoyaltyRefundInput {
  readonly entryId: string;
  readonly idempotencyKey: string;
  readonly purchaseId: string;
  readonly additionalRefundMicros: MicroCurrency;
  readonly refundOccurredAtMs: number;
  /** Optional ledger booking timestamp (e.g. delayed webhook arrival >= release.recordedAtMs). */
  readonly recordedAtMs?: number;
}

export type PostReleaseRoyaltyClawbackInput = CreatorRoyaltyRefundInput;

export interface CreatorRoyaltyReleaseInput {
  readonly entryId: string;
  readonly idempotencyKey: string;
  readonly purchaseId: string;
  readonly nowMs: number;
}

export interface CreatorRoyaltyLedger {
  readonly ledgerKind: "creator_royalty_entry";
  readonly entries: ReadonlyArray<CreatorRoyaltyEntry>;
}

export interface CreatorRoyaltyPosition {
  readonly purchaseId: string;
  readonly creatorAccountId: string;
  readonly buyerAccountId: string;
  readonly cartridgeId: string;
  readonly currency: CurrencyCode;
  readonly status: CreatorRoyaltyStatus;
  readonly excludedReason: CreatorRoyaltyExclusionReason | null;
  readonly settledPurchaseAtMs: number;
  readonly escrowReleaseAtMs: number;
  readonly escrowMaturedAtEvaluation: boolean;
  readonly remainingEscrowMs: number;
  readonly grossReceiptsMicros: MicroCurrency;
  readonly channelFeeMicros: MicroCurrency;
  readonly cumulativeRefundsMicros: MicroCurrency;
  readonly netReceiptsMicros: MicroCurrency;
  readonly ratePermille: bigint;
  readonly qualityMultiplierApplied: boolean;
  readonly royaltyMicros: MicroCurrency;
  readonly releasableMicros: MicroCurrency;
  readonly releasedEntryId: string | null;
  readonly releasedMicros: MicroCurrency;
  /** Cumulative post-release clawback magnitude (>= 0n, capped at releasedMicros). */
  readonly clawedBackMicros: MicroCurrency;
  /** Net settled royalty after post-release clawbacks (releasedMicros - clawedBackMicros >= 0n). */
  readonly netSettledMicros: MicroCurrency;
  /** Signed payable balance offset (<= 0n) owed back against future payouts. */
  readonly payableOffsetMicros: bigint;
}

export interface CreatorRoyaltyPayableSummary {
  readonly creatorAccountId: string;
  readonly currency: CurrencyCode;
  readonly pendingEscrowMicros: MicroCurrency;
  readonly maturedReleasableMicros: MicroCurrency;
  readonly grossReleasedMicros: MicroCurrency;
  readonly postReleaseClawbackMicros: MicroCurrency;
  /** Signed net payout balance: maturedReleasableMicros - postReleaseClawbackMicros. */
  readonly netPayableMicros: bigint;
  /** Lifetime net settled creator earnings: grossReleasedMicros - postReleaseClawbackMicros (>= 0n). */
  readonly netSettledLifetimeMicros: MicroCurrency;
}

export function createCreatorRoyaltyLedger(): CreatorRoyaltyLedger {
  return {
    ledgerKind: "creator_royalty_entry",
    entries: [],
  };
}

export function qualifiesForTransferQualityMultiplier(
  quality: TransferQualityMetrics,
): boolean {
  const cohortSize = assertNonNegativeSafeInteger(
    quality.eligibleCohortSize,
    "quality.eligibleCohortSize",
  );
  const transferRate = assertUnitIntervalRate(
    quality.blindSevenDayTransferRate,
    "quality.blindSevenDayTransferRate",
  );
  const severeLeakCount = assertNonNegativeSafeInteger(
    quality.severeLeakCount,
    "quality.severeLeakCount",
  );

  return (
    cohortSize >= MIN_QUALITY_COHORT_SIZE &&
    transferRate >= MIN_BLIND_SEVEN_DAY_TRANSFER_RATE &&
    severeLeakCount === 0
  );
}

/**
 * Computes exact net content receipts, related-party/BYOK exclusion, and
 * base (70%) vs verified quality multiplier (73.5% = 1.05x) creator royalty.
 */
export function calculateCreatorRoyalty(
  input: CreatorRoyaltyCalculationInput,
): CreatorRoyaltyCalculation {
  const buyerAccountId = normalizeIdentifier(
    input.buyerAccountId,
    "buyerAccountId",
  );
  const creatorAccountId = normalizeIdentifier(
    input.creatorAccountId,
    "creatorAccountId",
  );
  const grossReceiptsMicros = assertNonNegativeMicros(
    input.grossReceiptsMicros,
    "grossReceiptsMicros",
  );
  const channelFeeMicros = assertNonNegativeMicros(
    input.channelFeeMicros,
    "channelFeeMicros",
  );
  const refundsMicros = assertNonNegativeMicros(
    input.refundsMicros,
    "refundsMicros",
  );

  // Validate quality inputs eagerly even when excluded, so malformed metrics fail closed.
  const qualityMultiplierEligible = qualifiesForTransferQualityMultiplier(
    input.quality,
  );

  const rawNet = grossReceiptsMicros - channelFeeMicros - refundsMicros;
  const netReceiptsMicros = rawNet > 0n ? rawNet : 0n;

  if (input.fundingSource === "byok") {
    return {
      netReceiptsMicros,
      ratePermille: 0n,
      qualityMultiplierApplied: false,
      royaltyMicros: 0n,
      excludedReason: "byok_excluded",
    };
  }

  const normalizedRelated = new Set(
    (input.relatedPartyAccountIds ?? []).map((id, idx) =>
      normalizeIdentifier(id, `relatedPartyAccountIds[${idx}]`),
    ),
  );
  const isSelfOrRelated =
    buyerAccountId === creatorAccountId ||
    input.isRelatedParty === true ||
    normalizedRelated.has(buyerAccountId);

  if (isSelfOrRelated) {
    return {
      netReceiptsMicros,
      ratePermille: 0n,
      qualityMultiplierApplied: false,
      royaltyMicros: 0n,
      excludedReason: "self_or_related_party",
    };
  }

  const ratePermille = qualityMultiplierEligible
    ? ROYALTY_QUALITY_RATE_PERMILLE
    : ROYALTY_BASE_RATE_PERMILLE;
  const royaltyMicros =
    (ratePermille * netReceiptsMicros) / ROYALTY_RATE_DENOMINATOR;

  return {
    netReceiptsMicros,
    ratePermille,
    qualityMultiplierApplied: qualityMultiplierEligible,
    royaltyMicros,
    excludedReason: null,
  };
}

function royaltyEntriesEqual(
  a: CreatorRoyaltyEntry,
  b: CreatorRoyaltyEntry,
): boolean {
  return (
    a.entryId === b.entryId &&
    a.idempotencyKey === b.idempotencyKey &&
    a.purchaseId === b.purchaseId &&
    a.creatorAccountId === b.creatorAccountId &&
    a.buyerAccountId === b.buyerAccountId &&
    a.cartridgeId === b.cartridgeId &&
    a.currency === b.currency &&
    a.eventType === b.eventType &&
    a.referenceEntryId === b.referenceEntryId &&
    a.statusAfterEvent === b.statusAfterEvent &&
    a.excludedReason === b.excludedReason &&
    a.settledPurchaseAtMs === b.settledPurchaseAtMs &&
    a.escrowReleaseAtMs === b.escrowReleaseAtMs &&
    a.recordedAtMs === b.recordedAtMs &&
    a.grossReceiptsMicros === b.grossReceiptsMicros &&
    a.channelFeeMicros === b.channelFeeMicros &&
    a.eventRefundMicros === b.eventRefundMicros &&
    a.cumulativeRefundsMicros === b.cumulativeRefundsMicros &&
    a.netReceiptsMicros === b.netReceiptsMicros &&
    a.ratePermille === b.ratePermille &&
    a.qualityMultiplierApplied === b.qualityMultiplierApplied &&
    a.deltaRoyaltyMicros === b.deltaRoyaltyMicros &&
    a.resultingRoyaltyMicros === b.resultingRoyaltyMicros
  );
}

function appendValidatedRoyaltyEntry(
  ledger: CreatorRoyaltyLedger,
  entry: CreatorRoyaltyEntry,
): AppendLedgerResult<CreatorRoyaltyLedger, CreatorRoyaltyEntry> {
  if (entry.ledgerKind !== "creator_royalty_entry") {
    throw new CommercialResilienceError(
      "LEDGER_KIND_MISMATCH",
      "Only creator_royalty_entry records may be appended to CreatorRoyaltyLedger",
    );
  }
  for (const existing of ledger.entries) {
    if (existing.idempotencyKey === entry.idempotencyKey) {
      if (royaltyEntriesEqual(existing, entry)) {
        return { ledger, entry: existing, idempotentReplay: true };
      }
      throw new CommercialResilienceError(
        "IDEMPOTENCY_CONFLICT",
        `Conflicting creator_royalty_entry for idempotencyKey "${entry.idempotencyKey}"`,
      );
    }
    if (existing.entryId === entry.entryId) {
      throw new CommercialResilienceError(
        "DUPLICATE_ENTRY_ID",
        `Duplicate creator_royalty_entry entryId "${entry.entryId}"`,
      );
    }
  }
  return {
    ledger: {
      ledgerKind: "creator_royalty_entry",
      entries: [...ledger.entries, entry],
    },
    entry,
    idempotentReplay: false,
  };
}

/**
 * Appends an initial creator royalty accrual in `pending_escrow` (locked for
 * T + 14 days), `excluded` (self/related-party or BYOK), or `voided` (0n net).
 */
export function appendCreatorRoyaltyAccrual(
  ledger: CreatorRoyaltyLedger,
  input: CreatorRoyaltyAccrualInput,
): AppendLedgerResult<CreatorRoyaltyLedger, CreatorRoyaltyEntry> {
  const entryId = normalizeIdentifier(input.entryId, "entryId");
  const idempotencyKey = normalizeIdentifier(
    input.idempotencyKey,
    "idempotencyKey",
  );
  const purchaseId = normalizeIdentifier(input.purchaseId, "purchaseId");
  const creatorAccountId = normalizeIdentifier(
    input.creatorAccountId,
    "creatorAccountId",
  );
  const buyerAccountId = normalizeIdentifier(
    input.buyerAccountId,
    "buyerAccountId",
  );
  const cartridgeId = normalizeIdentifier(input.cartridgeId, "cartridgeId");
  const currency = normalizeCurrency(input.currency);
  const settledPurchaseAtMs = assertSafeTimestampMs(
    input.settledPurchaseAtMs,
    "settledPurchaseAtMs",
  );
  const grossReceiptsMicros = assertNonNegativeMicros(
    input.grossReceiptsMicros,
    "grossReceiptsMicros",
  );
  const channelFeeMicros = assertNonNegativeMicros(
    input.channelFeeMicros,
    "channelFeeMicros",
  );
  const refundsMicros = assertNonNegativeMicros(
    input.refundsMicros ?? 0n,
    "refundsMicros",
  );

  const calculation = calculateCreatorRoyalty({
    buyerAccountId,
    creatorAccountId,
    isRelatedParty: input.isRelatedParty,
    relatedPartyAccountIds: input.relatedPartyAccountIds,
    fundingSource: input.fundingSource,
    grossReceiptsMicros,
    channelFeeMicros,
    refundsMicros,
    quality: input.quality,
  });

  const statusAfterEvent: CreatorRoyaltyStatus =
    calculation.excludedReason !== null
      ? "excluded"
      : calculation.royaltyMicros === 0n
        ? "voided"
        : "pending_escrow";

  const entry: CreatorRoyaltyEntry = {
    ledgerKind: "creator_royalty_entry",
    entryId,
    idempotencyKey,
    purchaseId,
    creatorAccountId,
    buyerAccountId,
    cartridgeId,
    currency,
    eventType: "accrual",
    referenceEntryId: null,
    statusAfterEvent,
    excludedReason: calculation.excludedReason,
    settledPurchaseAtMs,
    escrowReleaseAtMs: settledPurchaseAtMs + ROYALTY_ESCROW_WINDOW_MS,
    recordedAtMs: settledPurchaseAtMs,
    grossReceiptsMicros,
    channelFeeMicros,
    eventRefundMicros: refundsMicros,
    cumulativeRefundsMicros: refundsMicros,
    netReceiptsMicros: calculation.netReceiptsMicros,
    ratePermille: calculation.ratePermille,
    qualityMultiplierApplied: calculation.qualityMultiplierApplied,
    deltaRoyaltyMicros: calculation.royaltyMicros,
    resultingRoyaltyMicros: calculation.royaltyMicros,
  };

  // Check idempotency BEFORE duplicate-purchase accrual check so exact replay succeeds.
  for (const existing of ledger.entries) {
    if (existing.idempotencyKey === idempotencyKey) {
      if (royaltyEntriesEqual(existing, entry)) {
        return { ledger, entry: existing, idempotentReplay: true };
      }
      throw new CommercialResilienceError(
        "IDEMPOTENCY_CONFLICT",
        `Conflicting creator_royalty_entry for idempotencyKey "${idempotencyKey}"`,
      );
    }
  }

  const alreadyAccrued = ledger.entries.some(
    (item) => item.purchaseId === purchaseId && item.eventType === "accrual",
  );
  if (alreadyAccrued) {
    throw new CommercialResilienceError(
      "IDEMPOTENCY_CONFLICT",
      `Purchase "${purchaseId}" already has an accrual entry in CreatorRoyaltyLedger`,
    );
  }

  return appendValidatedRoyaltyEntry(ledger, entry);
}

/**
 * Projects the current append-only state of a purchase's creator royalty at
 * timestamp `nowMs`. Entries remain in `pending_escrow` until
 * `nowMs >= settledPurchaseAtMs + 14 * 86_400_000`.
 */
export function projectCreatorRoyaltyPosition(
  ledger: CreatorRoyaltyLedger,
  purchaseId: string,
  nowMs: number,
): CreatorRoyaltyPosition {
  const normalizedPurchaseId = normalizeIdentifier(purchaseId, "purchaseId");
  const evaluatedAtMs = assertSafeTimestampMs(nowMs, "nowMs");

  const history = ledger.entries.filter(
    (item) => item.purchaseId === normalizedPurchaseId,
  );
  const latest = history[history.length - 1];
  if (!latest) {
    throw new CommercialResilienceError(
      "PURCHASE_NOT_FOUND",
      `No creator royalty entries found for purchase "${normalizedPurchaseId}"`,
    );
  }

  const escrowMatured = evaluatedAtMs >= latest.escrowReleaseAtMs;
  const remainingEscrowMs = escrowMatured
    ? 0
    : latest.escrowReleaseAtMs - evaluatedAtMs;

  const releaseEntry =
    history.find((item) => item.eventType === "escrow_release") ?? null;
  const releasedMicros = releaseEntry ? releaseEntry.resultingRoyaltyMicros : 0n;
  let clawedBackMicros = 0n;
  for (const item of history) {
    if (item.eventType === "post_release_clawback") {
      clawedBackMicros += -item.deltaRoyaltyMicros;
    }
  }
  const netSettledMicros =
    releasedMicros > clawedBackMicros ? releasedMicros - clawedBackMicros : 0n;
  const payableOffsetMicros = -clawedBackMicros;

  const releasableMicros =
    latest.statusAfterEvent === "pending_escrow" && escrowMatured
      ? latest.resultingRoyaltyMicros
      : 0n;

  return {
    purchaseId: latest.purchaseId,
    creatorAccountId: latest.creatorAccountId,
    buyerAccountId: latest.buyerAccountId,
    cartridgeId: latest.cartridgeId,
    currency: latest.currency,
    status: latest.statusAfterEvent,
    excludedReason: latest.excludedReason,
    settledPurchaseAtMs: latest.settledPurchaseAtMs,
    escrowReleaseAtMs: latest.escrowReleaseAtMs,
    escrowMaturedAtEvaluation: escrowMatured,
    remainingEscrowMs,
    grossReceiptsMicros: latest.grossReceiptsMicros,
    channelFeeMicros: latest.channelFeeMicros,
    cumulativeRefundsMicros: latest.cumulativeRefundsMicros,
    netReceiptsMicros: latest.netReceiptsMicros,
    ratePermille: latest.ratePermille,
    qualityMultiplierApplied: latest.qualityMultiplierApplied,
    royaltyMicros: latest.resultingRoyaltyMicros,
    releasableMicros,
    releasedEntryId: releaseEntry ? releaseEntry.entryId : null,
    releasedMicros,
    clawedBackMicros,
    netSettledMicros,
    payableOffsetMicros,
  };
}

/**
 * Appends an immutable `post_release_clawback` offset entry referencing the
 * immutable `escrow_release` entry when a delayed refund/chargeback arrives
 * after escrow release. Cumulatively capped at the originally released royalty
 * amount so net payable balance reflects the exact clawback without ever
 * mutating the released entry or double-clawing back.
 */
export function recordPostReleaseRoyaltyClawback(
  ledger: CreatorRoyaltyLedger,
  input: PostReleaseRoyaltyClawbackInput,
): AppendLedgerResult<CreatorRoyaltyLedger, CreatorRoyaltyEntry> {
  const entryId = normalizeIdentifier(input.entryId, "entryId");
  const idempotencyKey = normalizeIdentifier(
    input.idempotencyKey,
    "idempotencyKey",
  );
  const purchaseId = normalizeIdentifier(input.purchaseId, "purchaseId");
  const additionalRefundMicros = assertPositiveMicros(
    input.additionalRefundMicros,
    "additionalRefundMicros",
  );
  const refundOccurredAtMs = assertSafeTimestampMs(
    input.refundOccurredAtMs,
    "refundOccurredAtMs",
  );
  const explicitRecordedAtMs =
    input.recordedAtMs === undefined
      ? null
      : assertSafeTimestampMs(input.recordedAtMs, "recordedAtMs");

  const releaseEntry =
    ledger.entries.find(
      (item) =>
        item.purchaseId === purchaseId && item.eventType === "escrow_release",
    ) ?? null;

  const expectedRecordedAtMs = releaseEntry
    ? (explicitRecordedAtMs ??
      Math.max(refundOccurredAtMs, releaseEntry.recordedAtMs))
    : explicitRecordedAtMs;

  const existingByKey = ledger.entries.find(
    (item) => item.idempotencyKey === idempotencyKey,
  );
  if (existingByKey) {
    if (
      existingByKey.entryId === entryId &&
      existingByKey.purchaseId === purchaseId &&
      existingByKey.eventType === "post_release_clawback" &&
      existingByKey.eventRefundMicros === additionalRefundMicros &&
      expectedRecordedAtMs !== null &&
      existingByKey.recordedAtMs === expectedRecordedAtMs
    ) {
      return { ledger, entry: existingByKey, idempotentReplay: true };
    }
    throw new CommercialResilienceError(
      "IDEMPOTENCY_CONFLICT",
      `Conflicting creator_royalty_entry for idempotencyKey "${idempotencyKey}"`,
    );
  }

  const current = projectCreatorRoyaltyPosition(
    ledger,
    purchaseId,
    expectedRecordedAtMs ?? refundOccurredAtMs,
  );

  if (refundOccurredAtMs < current.settledPurchaseAtMs) {
    throw new CommercialResilienceError(
      "INVALID_TIMESTAMP",
      "refundOccurredAtMs cannot precede settledPurchaseAtMs",
    );
  }

  if (!releaseEntry) {
    throw new CommercialResilienceError(
      "ROYALTY_NOT_RELEASED",
      `Purchase "${purchaseId}" has no released royalty entry eligible for post-release clawback`,
    );
  }

  const effectiveRecordedAtMs =
    explicitRecordedAtMs ??
    Math.max(refundOccurredAtMs, releaseEntry.recordedAtMs);
  if (effectiveRecordedAtMs < releaseEntry.recordedAtMs) {
    throw new CommercialResilienceError(
      "INVALID_TIMESTAMP",
      "Post-release clawback recordedAtMs cannot precede escrow release timestamp",
    );
  }

  if (
    current.status === "clawed_back" ||
    current.clawedBackMicros >= releaseEntry.resultingRoyaltyMicros ||
    current.royaltyMicros === 0n
  ) {
    throw new CommercialResilienceError(
      "ROYALTY_CLAWBACK_EXHAUSTED",
      `Released royalty for purchase "${purchaseId}" has already been fully clawed back`,
    );
  }

  const cumulativeRefundsMicros =
    current.cumulativeRefundsMicros + additionalRefundMicros;
  const rawNet =
    current.grossReceiptsMicros -
    current.channelFeeMicros -
    cumulativeRefundsMicros;
  const netReceiptsMicros = rawNet > 0n ? rawNet : 0n;
  const targetEarnedRoyaltyMicros =
    (current.ratePermille * netReceiptsMicros) / ROYALTY_RATE_DENOMINATOR;

  const remainingClawbackable =
    releaseEntry.resultingRoyaltyMicros - current.clawedBackMicros;
  const rawClawbackMagnitude =
    current.royaltyMicros > targetEarnedRoyaltyMicros
      ? current.royaltyMicros - targetEarnedRoyaltyMicros
      : 0n;
  const clawbackMagnitude =
    rawClawbackMagnitude > remainingClawbackable
      ? remainingClawbackable
      : rawClawbackMagnitude;
  const resultingRoyaltyMicros = current.royaltyMicros - clawbackMagnitude;
  const statusAfterEvent: CreatorRoyaltyStatus =
    resultingRoyaltyMicros === 0n ? "clawed_back" : "partially_clawed_back";

  const entry: CreatorRoyaltyEntry = {
    ledgerKind: "creator_royalty_entry",
    entryId,
    idempotencyKey,
    purchaseId: current.purchaseId,
    creatorAccountId: current.creatorAccountId,
    buyerAccountId: current.buyerAccountId,
    cartridgeId: current.cartridgeId,
    currency: current.currency,
    eventType: "post_release_clawback",
    referenceEntryId: releaseEntry.entryId,
    statusAfterEvent,
    excludedReason: null,
    settledPurchaseAtMs: current.settledPurchaseAtMs,
    escrowReleaseAtMs: current.escrowReleaseAtMs,
    recordedAtMs: effectiveRecordedAtMs,
    grossReceiptsMicros: current.grossReceiptsMicros,
    channelFeeMicros: current.channelFeeMicros,
    eventRefundMicros: additionalRefundMicros,
    cumulativeRefundsMicros,
    netReceiptsMicros,
    ratePermille: current.ratePermille,
    qualityMultiplierApplied: current.qualityMultiplierApplied,
    deltaRoyaltyMicros: -clawbackMagnitude,
    resultingRoyaltyMicros,
  };

  return appendValidatedRoyaltyEntry(ledger, entry);
}

/**
 * Applies a refund or chargeback against a purchase's creator royalty:
 * - While `pending_escrow`: appends an `escrow_refund_adjustment` pro-rating
 *   or voiding the escrowed entry before release.
 * - After `escrow_release`: preserves the released entry immutably and appends
 *   a `post_release_clawback` payable offset referencing the released entry.
 */
export function appendCreatorRoyaltyRefund(
  ledger: CreatorRoyaltyLedger,
  input: CreatorRoyaltyRefundInput,
): AppendLedgerResult<CreatorRoyaltyLedger, CreatorRoyaltyEntry> {
  const entryId = normalizeIdentifier(input.entryId, "entryId");
  const idempotencyKey = normalizeIdentifier(
    input.idempotencyKey,
    "idempotencyKey",
  );
  const purchaseId = normalizeIdentifier(input.purchaseId, "purchaseId");
  const additionalRefundMicros = assertPositiveMicros(
    input.additionalRefundMicros,
    "additionalRefundMicros",
  );
  const refundOccurredAtMs = assertSafeTimestampMs(
    input.refundOccurredAtMs,
    "refundOccurredAtMs",
  );
  const effectiveEscrowRecordedAtMs =
    input.recordedAtMs === undefined
      ? refundOccurredAtMs
      : assertSafeTimestampMs(input.recordedAtMs, "recordedAtMs");

  // Check exact idempotent replay before checking current post-refund status.
  const existingByKey = ledger.entries.find(
    (item) => item.idempotencyKey === idempotencyKey,
  );
  if (existingByKey) {
    if (existingByKey.eventType === "post_release_clawback") {
      return recordPostReleaseRoyaltyClawback(ledger, input);
    }
    if (
      existingByKey.entryId === entryId &&
      existingByKey.purchaseId === purchaseId &&
      existingByKey.eventType === "escrow_refund_adjustment" &&
      existingByKey.eventRefundMicros === additionalRefundMicros &&
      existingByKey.recordedAtMs === effectiveEscrowRecordedAtMs
    ) {
      return { ledger, entry: existingByKey, idempotentReplay: true };
    }
    throw new CommercialResilienceError(
      "IDEMPOTENCY_CONFLICT",
      `Conflicting creator_royalty_entry for idempotencyKey "${idempotencyKey}"`,
    );
  }

  const current = projectCreatorRoyaltyPosition(
    ledger,
    purchaseId,
    refundOccurredAtMs,
  );

  if (refundOccurredAtMs < current.settledPurchaseAtMs) {
    throw new CommercialResilienceError(
      "INVALID_TIMESTAMP",
      "refundOccurredAtMs cannot precede settledPurchaseAtMs",
    );
  }
  if (
    current.status === "released" ||
    current.status === "partially_clawed_back" ||
    current.status === "clawed_back"
  ) {
    return recordPostReleaseRoyaltyClawback(ledger, input);
  }
  if (current.status === "excluded") {
    throw new CommercialResilienceError(
      "ROYALTY_EXCLUDED",
      `Royalty for purchase "${purchaseId}" is excluded (${current.excludedReason})`,
    );
  }
  if (current.status === "voided") {
    throw new CommercialResilienceError(
      "ROYALTY_VOIDED",
      `Royalty for purchase "${purchaseId}" is already voided`,
    );
  }

  const accrualEntry = ledger.entries.find(
    (item) => item.purchaseId === purchaseId && item.eventType === "accrual",
  );
  const cumulativeRefundsMicros =
    current.cumulativeRefundsMicros + additionalRefundMicros;
  const rawNet =
    current.grossReceiptsMicros -
    current.channelFeeMicros -
    cumulativeRefundsMicros;
  const netReceiptsMicros = rawNet > 0n ? rawNet : 0n;
  const updatedRoyaltyMicros =
    (current.ratePermille * netReceiptsMicros) / ROYALTY_RATE_DENOMINATOR;
  const deltaRoyaltyMicros = updatedRoyaltyMicros - current.royaltyMicros;
  const statusAfterEvent: CreatorRoyaltyStatus =
    updatedRoyaltyMicros === 0n ? "voided" : "pending_escrow";

  const entry: CreatorRoyaltyEntry = {
    ledgerKind: "creator_royalty_entry",
    entryId,
    idempotencyKey,
    purchaseId: current.purchaseId,
    creatorAccountId: current.creatorAccountId,
    buyerAccountId: current.buyerAccountId,
    cartridgeId: current.cartridgeId,
    currency: current.currency,
    eventType: "escrow_refund_adjustment",
    referenceEntryId: accrualEntry ? accrualEntry.entryId : null,
    statusAfterEvent,
    excludedReason: null,
    settledPurchaseAtMs: current.settledPurchaseAtMs,
    escrowReleaseAtMs: current.escrowReleaseAtMs,
    recordedAtMs: effectiveEscrowRecordedAtMs,
    grossReceiptsMicros: current.grossReceiptsMicros,
    channelFeeMicros: current.channelFeeMicros,
    eventRefundMicros: additionalRefundMicros,
    cumulativeRefundsMicros,
    netReceiptsMicros,
    ratePermille: current.ratePermille,
    qualityMultiplierApplied: current.qualityMultiplierApplied,
    deltaRoyaltyMicros,
    resultingRoyaltyMicros: updatedRoyaltyMicros,
  };

  return appendValidatedRoyaltyEntry(ledger, entry);
}

/**
 * Releases a matured `pending_escrow` creator royalty once
 * `nowMs >= settledPurchaseAtMs + 14 * 86_400_000`.
 */
export function appendCreatorRoyaltyRelease(
  ledger: CreatorRoyaltyLedger,
  input: CreatorRoyaltyReleaseInput,
): AppendLedgerResult<CreatorRoyaltyLedger, CreatorRoyaltyEntry> {
  const entryId = normalizeIdentifier(input.entryId, "entryId");
  const idempotencyKey = normalizeIdentifier(
    input.idempotencyKey,
    "idempotencyKey",
  );
  const purchaseId = normalizeIdentifier(input.purchaseId, "purchaseId");
  const nowMs = assertSafeTimestampMs(input.nowMs, "nowMs");

  const existingByKey = ledger.entries.find(
    (item) => item.idempotencyKey === idempotencyKey,
  );
  if (existingByKey) {
    if (
      existingByKey.entryId === entryId &&
      existingByKey.purchaseId === purchaseId &&
      existingByKey.eventType === "escrow_release" &&
      existingByKey.recordedAtMs === nowMs
    ) {
      return { ledger, entry: existingByKey, idempotentReplay: true };
    }
    throw new CommercialResilienceError(
      "IDEMPOTENCY_CONFLICT",
      `Conflicting creator_royalty_entry for idempotencyKey "${idempotencyKey}"`,
    );
  }

  const current = projectCreatorRoyaltyPosition(ledger, purchaseId, nowMs);

  if (current.status === "excluded") {
    throw new CommercialResilienceError(
      "ROYALTY_EXCLUDED",
      `Cannot release excluded royalty for purchase "${purchaseId}"`,
    );
  }
  if (current.status === "voided") {
    throw new CommercialResilienceError(
      "ROYALTY_VOIDED",
      `Cannot release voided royalty for purchase "${purchaseId}"`,
    );
  }
  if (
    current.status === "released" ||
    current.status === "partially_clawed_back" ||
    current.status === "clawed_back"
  ) {
    throw new CommercialResilienceError(
      "ROYALTY_ALREADY_RELEASED",
      `Royalty for purchase "${purchaseId}" was already released`,
    );
  }
  if (!current.escrowMaturedAtEvaluation) {
    throw new CommercialResilienceError(
      "ESCROW_NOT_MATURED",
      `Royalty for purchase "${purchaseId}" remains frozen in T+14d escrow for ${current.remainingEscrowMs}ms`,
    );
  }

  const accrualEntry = ledger.entries.find(
    (item) => item.purchaseId === purchaseId && item.eventType === "accrual",
  );
  const entry: CreatorRoyaltyEntry = {
    ledgerKind: "creator_royalty_entry",
    entryId,
    idempotencyKey,
    purchaseId: current.purchaseId,
    creatorAccountId: current.creatorAccountId,
    buyerAccountId: current.buyerAccountId,
    cartridgeId: current.cartridgeId,
    currency: current.currency,
    eventType: "escrow_release",
    referenceEntryId: accrualEntry ? accrualEntry.entryId : null,
    statusAfterEvent: "released",
    excludedReason: null,
    settledPurchaseAtMs: current.settledPurchaseAtMs,
    escrowReleaseAtMs: current.escrowReleaseAtMs,
    recordedAtMs: nowMs,
    grossReceiptsMicros: current.grossReceiptsMicros,
    channelFeeMicros: current.channelFeeMicros,
    eventRefundMicros: 0n,
    cumulativeRefundsMicros: current.cumulativeRefundsMicros,
    netReceiptsMicros: current.netReceiptsMicros,
    ratePermille: current.ratePermille,
    qualityMultiplierApplied: current.qualityMultiplierApplied,
    deltaRoyaltyMicros: 0n,
    resultingRoyaltyMicros: current.royaltyMicros,
  };

  return appendValidatedRoyaltyEntry(ledger, entry);
}

/**
 * Summarizes a creator's append-only escrow, matured releasable, released, and
 * post-release clawback payable balance in a single currency at `nowMs`.
 */
export function summarizeCreatorRoyaltyPayableBalance(
  ledger: CreatorRoyaltyLedger,
  options: {
    readonly creatorAccountId: string;
    readonly currency: CurrencyCode;
    readonly nowMs: number;
  },
): CreatorRoyaltyPayableSummary {
  const creatorAccountId = normalizeIdentifier(
    options.creatorAccountId,
    "creatorAccountId",
  );
  const currency = normalizeCurrency(options.currency);
  const nowMs = assertSafeTimestampMs(options.nowMs, "nowMs");

  const purchaseIds = new Set<string>();
  for (const entry of ledger.entries) {
    if (entry.creatorAccountId !== creatorAccountId) {
      continue;
    }
    if (entry.currency !== currency) {
      throw new CommercialResilienceError(
        "CURRENCY_MISMATCH",
        `Creator royalty entry "${entry.entryId}" has currency "${entry.currency}", expected "${currency}"`,
      );
    }
    purchaseIds.add(entry.purchaseId);
  }

  let pendingEscrowMicros = 0n;
  let maturedReleasableMicros = 0n;
  let grossReleasedMicros = 0n;
  let postReleaseClawbackMicros = 0n;

  for (const purchaseId of purchaseIds) {
    const pos = projectCreatorRoyaltyPosition(ledger, purchaseId, nowMs);
    if (pos.status === "pending_escrow") {
      if (pos.escrowMaturedAtEvaluation) {
        maturedReleasableMicros += pos.releasableMicros;
      } else {
        pendingEscrowMicros += pos.royaltyMicros;
      }
    }
    grossReleasedMicros += pos.releasedMicros;
    postReleaseClawbackMicros += pos.clawedBackMicros;
  }

  return {
    creatorAccountId,
    currency,
    pendingEscrowMicros,
    maturedReleasableMicros,
    grossReleasedMicros,
    postReleaseClawbackMicros,
    netPayableMicros: maturedReleasableMicros - postReleaseClawbackMicros,
    netSettledLifetimeMicros:
      grossReleasedMicros > postReleaseClawbackMicros
        ? grossReleasedMicros - postReleaseClawbackMicros
        : 0n,
  };
}
