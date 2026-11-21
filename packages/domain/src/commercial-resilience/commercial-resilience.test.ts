import { describe, expect, it } from "vitest";
import {
  aggregateCohortEventsToHeatmap,
  appendCreatorRoyaltyAccrual,
  appendCreatorRoyaltyRefund,
  appendCreatorRoyaltyRelease,
  appendLearnerCreditEntry,
  appendProviderCostEntry,
  authorizeModelRoute,
  buildCohortHeatmap,
  calculateCreatorRoyalty,
  CommercialResilienceError,
  computeFrozenRosterDigest,
  computePeriodBudgetEnvelope,
  createCreatorRoyaltyLedger,
  createLearnerCreditEntry,
  createLearnerCreditLedger,
  createProviderCostEntry,
  createProviderCostLedger,
  DAY_MS,
  evaluateBilateralPrivacyCell,
  evaluateMarginGuardrail,
  getIsoWeekWindowForTimestamp,
  getLearnerCreditBalance,
  LTI_13_VERSION,
  LTI_CLAIM_CONTEXT,
  LTI_CLAIM_CUSTOM,
  LTI_CLAIM_DEEP_LINKING_SETTINGS,
  LTI_CLAIM_DEPLOYMENT_ID,
  LTI_CLAIM_MESSAGE_TYPE,
  LTI_CLAIM_RESOURCE_LINK,
  LTI_CLAIM_ROLES,
  LTI_CLAIM_VERSION,
  MICROS_PER_UNIT,
  parseIsoWeekKey,
  projectCreatorRoyaltyPosition,
  recordPostReleaseRoyaltyClawback,
  resolveCohortSurfacePolicy,
  ROYALTY_ESCROW_WINDOW_MS,
  summarizeCreatorRoyaltyPayableBalance,
  summarizeProviderCostLedger,
  validateFixedIsoWeekWindow,
  validateLti13DeepLinkingClaims,
  WEEK_MS,
  type Lti13DeepLinkingClaimsPayload,
  type Lti13ValidationPolicy,
} from "./index";

