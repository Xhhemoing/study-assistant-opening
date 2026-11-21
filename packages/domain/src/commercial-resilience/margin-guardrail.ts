/**
 * Account-level period gross-margin guardrail and 3-tier seamless degradation router.
 *
 * Pure browser-safe BigInt arithmetic:
 *   B = max(0n, floor(0.35 * R) - F - H)
 *   B_daily_burst = ceil(B / 15) = (B + 14n) / 15n
 *
 * Exhaustion at 100% (or B === 0n) blocks paid platform-key LLM calls while
 * keeping local zero-cost Verify, FSRS flashcards, local Socratic rules, and
 * material reading 100% active. BYOK credentials remain strictly isolated and
 * never fall back to platform keys or debit platform budget.
 */

import {
  assertNonNegativeMicros,
  normalizeCurrency,
  normalizeIdentifier,
  type CurrencyCode,
  type MicroCurrency,
} from "./types";

export const VARIABLE_AI_REVENUE_NUMERATOR = 35n;
export const VARIABLE_AI_REVENUE_DENOMINATOR = 100n;
export const DAILY_BURST_DIVISOR = 15n;
export const TIER_1_UTILIZATION_PERCENT = 70n;
export const TIER_2_UTILIZATION_PERCENT = 90n;
export const TIER_3_UTILIZATION_PERCENT = 100n;

export type MarginGuardrailTier =
  | "normal"
  | "economical_70_90"
  | "deterministic_90_100"
  | "zero_cost_floor_100";

export type MarginGuardrailTierLevel = 0 | 1 | 2 | 3;

export type ModelRoutingProfile =
  | "flagship_managed_retrieval"
  | "economical_distilled_cached"
  | "deterministic_first_ambiguous_only"
  | "zero_cost_local_only";

export type ModelCredentialMode = "platform" | "byok";

export type LearnerInteractionStepKind =
  | "standard_draft"
  | "explanation"
  | "exam_grading"
  | "irreducible_ambiguous"
  | "local_verify"
  | "flashcard_review"
  | "local_socratic_rule"
  | "material_reading";

export interface PeriodBudgetInputs {
  readonly recognizedRevenueMicros: MicroCurrency;
  readonly channelAndRefundReserveMicros: MicroCurrency;
  readonly fixedInfraReserveMicros: MicroCurrency;
}

export interface PeriodBudgetEnvelope {
  readonly recognizedRevenueMicros: MicroCurrency;
  readonly grossVariableAiShareMicros: MicroCurrency;
  readonly channelAndRefundReserveMicros: MicroCurrency;
  readonly fixedInfraReserveMicros: MicroCurrency;
  readonly periodBudgetCeilingMicros: MicroCurrency;
  readonly dailyBurstCapMicros: MicroCurrency;
}

export interface MarginGuardrailInput extends PeriodBudgetInputs {
  readonly accountId: string;
  readonly currency: CurrencyCode;
  readonly periodSpendMicros: MicroCurrency;
  readonly dailySpendMicros: MicroCurrency;
}

export interface MarginGuardrailDecision {
  readonly accountId: string;
  readonly currency: CurrencyCode;
  readonly envelope: PeriodBudgetEnvelope;
  readonly periodSpendMicros: MicroCurrency;
  readonly dailySpendMicros: MicroCurrency;
  readonly remainingPeriodBudgetMicros: MicroCurrency;
  readonly remainingDailyBurstMicros: MicroCurrency;
  /** Integer basis points (0n..10_000n+), or null when periodBudgetCeilingMicros === 0n. */
  readonly utilizationBps: bigint | null;
  readonly tierLevel: MarginGuardrailTierLevel;
  readonly tier: MarginGuardrailTier;
  readonly routingProfile: ModelRoutingProfile;
  readonly triggeredByDailyBurst: boolean;
  readonly allowPaidModelCall: boolean;
  readonly allowFlagshipStandardTurns: boolean;
  readonly allowDistilledEconomicalTurns: boolean;
  readonly allowExamGradingFlagship: boolean;
  readonly allowIrreducibleAmbiguousStepOnly: boolean;
  readonly requireStaticPrefixCaching: boolean;
  readonly preferDeterministicLocalFirst: boolean;
  readonly localVerifyAndFlashcardsActive: true;
  readonly localSocraticRulesActive: true;
  readonly materialReadingActive: true;
  readonly allowByokIsolation: true;
  readonly allowPlatformCredentialFallbackForByok: false;
}

