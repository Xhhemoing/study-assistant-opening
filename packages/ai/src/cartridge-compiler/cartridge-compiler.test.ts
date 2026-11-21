import { describe, expect, it } from "vitest";
import {
  CartridgePiiViolationError,
  GepaForbiddenSurfaceError,
  GepaInvalidPatchPayloadError,
  HoldoutFirewallError,
  InvalidRubricAnchorPairError,
  assertDisjointSplitInvariants,
  assertNoHoldoutLeakage,
  assertNoRawPiiInText,
  buildGepaReflectionContext,
  canonicalizeIdentifier,
  clusterErrorTrajectories,
  computeCandidateMetrics,
  createDisjointTrajectorySplit,
  evaluateParetoFrontierAndPromotion,
  exactClopperPearsonLowerBound,
  matchesRubricRule,
  proposeGepaReflectivePatches,
  runGepaOptimizationRound,
  validateAndApplyGepaPatch,
  validateRubricAnchorPair,
  type CartridgeCandidateMetrics,
  type CartridgeDeclarativePolicy,
  type ErrorTrajectoryRecord,
  type MisconceptionRubricRule,
} from "./index";

function makeTrajectory(
  overrides: Partial<ErrorTrajectoryRecord> & { trajectoryId: string },
): ErrorTrajectoryRecord {
  return {
    learnerPseudoId: "pseudo_learner_001",
    conceptId: "alg.zero_product_property",
    firstErrorRuleId: "err.divide_by_variable",
    normalizedAstEdit: "DIV_VAR(x)|DROP_BRANCH(x=0)",
    missingPremise: "x != 0",
    hintStage: 1,
    itemFamilyId: "fam.alg.quad_01",
    verifiableFirstError: true,
    selfRepairedInSession: true,
    abandoned: false,
    totalReleasedTurns: 2,
    leakedReleasedTurns: 0,
    severeLeakCount: 0,
    guardBlockedCount: 0,
    day7FollowupStatus: "mature",
    passedFreshFamilyTransfer: true,
    ...overrides,
  };
}

function makeBasePolicy(): CartridgeDeclarativePolicy {
  return {
    policyId: "cartridge_alg_v1",
    version: "1.0.0",
    moveRules: [],
    hintLadder: [],
    rubricAnchors: [],
    approvedTemplateSlots: {},
  };
}

function makeValidZeroDivisionRubric(
  ruleId = "rubric.alg.divide_by_x",
): MisconceptionRubricRule {
  return {
    ruleId,
    conceptId: "alg.zero_product_property",
    firstErrorRuleId: "err.divide_by_variable",
    requiredAstTokens: ["DIV_VAR(X)"],
    requiredMissingPremise: "x != 0",
    positiveAnchors: [
      {
        anchorId: "pos_div_x_unconditional",
        label: "positive",
        conceptId: "alg.zero_product_property",
        firstErrorRuleId: "err.divide_by_variable",
        normalizedAstEdit: "DIV_VAR(x)|DROP_BRANCH(x=0)",
        establishedPremises: [],
        expression: "x(x - 1) = 0 => x - 1 = 0",
        rationale: "Divided by x without checking x = 0.",
      },
    ],
    negativeAnchors: [
      {
        anchorId: "neg_div_x_given_nonzero",
        label: "negative",
        conceptId: "alg.zero_product_property",
        firstErrorRuleId: "err.divide_by_variable",
        normalizedAstEdit: "DIV_VAR(x)",
        establishedPremises: ["x != 0"],
        expression: "Given x != 0, x(x - 1) = 0 => x - 1 = 0",
        rationale: "Valid cancellation because x != 0 is explicitly established.",
      },
    ],
  };
}