describe("commercial-resilience: margin guardrail & 3-tier degradation router", () => {
  it("computes exact BigInt B = max(0n, floor(0.35*R) - F - H) and ceil(B/15) without floating-point drift", () => {
    // R = $19.99 = 19_990_000n -> floor(0.35 * R) = 6_996_500n
    // F = $0.88 = 880_000n, H = $0.50 = 500_000n -> B = 5_616_500n
    // ceil(5_616_500n / 15n) = (5_616_500n + 14n) / 15n = 374_434n (since 374433*15 = 5_616_495 < 5_616_500)
    const envelope = computePeriodBudgetEnvelope({
      recognizedRevenueMicros: 19_990_000n,
      channelAndRefundReserveMicros: 880_000n,
      fixedInfraReserveMicros: 500_000n,
    });
    expect(envelope.grossVariableAiShareMicros).toBe(6_996_500n);
    expect(envelope.periodBudgetCeilingMicros).toBe(5_616_500n);
    expect(envelope.dailyBurstCapMicros).toBe(374_434n);

    // Exact ceiling boundary checks for B = 0n, 1n, 15n, 16n and huge > Number.MAX_SAFE_INTEGER values
    expect(
      computePeriodBudgetEnvelope({
        recognizedRevenueMicros: 100n,
        channelAndRefundReserveMicros: 30n,
        fixedInfraReserveMicros: 10n,
      }),
    ).toMatchObject({
      grossVariableAiShareMicros: 35n,
      periodBudgetCeilingMicros: 0n,
      dailyBurstCapMicros: 0n,
    });

    expect(
      computePeriodBudgetEnvelope({
        recognizedRevenueMicros: 100n,
        channelAndRefundReserveMicros: 34n,
        fixedInfraReserveMicros: 0n,
      }).dailyBurstCapMicros,
    ).toBe(1n);

    expect(
      computePeriodBudgetEnvelope({
        recognizedRevenueMicros: 100n,
        channelAndRefundReserveMicros: 20n,
        fixedInfraReserveMicros: 0n,
      }).dailyBurstCapMicros,
    ).toBe(1n); // B = 15n => ceil(15/15) = 1n

    expect(
      computePeriodBudgetEnvelope({
        recognizedRevenueMicros: 100n,
        channelAndRefundReserveMicros: 19n,
        fixedInfraReserveMicros: 0n,
      }).dailyBurstCapMicros,
    ).toBe(2n); // B = 16n => ceil(16/15) = 2n

    // Precision beyond 2^53 (IEEE-754 would lose exact last digits)
    const hugeR = 100_000_000_000_000_000_003n; // floor(0.35 * hugeR) = 35_000_000_000_000_000_001n
    const hugeEnvelope = computePeriodBudgetEnvelope({
      recognizedRevenueMicros: hugeR,
      channelAndRefundReserveMicros: 0n,
      fixedInfraReserveMicros: 0n,
    });
    expect(hugeEnvelope.periodBudgetCeilingMicros).toBe(
      35_000_000_000_000_000_001n,
    );
    expect(hugeEnvelope.dailyBurstCapMicros).toBe(2_333_333_333_333_333_334n);
  });

  it("routes all 4 tiers across exact utilization and daily burst boundaries", () => {
    // R = 10_000_000n ($10), F = 300_000n, H = 200_000n => B = 3_000_000n, dailyBurst = 200_000n
    const base = {
      accountId: "acct-1",
      currency: "USD",
      recognizedRevenueMicros: 10_000_000n,
      channelAndRefundReserveMicros: 300_000n,
      fixedInfraReserveMicros: 200_000n,
    };

    // Tier 0: 69.9999% (< 70%) AND dailySpend < dailyBurst (199_999n < 200_000n)
    const tier0 = evaluateMarginGuardrail({
      ...base,
      periodSpendMicros: 2_099_999n,
      dailySpendMicros: 199_999n,
    });
    expect(tier0.tierLevel).toBe(0);
    expect(tier0.tier).toBe("normal");
    expect(tier0.routingProfile).toBe("flagship_managed_retrieval");
    expect(tier0.allowPaidModelCall).toBe(true);
    expect(tier0.triggeredByDailyBurst).toBe(false);
    expect(tier0.localVerifyAndFlashcardsActive).toBe(true);

    // Tier 1 via daily burst while utilization < 70%
    const tier1Burst = evaluateMarginGuardrail({
      ...base,
      periodSpendMicros: 200_000n,
      dailySpendMicros: 200_000n,
    });
    expect(tier1Burst.tierLevel).toBe(1);
    expect(tier1Burst.tier).toBe("economical_70_90");
    expect(tier1Burst.triggeredByDailyBurst).toBe(true);
    expect(tier1Burst.requireStaticPrefixCaching).toBe(true);
    expect(tier1Burst.allowExamGradingFlagship).toBe(true);
    expect(tier1Burst.allowFlagshipStandardTurns).toBe(false);

    // Tier 1 via exact 70% boundary (2_100_000n / 3_000_000n)
    const tier1Util = evaluateMarginGuardrail({
      ...base,
      periodSpendMicros: 2_100_000n,
      dailySpendMicros: 0n,
    });
    expect(tier1Util.tierLevel).toBe(1);
    expect(tier1Util.tier).toBe("economical_70_90");
    expect(tier1Util.triggeredByDailyBurst).toBe(false);

    // Tier 1 upper edge: 89.9999%
    const tier1Upper = evaluateMarginGuardrail({
      ...base,
      periodSpendMicros: 2_699_999n,
      dailySpendMicros: 0n,
    });
    expect(tier1Upper.tier).toBe("economical_70_90");

    // Tier 2 exact 90% boundary (2_700_000n / 3_000_000n) — takes precedence over dailyBurst
    const tier2 = evaluateMarginGuardrail({
      ...base,
      periodSpendMicros: 2_700_000n,
      dailySpendMicros: 500_000n,
    });
    expect(tier2.tierLevel).toBe(2);
    expect(tier2.tier).toBe("deterministic_90_100");
    expect(tier2.preferDeterministicLocalFirst).toBe(true);
    expect(tier2.allowIrreducibleAmbiguousStepOnly).toBe(true);
    expect(tier2.allowPaidModelCall).toBe(true);

    // Tier 2 upper edge: 99.9999%
    const tier2Upper = evaluateMarginGuardrail({
      ...base,
      periodSpendMicros: 2_999_999n,
      dailySpendMicros: 0n,
    });
    expect(tier2Upper.tier).toBe("deterministic_90_100");

    // Tier 3 exact 100% exhaustion (3_000_000n)
    const tier3 = evaluateMarginGuardrail({
      ...base,
      periodSpendMicros: 3_000_000n,
      dailySpendMicros: 0n,
    });
    expect(tier3.tierLevel).toBe(3);
    expect(tier3.tier).toBe("zero_cost_floor_100");
    expect(tier3.allowPaidModelCall).toBe(false);
    expect(tier3.localVerifyAndFlashcardsActive).toBe(true);
    expect(tier3.localSocraticRulesActive).toBe(true);
    expect(tier3.materialReadingActive).toBe(true);
    expect(tier3.allowPlatformCredentialFallbackForByok).toBe(false);

    // Tier 3 when B === 0n (even at 0n spend!)
    const zeroBudget = evaluateMarginGuardrail({
      accountId: "acct-free",
      currency: "USD",
      recognizedRevenueMicros: 0n,
      channelAndRefundReserveMicros: 0n,
      fixedInfraReserveMicros: 0n,
      periodSpendMicros: 0n,
      dailySpendMicros: 0n,
    });
    expect(zeroBudget.tier).toBe("zero_cost_floor_100");
    expect(zeroBudget.utilizationBps).toBeNull();
    expect(zeroBudget.allowPaidModelCall).toBe(false);
    expect(zeroBudget.localVerifyAndFlashcardsActive).toBe(true);
  });

  it("enforces BYOK isolation, Tier 2 local-first routing, and never bricks local zero-cost tools at 100% exhaustion", () => {
    const tier1 = evaluateMarginGuardrail({
      accountId: "acct-1",
      currency: "USD",
      recognizedRevenueMicros: 10_000_000n,
      channelAndRefundReserveMicros: 500_000n,
      fixedInfraReserveMicros: 0n,
      periodSpendMicros: 2_200_000n, // 73.3% of 3_000_000n
      dailySpendMicros: 0n,
    });

    // Tier 1 keeps exam grading flagship while routing standard drafts to distilled cached tier
    expect(
      authorizeModelRoute({
        guardrail: tier1,
        credentialMode: "platform",
        stepKind: "standard_draft",
        estimatedPlatformCostMicros: 10_000n,
      }),
    ).toMatchObject({
      target: "platform_distilled_cached",
      allowPaidModelCall: true,
      platformBudgetDebitMicros: 10_000n,
    });

    expect(
      authorizeModelRoute({
        guardrail: tier1,
        credentialMode: "platform",
        stepKind: "exam_grading",
        estimatedPlatformCostMicros: 25_000n,
      }),
    ).toMatchObject({
      target: "platform_flagship",
      allowPaidModelCall: true,
      platformBudgetDebitMicros: 25_000n,
    });

    // Tier 2 blocks standard_draft paid calls but permits irreducible_ambiguous within remaining budget
    const tier2 = evaluateMarginGuardrail({
      accountId: "acct-1",
      currency: "USD",
      recognizedRevenueMicros: 10_000_000n,
      channelAndRefundReserveMicros: 500_000n,
      fixedInfraReserveMicros: 0n,
      periodSpendMicros: 2_800_000n, // remaining = 200_000n
      dailySpendMicros: 0n,
    });

    expect(
      authorizeModelRoute({
        guardrail: tier2,
        credentialMode: "platform",
        stepKind: "explanation",
        estimatedPlatformCostMicros: 10_000n,
      }),
    ).toMatchObject({
      target: "local_zero_cost",
      allowPaidModelCall: false,
      denialReason: "tier_2_requires_local_first",
      localVerifyAndFlashcardsActive: true,
    });

    expect(
      authorizeModelRoute({
        guardrail: tier2,
        credentialMode: "platform",
        stepKind: "irreducible_ambiguous",
        estimatedPlatformCostMicros: 50_000n,
      }),
    ).toMatchObject({
      target: "platform_irreducible_only",
      allowPaidModelCall: true,
      platformBudgetDebitMicros: 50_000n,
    });

    // Pre-flight guard prevents a single huge call from blowing past ceiling B
    expect(
      authorizeModelRoute({
        guardrail: tier2,
        credentialMode: "platform",
        stepKind: "irreducible_ambiguous",
        estimatedPlatformCostMicros: 200_001n,
      }),
    ).toMatchObject({
      target: "local_zero_cost",
      allowPaidModelCall: false,
      denialReason: "would_exceed_period_budget",
      platformBudgetDebitMicros: 0n,
    });

    // Tier 3 at 100%: platform LLM blocked, BYOK isolated & allowed with 0n platform debit, local tools uninterrupted
    const tier3 = evaluateMarginGuardrail({
      accountId: "acct-1",
      currency: "USD",
      recognizedRevenueMicros: 10_000_000n,
      channelAndRefundReserveMicros: 500_000n,
      fixedInfraReserveMicros: 0n,
      periodSpendMicros: 3_000_000n,
      dailySpendMicros: 0n,
    });

    expect(
      authorizeModelRoute({
        guardrail: tier3,
        credentialMode: "platform",
        stepKind: "irreducible_ambiguous",
        estimatedPlatformCostMicros: 1n,
      }),
    ).toMatchObject({
      target: "local_zero_cost",
      allowPaidModelCall: false,
      denialReason: "period_budget_exhausted",
      localVerifyAndFlashcardsActive: true,
    });

    expect(
      authorizeModelRoute({
        guardrail: tier3,
        credentialMode: "byok",
        stepKind: "standard_draft",
        estimatedPlatformCostMicros: 500_000n,
      }),
    ).toMatchObject({
      target: "byok_isolated",
      allowPaidModelCall: false,
      allowByokModelCall: true,
      allowPlatformCredentialFallback: false,
      platformBudgetDebitMicros: 0n,
      localVerifyAndFlashcardsActive: true,
      denialReason: null,
    });

    for (const localStep of [
      "local_verify",
      "flashcard_review",
      "local_socratic_rule",
      "material_reading",
    ] as const) {
      expect(
        authorizeModelRoute({
          guardrail: tier3,
          credentialMode: "platform",
          stepKind: localStep,
        }),
      ).toMatchObject({
        target: "local_zero_cost",
        allowPaidModelCall: false,
        platformBudgetDebitMicros: 0n,
        localVerifyAndFlashcardsActive: true,
        denialReason: null,
      });
    }
  });

  it("rejects negative BigInt monetary inputs and requires explicit positive cost bounds + daily burst projection on paid platform calls", () => {
    expect(() =>
      computePeriodBudgetEnvelope({
        recognizedRevenueMicros: -1n,
        channelAndRefundReserveMicros: 0n,
        fixedInfraReserveMicros: 0n,
      }),
    ).toThrow(CommercialResilienceError);

    // Tier 0 with B = 3_000_000n, dailyBurst = 200_000n, dailySpend = 180_000n
    const tier0NearBurst = evaluateMarginGuardrail({
      accountId: "acct-burst",
      currency: "USD",
      recognizedRevenueMicros: 10_000_000n,
      channelAndRefundReserveMicros: 500_000n,
      fixedInfraReserveMicros: 0n,
      periodSpendMicros: 180_000n,
      dailySpendMicros: 180_000n,
    });
    expect(tier0NearBurst.tier).toBe("normal");
    expect(tier0NearBurst.envelope.dailyBurstCapMicros).toBe(200_000n);

    // Omitting or passing 0n on a paid platform call MUST fail closed with MISSING_OR_ZERO_COST_ESTIMATE
    for (const badCost of [undefined, 0n, -5n] as const) {
      try {
        authorizeModelRoute({
          guardrail: tier0NearBurst,
          credentialMode: "platform",
          stepKind: "standard_draft",
          estimatedPlatformCostMicros: badCost,
        });
        expect.unreachable("Expected MISSING_OR_ZERO_COST_ESTIMATE");
      } catch (err) {
        expect(err).toBeInstanceOf(CommercialResilienceError);
        expect((err as CommercialResilienceError).code).toBe(
          "MISSING_OR_ZERO_COST_ESTIMATE",
        );
      }
    }

    // Fitting at exact daily burst boundary (180_000n + 20_000n === 200_000n) stays Tier 0
    expect(
      authorizeModelRoute({
        guardrail: tier0NearBurst,
        credentialMode: "platform",
        stepKind: "standard_draft",
        estimatedPlatformCostMicros: 20_000n,
      }),
    ).toMatchObject({
      target: "platform_flagship",
      effectiveTier: "normal",
      upgradedByDailyBurstProjection: false,
      allowPaidModelCall: true,
      platformBudgetDebitMicros: 20_000n,
    });

    // Crossing daily burst cap (180_000n + 20_001n > 200_000n) upgrades immediately into Tier 1
    expect(
      authorizeModelRoute({
        guardrail: tier0NearBurst,
        credentialMode: "platform",
        stepKind: "standard_draft",
        estimatedPlatformCostMicros: 20_001n,
      }),
    ).toMatchObject({
      target: "platform_distilled_cached",
      effectiveTier: "economical_70_90",
      upgradedByDailyBurstProjection: true,
      allowPaidModelCall: true,
      platformBudgetDebitMicros: 20_001n,
    });

    // Exam grading crossing daily burst still upgrades effectiveTier to Tier 1 while keeping flagship accuracy
    expect(
      authorizeModelRoute({
        guardrail: tier0NearBurst,
        credentialMode: "platform",
        stepKind: "exam_grading",
        estimatedPlatformCostMicros: 20_001n,
      }),
    ).toMatchObject({
      target: "platform_flagship",
      effectiveTier: "economical_70_90",
      upgradedByDailyBurstProjection: true,
      allowPaidModelCall: true,
      platformBudgetDebitMicros: 20_001n,
    });

    // BYOK and local zero-cost steps remain allowed even when estimatedPlatformCostMicros is omitted
    expect(
      authorizeModelRoute({
        guardrail: tier0NearBurst,
        credentialMode: "byok",
        stepKind: "standard_draft",
      }),
    ).toMatchObject({
      target: "byok_isolated",
      allowByokModelCall: true,
      platformBudgetDebitMicros: 0n,
    });
  });
});