export interface ModelRouteAuthorizationInput {
  readonly guardrail: MarginGuardrailDecision;
  readonly credentialMode: ModelCredentialMode;
  readonly stepKind: LearnerInteractionStepKind;
  readonly estimatedPlatformCostMicros?: MicroCurrency;
}

export type ModelRouteTarget =
  | "platform_flagship"
  | "platform_distilled_cached"
  | "platform_irreducible_only"
  | "byok_isolated"
  | "local_zero_cost";

export interface ModelRouteAuthorization {
  readonly target: ModelRouteTarget;
  readonly credentialMode: ModelCredentialMode;
  readonly allowPaidModelCall: boolean;
  readonly allowByokModelCall: boolean;
  readonly allowPlatformCredentialFallback: false;
  readonly platformBudgetDebitMicros: MicroCurrency;
  readonly localVerifyAndFlashcardsActive: true;
  readonly denialReason:
    | null
    | "period_budget_exhausted"
    | "tier_2_requires_local_first"
    | "would_exceed_period_budget";
}

const ZERO_COST_LOCAL_STEPS: ReadonlySet<LearnerInteractionStepKind> = new Set([
  "local_verify",
  "flashcard_review",
  "local_socratic_rule",
  "material_reading",
]);

/**
 * Computes exact integer BigInt period budget ceiling and daily burst cap:
 *   B = max(0n, floor(0.35 * R) - F - H)
 *   B_daily_burst = ceil(B / 15) = (B + 14n) / 15n
 */
export function computePeriodBudgetEnvelope(
  input: PeriodBudgetInputs,
): PeriodBudgetEnvelope {
  const recognizedRevenueMicros = assertNonNegativeMicros(
    input.recognizedRevenueMicros,
    "recognizedRevenueMicros",
  );
  const channelAndRefundReserveMicros = assertNonNegativeMicros(
    input.channelAndRefundReserveMicros,
    "channelAndRefundReserveMicros",
  );
  const fixedInfraReserveMicros = assertNonNegativeMicros(
    input.fixedInfraReserveMicros,
    "fixedInfraReserveMicros",
  );

  const grossVariableAiShareMicros =
    (VARIABLE_AI_REVENUE_NUMERATOR * recognizedRevenueMicros) /
    VARIABLE_AI_REVENUE_DENOMINATOR;

  const rawCeiling =
    grossVariableAiShareMicros -
    channelAndRefundReserveMicros -
    fixedInfraReserveMicros;

  const periodBudgetCeilingMicros = rawCeiling > 0n ? rawCeiling : 0n;
  const dailyBurstCapMicros =
    (periodBudgetCeilingMicros + (DAILY_BURST_DIVISOR - 1n)) /
    DAILY_BURST_DIVISOR;

  return {
    recognizedRevenueMicros,
    grossVariableAiShareMicros,
    channelAndRefundReserveMicros,
    fixedInfraReserveMicros,
    periodBudgetCeilingMicros,
    dailyBurstCapMicros,
  };
}

/**
 * Evaluates the account-level period gross-margin guardrail and returns the
 * deterministic 4-state (Tier 0..3) routing policy using exact BigInt
 * cross-multiplication for all utilization boundaries.
 */