describe("Gradescope dynamic error clustering & rubric anchor validation", () => {
  it("rejects raw PII fields and non-pseudonymized learner identifiers", () => {
    const withRawEmailField = {
      ...makeTrajectory({ trajectoryId: "t_pii_1" }),
      email: "alice@example.com",
    } as unknown as ErrorTrajectoryRecord;

    expect(() => clusterErrorTrajectories([withRawEmailField])).toThrow(
      CartridgePiiViolationError,
    );

    const withRawPseudoEmail = makeTrajectory({
      trajectoryId: "t_pii_2",
      learnerPseudoId: "bob@university.edu",
    });
    expect(() => clusterErrorTrajectories([withRawPseudoEmail])).toThrow(
      CartridgePiiViolationError,
    );

    const withPiiSnippet = makeTrajectory({
      trajectoryId: "t_pii_3",
      snippet: "Contact me at 555-867-5309 for my homework",
    });
    expect(() => clusterErrorTrajectories([withPiiSnippet])).toThrow(
      CartridgePiiViolationError,
    );
  });

  it("deterministically buckets by (conceptId, firstErrorRuleId), clusters AST edits, and flags support < minSupport as observation_only", () => {
    const actionableRecords = Array.from({ length: 6 }, (_, i) =>
      makeTrajectory({
        trajectoryId: `t_act_${i}`,
        learnerPseudoId: `pseudo_u_${i + 1}`,
        itemFamilyId: `fam_a_${(i % 2) + 1}`,
        hintStage: (i % 2) + 1,
        normalizedAstEdit: i % 2 === 0 ? "DIV_VAR(x) | DROP_BRANCH(x=0)" : "DROP_BRANCH(x=0); DIV_VAR(x)",
      }),
    );

    const lowSupportRecords = Array.from({ length: 3 }, (_, i) =>
      makeTrajectory({
        trajectoryId: `t_obs_${i}`,
        learnerPseudoId: `pseudo_v_${i + 1}`,
        conceptId: "linalg.matrix_left_cancellation",
        firstErrorRuleId: "err.singular_matrix_cancel",
        normalizedAstEdit: "CANCEL_LEFT_MATRIX(A)",
        missingPremise: "det(A) != 0",
        itemFamilyId: "fam_lin_01",
      }),
    );

    const summary1 = clusterErrorTrajectories([...actionableRecords, ...lowSupportRecords], {
      minSupport: 5,
    });
    const summary2 = clusterErrorTrajectories([...lowSupportRecords, ...actionableRecords], {
      minSupport: 5,
    });

    expect(JSON.stringify(summary1)).toBe(JSON.stringify(summary2));
    expect(summary1.actionableClusters).toHaveLength(1);
    expect(summary1.actionableClusters[0]!.supportCount).toBe(6);
    expect(summary1.actionableClusters[0]!.uniqueLearnerCount).toBe(6);
    expect(summary1.actionableClusters[0]!.status).toBe("actionable_candidate");

    expect(summary1.observationOnlyClusters).toHaveLength(1);
    expect(summary1.observationOnlyClusters[0]!.supportCount).toBe(3);
    expect(summary1.observationOnlyClusters[0]!.status).toBe("observation_only");
  });

  it("enforces positive + contrasting valid negative rubric anchor pair validation", () => {
    const validRule = makeValidZeroDivisionRubric();
    const validResult = validateRubricAnchorPair(validRule);
    expect(validResult.valid).toBe(true);
    expect(validResult.positiveFiredCount).toBe(1);
    expect(validResult.negativeFalsePositiveCount).toBe(0);
    expect(matchesRubricRule(validRule, validRule.positiveAnchors[0]!)).toBe(true);
    expect(matchesRubricRule(validRule, validRule.negativeAnchors[0]!)).toBe(false);

    // Missing negative anchor fails validation
    const missingNegative: MisconceptionRubricRule = {
      ...validRule,
      negativeAnchors: [],
    };
    expect(validateRubricAnchorPair(missingNegative).valid).toBe(false);

    // Contrasting negative anchor that omits the established premise causes a false positive -> fails!
    const leakyRule: MisconceptionRubricRule = {
      ...validRule,
      negativeAnchors: [
        {
          ...validRule.negativeAnchors[0]!,
          anchorId: "neg_bad_unestablished",
          establishedPremises: ["y > 0"], // does NOT establish x != 0 -> rule falsely fires!
        },
      ],
    };
    const leakyResult = validateRubricAnchorPair(leakyRule);
    expect(leakyResult.valid).toBe(false);
    expect(leakyResult.negativeFalsePositiveCount).toBe(1);
    expect(leakyResult.falsePositiveNegativeAnchorIds).toEqual(["neg_bad_unestablished"]);
  });
});