describe("commercial-resilience: micro-unit three-ledger accounting & creator royalties", () => {
  it("separates provider cost ledger, enforces BYOK 0n platform cost, and deduplicates idempotently", () => {
    let ledger = createProviderCostLedger();

    const platformEntry = createProviderCostEntry({
      entryId: "pc-1",
      idempotencyKey: "req-1",
      accountId: "learner-1",
      requestId: "req-1",
      provider: "openai",
      sku: "gpt-4.1-mini",
      fundingSource: "platform",
      currency: "USD",
      supplierCostMicros: 12_500n,
      inputTokens: 1500,
      outputTokens: 400,
      cachedInputTokens: 900,
      recordedAtMs: 1_700_000_000_000,
    });

    const byokEntry = createProviderCostEntry({
      entryId: "pc-2",
      idempotencyKey: "req-2",
      accountId: "learner-1",
      requestId: "req-2",
      provider: "anthropic",
      sku: "claude-sonnet",
      fundingSource: "byok",
      currency: "USD",
      supplierCostMicros: 95_000n,
      inputTokens: 2000,
      outputTokens: 600,
      recordedAtMs: 1_700_000_001_000,
    });

    expect(byokEntry.platformCostMicros).toBe(0n);
    expect(byokEntry.canMintCreatorRoyalty).toBe(false);

    const r1 = appendProviderCostEntry(ledger, platformEntry);
    ledger = r1.ledger;
    expect(r1.idempotentReplay).toBe(false);

    // Exact idempotent replay does not double-count
    const r1Replay = appendProviderCostEntry(ledger, platformEntry);
    expect(r1Replay.idempotentReplay).toBe(true);
    expect(r1Replay.ledger.entries).toHaveLength(1);

    // Conflicting payload on same idempotencyKey fails closed
    expect(() =>
      appendProviderCostEntry(ledger, {
        ...platformEntry,
        supplierCostMicros: 12_501n,
        platformCostMicros: 12_501n,
      }),
    ).toThrow(CommercialResilienceError);

    // Forged BYOK entry carrying platformCostMicros > 0n is rejected
    expect(() =>
      appendProviderCostEntry(ledger, {
        ...byokEntry,
        platformCostMicros: 1n,
      }),
    ).toThrow(CommercialResilienceError);

    ledger = appendProviderCostEntry(ledger, byokEntry).ledger;

    const summary = summarizeProviderCostLedger(ledger, {
      currency: "USD",
      accountId: "learner-1",
    });
    expect(summary).toEqual({
      currency: "USD",
      totalPlatformCostMicros: 12_500n,
      totalByokObservedCostMicros: 95_000n,
      platformEntryCount: 1,
      byokEntryCount: 1,
    });
  });

  it("enforces learner credit balance >= 0n, idempotency, and bounded refund/reversal linkage", () => {
    let ledger = createLearnerCreditLedger();

    const grant = createLearnerCreditEntry({
      entryId: "lc-grant-1",
      idempotencyKey: "grant-1",
      accountId: "learner-1",
      currency: "USD",
      operation: "grant",
      amountMicros: 5_000_000n,
      recordedAtMs: 1_700_000_000_000,
    });
    ledger = appendLearnerCreditEntry(ledger, grant).ledger;
    expect(getLearnerCreditBalance(ledger, "learner-1", "USD")).toBe(5_000_000n);

    // Idempotent replay of grant does not mint duplicate credits
    const grantReplay = appendLearnerCreditEntry(ledger, grant);
    expect(grantReplay.idempotentReplay).toBe(true);
    expect(getLearnerCreditBalance(grantReplay.ledger, "learner-1", "USD")).toBe(
      5_000_000n,
    );

    const consume = createLearnerCreditEntry({
      entryId: "lc-consume-1",
      idempotencyKey: "consume-1",
      accountId: "learner-1",
      currency: "USD",
      operation: "consumption",
      amountMicros: 3_000_000n,
      recordedAtMs: 1_700_000_010_000,
    });
    ledger = appendLearnerCreditEntry(ledger, consume).ledger;
    expect(getLearnerCreditBalance(ledger, "learner-1", "USD")).toBe(2_000_000n);

    // Overdraft attempt is strictly rejected (balance invariant >= 0n)
    expect(() =>
      appendLearnerCreditEntry(
        ledger,
        createLearnerCreditEntry({
          entryId: "lc-overdraft",
          idempotencyKey: "overdraft-1",
          accountId: "learner-1",
          currency: "USD",
          operation: "consumption",
          amountMicros: 2_000_001n,
          recordedAtMs: 1_700_000_020_000,
        }),
      ),
    ).toThrow(CommercialResilienceError);

    // Partial refund linked to consumption succeeds; refund exceeding original consumption fails
    ledger = appendLearnerCreditEntry(
      ledger,
      createLearnerCreditEntry({
        entryId: "lc-refund-1",
        idempotencyKey: "refund-1",
        accountId: "learner-1",
        currency: "USD",
        operation: "refund",
        amountMicros: 1_000_000n,
        referenceEntryId: "lc-consume-1",
        recordedAtMs: 1_700_000_030_000,
      }),
    ).ledger;
    expect(getLearnerCreditBalance(ledger, "learner-1", "USD")).toBe(3_000_000n);

    expect(() =>
      appendLearnerCreditEntry(
        ledger,
        createLearnerCreditEntry({
          entryId: "lc-refund-excess",
          idempotencyKey: "refund-excess",
          accountId: "learner-1",
          currency: "USD",
          operation: "refund",
          amountMicros: 2_000_001n,
          referenceEntryId: "lc-consume-1",
          recordedAtMs: 1_700_000_040_000,
        }),
      ),
    ).toThrow(CommercialResilienceError);

    // Grant reversal succeeds up to available balance and refuses overdraft
    ledger = appendLearnerCreditEntry(
      ledger,
      createLearnerCreditEntry({
        entryId: "lc-reversal-1",
        idempotencyKey: "reversal-1",
        accountId: "learner-1",
        currency: "USD",
        operation: "reversal",
        amountMicros: 3_000_000n,
        referenceEntryId: "lc-grant-1",
        recordedAtMs: 1_700_000_050_000,
      }),
    ).ledger;
    expect(getLearnerCreditBalance(ledger, "learner-1", "USD")).toBe(0n);

    // Fail-closed: unlinked refund or reversal (missing/null/blank referenceEntryId) is rejected in both factory and append
    const expectInvalidRef = (fn: () => unknown) => {
      try {
        fn();
        expect.unreachable("Expected CommercialResilienceError");
      } catch (err) {
        expect(err).toBeInstanceOf(CommercialResilienceError);
        expect((err as CommercialResilienceError).code).toBe(
          "INVALID_REFERENCE_ENTRY",
        );
      }
    };

    expectInvalidRef(() =>
      createLearnerCreditEntry({
        entryId: "lc-unlinked-refund",
        idempotencyKey: "unlinked-refund",
        accountId: "learner-1",
        currency: "USD",
        operation: "refund",
        amountMicros: 1_000_000n,
        referenceEntryId: null as unknown as string,
        recordedAtMs: 1_700_000_060_000,
      }),
    );

    expectInvalidRef(() =>
      createLearnerCreditEntry({
        entryId: "lc-unlinked-reversal",
        idempotencyKey: "unlinked-reversal",
        accountId: "learner-1",
        currency: "USD",
        operation: "reversal",
        amountMicros: 1_000_000n,
        referenceEntryId: "   ",
        recordedAtMs: 1_700_000_061_000,
      }),
    );

    // Bypassing createLearnerCreditEntry with forged null referenceEntryId is also blocked by appendLearnerCreditEntry
    expectInvalidRef(() =>
      appendLearnerCreditEntry(ledger, {
        ledgerKind: "learner_credit_entry",
        entryId: "lc-forged-unlinked-refund",
        idempotencyKey: "forged-unlinked-refund",
        accountId: "learner-1",
        currency: "USD",
        operation: "refund",
        amountMicros: 999_000_000n,
        signedDeltaMicros: 999_000_000n,
        referenceEntryId: null,
        recordedAtMs: 1_700_000_062_000,
      }),
    );

    expectInvalidRef(() =>
      appendLearnerCreditEntry(ledger, {
        ledgerKind: "learner_credit_entry",
        entryId: "lc-forged-unlinked-reversal",
        idempotencyKey: "forged-unlinked-reversal",
        accountId: "learner-1",
        currency: "USD",
        operation: "reversal",
        amountMicros: 1_000_000n,
        signedDeltaMicros: -1_000_000n,
        referenceEntryId: null,
        recordedAtMs: 1_700_000_063_000,
      }),
    );
  });

  it("enforces self-purchase/related-party/BYOK 0n exclusion and 70% vs 73.5% (1.05x) quality multiplier", () => {
    const netBaseInput = {
      buyerAccountId: "buyer-1",
      creatorAccountId: "creator-1",
      grossReceiptsMicros: 100n * MICROS_PER_UNIT,
      channelFeeMicros: 5n * MICROS_PER_UNIT,
      refundsMicros: 15n * MICROS_PER_UNIT, // N_net = 80_000_000n
    };

    // Qualifying cohort: N >= 30, T7 >= 0.60, severeLeakCount === 0 => 73.5% (1.05x)
    const qualified = calculateCreatorRoyalty({
      ...netBaseInput,
      quality: {
        eligibleCohortSize: 30,
        blindSevenDayTransferRate: 0.6,
        severeLeakCount: 0,
      },
    });
    expect(qualified).toEqual({
      netReceiptsMicros: 80_000_000n,
      ratePermille: 735n,
      qualityMultiplierApplied: true,
      royaltyMicros: 58_800_000n, // 80 * 0.735 = 58.80
      excludedReason: null,
    });

    // Cohort size < 30 => base 70%
    const smallCohort = calculateCreatorRoyalty({
      ...netBaseInput,
      quality: {
        eligibleCohortSize: 29,
        blindSevenDayTransferRate: 0.95,
        severeLeakCount: 0,
      },
    });
    expect(smallCohort).toEqual({
      netReceiptsMicros: 80_000_000n,
      ratePermille: 700n,
      qualityMultiplierApplied: false,
      royaltyMicros: 56_000_000n, // 80 * 0.70 = 56.00
      excludedReason: null,
    });

    // T7 < 0.60 => base 70%
    const lowTransfer = calculateCreatorRoyalty({
      ...netBaseInput,
      quality: {
        eligibleCohortSize: 100,
        blindSevenDayTransferRate: 0.5999,
        severeLeakCount: 0,
      },
    });
    expect(lowTransfer.ratePermille).toBe(700n);
    expect(lowTransfer.qualityMultiplierApplied).toBe(false);
    expect(lowTransfer.royaltyMicros).toBe(56_000_000n);

    // Severe leak > 0 => base 70% even with huge cohort & high T7
    const leakyCartridge = calculateCreatorRoyalty({
      ...netBaseInput,
      quality: {
        eligibleCohortSize: 200,
        blindSevenDayTransferRate: 0.9,
        severeLeakCount: 1,
      },
    });
    expect(leakyCartridge.ratePermille).toBe(700n);
    expect(leakyCartridge.qualityMultiplierApplied).toBe(false);
    expect(leakyCartridge.royaltyMicros).toBe(56_000_000n);

    // Self-purchase (including whitespace padding spoof attempt) => 0n excluded
    const selfPurchase = calculateCreatorRoyalty({
      ...netBaseInput,
      buyerAccountId: " creator-1 ",
      quality: {
        eligibleCohortSize: 50,
        blindSevenDayTransferRate: 0.8,
        severeLeakCount: 0,
      },
    });
    expect(selfPurchase).toMatchObject({
      royaltyMicros: 0n,
      ratePermille: 0n,
      qualityMultiplierApplied: false,
      excludedReason: "self_or_related_party",
    });

    // Related-party flag or relatedPartyAccountIds => 0n excluded
    const relatedFlag = calculateCreatorRoyalty({
      ...netBaseInput,
      isRelatedParty: true,
      quality: {
        eligibleCohortSize: 50,
        blindSevenDayTransferRate: 0.8,
        severeLeakCount: 0,
      },
    });
    expect(relatedFlag.royaltyMicros).toBe(0n);
    expect(relatedFlag.excludedReason).toBe("self_or_related_party");

    const relatedSet = calculateCreatorRoyalty({
      ...netBaseInput,
      relatedPartyAccountIds: ["buyer-1"],
      quality: {
        eligibleCohortSize: 50,
        blindSevenDayTransferRate: 0.8,
        severeLeakCount: 0,
      },
    });
    expect(relatedSet.royaltyMicros).toBe(0n);
    expect(relatedSet.excludedReason).toBe("self_or_related_party");

    // BYOK source cannot mint creator royalties
    const byokExcluded = calculateCreatorRoyalty({
      ...netBaseInput,
      fundingSource: "byok",
      quality: {
        eligibleCohortSize: 50,
        blindSevenDayTransferRate: 0.8,
        severeLeakCount: 0,
      },
    });
    expect(byokExcluded.royaltyMicros).toBe(0n);
    expect(byokExcluded.excludedReason).toBe("byok_excluded");
  });

  it("enforces T+14d escrow freeze, within-window refund pro-rating/voiding, and release gating", () => {
    const settledAt = Date.UTC(2026, 10, 1, 12, 0, 0);
    let ledger = createCreatorRoyaltyLedger();

    // Purchase A: partial refund within 14d pro-rates escrow, then releases cleanly at exact T+14d
    ledger = appendCreatorRoyaltyAccrual(ledger, {
      entryId: "cr-a-1",
      idempotencyKey: "accrual-a",
      purchaseId: "order-a",
      creatorAccountId: "creator-1",
      buyerAccountId: "buyer-1",
      cartridgeId: "cs408-os",
      currency: "USD",
      settledPurchaseAtMs: settledAt,
      grossReceiptsMicros: 100_000_000n,
      channelFeeMicros: 10_000_000n, // net = 90_000_000n -> 73.5% = 66_150_000n
      quality: {
        eligibleCohortSize: 40,
        blindSevenDayTransferRate: 0.72,
        severeLeakCount: 0,
      },
    }).ledger;

    // 1 ms before T+14d: still pending_escrow and release throws ESCROW_NOT_MATURED
    const oneMsBefore = settledAt + ROYALTY_ESCROW_WINDOW_MS - 1;
    const beforePosition = projectCreatorRoyaltyPosition(
      ledger,
      "order-a",
      oneMsBefore,
    );
    expect(beforePosition.status).toBe("pending_escrow");
    expect(beforePosition.escrowMaturedAtEvaluation).toBe(false);
    expect(beforePosition.remainingEscrowMs).toBe(1);
    expect(beforePosition.releasableMicros).toBe(0n);
    expect(beforePosition.royaltyMicros).toBe(66_150_000n);

    expect(() =>
      appendCreatorRoyaltyRelease(ledger, {
        entryId: "cr-a-early",
        idempotencyKey: "release-a-early",
        purchaseId: "order-a",
        nowMs: oneMsBefore,
      }),
    ).toThrow(CommercialResilienceError);

    // Partial refund of $30 on day 5 pro-rates net to $60 -> 73.5% = $44.10
    ledger = appendCreatorRoyaltyRefund(ledger, {
      entryId: "cr-a-ref-1",
      idempotencyKey: "refund-a-1",
      purchaseId: "order-a",
      additionalRefundMicros: 30_000_000n,
      refundOccurredAtMs: settledAt + 5 * DAY_MS,
    }).ledger;

    const proRated = projectCreatorRoyaltyPosition(
      ledger,
      "order-a",
      settledAt + 5 * DAY_MS,
    );
    expect(proRated.status).toBe("pending_escrow");
    expect(proRated.netReceiptsMicros).toBe(60_000_000n);
    expect(proRated.royaltyMicros).toBe(44_100_000n);

    // At exact T+14d, release succeeds
    const exactMaturity = settledAt + ROYALTY_ESCROW_WINDOW_MS;
    ledger = appendCreatorRoyaltyRelease(ledger, {
      entryId: "cr-a-rel",
      idempotencyKey: "release-a",
      purchaseId: "order-a",
      nowMs: exactMaturity,
    }).ledger;

    const released = projectCreatorRoyaltyPosition(
      ledger,
      "order-a",
      exactMaturity,
    );
    expect(released.status).toBe("released");
    expect(released.releasedEntryId).toBe("cr-a-rel");
    expect(released.releasedMicros).toBe(44_100_000n);
    expect(released.clawedBackMicros).toBe(0n);
    expect(released.netSettledMicros).toBe(44_100_000n);
    expect(released.payableOffsetMicros).toBe(0n);

    // Delayed day-13 refund webhook arriving on day 15 appends an immutable post_release_clawback
    // referencing cr-a-rel WITHOUT mutating the released entry in place
    const releaseEntryBefore = ledger.entries.find(
      (item) => item.entryId === "cr-a-rel",
    );
    const partialClawback = appendCreatorRoyaltyRefund(ledger, {
      entryId: "cr-a-claw-1",
      idempotencyKey: "refund-a-day13-delayed",
      purchaseId: "order-a",
      additionalRefundMicros: 20_000_000n, // net $60 -> $40 => 73.5% = $29.40, clawback = -$14.70
      refundOccurredAtMs: settledAt + 13 * DAY_MS,
      recordedAtMs: exactMaturity + DAY_MS,
    });
    ledger = partialClawback.ledger;
    expect(partialClawback.entry.eventType).toBe("post_release_clawback");
    expect(partialClawback.entry.referenceEntryId).toBe("cr-a-rel");
    expect(partialClawback.entry.deltaRoyaltyMicros).toBe(-14_700_000n);
    expect(partialClawback.entry.resultingRoyaltyMicros).toBe(29_400_000n);
    expect(partialClawback.entry.statusAfterEvent).toBe("partially_clawed_back");

    // Original released entry remains 100% immutable
    expect(
      ledger.entries.find((item) => item.entryId === "cr-a-rel"),
    ).toEqual(releaseEntryBefore);

    // Exact idempotent replay of post-release clawback does NOT double-claw back
    const clawbackReplay = recordPostReleaseRoyaltyClawback(ledger, {
      entryId: "cr-a-claw-1",
      idempotencyKey: "refund-a-day13-delayed",
      purchaseId: "order-a",
      additionalRefundMicros: 20_000_000n,
      refundOccurredAtMs: settledAt + 13 * DAY_MS,
      recordedAtMs: exactMaturity + DAY_MS,
    });
    expect(clawbackReplay.idempotentReplay).toBe(true);
    expect(clawbackReplay.ledger.entries).toHaveLength(ledger.entries.length);

    const afterPartialClawback = projectCreatorRoyaltyPosition(
      ledger,
      "order-a",
      exactMaturity + DAY_MS,
    );
    expect(afterPartialClawback).toMatchObject({
      status: "partially_clawed_back",
      releasedEntryId: "cr-a-rel",
      releasedMicros: 44_100_000n,
      clawedBackMicros: 14_700_000n,
      netSettledMicros: 29_400_000n,
      payableOffsetMicros: -14_700_000n,
      royaltyMicros: 29_400_000n,
    });

    // Subsequent full chargeback ($100) caps cumulative clawback at originally released $44.10
    const fullClawback = recordPostReleaseRoyaltyClawback(ledger, {
      entryId: "cr-a-claw-2",
      idempotencyKey: "refund-a-full-chargeback",
      purchaseId: "order-a",
      additionalRefundMicros: 100_000_000n,
      refundOccurredAtMs: exactMaturity + 2 * DAY_MS,
    });
    ledger = fullClawback.ledger;
    expect(fullClawback.entry.deltaRoyaltyMicros).toBe(-29_400_000n);
    expect(fullClawback.entry.resultingRoyaltyMicros).toBe(0n);
    expect(fullClawback.entry.statusAfterEvent).toBe("clawed_back");

    const afterFullClawback = projectCreatorRoyaltyPosition(
      ledger,
      "order-a",
      exactMaturity + 2 * DAY_MS,
    );
    expect(afterFullClawback).toMatchObject({
      status: "clawed_back",
      releasedMicros: 44_100_000n,
      clawedBackMicros: 44_100_000n,
      netSettledMicros: 0n,
      payableOffsetMicros: -44_100_000n,
      royaltyMicros: 0n,
    });

    // Further clawback after full exhaustion fails closed (never double-claws back)
    try {
      recordPostReleaseRoyaltyClawback(ledger, {
        entryId: "cr-a-claw-3",
        idempotencyKey: "refund-a-over-claw",
        purchaseId: "order-a",
        additionalRefundMicros: 1_000_000n,
        refundOccurredAtMs: exactMaturity + 3 * DAY_MS,
      });
      expect.unreachable("Expected ROYALTY_CLAWBACK_EXHAUSTED");
    } catch (err) {
      expect(err).toBeInstanceOf(CommercialResilienceError);
      expect((err as CommercialResilienceError).code).toBe(
        "ROYALTY_CLAWBACK_EXHAUSTED",
      );
    }

    // Re-releasing a clawed-back purchase is forbidden
    expect(() =>
      appendCreatorRoyaltyRelease(ledger, {
        entryId: "cr-a-rel-dup",
        idempotencyKey: "release-a-dup",
        purchaseId: "order-a",
        nowMs: exactMaturity + 3 * DAY_MS,
      }),
    ).toThrow(CommercialResilienceError);

    // Creator payable summary nets matured releasable earnings against post-release clawbacks
    ledger = appendCreatorRoyaltyAccrual(ledger, {
      entryId: "cr-d-1",
      idempotencyKey: "accrual-d",
      purchaseId: "order-d",
      creatorAccountId: "creator-1",
      buyerAccountId: "buyer-4",
      cartridgeId: "cs408-os",
      currency: "USD",
      settledPurchaseAtMs: settledAt,
      grossReceiptsMicros: 100_000_000n,
      channelFeeMicros: 0n, // 70% = 70_000_000n matured releasable
      quality: {
        eligibleCohortSize: 10,
        blindSevenDayTransferRate: 0.5,
        severeLeakCount: 0,
      },
    }).ledger;

    const payableSummary = summarizeCreatorRoyaltyPayableBalance(ledger, {
      creatorAccountId: "creator-1",
      currency: "USD",
      nowMs: exactMaturity + 3 * DAY_MS,
    });
    expect(payableSummary).toEqual({
      creatorAccountId: "creator-1",
      currency: "USD",
      pendingEscrowMicros: 0n,
      maturedReleasableMicros: 70_000_000n,
      grossReleasedMicros: 44_100_000n,
      postReleaseClawbackMicros: 44_100_000n,
      netPayableMicros: 25_900_000n, // 70_000_000n matured - 44_100_000n clawback offset
      netSettledLifetimeMicros: 0n,
    });

    // Purchase B: full chargeback within 14d voids escrowed entry cleanly before release
    ledger = appendCreatorRoyaltyAccrual(ledger, {
      entryId: "cr-b-1",
      idempotencyKey: "accrual-b",
      purchaseId: "order-b",
      creatorAccountId: "creator-1",
      buyerAccountId: "buyer-2",
      cartridgeId: "cs408-os",
      currency: "USD",
      settledPurchaseAtMs: settledAt,
      grossReceiptsMicros: 50_000_000n,
      channelFeeMicros: 2_000_000n,
      quality: {
        eligibleCohortSize: 10,
        blindSevenDayTransferRate: 0.5,
        severeLeakCount: 0,
      },
    }).ledger;

    ledger = appendCreatorRoyaltyRefund(ledger, {
      entryId: "cr-b-void",
      idempotencyKey: "refund-b-full",
      purchaseId: "order-b",
      additionalRefundMicros: 50_000_000n,
      refundOccurredAtMs: settledAt + 10 * DAY_MS,
    }).ledger;

    const voided = projectCreatorRoyaltyPosition(
      ledger,
      "order-b",
      exactMaturity,
    );
    expect(voided.status).toBe("voided");
    expect(voided.royaltyMicros).toBe(0n);
    expect(voided.releasableMicros).toBe(0n);

    expect(() =>
      appendCreatorRoyaltyRelease(ledger, {
        entryId: "cr-b-rel",
        idempotencyKey: "release-b",
        purchaseId: "order-b",
        nowMs: exactMaturity,
      }),
    ).toThrow(CommercialResilienceError);

    // Purchase C: self-purchase is permanently excluded and can never release
    ledger = appendCreatorRoyaltyAccrual(ledger, {
      entryId: "cr-c-1",
      idempotencyKey: "accrual-c",
      purchaseId: "order-c",
      creatorAccountId: "creator-1",
      buyerAccountId: "creator-1",
      cartridgeId: "cs408-os",
      currency: "USD",
      settledPurchaseAtMs: settledAt,
      grossReceiptsMicros: 50_000_000n,
      channelFeeMicros: 0n,
      quality: {
        eligibleCohortSize: 100,
        blindSevenDayTransferRate: 0.9,
        severeLeakCount: 0,
      },
    }).ledger;

    expect(() =>
      appendCreatorRoyaltyRelease(ledger, {
        entryId: "cr-c-rel",
        idempotencyKey: "release-c",
        purchaseId: "order-c",
        nowMs: exactMaturity,
      }),
    ).toThrow(CommercialResilienceError);
  });
});