export function evaluateMarginGuardrail(
  input: MarginGuardrailInput,
): MarginGuardrailDecision {
  const accountId = normalizeIdentifier(input.accountId, "accountId");
  const currency = normalizeCurrency(input.currency);
  const periodSpendMicros = assertNonNegativeMicros(
    input.periodSpendMicros,
    "periodSpendMicros",
  );
  const dailySpendMicros = assertNonNegativeMicros(
    input.dailySpendMicros,
    "dailySpendMicros",
  );

  const envelope = computePeriodBudgetEnvelope(input);
  const budget = envelope.periodBudgetCeilingMicros;
  const dailyBurst = envelope.dailyBurstCapMicros;

  const remainingPeriodBudgetMicros =
    budget > periodSpendMicros ? budget - periodSpendMicros : 0n;
  const remainingDailyBurstMicros =
    dailyBurst > dailySpendMicros ? dailyBurst - dailySpendMicros : 0n;
  const utilizationBps =
    budget === 0n ? null : (periodSpendMicros * 10_000n) / budget;

  // Exact BigInt boundary checks — zero floating-point rounding drift.
  const isTier3 = budget === 0n || periodSpendMicros >= budget;
  const isTier2 =
    !isTier3 &&
    periodSpendMicros * 100n >= TIER_2_UTILIZATION_PERCENT * budget;
  const meetsTier1Utilization =
    !isTier3 &&
    !isTier2 &&
    periodSpendMicros * 100n >= TIER_1_UTILIZATION_PERCENT * budget;
  const meetsDailyBurst = !isTier3 && !isTier2 && dailySpendMicros >= dailyBurst;
  const isTier1 = meetsTier1Utilization || meetsDailyBurst;

  if (isTier3) {
    return {
      accountId,
      currency,
      envelope,
      periodSpendMicros,
      dailySpendMicros,
      remainingPeriodBudgetMicros: 0n,
      remainingDailyBurstMicros: 0n,
      utilizationBps,
      tierLevel: 3,
      tier: "zero_cost_floor_100",
      routingProfile: "zero_cost_local_only",
      triggeredByDailyBurst: false,
      allowPaidModelCall: false,
      allowFlagshipStandardTurns: false,
      allowDistilledEconomicalTurns: false,
      allowExamGradingFlagship: false,
      allowIrreducibleAmbiguousStepOnly: false,
      requireStaticPrefixCaching: true,
      preferDeterministicLocalFirst: true,
      localVerifyAndFlashcardsActive: true,
      localSocraticRulesActive: true,
      materialReadingActive: true,
      allowByokIsolation: true,
      allowPlatformCredentialFallbackForByok: false,
    };
  }

  if (isTier2) {
    return {
      accountId,
      currency,
      envelope,
      periodSpendMicros,
      dailySpendMicros,
      remainingPeriodBudgetMicros,
      remainingDailyBurstMicros,
      utilizationBps,
      tierLevel: 2,
      tier: "deterministic_90_100",
      routingProfile: "deterministic_first_ambiguous_only",
      triggeredByDailyBurst: false,
      allowPaidModelCall: true,
      allowFlagshipStandardTurns: false,
      allowDistilledEconomicalTurns: false,
      allowExamGradingFlagship: false,
      allowIrreducibleAmbiguousStepOnly: true,
      requireStaticPrefixCaching: true,
      preferDeterministicLocalFirst: true,
      localVerifyAndFlashcardsActive: true,
      localSocraticRulesActive: true,
      materialReadingActive: true,
      allowByokIsolation: true,
      allowPlatformCredentialFallbackForByok: false,
    };
  }

  if (isTier1) {
    return {
      accountId,
      currency,
      envelope,
      periodSpendMicros,
      dailySpendMicros,
      remainingPeriodBudgetMicros,
      remainingDailyBurstMicros,
      utilizationBps,
      tierLevel: 1,
      tier: "economical_70_90",
      routingProfile: "economical_distilled_cached",
      triggeredByDailyBurst: !meetsTier1Utilization && meetsDailyBurst,
      allowPaidModelCall: true,
      allowFlagshipStandardTurns: false,
      allowDistilledEconomicalTurns: true,
      allowExamGradingFlagship: true,
      allowIrreducibleAmbiguousStepOnly: false,
      requireStaticPrefixCaching: true,
      preferDeterministicLocalFirst: false,
      localVerifyAndFlashcardsActive: true,
      localSocraticRulesActive: true,
      materialReadingActive: true,
      allowByokIsolation: true,
      allowPlatformCredentialFallbackForByok: false,
    };
  }

  return {
    accountId,
    currency,
    envelope,
    periodSpendMicros,
    dailySpendMicros,
    remainingPeriodBudgetMicros,
    remainingDailyBurstMicros,
    utilizationBps,
    tierLevel: 0,
    tier: "normal",
    routingProfile: "flagship_managed_retrieval",
    triggeredByDailyBurst: false,
    allowPaidModelCall: true,
    allowFlagshipStandardTurns: true,
    allowDistilledEconomicalTurns: true,
    allowExamGradingFlagship: true,
    allowIrreducibleAmbiguousStepOnly: false,
    requireStaticPrefixCaching: false,
    preferDeterministicLocalFirst: false,
    localVerifyAndFlashcardsActive: true,
    localSocraticRulesActive: true,
    materialReadingActive: true,
    allowByokIsolation: true,
    allowPlatformCredentialFallbackForByok: false,
  };
}