describe("GEPA disjoint split, holdout firewall, and declarative surface guard", () => {
  it("enforces strict (learnerPseudoId, itemFamilyId) disjointness for both component and dense grids", () => {
    // Case 1: Multiple disconnected components (zero quarantine needed)
    const componentTrajectories: ErrorTrajectoryRecord[] = [];
    for (let comp = 0; comp < 4; comp += 1) {
      for (let i = 0; i < 6; i += 1) {
        componentTrajectories.push(
          makeTrajectory({
            trajectoryId: `comp_${comp}_t_${i}`,
            learnerPseudoId: `pseudo_c${comp}_u${i}`,
            itemFamilyId: `fam_c${comp}_${i % 2}`,
          }),
        );
      }
    }
    const compSplit = createDisjointTrajectorySplit(componentTrajectories, { seed: 77 });
    expect(() => assertDisjointSplitInvariants(compSplit)).not.toThrow();
    expect(compSplit.holdout.length).toBeGreaterThan(0);
    expect(compSplit.train.length).toBeGreaterThan(0);
    expect(compSplit.quarantinedCrossing).toHaveLength(0);

    // Case 2: Dense grid (every learner touches every item family) -> 2D block holdout guarantees 0 overlap
    const denseTrajectories: ErrorTrajectoryRecord[] = [];
    for (let u = 0; u < 6; u += 1) {
      for (let f = 0; f < 4; f += 1) {
        denseTrajectories.push(
          makeTrajectory({
            trajectoryId: `dense_u${u}_f${f}`,
            learnerPseudoId: `pseudo_dense_u${u}`,
            itemFamilyId: `fam_dense_${f}`,
          }),
        );
      }
    }
    const denseSplit = createDisjointTrajectorySplit(denseTrajectories, { seed: 99 });
    expect(() => assertDisjointSplitInvariants(denseSplit)).not.toThrow();
    expect(denseSplit.holdout.length).toBeGreaterThan(0);
    expect(denseSplit.train.length + denseSplit.dev.length).toBeGreaterThan(0);

    const holdoutLearners = new Set(denseSplit.holdout.map((t) => t.learnerPseudoId));
    const holdoutFamilies = new Set(denseSplit.holdout.map((t) => t.itemFamilyId));
    for (const t of [...denseSplit.train, ...denseSplit.dev]) {
      expect(holdoutLearners.has(t.learnerPseudoId)).toBe(false);
      expect(holdoutFamilies.has(t.itemFamilyId)).toBe(false);
    }
  });

  it("throws HoldoutFirewallError whenever holdout trajectories, learners, or families enter GEPA reflection", () => {
    const records: ErrorTrajectoryRecord[] = [];
    for (let comp = 0; comp < 4; comp += 1) {
      for (let i = 0; i < 6; i += 1) {
        records.push(
          makeTrajectory({
            trajectoryId: `fw_c${comp}_t${i}`,
            learnerPseudoId: `pseudo_fw_c${comp}_u${i}`,
            itemFamilyId: `fam_fw_c${comp}`,
          }),
        );
      }
    }
    const split = createDisjointTrajectorySplit(records, { seed: 2026 });
    const leakedSample = split.holdout[0]!;

    // Direct holdout trajectory passed to reflective context -> blocked!
    expect(() =>
      buildGepaReflectionContext({
        policy: makeBasePolicy(),
        trainTrajectories: [...split.train, leakedSample],
        devTrajectories: split.dev,
        holdoutFirewall: split.holdoutFirewall,
      }),
    ).toThrow(HoldoutFirewallError);

    // Synthesized record reusing ONLY a holdout learnerPseudoId -> blocked!
    expect(() =>
      assertNoHoldoutLeakage(
        [
          makeTrajectory({
            trajectoryId: "brand_new_id",
            learnerPseudoId: leakedSample.learnerPseudoId,
            itemFamilyId: "fam_completely_different",
          }),
        ],
        split.holdoutFirewall,
      ),
    ).toThrow(HoldoutFirewallError);

    // Synthesized record reusing ONLY a holdout itemFamilyId -> blocked!
    expect(() =>
      assertNoHoldoutLeakage(
        [
          makeTrajectory({
            trajectoryId: "brand_new_id_2",
            learnerPseudoId: "pseudo_brand_new_learner",
            itemFamilyId: leakedSample.itemFamilyId,
          }),
        ],
        split.holdoutFirewall,
      ),
    ).toThrow(HoldoutFirewallError);
  });

  it("allows GEPA mutation ONLY on declarative surfaces and rejects forbidden authority/safety surfaces", () => {
    const base = makeBasePolicy();

    // Allowed declarative surfaces succeed
    const updated = validateAndApplyGepaPatch(base, {
      surface: "rubricAnchors",
      summary: "Add validated zero-division anchor pair",
      payload: [makeValidZeroDivisionRubric()],
    });
    expect(updated.rubricAnchors).toHaveLength(1);

    // Forbidden top-level surfaces throw GepaForbiddenSurfaceError
    for (const forbidden of [
      "permissions",
      "answerVisibility",
      "gradingWriteAuthority",
      "leakageDetectors",
    ]) {
      expect(() =>
        validateAndApplyGepaPatch(base, {
          surface: forbidden,
          summary: "Attempt unauthorized privilege escalation",
          payload: { allowAll: true },
        }),
      ).toThrow(GepaForbiddenSurfaceError);
    }

    // Smuggling a forbidden key inside an allowed surface payload also throws
    expect(() =>
      validateAndApplyGepaPatch(base, {
        surface: "approvedTemplateSlots",
        summary: "Smuggled authority key",
        payload: { leakageDetectors: "disabled" },
      }),
    ).toThrow(GepaForbiddenSurfaceError);

    // Invalid rubric anchor pair inside rubricAnchors throws InvalidRubricAnchorPairError
    expect(() =>
      validateAndApplyGepaPatch(base, {
        surface: "rubricAnchors",
        summary: "Missing negative anchor",
        payload: [{ ...makeValidZeroDivisionRubric(), negativeAnchors: [] }],
      }),
    ).toThrow(InvalidRubricAnchorPairError);
  });
});