describe("commercial-resilience: bilateral-privacy cohort heatmap & LTI 1.3 validator", () => {
  const validWeek = parseIsoWeekKey("2026-W47");

  it("enforces zero solo-UI pollution for solo learners regardless of role", () => {
    expect(resolveCohortSurfacePolicy({ mode: "solo", role: "learner" })).toEqual(
      {
        mode: "solo",
        role: "learner",
        cohortSurfaceVisible: false,
        allowCohortQueries: false,
        widgets: [],
        allowPrivateSoloNotesAccess: false,
        allowRawAttemptTranscriptAccess: false,
        reason: "solo_mode_isolated",
      },
    );

    expect(
      resolveCohortSurfacePolicy({ mode: "solo", role: "instructor" })
        .cohortSurfaceVisible,
    ).toBe(false);

    const soloHeatmap = buildCohortHeatmap({
      mode: "solo",
      role: "instructor",
      window: {
        weekStartUtcMs: validWeek.weekStartUtcMs,
        weekEndUtcMs: validWeek.weekEndUtcMs,
      },
      evaluatedAtMs: validWeek.weekEndUtcMs,
      frozenRosterDigest: "sha256:solo-ignored",
      cells: [{ skillId: "os-paging", enrolledActiveCount: 30, eventLearnerCount: 15 }],
    });
    expect(soloHeatmap).toEqual({
      cohortSurfaceVisible: false,
      window: null,
      finalizedAtMs: null,
      frozenRosterDigest: null,
      cells: [],
      disclosedCellCount: 0,
      suppressedCellCount: 0,
    });
  });

  it("enforces bilateral privacy gate N >= 10 && E >= 5 && (N - E) >= 5 with uniform non-leaking suppression", () => {
    // Disclosed boundary: (N=10, E=5) => N-E = 5 >= 5
    expect(
      evaluateBilateralPrivacyCell({
        skillId: "s-10-5",
        enrolledActiveCount: 10,
        eventLearnerCount: 5,
      }),
    ).toEqual({
      skillId: "s-10-5",
      suppressed: false,
      enrolledActiveCount: 10,
      eventLearnerCount: 5,
      complementLearnerCount: 5,
      eventRate: 0.5,
      eventRateBps: 5000,
      suppressionReason: null,
    });

    // Suppressed bilateral upper tail: (N=10, E=6) => N-E = 4 < 5
    const upperTail = evaluateBilateralPrivacyCell({
      skillId: "s-10-6",
      enrolledActiveCount: 10,
      eventLearnerCount: 6,
    });
    // Suppressed bilateral lower tail: (N=10, E=4) => E = 4 < 5
    const lowerTail = evaluateBilateralPrivacyCell({
      skillId: "s-10-4",
      enrolledActiveCount: 10,
      eventLearnerCount: 4,
    });
    // Suppressed small cohort: (N=9, E=5)
    const smallCohort = evaluateBilateralPrivacyCell({
      skillId: "s-9-5",
      enrolledActiveCount: 9,
      eventLearnerCount: 5,
    });
    // Suppressed unanimous: (N=10, E=10) and (N=10, E=0)
    const allEvent = evaluateBilateralPrivacyCell({
      skillId: "s-10-10",
      enrolledActiveCount: 10,
      eventLearnerCount: 10,
    });
    const zeroEvent = evaluateBilateralPrivacyCell({
      skillId: "s-10-0",
      enrolledActiveCount: 10,
      eventLearnerCount: 0,
    });

    for (const suppressedCell of [
      upperTail,
      lowerTail,
      smallCohort,
      allEvent,
      zeroEvent,
    ]) {
      expect(suppressedCell.suppressed).toBe(true);
      expect(suppressedCell.enrolledActiveCount).toBeNull();
      expect(suppressedCell.eventLearnerCount).toBeNull();
      expect(suppressedCell.complementLearnerCount).toBeNull();
      expect(suppressedCell.eventRate).toBeNull();
      expect(suppressedCell.eventRateBps).toBeNull();
      // Uniform reason prevents leaking whether E < 5 or N - E < 5
      expect(suppressedCell.suppressionReason).toBe(
        "bilateral_privacy_threshold",
      );
    }

    // (N=11, E=6) => N-E = 5 >= 5 disclosed; (N=11, E=7) => N-E = 4 < 5 suppressed
    expect(
      evaluateBilateralPrivacyCell({
        skillId: "s-11-6",
        enrolledActiveCount: 11,
        eventLearnerCount: 6,
      }).suppressed,
    ).toBe(false);
    expect(
      evaluateBilateralPrivacyCell({
        skillId: "s-11-7",
        enrolledActiveCount: 11,
        eventLearnerCount: 7,
      }).suppressed,
    ).toBe(true);

    // Invalid E > N throws
    expect(() =>
      evaluateBilateralPrivacyCell({
        skillId: "s-bad",
        enrolledActiveCount: 10,
        eventLearnerCount: 11,
      }),
    ).toThrow(CommercialResilienceError);
  });

  it("locks cohort aggregation strictly to immutable ISO calendar weeks and deduplicates per learner", () => {
    expect(validWeek.isoWeekKey).toBe("2026-W47");
    expect(validWeek.weekStartUtcMs).toBe(Date.UTC(2026, 10, 16, 0, 0, 0));
    expect(validWeek.weekEndUtcMs).toBe(Date.UTC(2026, 10, 23, 0, 0, 0));
    expect(getIsoWeekWindowForTimestamp(Date.UTC(2026, 10, 21, 15, 30, 0))).toEqual(
      validWeek,
    );

    // Sliding window shifted by +1 hour MUST be rejected
    expect(() =>
      validateFixedIsoWeekWindow({
        weekStartUtcMs: validWeek.weekStartUtcMs + 3_600_000,
        weekEndUtcMs: validWeek.weekEndUtcMs + 3_600_000,
      }),
    ).toThrow(CommercialResilienceError);

    // Multi-week window (14d) or partial window (6d) MUST be rejected
    expect(() =>
      validateFixedIsoWeekWindow({
        weekStartUtcMs: validWeek.weekStartUtcMs,
        weekEndUtcMs: validWeek.weekStartUtcMs + 2 * WEEK_MS,
      }),
    ).toThrow(CommercialResilienceError);

    expect(() =>
      validateFixedIsoWeekWindow({
        weekStartUtcMs: validWeek.weekStartUtcMs,
        weekEndUtcMs: validWeek.weekStartUtcMs + 6 * DAY_MS,
      }),
    ).toThrow(CommercialResilienceError);

    // Non-existent W53 in a 52-week year (2025 had 52 ISO weeks; 2026 has 53)
    expect(() => parseIsoWeekKey("2025-W53")).toThrow(CommercialResilienceError);
    expect(parseIsoWeekKey("2026-W53").isoWeekKey).toBe("2026-W53");

    // Repeated events from ONE learner cannot inflate E from 1 to 5; in-progress weeks fail closed; late enrollees are excluded from frozen roster
    const enrolledRoster = Array.from({ length: 10 }, (_, idx) => ({
      learnerId: `stu-${idx + 1}`,
      enrolledAtMs: validWeek.weekStartUtcMs - DAY_MS,
    }));
    const rosterWithLateEnrollee = [
      ...enrolledRoster,
      {
        learnerId: "stu-late-11",
        enrolledAtMs: validWeek.weekEndUtcMs + 1, // enrolled AFTER week close -> excluded from frozen roster
      },
    ];

    // In-progress week (evaluatedAtMs < weekEndUtcMs) MUST fail closed with COHORT_WEEK_NOT_FINALIZED
    for (const runOpenWeek of [
      () =>
        buildCohortHeatmap({
          mode: "cohort",
          role: "instructor",
          window: {
            weekStartUtcMs: validWeek.weekStartUtcMs,
            weekEndUtcMs: validWeek.weekEndUtcMs,
          },
          evaluatedAtMs: validWeek.weekEndUtcMs - 1,
          frozenRosterDigest: computeFrozenRosterDigest(
            validWeek,
            enrolledRoster.map((m) => m.learnerId),
          ),
          cells: [
            {
              skillId: "genuine-five-students",
              enrolledActiveCount: 10,
              eventLearnerCount: 5,
            },
          ],
        }),
      () =>
        aggregateCohortEventsToHeatmap({
          mode: "cohort",
          role: "instructor",
          window: {
            weekStartUtcMs: validWeek.weekStartUtcMs,
            weekEndUtcMs: validWeek.weekEndUtcMs,
          },
          evaluatedAtMs: validWeek.weekEndUtcMs - 1,
          enrolledRoster,
          skillIds: ["genuine-five-students"],
          events: [],
        }),
    ]) {
      try {
        runOpenWeek();
        expect.unreachable("Expected COHORT_WEEK_NOT_FINALIZED");
      } catch (err) {
        expect(err).toBeInstanceOf(CommercialResilienceError);
        expect((err as CommercialResilienceError).code).toBe(
          "COHORT_WEEK_NOT_FINALIZED",
        );
      }
    }

    const baseEvents = [
      // 1 student submits 6 times => distinct E = 1 (< 5) => SUPPRESSED!
      ...Array.from({ length: 6 }, (_, i) => ({
        learnerId: "stu-1",
        skillId: "spam-single-student",
        occurredAtMs: validWeek.weekStartUtcMs + (i + 1) * 60_000,
      })),
      // 5 distinct students inside the window (+ 1 event outside window + 1 late enrollee ignored) => E = 5, N-E = 5 => DISCLOSED!
      ...["stu-1", "stu-2", "stu-3", "stu-4", "stu-5"].map((id, i) => ({
        learnerId: id,
        skillId: "genuine-five-students",
        occurredAtMs: validWeek.weekStartUtcMs + (i + 1) * 60_000,
      })),
      {
        learnerId: "stu-6",
        skillId: "genuine-five-students",
        occurredAtMs: validWeek.weekEndUtcMs, // exclusive end boundary -> ignored
      },
      {
        learnerId: "stu-late-11",
        skillId: "genuine-five-students",
        occurredAtMs: validWeek.weekStartUtcMs + 15_000, // late enrollee -> excluded from frozen roster
      },
      {
        learnerId: "unenrolled-ghost",
        skillId: "genuine-five-students",
        occurredAtMs: validWeek.weekStartUtcMs + 10_000, // not enrolled -> ignored
      },
    ];

    const heatmap = aggregateCohortEventsToHeatmap({
      mode: "cohort",
      role: "instructor",
      window: {
        weekStartUtcMs: validWeek.weekStartUtcMs,
        weekEndUtcMs: validWeek.weekEndUtcMs,
      },
      evaluatedAtMs: validWeek.weekEndUtcMs,
      enrolledRoster: rosterWithLateEnrollee,
      skillIds: ["spam-single-student", "genuine-five-students"],
      events: baseEvents,
    });

    const heatmapWithoutLate = aggregateCohortEventsToHeatmap({
      mode: "cohort",
      role: "instructor",
      window: {
        weekStartUtcMs: validWeek.weekStartUtcMs,
        weekEndUtcMs: validWeek.weekEndUtcMs,
      },
      evaluatedAtMs: validWeek.weekEndUtcMs + 3_600_000,
      enrolledRoster: [...enrolledRoster].reverse(), // order-independent digest
      skillIds: ["spam-single-student", "genuine-five-students"],
      events: baseEvents,
    });

    expect(heatmap.cohortSurfaceVisible).toBe(true);
    expect(heatmap.finalizedAtMs).toBe(validWeek.weekEndUtcMs);
    expect(heatmap.frozenRosterDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(heatmap.frozenRosterDigest).toBe(
      heatmapWithoutLate.frozenRosterDigest,
    );
    expect(heatmap.disclosedCellCount).toBe(1);
    expect(heatmap.suppressedCellCount).toBe(1);
    expect(heatmap.cells[0]?.suppressed).toBe(true);
    expect(heatmap.cells[1]).toMatchObject({
      skillId: "genuine-five-students",
      suppressed: false,
      enrolledActiveCount: 10,
      eventLearnerCount: 5,
      complementLearnerCount: 5,
      eventRate: 0.5,
    });
  });

  it("validates LTI 1.3 deep-linking claims, binds initiated launch nonces, blocks spoofing/replay/expiry, and forbids private note/transcript leakage", () => {
    const nowMs = Date.UTC(2026, 10, 21, 8, 0, 0);
    const nowSec = Math.floor(nowMs / 1000);

    const policy: Lti13ValidationPolicy = {
      expectedIssuer: "https://lms.university.edu",
      expectedClientId: "aistudy-lti-client-1",
      allowedDeploymentIds: ["dep-cs408-2026"],
      expectedNonce: "fresh-nonce-abc123",
      nowMs,
      maxClockSkewSeconds: 30,
      usedNonces: new Set(["used-nonce-999"]),
      allowedReturnOrigins: ["https://lms.university.edu"],
      allowedCartridgeIds: ["cs408-os-v1"],
    };

    const validClaims: Lti13DeepLinkingClaimsPayload = {
      iss: "https://lms.university.edu",
      sub: "lti-user-42",
      aud: ["aistudy-lti-client-1", "other-aud"],
      azp: "aistudy-lti-client-1",
      nonce: "fresh-nonce-abc123",
      iat: nowSec - 10,
      exp: nowSec + 300,
      [LTI_CLAIM_VERSION]: LTI_13_VERSION,
      [LTI_CLAIM_MESSAGE_TYPE]: "LtiDeepLinkingRequest",
      [LTI_CLAIM_DEPLOYMENT_ID]: "dep-cs408-2026",
      [LTI_CLAIM_ROLES]: [
        "http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor",
      ],
      [LTI_CLAIM_CONTEXT]: { id: "course-ctx-408" },
      [LTI_CLAIM_RESOURCE_LINK]: {
        id: "rl-week47-os",
        target_link_uri: "https://app.aistudy.edu/lti/launch/cs408-os-v1",
      },
      [LTI_CLAIM_DEEP_LINKING_SETTINGS]: {
        deep_link_return_url: "https://lms.university.edu/lti/deep-link/return",
        accept_types: ["ltiResourceLink"],
      },
      [LTI_CLAIM_CUSTOM]: {
        cartridge_id: "cs408-os-v1",
        course_id: "cs408-fall-2026",
      },
    };

    const ok = validateLti13DeepLinkingClaims(validClaims, policy);
    expect(ok.valid).toBe(true);
    if (ok.valid) {
      expect(ok.context.mappedRole).toBe("instructor");
      expect(ok.context.targetResourceLink).toEqual({
        resourceLinkId: "rl-week47-os",
        cartridgeId: "cs408-os-v1",
        courseId: "cs408-fall-2026",
        targetLinkUri: "https://app.aistudy.edu/lti/launch/cs408-os-v1",
      });
      // Instructors get cohort heatmap only — NEVER solo private notes or raw attempt transcripts
      expect(ok.context.privacyBoundary).toEqual({
        canViewAggregatedCohortHeatmap: true,
        canAccessSoloLearnerPrivateNotes: false,
        canAccessRawAttemptTranscripts: false,
        canQuerySlidingTimeWindows: false,
      });
    }

    // Replayed nonce, expired token, wrong deployment, spoofed non-IMS role URI, and forbidden transcript scope all fail closed
    const bad = validateLti13DeepLinkingClaims(
      {
        ...validClaims,
        iss: "http://lms.university.edu", // insecure http downgrade
        azp: "wrong-azp",
        nonce: "used-nonce-999",
        iat: nowSec - 600,
        exp: nowSec - 31, // expired past skew
        [LTI_CLAIM_DEPLOYMENT_ID]: "dep-evil",
        [LTI_CLAIM_ROLES]: ["https://evil.example/Instructor"], // spoofed substring!
        [LTI_CLAIM_CUSTOM]: {
          cartridge_id: "../etc/passwd",
          solo_private_notes: "true",
          raw_attempt_transcripts: "true",
        },
      },
      policy,
    );

    expect(bad.valid).toBe(false);
    const codes = new Set(bad.errors.map((err) => err.code));
    expect(codes.has("INVALID_ISSUER")).toBe(true);
    expect(codes.has("INVALID_CLIENT_ID")).toBe(true);
    expect(codes.has("INVALID_DEPLOYMENT_ID")).toBe(true);
    expect(codes.has("NONCE_REPLAYED")).toBe(true);
    expect(codes.has("TOKEN_EXPIRED")).toBe(true);
    expect(codes.has("NO_VALID_LTI_ROLE")).toBe(true);
    expect(codes.has("INVALID_TARGET_RESOURCE_LINK")).toBe(true);
    expect(codes.has("FORBIDDEN_PRIVACY_SCOPE")).toBe(true);

    // Inverted timestamps (exp <= iat) fail closed with INVALID_TIMESTAMPS
    const invertedTimestamps = validateLti13DeepLinkingClaims(
      {
        ...validClaims,
        iat: nowSec - 10,
        exp: nowSec - 20,
      },
      policy,
    );
    expect(invertedTimestamps.valid).toBe(false);
    expect(invertedTimestamps.errors.map((e) => e.code)).toContain(
      "INVALID_TIMESTAMPS",
    );

    // OIDC Core §3.1.3.7: mismatched azp MUST fail even when aud is single-valued (string or 1-element array)
    for (const singleAud of [
      "aistudy-lti-client-1",
      ["aistudy-lti-client-1"],
    ] as const) {
      const badAzp = validateLti13DeepLinkingClaims(
        {
          ...validClaims,
          aud: singleAud,
          azp: "some-other-client",
        },
        policy,
      );
      expect(badAzp.valid).toBe(false);
      expect(badAzp.errors.map((e) => e.code)).toContain("INVALID_CLIENT_ID");

      const matchingAzp = validateLti13DeepLinkingClaims(
        {
          ...validClaims,
          aud: singleAud,
          azp: "aistudy-lti-client-1",
        },
        policy,
      );
      expect(matchingAzp.valid).toBe(true);
    }

    // Truthy non-string values on forbidden privacy custom keys (boolean true / number 1) MUST be rejected
    const nonStringForbiddenBool = validateLti13DeepLinkingClaims(
      {
        ...validClaims,
        [LTI_CLAIM_CUSTOM]: {
          cartridge_id: "cs408-os-v1",
          solo_private_notes: true,
        },
      },
      policy,
    );
    expect(nonStringForbiddenBool.valid).toBe(false);
    expect(nonStringForbiddenBool.errors.map((e) => e.code)).toContain(
      "FORBIDDEN_PRIVACY_SCOPE",
    );

    const nonStringForbiddenNum = validateLti13DeepLinkingClaims(
      {
        ...validClaims,
        [LTI_CLAIM_CUSTOM]: {
          cartridge_id: "cs408-os-v1",
          raw_attempt_transcripts: 1,
        },
      },
      policy,
    );
    expect(nonStringForbiddenNum.valid).toBe(false);
    expect(nonStringForbiddenNum.errors.map((e) => e.code)).toContain(
      "FORBIDDEN_PRIVACY_SCOPE",
    );

    // Explicitly disabled falsy values (false / 0) on forbidden keys stay allowed
    const falsyForbidden = validateLti13DeepLinkingClaims(
      {
        ...validClaims,
        [LTI_CLAIM_CUSTOM]: {
          cartridge_id: "cs408-os-v1",
          solo_private_notes: false,
          raw_attempt_transcripts: 0,
        },
      },
      policy,
    );
    expect(falsyForbidden.valid).toBe(true);

    // Forged / foreign launch nonce NOT in policy expectedNonce / issuedLaunchNonces MUST fail closed
    const foreignNonce = validateLti13DeepLinkingClaims(
      {
        ...validClaims,
        nonce: "forged-foreign-nonce-777",
      },
      policy,
    );
    expect(foreignNonce.valid).toBe(false);
    expect(foreignNonce.errors.map((e) => e.code)).toContain(
      "UNRECOGNIZED_NONCE",
    );

    // Consuming a valid initiated nonce returns nextUsedNonces so replay fails closed with NONCE_REPLAYED
    const multiNoncePolicy: Lti13ValidationPolicy = {
      expectedIssuer: policy.expectedIssuer,
      expectedClientId: policy.expectedClientId,
      allowedDeploymentIds: policy.allowedDeploymentIds,
      issuedLaunchNonces: ["fresh-nonce-abc123", "second-launch-nonce"],
      nowMs,
      maxClockSkewSeconds: 30,
      allowedReturnOrigins: policy.allowedReturnOrigins,
      allowedCartridgeIds: policy.allowedCartridgeIds,
    };
    const firstLaunch = validateLti13DeepLinkingClaims(
      validClaims,
      multiNoncePolicy,
    );
    expect(firstLaunch.valid).toBe(true);
    if (firstLaunch.valid) {
      expect(firstLaunch.consumedNonce).toBe("fresh-nonce-abc123");
      expect(firstLaunch.nextUsedNonces.has("fresh-nonce-abc123")).toBe(true);

      const replayedLaunch = validateLti13DeepLinkingClaims(validClaims, {
        ...multiNoncePolicy,
        usedNonces: firstLaunch.nextUsedNonces,
      });
      expect(replayedLaunch.valid).toBe(false);
      expect(replayedLaunch.errors.map((e) => e.code)).toContain(
        "NONCE_REPLAYED",
      );
    }

    // Empty issuedLaunchNonces allowlist in policy fails closed
    expect(() =>
      validateLti13DeepLinkingClaims(validClaims, {
        ...multiNoncePolicy,
        issuedLaunchNonces: [],
      }),
    ).toThrow(CommercialResilienceError);
  });

  it("satisfies deterministic property invariants across margin ceilings, bilateral privacy cells, and royalty splits", () => {
    // Property 1: Margin guardrail ceiling B, ceil(B/15), tier monotonicity, and zero-cost floor
    const budgets = [0n, 1n, 14n, 15n, 16n, 99n, 100n, 1_000_000n, 9_999_999n];
    for (const r of budgets) {
      for (const reserve of [0n, 10n, 500_000n]) {
        const env = computePeriodBudgetEnvelope({
          recognizedRevenueMicros: r,
          channelAndRefundReserveMicros: reserve,
          fixedInfraReserveMicros: 0n,
        });
        expect(env.periodBudgetCeilingMicros >= 0n).toBe(true);
        if (env.periodBudgetCeilingMicros === 0n) {
          expect(env.dailyBurstCapMicros).toBe(0n);
        } else {
          expect(env.dailyBurstCapMicros * 15n >= env.periodBudgetCeilingMicros).toBe(true);
          expect((env.dailyBurstCapMicros - 1n) * 15n < env.periodBudgetCeilingMicros).toBe(true);
        }

        // Monotonicity as periodSpend grows
        const b = env.periodBudgetCeilingMicros;
        const spendPoints = [0n, b / 2n, (70n * b) / 100n, (90n * b) / 100n, b, b + 1n];
        let prevTier = -1;
        for (const s of spendPoints) {
          const decision = evaluateMarginGuardrail({
            accountId: "prop-acct",
            currency: "CNY",
            recognizedRevenueMicros: r,
            channelAndRefundReserveMicros: reserve,
            fixedInfraReserveMicros: 0n,
            periodSpendMicros: s,
            dailySpendMicros: 0n,
          });
          expect(decision.tierLevel >= prevTier).toBe(true);
          expect(decision.localVerifyAndFlashcardsActive).toBe(true);
          expect(decision.allowPlatformCredentialFallbackForByok).toBe(false);
          expect(decision.allowPaidModelCall).toBe(!(b === 0n || s >= b));
          prevTier = decision.tierLevel;
        }
      }
    }

    // Property 2: Exhaustive bilateral privacy gate verification for 0 <= N <= 25, 0 <= E <= N
    for (let n = 0; n <= 25; n += 1) {
      for (let e = 0; e <= n; e += 1) {
        const cell = evaluateBilateralPrivacyCell({
          skillId: `skill-${n}-${e}`,
          enrolledActiveCount: n,
          eventLearnerCount: e,
        });
        const shouldDisclose = n >= 10 && e >= 5 && n - e >= 5;
        expect(cell.suppressed).toBe(!shouldDisclose);
        if (cell.suppressed) {
          expect(cell.enrolledActiveCount).toBeNull();
          expect(cell.eventLearnerCount).toBeNull();
          expect(cell.complementLearnerCount).toBeNull();
          expect(cell.eventRate).toBeNull();
          expect(cell.suppressionReason).toBe("bilateral_privacy_threshold");
        } else {
          expect(cell.enrolledActiveCount).toBe(n);
          expect(cell.eventLearnerCount).toBe(e);
          expect(cell.complementLearnerCount).toBe(n - e);
          expect(cell.eventLearnerCount >= 5).toBe(true);
          expect(cell.complementLearnerCount >= 5).toBe(true);
        }
      }
    }

    // Property 3: Royalty conservation & quality multiplier dominance
    for (const gross of [0n, 1n, 999n, 1_000_000n, 98_765_432n]) {
      for (const fee of [0n, 500n, 1_500_000n]) {
        const base = calculateCreatorRoyalty({
          buyerAccountId: "buyer-x",
          creatorAccountId: "creator-y",
          grossReceiptsMicros: gross,
          channelFeeMicros: fee,
          refundsMicros: 0n,
          quality: { eligibleCohortSize: 10, blindSevenDayTransferRate: 0.4, severeLeakCount: 0 },
        });
        const boosted = calculateCreatorRoyalty({
          buyerAccountId: "buyer-x",
          creatorAccountId: "creator-y",
          grossReceiptsMicros: gross,
          channelFeeMicros: fee,
          refundsMicros: 0n,
          quality: { eligibleCohortSize: 30, blindSevenDayTransferRate: 0.6, severeLeakCount: 0 },
        });
        expect(base.royaltyMicros >= 0n).toBe(true);
        expect(base.royaltyMicros <= base.netReceiptsMicros).toBe(true);
        expect(boosted.royaltyMicros >= base.royaltyMicros).toBe(true);
        expect(boosted.royaltyMicros <= boosted.netReceiptsMicros).toBe(true);
      }
    }
  });

  it("rejects refund idempotency conflicts and cross-ledger type confusion", () => {
    const settledAt = Date.UTC(2026, 10, 1, 0, 0, 0);
    let royaltyLedger = createCreatorRoyaltyLedger();
    royaltyLedger = appendCreatorRoyaltyAccrual(royaltyLedger, {
      entryId: "cr-idem-1",
      idempotencyKey: "accrual-idem-1",
      purchaseId: "order-idem-1",
      creatorAccountId: "creator-1",
      buyerAccountId: "buyer-1",
      cartridgeId: "cs408-os",
      currency: "USD",
      settledPurchaseAtMs: settledAt,
      grossReceiptsMicros: 50_000_000n,
      channelFeeMicros: 0n,
      quality: { eligibleCohortSize: 30, blindSevenDayTransferRate: 0.65, severeLeakCount: 0 },
    }).ledger;

    const firstRefund = appendCreatorRoyaltyRefund(royaltyLedger, {
      entryId: "cr-idem-ref-1",
      idempotencyKey: "ref-key-1",
      purchaseId: "order-idem-1",
      additionalRefundMicros: 10_000_000n,
      refundOccurredAtMs: settledAt + DAY_MS,
    });
    royaltyLedger = firstRefund.ledger;

    // Exact replay succeeds without double-refunding
    const replayRefund = appendCreatorRoyaltyRefund(royaltyLedger, {
      entryId: "cr-idem-ref-1",
      idempotencyKey: "ref-key-1",
      purchaseId: "order-idem-1",
      additionalRefundMicros: 10_000_000n,
      refundOccurredAtMs: settledAt + DAY_MS,
    });
    expect(replayRefund.idempotentReplay).toBe(true);

    // Same idempotencyKey with altered refund amount MUST fail closed
    expect(() =>
      appendCreatorRoyaltyRefund(royaltyLedger, {
        entryId: "cr-idem-ref-1",
        idempotencyKey: "ref-key-1",
        purchaseId: "order-idem-1",
        additionalRefundMicros: 20_000_000n,
        refundOccurredAtMs: settledAt + DAY_MS,
      }),
    ).toThrow(CommercialResilienceError);

    // Runtime cross-ledger kind guard rejects forged entry of wrong ledgerKind
    const providerEntry = createProviderCostEntry({
      entryId: "pc-cross",
      idempotencyKey: "pc-cross-key",
      accountId: "learner-1",
      requestId: "req-cross",
      provider: "openai",
      sku: "gpt-4.1",
      fundingSource: "platform",
      currency: "USD",
      supplierCostMicros: 1_000n,
      inputTokens: 10,
      outputTokens: 10,
      recordedAtMs: settledAt,
    });
    expect(() =>
      appendLearnerCreditEntry(
        createLearnerCreditLedger(),
        providerEntry as unknown as ReturnType<typeof createLearnerCreditEntry>,
      ),
    ).toThrow(CommercialResilienceError);
  });
});