/**
 * Resolves the concrete route for a single learner interaction step under the
 * active guardrail decision while strictly isolating BYOK credentials and
 * guaranteeing zero-cost local learning continuity at every tier.
 */
export function authorizeModelRoute(
  input: ModelRouteAuthorizationInput,
): ModelRouteAuthorization {
  const estimatedCostMicros = assertNonNegativeMicros(
    input.estimatedPlatformCostMicros ?? 0n,
    "estimatedPlatformCostMicros",
  );

  // Zero-cost local steps are ALWAYS allowed and NEVER incur platform spend.
  if (ZERO_COST_LOCAL_STEPS.has(input.stepKind)) {
    return {
      target: "local_zero_cost",
      credentialMode: input.credentialMode,
      allowPaidModelCall: false,
      allowByokModelCall: false,
      allowPlatformCredentialFallback: false,
      platformBudgetDebitMicros: 0n,
      localVerifyAndFlashcardsActive: true,
      denialReason: null,
    };
  }

  // BYOK calls stay strictly isolated on user-supplied credentials:
  // never debit platform budget, never fall back to platform keys, never bricked by Tier 3.
  if (input.credentialMode === "byok") {
    return {
      target: "byok_isolated",
      credentialMode: "byok",
      allowPaidModelCall: false,
      allowByokModelCall: true,
      allowPlatformCredentialFallback: false,
      platformBudgetDebitMicros: 0n,
      localVerifyAndFlashcardsActive: true,
      denialReason: null,
    };
  }

  const { guardrail, stepKind } = input;

  if (!guardrail.allowPaidModelCall || guardrail.tier === "zero_cost_floor_100") {
    return {
      target: "local_zero_cost",
      credentialMode: "platform",
      allowPaidModelCall: false,
      allowByokModelCall: false,
      allowPlatformCredentialFallback: false,
      platformBudgetDebitMicros: 0n,
      localVerifyAndFlashcardsActive: true,
      denialReason: "period_budget_exhausted",
    };
  }

  if (
    estimatedCostMicros > 0n &&
    estimatedCostMicros > guardrail.remainingPeriodBudgetMicros
  ) {
    return {
      target: "local_zero_cost",
      credentialMode: "platform",
      allowPaidModelCall: false,
      allowByokModelCall: false,
      allowPlatformCredentialFallback: false,
      platformBudgetDebitMicros: 0n,
      localVerifyAndFlashcardsActive: true,
      denialReason: "would_exceed_period_budget",
    };
  }

  if (guardrail.tier === "deterministic_90_100") {
    if (stepKind !== "irreducible_ambiguous") {
      return {
        target: "local_zero_cost",
        credentialMode: "platform",
        allowPaidModelCall: false,
        allowByokModelCall: false,
        allowPlatformCredentialFallback: false,
        platformBudgetDebitMicros: 0n,
        localVerifyAndFlashcardsActive: true,
        denialReason: "tier_2_requires_local_first",
      };
    }

    return {
      target: "platform_irreducible_only",
      credentialMode: "platform",
      allowPaidModelCall: true,
      allowByokModelCall: false,
      allowPlatformCredentialFallback: false,
      platformBudgetDebitMicros: estimatedCostMicros,
      localVerifyAndFlashcardsActive: true,
      denialReason: null,
    };
  }

  if (guardrail.tier === "economical_70_90") {
    const target: ModelRouteTarget =
      stepKind === "exam_grading"
        ? "platform_flagship"
        : "platform_distilled_cached";
    return {
      target,
      credentialMode: "platform",
      allowPaidModelCall: true,
      allowByokModelCall: false,
      allowPlatformCredentialFallback: false,
      platformBudgetDebitMicros: estimatedCostMicros,
      localVerifyAndFlashcardsActive: true,
      denialReason: null,
    };
  }

  return {
    target: "platform_flagship",
    credentialMode: "platform",
    allowPaidModelCall: true,
    allowByokModelCall: false,
    allowPlatformCredentialFallback: false,
    platformBudgetDebitMicros: estimatedCostMicros,
    localVerifyAndFlashcardsActive: true,
    denialReason: null,
  };
}