describe("Exact (C, -L, T7) Pareto frontier, Hard Pre-Pareto Veto, and Promotion Gate", () => {
  function buildMatureCohort(
    candidateId: string,
    opts: {
      learnerCount: number;
      repairedCount: number;
      t7PassedCount: number;
      leakedTurns?: number;
      severeLeaks?: number;
    },
  ): CartridgeCandidateMetrics {
    const trajectories: ErrorTrajectoryRecord[] = Array.from(
      { length: opts.learnerCount },
      (_, i) =>
        makeTrajectory({
          trajectoryId: `${candidateId}_t_${i}`,
          learnerPseudoId: `pseudo_cohort_${i + 1}`,
          selfRepairedInSession: i < opts.repairedCount,
          totalReleasedTurns: 2,
          leakedReleasedTurns: i === 0 ? (opts.leakedTurns ?? 0) : 0,
          severeLeakCount: i === 0 ? (opts.severeLeaks ?? 0) : 0,
          day7FollowupStatus: "mature",
          passedFreshFamilyTransfer: i < opts.t7PassedCount,
        }),
    );
    return computeCandidateMetrics(candidateId, trajectories);
  }

  it("enforces Hard Pre-Pareto Veto so a leaky high-C candidate never enters the frontier or dominates a safe candidate", () => {
    // Leaky candidate has C=1.0, T7=1.0, but severeLeakCount=1 and L>0
    const leakyHighC = buildMatureCohort("cand_leaky_high_c", {
      learnerCount: 20,
      repairedCount: 20,
      t7PassedCount: 20,
      leakedTurns: 1,
      severeLeaks: 1,
    });

    // Safe candidate has C=0.80, L=0, T7=0.95 (would have been dominated on C & T7 if leaky wasn't vetoed first!)
    const safePromotable = buildMatureCohort("cand_safe_strong", {
      learnerCount: 20,
      repairedCount: 16,
      t7PassedCount: 19,
    });

    // Safe dominated candidate: C=0.70, L=0, T7=0.80 (dominated by safePromotable)
    const safeDominated = buildMatureCohort("cand_safe_weak", {
      learnerCount: 20,
      repairedCount: 14,
      t7PassedCount: 16,
    });

    const evalResult = evaluateParetoFrontierAndPromotion(
      [leakyHighC, safePromotable, safeDominated],
      {
        baseline: { cRate: 0.78, t7Rate: 0.72 },
        maxAllowedLeakageRate: 0,
        minT7Gain: 0.05,
        nonInferiorityMargin: 0.02,
        minClusterCount: 5,
      },
    );

    expect(evalResult.vetoedCandidateIds).toEqual(["cand_leaky_high_c"]);
    expect(evalResult.frontierCandidateIds).toEqual(["cand_safe_strong"]);
    expect(evalResult.promotedCandidateIds).toEqual(["cand_safe_strong"]);
    expect(evalResult.dominatedCandidateIds).toEqual(["cand_safe_weak"]);

    const leakyEntry = evalResult.results.find((r) => r.candidateId === "cand_leaky_high_c")!;
    expect(leakyEntry.status).toBe("vetoed_leakage");
    expect(leakyEntry.onParetoFrontier).toBe(false);
    expect(leakyEntry.vetoReasons.length).toBeGreaterThan(0);

    const safeEntry = evalResult.results.find((r) => r.candidateId === "cand_safe_strong")!;
    expect(safeEntry.status).toBe("promoted");
    expect(safeEntry.dominatedBy).toEqual([]);
  });

  it("records immature follow-up as { status: 'pending' } without fabricating 0 or 1, and blocks promotion to shadow_candidate only", () => {
    const pendingTrajectories = Array.from({ length: 12 }, (_, i) =>
      makeTrajectory({
        trajectoryId: `pend_${i}`,
        learnerPseudoId: `pseudo_pend_${i + 1}`,
        selfRepairedInSession: true,
        day7FollowupStatus: "pending",
        passedFreshFamilyTransfer: undefined,
      }),
    );

    const candA = computeCandidateMetrics("cand_pending_high_c", pendingTrajectories);
    expect(candA.t7.status).toBe("pending");
    if (candA.t7.status === "pending") {
      expect(candA.t7.pendingCohortCount).toBe(12);
      expect(candA.t7.eligibleFollowupCohortCount).toBe(0);
    }

    const candB = computeCandidateMetrics(
      "cand_pending_low_c",
      pendingTrajectories.map((t, i) => ({ ...t, selfRepairedInSession: i < 6 })),
    );

    const result = evaluateParetoFrontierAndPromotion([candA, candB], {
      baseline: { cRate: 0.7, t7Rate: 0.7 },
    });

    // Ranked on (C, -L) -> candA on frontier as shadow_candidate ONLY, never promoted!
    expect(result.frontierCandidateIds).toEqual(["cand_pending_high_c"]);
    expect(result.shadowCandidateIds).toEqual(["cand_pending_high_c"]);
    expect(result.dominatedCandidateIds).toEqual(["cand_pending_low_c"]);
    expect(result.promotedCandidateIds).toEqual([]);
  });

  it("blocks promotion when student-clustered T7 LCB fails minT7Gain or C fails nonInferiorityMargin", () => {
    // High point estimate T7=0.80 (4/5) on only 5 noisy clusters -> wide SE -> LCB below 0.75 + 0.05 = 0.80
    const noisyHighPoint = buildMatureCohort("cand_noisy_ci", {
      learnerCount: 5,
      repairedCount: 5,
      t7PassedCount: 4,
    });

    // Strong mature T7=0.95 across 20 clusters, BUT C=0.60 drops below baselineC (0.80) - margin (0.02) = 0.78!
    const lowCRegressed = buildMatureCohort("cand_low_c_regressed", {
      learnerCount: 20,
      repairedCount: 12,
      t7PassedCount: 19,
    });

    const result = evaluateParetoFrontierAndPromotion([noisyHighPoint, lowCRegressed], {
      baseline: { cRate: 0.8, t7Rate: 0.75 },
      minT7Gain: 0.05,
      nonInferiorityMargin: 0.02,
      minClusterCount: 5,
    });

    // Both sit on the 3D Pareto frontier (tradeoff between C and T7), neither may be promoted!
    expect(result.frontierCandidateIds).toEqual(["cand_noisy_ci", "cand_low_c_regressed"]);
    expect(result.promotedCandidateIds).toEqual([]);
    expect(result.shadowCandidateIds).toEqual(["cand_noisy_ci", "cand_low_c_regressed"]);

    const noisyEval = result.results.find((r) => r.candidateId === "cand_noisy_ci")!;
    expect(noisyEval.promotionBlockers.some((b) => b.startsWith("t7_lcb_below_gain_threshold"))).toBe(true);

    const lowCEval = result.results.find((r) => r.candidateId === "cand_low_c_regressed")!;
    expect(lowCEval.promotionBlockers.some((b) => b.startsWith("c_below_non_inferiority"))).toBe(true);
  });

  it("enforces -L dominance direction and vetoes rate leakage even when severeLeakCount is 0", () => {
    const zeroLeak = buildMatureCohort("cand_zero_leak", {
      learnerCount: 20,
      repairedCount: 18,
      t7PassedCount: 19,
      leakedTurns: 0,
      severeLeaks: 0,
    });
    // 1 leaked turn out of 40 = 0.025 leakage rate, severeLeakCount = 0
    const minorLeak = buildMatureCohort("cand_minor_leak", {
      learnerCount: 20,
      repairedCount: 18,
      t7PassedCount: 19,
      leakedTurns: 1,
      severeLeaks: 0,
    });

    // Under strict default maxAllowedLeakageRate=0, minorLeak is vetoed before Pareto.
    const strictEval = evaluateParetoFrontierAndPromotion([zeroLeak, minorLeak], {
      baseline: { cRate: 0.85, t7Rate: 0.72 },
      maxAllowedLeakageRate: 0,
    });
    expect(strictEval.vetoedCandidateIds).toEqual(["cand_minor_leak"]);
    expect(strictEval.promotedCandidateIds).toEqual(["cand_zero_leak"]);

    // Under relaxed maxAllowedLeakageRate=0.05, zeroLeak strictly dominates minorLeak via -L.
    const relaxedEval = evaluateParetoFrontierAndPromotion([zeroLeak, minorLeak], {
      baseline: { cRate: 0.85, t7Rate: 0.72 },
      maxAllowedLeakageRate: 0.05,
    });
    expect(relaxedEval.vetoedCandidateIds).toEqual([]);
    expect(relaxedEval.frontierCandidateIds).toEqual(["cand_zero_leak"]);
    expect(relaxedEval.dominatedCandidateIds).toEqual(["cand_minor_leak"]);
  });

  it("runs a full end-to-end GEPA optimization round respecting holdout firewall, anchor validation, and Pareto promotion", () => {
    const records: ErrorTrajectoryRecord[] = [];
    for (let comp = 0; comp < 4; comp += 1) {
      for (let i = 0; i < 8; i += 1) {
        records.push(
          makeTrajectory({
            trajectoryId: `e2e_c${comp}_t${i}`,
            learnerPseudoId: `pseudo_e2e_c${comp}_u${i}`,
            itemFamilyId: `fam_e2e_c${comp}`,
            conceptId: comp % 2 === 0 ? "alg.zero_product_property" : "linalg.matrix_left_cancellation",
            firstErrorRuleId:
              comp % 2 === 0 ? "err.divide_by_variable" : "err.singular_matrix_cancel",
            normalizedAstEdit:
              comp % 2 === 0 ? "DIV_VAR(x)|DROP_BRANCH(x=0)" : "CANCEL_LEFT_MATRIX(A)",
            missingPremise: comp % 2 === 0 ? "x != 0" : "det(A) != 0",
          }),
        );
      }
    }

    const split = createDisjointTrajectorySplit(records, { seed: 20261121 });

    const round = runGepaOptimizationRound({
      basePolicy: makeBasePolicy(),
      split,
      clusteringOptions: { minSupport: 5 },
      scoreCandidate: (candidate) =>
        buildMatureCohort(candidate.candidateId, {
          learnerCount: 25,
          repairedCount: 23,
          t7PassedCount: 24,
        }),
      paretoOptions: {
        baseline: { cRate: 0.85, t7Rate: 0.72 },
        minT7Gain: 0.05,
        nonInferiorityMargin: 0.02,
        minClusterCount: 5,
      },
    });

    expect(round.candidates.length).toBeGreaterThan(0);
    for (const c of round.candidates) {
      expect(c.policy.moveRules.length).toBeGreaterThan(0);
      expect(c.policy.hintLadder.length).toBeGreaterThan(0);
      expect(c.policy.rubricAnchors.length).toBeGreaterThan(0);
      for (const rubric of c.policy.rubricAnchors) {
        expect(validateRubricAnchorPair(rubric).valid).toBe(true);
      }
    }
    expect(round.pareto.promotedCandidateIds.length).toBeGreaterThan(0);
  });

  it("scans normalizedAstEdit, missingPremise, and GEPA patch strings for raw PII (P1-2)", () => {
    expect(() =>
      clusterErrorTrajectories([
        makeTrajectory({
          trajectoryId: "t_pii_ast",
          normalizedAstEdit: "DIV_VAR(x)|NOTE(student@school.edu)",
        }),
      ]),
    ).toThrow(CartridgePiiViolationError);

    expect(() =>
      clusterErrorTrajectories([
        makeTrajectory({
          trajectoryId: "t_pii_premise",
          missingPremise: "call +1-555-234-5678 before dividing",
        }),
      ]),
    ).toThrow(CartridgePiiViolationError);

    expect(() =>
      assertNoRawPiiInText("https://example.edu/submit?token=secret123", "test_url"),
    ).toThrow(CartridgePiiViolationError);

    const base = makeBasePolicy();
    expect(() =>
      validateAndApplyGepaPatch(base, {
        surface: "approvedTemplateSlots",
        summary: "Safe summary",
        payload: { cue: "Email teacher@college.edu or visit https://api.example.com?api_key=abc123" },
      }),
    ).toThrow(CartridgePiiViolationError);

    expect(() =>
      validateAndApplyGepaPatch(base, {
        surface: "hintLadder",
        summary: "Contains raw student_id=987654",
        payload: [
          {
            stage: 1,
            conceptId: "alg.zero_product_property",
            cueTemplate: "Check x != 0 before dividing",
            revealsPremiseCheck: true,
          },
        ],
      }),
    ).toThrow(CartridgePiiViolationError);

    // Reflection context with smuggled PII in missingPremise is rejected before generating patches.
    expect(() =>
      proposeGepaReflectivePatches({
        policyId: base.policyId,
        policyVersion: base.version,
        trainTrajectoryCount: 5,
        devTrajectoryCount: 0,
        actionableClusters: [
          {
            clusterId: "cluster_pii",
            conceptId: "alg.zero_product_property",
            firstErrorRuleId: "err.divide_by_variable",
            centroidAstEdit: "DIV_VAR(X)",
            missingPremise: "contact alice@university.edu",
            supportCount: 5,
            uniqueLearnerCount: 5,
            itemFamilyIds: ["fam_1"],
          },
        ],
        observationOnlyClusterCount: 0,
        allowedSurfaces: ["moveRules", "hintLadder", "rubricAnchors", "approvedTemplateSlots"],
        currentPolicy: base,
      }),
    ).toThrow(CartridgePiiViolationError);
  });

  it("canonicalizes NFKC + trimmed itemFamilyId and learnerPseudoId across split, firewall, clustering, and Pareto (P1-3)", () => {
    expect(canonicalizeIdentifier("  \uFF46\uFF41\uFF4D-\uFF11  ", "itemFamilyId")).toBe("fam-1");
    expect(() => canonicalizeIdentifier("   \t\n  ", "itemFamilyId")).toThrow(
      CartridgePiiViolationError,
    );

    const records: ErrorTrajectoryRecord[] = [];
    for (let comp = 0; comp < 4; comp += 1) {
      for (let i = 0; i < 6; i += 1) {
        records.push(
          makeTrajectory({
            trajectoryId: `norm_c${comp}_t${i}`,
            learnerPseudoId:
              i % 2 === 0 ? `  pseudo_norm_c${comp}_u${i}  ` : `pseudo_norm_c${comp}_u${i}`,
            itemFamilyId:
              i % 2 === 0 ? ` \uFF46\uFF41\uFF4D_c${comp} ` : `fam_c${comp}`,
          }),
        );
      }
    }

    const split = createDisjointTrajectorySplit(records, { seed: 2026 });
    expect(() => assertDisjointSplitInvariants(split)).not.toThrow();

    const leaked = split.holdout[0]!;
    // Whitespace-padded and fullwidth-Unicode variant of holdout itemFamilyId MUST be blocked!
    const fullwidthFamily = `  ${leaked.itemFamilyId.replace(/f/g, "\uFF46")}  `;
    expect(() =>
      assertNoHoldoutLeakage(
        [
          makeTrajectory({
            trajectoryId: "padded_bypass_attempt",
            learnerPseudoId: "pseudo_brand_new_999",
            itemFamilyId: fullwidthFamily,
          }),
        ],
        split.holdoutFirewall,
      ),
    ).toThrow(HoldoutFirewallError);

    // Whitespace-padded variant of holdout learnerPseudoId MUST also be blocked!
    expect(() =>
      assertNoHoldoutLeakage(
        [
          makeTrajectory({
            trajectoryId: "padded_learner_bypass",
            learnerPseudoId: `  ${leaked.learnerPseudoId}  `,
            itemFamilyId: "fam_completely_unrelated",
          }),
        ],
        split.holdoutFirewall,
      ),
    ).toThrow(HoldoutFirewallError);

    // Padded learnerPseudoId variants collapse to 1 unique student cluster in computeCandidateMetrics!
    const paddedMetrics = computeCandidateMetrics("cand_padded_clusters", [
      makeTrajectory({ trajectoryId: "p1", learnerPseudoId: "pseudo_same_u1" }),
      makeTrajectory({ trajectoryId: "p2", learnerPseudoId: "  pseudo_same_u1  " }),
      makeTrajectory({ trajectoryId: "p3", learnerPseudoId: "\uFF50seudo_same_u1" }),
    ]);
    expect(paddedMetrics.t7.status).toBe("mature");
    if (paddedMetrics.t7.status === "mature") {
      expect(paddedMetrics.t7.learnerClusterCount).toBe(1);
    }
  });

  it("enforces strict runtime payload schema & blocks prototype pollution in validateAndApplyGepaPatch (P1-4)", () => {
    const base = makeBasePolicy();

    // Array where plain object is required for approvedTemplateSlots
    expect(() =>
      validateAndApplyGepaPatch(base, {
        surface: "approvedTemplateSlots",
        summary: "Malformed array payload",
        payload: ["not", "a", "record"],
      }),
    ).toThrow(GepaInvalidPatchPayloadError);

    // Non-string slot value
    expect(() =>
      validateAndApplyGepaPatch(base, {
        surface: "approvedTemplateSlots",
        summary: "Malformed slot value",
        payload: { validKey: 12345 },
      }),
    ).toThrow(GepaInvalidPatchPayloadError);

    // Prototype pollution key (__proto__, constructor, prototype) via JSON.parse
    const protoPayload = JSON.parse('{"__proto__": "polluted", "safe": "ok"}') as unknown;
    expect(() =>
      validateAndApplyGepaPatch(base, {
        surface: "approvedTemplateSlots",
        summary: "Proto pollution attempt",
        payload: protoPayload,
      }),
    ).toThrow(GepaInvalidPatchPayloadError);

    expect(() =>
      validateAndApplyGepaPatch(base, {
        surface: "approvedTemplateSlots",
        summary: "Constructor key attempt",
        payload: { constructor: "bad" },
      }),
    ).toThrow(GepaInvalidPatchPayloadError);

    // Non-array payload for moveRules / hintLadder / rubricAnchors
    expect(() =>
      validateAndApplyGepaPatch(base, {
        surface: "moveRules",
        summary: "Malformed moveRules",
        payload: null,
      }),
    ).toThrow(GepaInvalidPatchPayloadError);

    expect(() =>
      validateAndApplyGepaPatch(base, {
        surface: "hintLadder",
        summary: "Malformed hint step",
        payload: [{ stage: -1, conceptId: "", cueTemplate: "x", revealsPremiseCheck: "yes" }],
      }),
    ).toThrow(GepaInvalidPatchPayloadError);

    expect(() =>
      validateAndApplyGepaPatch(base, {
        surface: "rubricAnchors",
        summary: "Malformed rubric anchors",
        payload: [{ ruleId: "r1" }],
      }),
    ).toThrow(GepaInvalidPatchPayloadError);
  });

  it("fails closed on NaN, negative, zero-turn, and inconsistent leakage telemetry before Pareto ranking (P1-5)", () => {
    const safeBaseline = buildMatureCohort("cand_safe_ref", {
      learnerCount: 25,
      repairedCount: 22,
      t7PassedCount: 24,
    });

    // NaN leakage counts via trajectories
    const nanFromTraj = computeCandidateMetrics("cand_nan_traj", [
      makeTrajectory({
        trajectoryId: "nan_1",
        totalReleasedTurns: Number.NaN,
        leakedReleasedTurns: 0,
      }),
    ]);

    // Zero released turns (must NOT silently report rate=0 and pass veto!)
    const zeroTurns = computeCandidateMetrics("cand_zero_turns", [
      makeTrajectory({
        trajectoryId: "zero_1",
        totalReleasedTurns: 0,
        leakedReleasedTurns: 0,
      }),
    ]);

    // Negative / inconsistent counts constructed directly on metrics
    const inconsistentDirect: CartridgeCandidateMetrics = {
      ...safeBaseline,
      candidateId: "cand_inconsistent_direct",
      l: {
        rate: 0,
        leakedReleasedTurns: 3,
        totalReleasedTurns: 2,
        severeLeakCount: 0,
        guardBlockedCount: 0,
      },
    };

    const nanDirect: CartridgeCandidateMetrics = {
      ...safeBaseline,
      candidateId: "cand_nan_direct",
      l: {
        rate: Number.NaN,
        leakedReleasedTurns: 0,
        totalReleasedTurns: 10,
        severeLeakCount: Number.NaN,
        guardBlockedCount: 0,
      },
    };

    const negativeDirect: CartridgeCandidateMetrics = {
      ...safeBaseline,
      candidateId: "cand_negative_direct",
      l: {
        rate: -0.1,
        leakedReleasedTurns: -1,
        totalReleasedTurns: 10,
        severeLeakCount: 0,
        guardBlockedCount: 0,
      },
    };

    const evalRes = evaluateParetoFrontierAndPromotion(
      [safeBaseline, nanFromTraj, zeroTurns, inconsistentDirect, nanDirect, negativeDirect],
      {
        baseline: { cRate: 0.8, t7Rate: 0.72 },
        maxAllowedLeakageRate: 0,
      },
    );

    expect(evalRes.vetoedCandidateIds).toEqual([
      "cand_nan_traj",
      "cand_zero_turns",
      "cand_inconsistent_direct",
      "cand_nan_direct",
      "cand_negative_direct",
    ]);
    expect(evalRes.promotedCandidateIds).toEqual(["cand_safe_ref"]);
  });

  it("caps cluster-level 95% LCB with exact Clopper-Pearson bound so 5/5 learners yields <= 0.55 and cannot pass a 0.80 gate (P1-6)", () => {
    // Exact 0.05 ** (1/5) = 0.54928027165...
    expect(exactClopperPearsonLowerBound(5, 5, 0.05)).toBeCloseTo(Math.pow(0.05, 1 / 5), 10);
    expect(exactClopperPearsonLowerBound(5, 5, 0.05)).toBeLessThanOrEqual(0.55);

    // 5 learners, 5/5 pass (100% empirical mean, zero sample variance)
    const fiveOfFive = buildMatureCohort("cand_5_of_5", {
      learnerCount: 5,
      repairedCount: 5,
      t7PassedCount: 5,
    });
    expect(fiveOfFive.t7.status).toBe("mature");
    if (fiveOfFive.t7.status === "mature") {
      expect(fiveOfFive.t7.rate).toBe(1);
      expect(fiveOfFive.t7.learnerClusterCount).toBe(5);
      expect(fiveOfFive.t7.effectiveClusterSampleSize).toBe(5);
      expect(fiveOfFive.t7.clopperPearsonLowerBound).toBeCloseTo(Math.pow(0.05, 1 / 5), 6);
      expect(fiveOfFive.t7.learnerClusterLowerBound).toBeLessThanOrEqual(0.55);
    }

    // Even if those same 5 learners complete 10 items each (50/50 passes), n_eff stays bounded by 5!
    const repeatedFiveLearners: ErrorTrajectoryRecord[] = [];
    for (let u = 0; u < 5; u += 1) {
      for (let item = 0; item < 10; item += 1) {
        repeatedFiveLearners.push(
          makeTrajectory({
            trajectoryId: `rep_u${u}_i${item}`,
            learnerPseudoId: `pseudo_rep_u${u}`,
            passedFreshFamilyTransfer: true,
          }),
        );
      }
    }
    const repeatedMetrics = computeCandidateMetrics("cand_5_learners_50_items", repeatedFiveLearners);
    expect(repeatedMetrics.t7.status).toBe("mature");
    if (repeatedMetrics.t7.status === "mature") {
      expect(repeatedMetrics.t7.learnerClusterCount).toBe(5);
      expect(repeatedMetrics.t7.effectiveClusterSampleSize).toBe(5);
      expect(repeatedMetrics.t7.learnerClusterLowerBound).toBeLessThanOrEqual(0.55);
    }

    // Neither 5/5 nor 50/50-on-5-learners may pass a 0.80 promotion floor (baseline 0.75 + minT7Gain 0.05).
    const promoEval = evaluateParetoFrontierAndPromotion([fiveOfFive, repeatedMetrics], {
      baseline: { cRate: 0.8, t7Rate: 0.75 },
      minT7Gain: 0.05,
      minClusterCount: 5,
    });
    expect(promoEval.promotedCandidateIds).toEqual([]);
    expect(promoEval.shadowCandidateIds).toEqual(["cand_5_of_5", "cand_5_learners_50_items"]);
    for (const r of promoEval.results) {
      expect(r.promotionBlockers.some((b) => b.startsWith("t7_lcb_below_gain_threshold"))).toBe(
        true,
      );
    }
  });
});
