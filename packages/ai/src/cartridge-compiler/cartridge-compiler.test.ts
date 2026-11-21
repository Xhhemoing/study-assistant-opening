import { describe, expect, it } from "vitest";
import {
  CandidateIdentityError,
  CartridgePiiViolationError,
  GepaForbiddenSurfaceError,
  GepaInvalidPatchPayloadError,
  HoldoutFirewallError,
  InvalidRubricAnchorPairError,
  assertDisjointSplitInvariants,
  assertNoHoldoutLeakage,
  assertNoRawPiiInText,
  assertNoRawPiiInValue,
  buildGepaReflectionContext,
  canonicalizeIdentifier,
  certifyMatureTransferLowerBound,
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

  it("blocks whitespace-obfuscated token URLs before/after normalization and JWTs in learnerPseudoId (Round-3 P1-2)", () => {
    // Tokenized URL with whitespace around '=' that normalization would collapse into ?token=abc
    const spacedTokenUrl = makeTrajectory({
      trajectoryId: "t_spaced_url",
      missingPremise: "see https://x.test?token = abc12345 before solving",
    });
    expect(() => clusterErrorTrajectories([spacedTokenUrl])).toThrow(CartridgePiiViolationError);

    const spacedTokenAst = makeTrajectory({
      trajectoryId: "t_spaced_ast",
      normalizedAstEdit: "DIV_VAR(x)|REF(https://x.test ? api_key = secret999)",
    });
    expect(() => clusterErrorTrajectories([spacedTokenAst])).toThrow(CartridgePiiViolationError);

    // JWT embedded inside learnerPseudoId (matches base charset [A-Za-z0-9._:-]) MUST fail closed!
    const jwtPseudo = makeTrajectory({
      trajectoryId: "t_jwt_pseudo",
      learnerPseudoId: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIn0.sigABCDEF1234",
    });
    expect(() => clusterErrorTrajectories([jwtPseudo])).toThrow(CartridgePiiViolationError);

    // Ensure buildGepaReflectionContext rejects spaced token URLs in train/dev inputs.
    expect(() =>
      buildGepaReflectionContext({
        policy: makeBasePolicy(),
        trainTrajectories: [spacedTokenUrl],
        devTrajectories: [],
        holdoutFirewall: {
          holdoutTrajectoryIds: [],
          holdoutLearnerPseudoIds: [],
          holdoutItemFamilyIds: [],
        },
      }),
    ).toThrow(CartridgePiiViolationError);
  });

  it("enforces maxAllowedLeakageRate against the exact count-derived ratio (1000/99999 > 0.01) (Round-3 P1-3)", () => {
    const safeBaseline = buildMatureCohort("cand_exact_safe", {
      learnerCount: 25,
      repairedCount: 22,
      t7PassedCount: 24,
    });

    // Caller rounds 1000 / 99999 = 0.0100001000... down to 0.01 against maxAllowedLeakageRate = 0.01.
    const roundedBypass: CartridgeCandidateMetrics = {
      ...safeBaseline,
      candidateId: "cand_rounded_leak_bypass",
      l: {
        rate: 0.01,
        leakedReleasedTurns: 1000,
        totalReleasedTurns: 99999,
        severeLeakCount: 0,
        guardBlockedCount: 0,
      },
    };

    // Exact boundary 1000 / 100000 = 0.01 IS allowed when maxAllowedLeakageRate = 0.01.
    const exactAtBoundary: CartridgeCandidateMetrics = {
      ...safeBaseline,
      candidateId: "cand_exact_at_cap",
      l: {
        rate: 0.01,
        leakedReleasedTurns: 1000,
        totalReleasedTurns: 100000,
        severeLeakCount: 0,
        guardBlockedCount: 0,
      },
    };

    const result = evaluateParetoFrontierAndPromotion([roundedBypass, exactAtBoundary], {
      baseline: { cRate: 0.8, t7Rate: 0.72 },
      maxAllowedLeakageRate: 0.01,
    });

    expect(result.vetoedCandidateIds).toEqual(["cand_rounded_leak_bypass"]);
    expect(result.promotedCandidateIds).toEqual(["cand_exact_at_cap"]);
  });

  it("hard-enforces one-sided alpha <= 0.05 at scorer and promotion gate so 5/5 cannot clear 0.80 via alpha=0.5 or forged LCB (Round-3 P1-4)", () => {
    const fiveTrajs = Array.from({ length: 5 }, (_, i) =>
      makeTrajectory({
        trajectoryId: `alpha_t_${i}`,
        learnerPseudoId: `pseudo_alpha_u${i + 1}`,
        passedFreshFamilyTransfer: true,
      }),
    );

    // Weakening alpha > 0.05 or confidenceZ < 1.64485 throws RangeError!
    expect(() => computeCandidateMetrics("cand_weak_alpha", fiveTrajs, { alpha: 0.5 })).toThrow(
      RangeError,
    );
    expect(() =>
      computeCandidateMetrics("cand_weak_z", fiveTrajs, { confidenceZ: 0.5 }),
    ).toThrow(RangeError);

    // Forged custom scorer metrics attempting to pass 5/5 with inflated learnerClusterLowerBound: 0.95
    const base5 = computeCandidateMetrics("cand_forged_lcb", fiveTrajs);
    const forgedMetrics: CartridgeCandidateMetrics = {
      ...base5,
      t7:
        base5.t7.status === "mature"
          ? {
              ...base5.t7,
              learnerClusterLowerBound: 0.95,
              clopperPearsonLowerBound: 0.95,
            }
          : base5.t7,
    };

    const promoCheck = evaluateParetoFrontierAndPromotion([forgedMetrics], {
      baseline: { cRate: 0.8, t7Rate: 0.75 },
      minT7Gain: 0.05,
      minClusterCount: 5,
    });
    expect(promoCheck.promotedCandidateIds).toEqual([]);
    expect(promoCheck.vetoedCandidateIds).toEqual(["cand_forged_lcb"]);
    expect(promoCheck.results[0]!.status).toBe("vetoed_invalid_telemetry");
    expect(promoCheck.results[0]!.onParetoFrontier).toBe(false);
    expect(promoCheck.results[0]!.vetoReasons).toEqual(
      expect.arrayContaining([expect.stringContaining("t7_lcb_exceeds_certified_cp95")]),
    );

    // Even via runGepaOptimizationRound with a custom scoreCandidate returning inflated LCB or effectiveClusterSampleSize=50!
    const records: ErrorTrajectoryRecord[] = [];
    for (let comp = 0; comp < 4; comp += 1) {
      for (let i = 0; i < 6; i += 1) {
        records.push(
          makeTrajectory({
            trajectoryId: `gepa_forged_c${comp}_t${i}`,
            learnerPseudoId: `pseudo_gepa_f_c${comp}_u${i}`,
            itemFamilyId: `fam_gepa_f_c${comp}`,
          }),
        );
      }
    }
    const split = createDisjointTrajectorySplit(records, { seed: 42 });
    const round = runGepaOptimizationRound({
      basePolicy: makeBasePolicy(),
      split,
      clusteringOptions: { minSupport: 5 },
      scoreCandidate: (cand) => ({
        ...forgedMetrics,
        candidateId: cand.candidateId,
        t7:
          base5.t7.status === "mature"
            ? {
                ...base5.t7,
                effectiveClusterSampleSize: 50, // forged > learnerClusterCount (5)!
                learnerClusterLowerBound: 0.92,
                alpha: 0.5,
              }
            : base5.t7,
      }),
      paretoOptions: {
        baseline: { cRate: 0.8, t7Rate: 0.75 },
        minT7Gain: 0.05,
        minClusterCount: 5,
      },
    });
    expect(round.pareto.promotedCandidateIds).toEqual([]);
  });

  it("rejects undeclared keys on GEPA rule/anchor objects and reconstructs clean declared-only copies (Round-3 P2-1)", () => {
    const base = makeBasePolicy();

    // Undeclared extra key on moveRules item -> rejected
    expect(() =>
      validateAndApplyGepaPatch(base, {
        surface: "moveRules",
        summary: "Extra field on moveRule",
        payload: [
          {
            id: "r1",
            conceptId: "alg.zero_product_property",
            triggerRuleId: "err.divide_by_variable",
            missingPremise: "x != 0",
            move: "targeted_scaffold",
            priority: 10,
            undeclaredFlag: true,
          },
        ],
      }),
    ).toThrow(GepaInvalidPatchPayloadError);

    // Undeclared extra key on hintLadder item -> rejected
    expect(() =>
      validateAndApplyGepaPatch(base, {
        surface: "hintLadder",
        summary: "Extra field on hintStep",
        payload: [
          {
            stage: 1,
            conceptId: "alg.zero_product_property",
            cueTemplate: "Check x != 0",
            revealsPremiseCheck: true,
            shadowOverride: "bypass",
          },
        ],
      }),
    ).toThrow(GepaInvalidPatchPayloadError);

    // Undeclared extra key on nested RubricAnchorExample -> rejected
    const validRubric = makeValidZeroDivisionRubric();
    expect(() =>
      validateAndApplyGepaPatch(base, {
        surface: "rubricAnchors",
        summary: "Extra field on anchor",
        payload: [
          {
            ...validRubric,
            positiveAnchors: [
              {
                ...validRubric.positiveAnchors[0]!,
                hiddenMetadata: "smuggled",
              },
            ],
          },
        ],
      }),
    ).toThrow(GepaInvalidPatchPayloadError);

    // Undeclared top-level patch key -> rejected
    expect(() =>
      validateAndApplyGepaPatch(base, {
        surface: "approvedTemplateSlots",
        summary: "Extra top-level field",
        payload: { slotA: "Check premise" },
        extraTopLevel: "nope",
      }),
    ).toThrow(GepaInvalidPatchPayloadError);

    // Valid declared-only rubric patch produces cleanly reconstructed independent copy.
    const applied = validateAndApplyGepaPatch(base, {
      surface: "rubricAnchors",
      summary: "Valid rubric",
      payload: [validRubric],
    });
    expect(applied.rubricAnchors).toHaveLength(1);
    expect(applied.rubricAnchors[0]).not.toBe(validRubric);
    expect(Object.keys(applied.rubricAnchors[0]!).sort()).toEqual([
      "conceptId",
      "firstErrorRuleId",
      "negativeAnchors",
      "positiveAnchors",
      "requiredAstTokens",
      "requiredMissingPremise",
      "ruleId",
    ]);
  });

  it("enforces unique canonical candidateIds and receipt.candidateId matching in Pareto and GEPA rounds (Round-4 P1-2)", () => {
    const c1 = buildMatureCohort("cand_alpha", {
      learnerCount: 25,
      repairedCount: 23,
      t7PassedCount: 24,
    });
    const c1PaddedDup = buildMatureCohort("cand_alpha", {
      learnerCount: 25,
      repairedCount: 23,
      t7PassedCount: 24,
    });
    const paddedCopy: CartridgeCandidateMetrics = {
      ...c1PaddedDup,
      candidateId: "  cand_alpha  ",
    };

    // Duplicate canonical candidateId in evaluateParetoFrontierAndPromotion -> throws CandidateIdentityError
    expect(() =>
      evaluateParetoFrontierAndPromotion([c1, paddedCopy], {
        baseline: { cRate: 0.8, t7Rate: 0.72 },
      }),
    ).toThrow(CandidateIdentityError);

    const records: ErrorTrajectoryRecord[] = [];
    for (let comp = 0; comp < 4; comp += 1) {
      for (let i = 0; i < 6; i += 1) {
        records.push(
          makeTrajectory({
            trajectoryId: `id_chk_c${comp}_t${i}`,
            learnerPseudoId: `pseudo_id_c${comp}_u${i}`,
            itemFamilyId: `fam_id_c${comp}`,
          }),
        );
      }
    }
    const split = createDisjointTrajectorySplit(records, { seed: 123 });

    // Swapped scorer receipt candidateId -> throws CandidateIdentityError (mismatched_receipt_candidate_id)
    expect(() =>
      runGepaOptimizationRound({
        basePolicy: makeBasePolicy(),
        split,
        clusteringOptions: { minSupport: 5 },
        scoreCandidate: () => ({ ...c1, candidateId: "different_swapped_candidate" }),
        paretoOptions: { baseline: { cRate: 0.8, t7Rate: 0.72 } },
      }),
    ).toThrow(CandidateIdentityError);

    // Duplicate extraCandidatePatches IDs (including whitespace-padded variant) -> throws CandidateIdentityError
    expect(() =>
      runGepaOptimizationRound({
        basePolicy: makeBasePolicy(),
        split,
        clusteringOptions: { minSupport: 5 },
        extraCandidatePatches: [
          {
            candidateId: "extra_dup_cand",
            patches: [
              {
                surface: "approvedTemplateSlots",
                summary: "Slot 1",
                payload: { k1: "v1" },
              },
            ],
          },
          {
            candidateId: "  extra_dup_cand  ",
            patches: [
              {
                surface: "approvedTemplateSlots",
                summary: "Slot 2",
                payload: { k2: "v2" },
              },
            ],
          },
        ],
        scoreCandidate: (cand) => ({ ...c1, candidateId: cand.candidateId }),
        paretoOptions: { baseline: { cRate: 0.8, t7Rate: 0.72 } },
      }),
    ).toThrow(CandidateIdentityError);
  });

  it("independently verifies Kish n_eff from learnerOutcomeCounts so 81+19x1 concentrated outcomes cannot clear 0.80 (Round-4 P1-3)", () => {
    // 100 passes across 20 learners: 1 learner has 81 outcomes, 19 learners have 1 outcome each.
    // True Kish n_eff = 100^2 / (81^2 + 19) = 10000 / 6580 ≈ 1.5198; CP95 ≈ 0.1394 << 0.80!
    const concentratedTrajs: ErrorTrajectoryRecord[] = [];
    for (let i = 0; i < 81; i += 1) {
      concentratedTrajs.push(
        makeTrajectory({
          trajectoryId: `conc_heavy_${i}`,
          learnerPseudoId: "pseudo_heavy_learner",
          passedFreshFamilyTransfer: true,
        }),
      );
    }
    for (let u = 1; u <= 19; u += 1) {
      concentratedTrajs.push(
        makeTrajectory({
          trajectoryId: `conc_single_${u}`,
          learnerPseudoId: `pseudo_single_${u}`,
          passedFreshFamilyTransfer: true,
        }),
      );
    }

    const honest = computeCandidateMetrics("cand_concentrated_honest", concentratedTrajs);
    expect(honest.t7.status).toBe("mature");
    if (honest.t7.status === "mature") {
      expect(honest.t7.learnerClusterCount).toBe(20);
      expect(honest.t7.learnerOutcomeCounts).toHaveLength(20);
      expect(honest.t7.effectiveClusterSampleSize).toBeCloseTo(10000 / 6580, 6);
      expect(honest.t7.learnerClusterLowerBound).toBeCloseTo(
        Math.pow(0.05, 6580 / 10000),
        4,
      );
      expect(honest.t7.learnerClusterLowerBound).toBeLessThan(0.15);
    }

    // Custom scorer lies about effectiveClusterSampleSize = 20 and LCB = 0.861 while carrying the concentrated counts.
    const forgedConcentrated: CartridgeCandidateMetrics = {
      ...honest,
      candidateId: "cand_concentrated_forged_neff",
      t7:
        honest.t7.status === "mature"
          ? {
              ...honest.t7,
              effectiveClusterSampleSize: 20,
              clopperPearsonLowerBound: 0.86089,
              learnerClusterLowerBound: 0.86089,
            }
          : honest.t7,
    };

    if (forgedConcentrated.t7.status === "mature") {
      const cert = certifyMatureTransferLowerBound(forgedConcentrated.t7);
      expect(cert.validTelemetry).toBe(false);
      expect(cert.exactKishNEff).toBeCloseTo(10000 / 6580, 6);
      expect(cert.certifiedCp95Lcb).toBeLessThan(0.15);
    }

    const evalRes = evaluateParetoFrontierAndPromotion([honest, forgedConcentrated], {
      baseline: { cRate: 0.8, t7Rate: 0.75 },
      minT7Gain: 0.05,
      minClusterCount: 5,
    });
    expect(evalRes.promotedCandidateIds).toEqual([]);
    const forgedEval = evalRes.results.find(
      (r) => r.candidateId === "cand_concentrated_forged_neff",
    )!;
    expect(forgedEval.status).toBe("vetoed_invalid_telemetry");
    expect(forgedEval.onParetoFrontier).toBe(false);
  });

  it("canonicalizes and PII-scans all caller-provided candidateIds and extra candidate metadata (Round-4 P1-4)", () => {
    const safe = buildMatureCohort("cand_clean", {
      learnerCount: 25,
      repairedCount: 23,
      t7PassedCount: 24,
    });

    // PII in computeCandidateMetrics candidateId -> throws CartridgePiiViolationError
    expect(() => computeCandidateMetrics("alice@school.edu", [makeTrajectory({ trajectoryId: "t1" })])).toThrow(
      CartridgePiiViolationError,
    );

    // PII in evaluateParetoFrontierAndPromotion candidateId -> throws CartridgePiiViolationError
    expect(() =>
      evaluateParetoFrontierAndPromotion([{ ...safe, candidateId: "cand_user@example.com" }], {
        baseline: { cRate: 0.8, t7Rate: 0.72 },
      }),
    ).toThrow(CartridgePiiViolationError);

    // PII in extraCandidatePatches candidateId -> throws CartridgePiiViolationError
    const records: ErrorTrajectoryRecord[] = [];
    for (let comp = 0; comp < 4; comp += 1) {
      for (let i = 0; i < 6; i += 1) {
        records.push(
          makeTrajectory({
            trajectoryId: `pii_id_c${comp}_t${i}`,
            learnerPseudoId: `pseudo_piid_c${comp}_u${i}`,
            itemFamilyId: `fam_piid_c${comp}`,
          }),
        );
      }
    }
    const split = createDisjointTrajectorySplit(records, { seed: 321 });

    expect(() =>
      runGepaOptimizationRound({
        basePolicy: makeBasePolicy(),
        split,
        clusteringOptions: { minSupport: 5 },
        extraCandidatePatches: [
          {
            candidateId: "cand_555-867-5309",
            patches: [
              {
                surface: "approvedTemplateSlots",
                summary: "Clean slot",
                payload: { k: "v" },
              },
            ],
          },
        ],
        scoreCandidate: (cand) => ({ ...safe, candidateId: cand.candidateId }),
        paretoOptions: { baseline: { cRate: 0.8, t7Rate: 0.72 } },
      }),
    ).toThrow(CartridgePiiViolationError);
  });

  it("vetoes malformed C/T7 telemetry BEFORE Pareto dominance so invalid candidates cannot suppress valid ones (Round-4 P2-1)", () => {
    const validCandidate = buildMatureCohort("cand_valid_honest", {
      learnerCount: 25,
      repairedCount: 22, // C = 0.88
      t7PassedCount: 24, // T7 = 0.96
    });

    // Leakage-safe candidate claiming T7 rate = 1.0 backed by 0 passes (inconsistent T7 counts!)
    const bogusT7Candidate: CartridgeCandidateMetrics = {
      ...validCandidate,
      candidateId: "cand_bogus_t7_rate",
      c: { ...validCandidate.c, rate: 1, repairedCount: 25, verifiableFirstErrorCount: 25 },
      t7:
        validCandidate.t7.status === "mature"
          ? {
              ...validCandidate.t7,
              rate: 1.0,
              passedFreshTransferCount: 0,
            }
          : validCandidate.t7,
    };

    // Leakage-safe candidate with inconsistent C rate (rate=1.0 backed by 0 repaired)
    const bogusCCandidate: CartridgeCandidateMetrics = {
      ...validCandidate,
      candidateId: "cand_bogus_c_rate",
      c: {
        rate: 1.0,
        repairedCount: 0,
        verifiableFirstErrorCount: 25,
        abandonedCount: 0,
        abandonmentRate: 0,
      },
    };

    const result = evaluateParetoFrontierAndPromotion(
      [bogusT7Candidate, bogusCCandidate, validCandidate],
      {
        baseline: { cRate: 0.85, t7Rate: 0.72 },
        minT7Gain: 0.05,
        nonInferiorityMargin: 0.02,
        minClusterCount: 5,
      },
    );

    expect(result.vetoedCandidateIds).toEqual(["cand_bogus_t7_rate", "cand_bogus_c_rate"]);
    expect(result.frontierCandidateIds).toEqual(["cand_valid_honest"]);
    expect(result.promotedCandidateIds).toEqual(["cand_valid_honest"]);
    expect(result.dominatedCandidateIds).toEqual([]);

    const bogusT7Eval = result.results.find((r) => r.candidateId === "cand_bogus_t7_rate")!;
    expect(bogusT7Eval.status).toBe("vetoed_invalid_telemetry");
    expect(bogusT7Eval.onParetoFrontier).toBe(false);
  });

  it("scans entire scorer receipts and direct Pareto/metrics inputs for raw PII in t7.reason and l.telemetryIssues (Round-5 P1-2)", () => {
    const clean = buildMatureCohort("cand_clean_r5", {
      learnerCount: 25,
      repairedCount: 23,
      t7PassedCount: 24,
    });

    // Direct caller smuggling PII inside t7.reason (pending receipt) -> throws CartridgePiiViolationError
    const piiInPendingReason: CartridgeCandidateMetrics = {
      ...clean,
      candidateId: "cand_pii_reason",
      t7: {
        status: "pending",
        passedFreshTransferCount: 0,
        eligibleFollowupCohortCount: 0,
        pendingCohortCount: 5,
        reason: "Waiting on student alice@university.edu (https://x.test?token = abc12345)",
      },
    };
    expect(() =>
      evaluateParetoFrontierAndPromotion([piiInPendingReason], {
        baseline: { cRate: 0.8, t7Rate: 0.72 },
      }),
    ).toThrow(CartridgePiiViolationError);

    // Direct caller smuggling PII inside l.telemetryIssues -> throws CartridgePiiViolationError
    const piiInTelemetryIssues: CartridgeCandidateMetrics = {
      ...clean,
      candidateId: "cand_pii_issues",
      l: {
        ...clean.l,
        telemetryIssues: ["contact +1-555-234-5678 for audit details"],
      },
    };
    expect(() =>
      evaluateParetoFrontierAndPromotion([piiInTelemetryIssues], {
        baseline: { cRate: 0.8, t7Rate: 0.72 },
      }),
    ).toThrow(CartridgePiiViolationError);

    // Scorer inside runGepaOptimizationRound smuggling PII inside t7.reason -> throws CartridgePiiViolationError
    const records: ErrorTrajectoryRecord[] = [];
    for (let comp = 0; comp < 4; comp += 1) {
      for (let i = 0; i < 6; i += 1) {
        records.push(
          makeTrajectory({
            trajectoryId: `r5_pii_c${comp}_t${i}`,
            learnerPseudoId: `pseudo_r5_c${comp}_u${i}`,
            itemFamilyId: `fam_r5_c${comp}`,
          }),
        );
      }
    }
    const split = createDisjointTrajectorySplit(records, { seed: 555 });
    expect(() =>
      runGepaOptimizationRound({
        basePolicy: makeBasePolicy(),
        split,
        clusteringOptions: { minSupport: 5 },
        scoreCandidate: (cand) => ({
          ...piiInPendingReason,
          candidateId: cand.candidateId,
        }),
        paretoOptions: { baseline: { cRate: 0.8, t7Rate: 0.72 } },
      }),
    ).toThrow(CartridgePiiViolationError);

    // Direct caller passing trajectory with raw PII into computeCandidateMetrics -> throws CartridgePiiViolationError
    expect(() =>
      computeCandidateMetrics("cand_direct_traj_pii", [
        makeTrajectory({
          trajectoryId: "traj_direct_pii",
          snippet: "Reach me at bob@college.edu",
        }),
      ]),
    ).toThrow(CartridgePiiViolationError);
  });

  it("vetoes invalid T7 alpha (> 0.05) and inflated LCB BEFORE Pareto dominance so invalid candidates cannot suppress valid promotable ones (Round-5 P1-3)", () => {
    // Valid promotable candidate: C = 0.88 (22/25), L = 0, T7 = 0.96 (24/25, CP95 ≈ 0.8246 >= 0.77)
    const validPromotable = buildMatureCohort("cand_valid_promotable", {
      learnerCount: 25,
      repairedCount: 22,
      t7PassedCount: 24,
    });

    // Invalid alpha > 0.05 candidate with higher empirical C = 1.0 and T7 = 1.0 on 5/5!
    // Would Pareto-dominate validPromotable if alpha integrity were checked only after Pareto!
    const fiveOfFive = buildMatureCohort("cand_5_base", {
      learnerCount: 5,
      repairedCount: 5,
      t7PassedCount: 5,
    });
    const invalidAlphaDominator: CartridgeCandidateMetrics = {
      ...fiveOfFive,
      candidateId: "cand_invalid_alpha_dominator",
      t7:
        fiveOfFive.t7.status === "mature"
          ? {
              ...fiveOfFive.t7,
              alpha: 0.5,
            }
          : fiveOfFive.t7,
    };

    // Inflated LCB candidate (valid counts 5/5, alpha=0.05, C=1.0, T7=1.0, but forged LCB=0.95 > CP95=0.5493)
    const inflatedLcbDominator: CartridgeCandidateMetrics = {
      ...fiveOfFive,
      candidateId: "cand_inflated_lcb_dominator",
      t7:
        fiveOfFive.t7.status === "mature"
          ? {
              ...fiveOfFive.t7,
              learnerClusterLowerBound: 0.95,
            }
          : fiveOfFive.t7,
    };

    const result = evaluateParetoFrontierAndPromotion(
      [invalidAlphaDominator, inflatedLcbDominator, validPromotable],
      {
        baseline: { cRate: 0.85, t7Rate: 0.72 },
        minT7Gain: 0.05,
        nonInferiorityMargin: 0.02,
        minClusterCount: 5,
      },
    );

    expect(result.vetoedCandidateIds).toEqual([
      "cand_invalid_alpha_dominator",
      "cand_inflated_lcb_dominator",
    ]);
    expect(result.frontierCandidateIds).toEqual(["cand_valid_promotable"]);
    expect(result.promotedCandidateIds).toEqual(["cand_valid_promotable"]);
    expect(result.dominatedCandidateIds).toEqual([]);

    for (const badId of ["cand_invalid_alpha_dominator", "cand_inflated_lcb_dominator"]) {
      const entry = result.results.find((r) => r.candidateId === badId)!;
      expect(entry.status).toBe("vetoed_invalid_telemetry");
      expect(entry.onParetoFrontier).toBe(false);
    }
  });

  it("detects standalone unformatted 10-11 digit phone numbers without floating-point decimal false positives (Round-6 P1-2)", () => {
    const clean = buildMatureCohort("cand_phone_base", {
      learnerCount: 25,
      repairedCount: 23,
      t7PassedCount: 24,
    });

    // Unformatted 10-digit US phone & 11-digit mobile inside t7.reason / l.telemetryIssues / trajectories MUST fail closed!
    expect(() => assertNoRawPiiInText("Call 4155550199", "t7.reason")).toThrow(
      CartridgePiiViolationError,
    );
    expect(() => assertNoRawPiiInText("4155550199", "t7.reason")).toThrow(
      CartridgePiiViolationError,
    );
    expect(() => assertNoRawPiiInText("Mobile 13800138000.", "l.telemetryIssues")).toThrow(
      CartridgePiiViolationError,
    );

    const piiUnformattedPhoneReceipt: CartridgeCandidateMetrics = {
      ...clean,
      candidateId: "cand_unformatted_phone",
      t7: {
        status: "pending",
        passedFreshTransferCount: 0,
        eligibleFollowupCohortCount: 0,
        pendingCohortCount: 5,
        reason: "Waiting on callback 4155550199",
      },
    };
    expect(() =>
      evaluateParetoFrontierAndPromotion([piiUnformattedPhoneReceipt], {
        baseline: { cRate: 0.8, t7Rate: 0.72 },
      }),
    ).toThrow(CartridgePiiViolationError);

    // Floating-point decimals, scientific notation, UUIDs, and 13-digit ms timestamps MUST NOT false-positive!
    expect(() =>
      assertNoRawPiiInText(
        "ratio=0.3333333333 exact=1.0000000000 delta=0.01000010000100001 ts=1700000000000 uuid=550e8400-e29b-41d4-a716-446655440000",
        "numeric_diagnostics",
      ),
    ).not.toThrow();
  });

  it("vetoes unknown t7.status values BEFORE Pareto dominance and never promotes uncertified status (Round-6 P1-3)", () => {
    const validPromotable = buildMatureCohort("cand_valid_r6", {
      learnerCount: 25,
      repairedCount: 22, // C = 0.88
      t7PassedCount: 24, // T7 = 0.96
    });

    // Corrupted runtime t7.status ("unknown") with C = 1.0 and zero leaks — must be vetoed BEFORE Pareto!
    const unknownStatusCandidate: CartridgeCandidateMetrics = {
      ...validPromotable,
      candidateId: "cand_unknown_t7_status",
      c: {
        rate: 1,
        repairedCount: 25,
        verifiableFirstErrorCount: 25,
        abandonedCount: 0,
        abandonmentRate: 0,
      },
      t7: {
        status: "unknown" as never,
        passedFreshTransferCount: 0,
        eligibleFollowupCohortCount: 0,
        pendingCohortCount: 0,
        reason: "corrupted_status",
      } as unknown as CartridgeCandidateMetrics["t7"],
    };

    const result = evaluateParetoFrontierAndPromotion([unknownStatusCandidate, validPromotable], {
      baseline: { cRate: 0.85, t7Rate: 0.72 },
      minT7Gain: 0.05,
      nonInferiorityMargin: 0.02,
      minClusterCount: 5,
    });

    expect(result.vetoedCandidateIds).toEqual(["cand_unknown_t7_status"]);
    expect(result.frontierCandidateIds).toEqual(["cand_valid_r6"]);
    expect(result.promotedCandidateIds).toEqual(["cand_valid_r6"]);
    expect(result.dominatedCandidateIds).toEqual([]);

    const badEntry = result.results.find((r) => r.candidateId === "cand_unknown_t7_status")!;
    expect(badEntry.status).toBe("vetoed_invalid_telemetry");
    expect(badEntry.onParetoFrontier).toBe(false);
    expect(badEntry.vetoReasons).toEqual(expect.arrayContaining(["invalid_t7_status"]));
    expect(JSON.stringify(badEntry.vetoReasons)).not.toContain("unknown");
  });

  it("allows valid UUIDs with 11-digit tails and alphanumeric IDs while still catching unformatted phones (Round-7 P1-1)", () => {
    // Valid UUID ending in a12345678901 and alphanumeric/underscore token id_1234567890 MUST NOT false-positive.
    expect(() =>
      assertNoRawPiiInText(
        "trace=550e8400-e29b-41d4-a716-a12345678901 ref=id_1234567890 hex=a12345678901",
        "uuid_and_alnum",
      ),
    ).not.toThrow();

    // Real unformatted phones in standalone/key=val/tel: contexts ARE still caught.
    for (const sample of [
      "4155550199",
      "13800138000",
      "contact=4155550199",
      "tel:4155550199",
    ]) {
      expect(() => assertNoRawPiiInText(sample, "phone_check")).toThrow(
        CartridgePiiViolationError,
      );
    }
  });

  it("rejects non-string numeric PII in t7.reason / l.telemetryIssues and redacts non-string raw fields on vetoed receipts (Round-7 P1-2)", () => {
    const clean = buildMatureCohort("cand_num_pii_base", {
      learnerCount: 25,
      repairedCount: 23,
      t7PassedCount: 24,
    });

    // Numeric phone 4155550199 smuggled into t7.reason -> throws CartridgePiiViolationError!
    const numericPhoneReason: CartridgeCandidateMetrics = {
      ...clean,
      candidateId: "cand_numeric_phone_reason",
      t7: {
        status: "pending",
        passedFreshTransferCount: 0,
        eligibleFollowupCohortCount: 0,
        pendingCohortCount: 5,
        reason: 4155550199 as unknown as string,
      },
    };
    expect(() =>
      evaluateParetoFrontierAndPromotion([numericPhoneReason], {
        baseline: { cRate: 0.8, t7Rate: 0.72 },
      }),
    ).toThrow(CartridgePiiViolationError);

    // Numeric phone smuggled inside l.telemetryIssues -> throws CartridgePiiViolationError!
    const numericPhoneIssue: CartridgeCandidateMetrics = {
      ...clean,
      candidateId: "cand_numeric_phone_issue",
      l: {
        ...clean.l,
        telemetryIssues: [13800138000 as unknown as string],
      },
    };
    expect(() =>
      evaluateParetoFrontierAndPromotion([numericPhoneIssue], {
        baseline: { cRate: 0.8, t7Rate: 0.72 },
      }),
    ).toThrow(CartridgePiiViolationError);

    // Non-PII non-string value (e.g., 42) in t7.reason is vetoed AND redacted (never echoed raw in returned metrics).
    const nonStringReason: CartridgeCandidateMetrics = {
      ...clean,
      candidateId: "cand_non_string_reason",
      t7: {
        status: "pending",
        passedFreshTransferCount: 0,
        eligibleFollowupCohortCount: 0,
        pendingCohortCount: 5,
        reason: 42 as unknown as string,
      },
    };
    const vetoRes = evaluateParetoFrontierAndPromotion([nonStringReason], {
      baseline: { cRate: 0.8, t7Rate: 0.72 },
    });
    expect(vetoRes.vetoedCandidateIds).toEqual(["cand_non_string_reason"]);
    const vetoedEntry = vetoRes.results[0]!;
    expect(vetoedEntry.status).toBe("vetoed_invalid_telemetry");
    expect(vetoedEntry.metrics.t7.status).toBe("pending");
    if (vetoedEntry.metrics.t7.status === "pending") {
      expect(typeof vetoedEntry.metrics.t7.reason).toBe("string");
      expect(vetoedEntry.metrics.t7.reason).toBe("redacted_invalid_reason");
    }
  });

  it("rejects non-finite or out-of-range Pareto promotion option thresholds fail-closed (Round-7 P1-3)", () => {
    const safe = buildMatureCohort("cand_opts_check", {
      learnerCount: 25,
      repairedCount: 22,
      t7PassedCount: 24,
    });

    const invalidOptionCases = [
      { baseline: { cRate: 0.8, t7Rate: 0.72 }, minT7Gain: Number.NEGATIVE_INFINITY },
      { baseline: { cRate: 0.8, t7Rate: 0.72 }, minT7Gain: Number.NaN },
      { baseline: { cRate: 0.8, t7Rate: 0.72 }, minT7Gain: -0.05 },
      { baseline: { cRate: 0.8, t7Rate: 0.72 }, nonInferiorityMargin: Number.POSITIVE_INFINITY },
      { baseline: { cRate: 0.8, t7Rate: 0.72 }, nonInferiorityMargin: Number.NaN },
      { baseline: { cRate: 0.8, t7Rate: 0.72 }, nonInferiorityMargin: -0.01 },
      { baseline: { cRate: 0.8, t7Rate: 0.72 }, nonInferiorityMargin: 1.5 },
      { baseline: { cRate: 0.8, t7Rate: 0.72 }, maxAllowedLeakageRate: Number.NaN },
      { baseline: { cRate: 0.8, t7Rate: 0.72 }, minClusterCount: 0 },
      { baseline: { cRate: 0.8, t7Rate: 0.72 }, minClusterCount: Number.POSITIVE_INFINITY },
      { baseline: { cRate: Number.NaN, t7Rate: 0.72 } },
      { baseline: { cRate: 0.8, t7Rate: 1.2 } },
    ];

    for (const opts of invalidOptionCases) {
      expect(() => evaluateParetoFrontierAndPromotion([safe], opts)).toThrow(RangeError);
    }
  });

  it("scopes UUID masking ONLY to phone/SSN checks so UUID local-part emails and UUID Bearer tokens are caught (Round-8 P1-1)", () => {
    // UUID local-part email MUST be rejected as email PII!
    expect(() =>
      assertNoRawPiiInText("550e8400-e29b-41d4-a716-446655440000@example.com", "uuid_email"),
    ).toThrow(CartridgePiiViolationError);

    // Bearer token formatted as UUID MUST be rejected as auth_token PII!
    expect(() =>
      assertNoRawPiiInText("Bearer 550e8400-e29b-41d4-a716-446655440000", "uuid_bearer"),
    ).toThrow(CartridgePiiViolationError);

    // Tokenized URL carrying UUID token MUST be rejected!
    expect(() =>
      assertNoRawPiiInText(
        "https://api.example.edu/eval?token=550e8400-e29b-41d4-a716-446655440000",
        "uuid_url_token",
      ),
    ).toThrow(CartridgePiiViolationError);

    // Benign bare UUID with 11-digit tail STILL passes cleanly (no phone/SSN false positive).
    expect(() =>
      assertNoRawPiiInText("trace=550e8400-e29b-41d4-a716-a12345678901", "uuid_benign"),
    ).not.toThrow();
  });

  it("rejects nested numeric PII under arbitrary keys like extra.seed, blocks 9-digit SSN ints, avoids echoing malformed status, and strips extra fields on ALL returned receipts (Round-8 P1-2)", () => {
    const clean = buildMatureCohort("cand_r8_base", {
      learnerCount: 25,
      repairedCount: 23,
      t7PassedCount: 24,
    });

    // Nested numeric phone under `{ extra: { seed: 4155550199 } }` MUST NOT bypass PII check via bare key name!
    const nestedExtraSeed = {
      ...clean,
      candidateId: "cand_extra_seed_phone",
      extra: { seed: 4155550199 },
    } as unknown as CartridgeCandidateMetrics;
    expect(() =>
      evaluateParetoFrontierAndPromotion([nestedExtraSeed], {
        baseline: { cRate: 0.8, t7Rate: 0.72 },
      }),
    ).toThrow(CartridgePiiViolationError);

    // 9-digit SSN-length integer inside malformed t7.status MUST be rejected as numeric_ssn_pii!
    const numericSsnStatus: CartridgeCandidateMetrics = {
      ...clean,
      candidateId: "cand_ssn_status",
      t7: {
        status: 123456789 as never,
        passedFreshTransferCount: 0,
        eligibleFollowupCohortCount: 0,
        pendingCohortCount: 0,
        reason: "bad",
      } as unknown as CartridgeCandidateMetrics["t7"],
    };
    expect(() =>
      evaluateParetoFrontierAndPromotion([numericSsnStatus], {
        baseline: { cRate: 0.8, t7Rate: 0.72 },
      }),
    ).toThrow(CartridgePiiViolationError);

    // Malformed non-PII string status (e.g. "custom_secret_tag") is vetoed using fixed diagnostic code ONLY (never echoed).
    const malformedStringStatus: CartridgeCandidateMetrics = {
      ...clean,
      candidateId: "cand_custom_status",
      t7: {
        status: "custom_secret_tag" as never,
        passedFreshTransferCount: 0,
        eligibleFollowupCohortCount: 0,
        pendingCohortCount: 0,
        reason: "bad",
      } as unknown as CartridgeCandidateMetrics["t7"],
    };
    const malformedRes = evaluateParetoFrontierAndPromotion([malformedStringStatus], {
      baseline: { cRate: 0.8, t7Rate: 0.72 },
    });
    expect(malformedRes.results[0]!.vetoReasons).toEqual(["invalid_t7_status"]);
    expect(JSON.stringify(malformedRes)).not.toContain("custom_secret_tag");

    // Non-vetoed (promoted) candidate carrying undeclared extra fields MUST have extra properties stripped on output!
    const promotedWithExtra = {
      ...clean,
      candidateId: "cand_promoted_projected",
      undeclaredTop: "should_not_appear",
      c: { ...clean.c, undeclaredC: "drop_c" },
      l: { ...clean.l, undeclaredL: "drop_l" },
      t7: { ...clean.t7, undeclaredT7: "drop_t7" },
    } as unknown as CartridgeCandidateMetrics;
    const promotedRes = evaluateParetoFrontierAndPromotion([promotedWithExtra], {
      baseline: { cRate: 0.8, t7Rate: 0.72 },
    });
    expect(promotedRes.promotedCandidateIds).toEqual(["cand_promoted_projected"]);
    const outMetrics = promotedRes.results[0]!.metrics as unknown as Record<string, unknown>;
    expect(outMetrics).not.toHaveProperty("undeclaredTop");
    expect(outMetrics.c).not.toHaveProperty("undeclaredC");
    expect(outMetrics.l).not.toHaveProperty("undeclaredL");
    expect(outMetrics.t7).not.toHaveProperty("undeclaredT7");
  });

  it("redacts sensitive or PII-bearing property keys in CartridgePiiViolationError message and offendingFields (Round-8 P1-3)", () => {
    const cases: { payload: unknown; forbiddenSubstrings: string[] }[] = [
      {
        payload: { "alice@example.com": "x" },
        forbiddenSubstrings: ["alice@example.com"],
      },
      {
        payload: { "ssn_123-45-6789": "4155550199" },
        forbiddenSubstrings: ["ssn_123-45-6789", "123-45-6789", "4155550199"],
      },
      {
        payload: { email: "bob@university.edu", nested: { phoneNumber: "4155550199" } },
        forbiddenSubstrings: ["bob@university.edu", "4155550199", ".email:", ".phoneNumber:"],
      },
    ];

    for (const { payload, forbiddenSubstrings } of cases) {
      let caught: unknown;
      try {
        assertNoRawPiiInValue(payload, "audit_payload");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(CartridgePiiViolationError);
      const piiErr = caught as CartridgePiiViolationError;
      const serializedFields = JSON.stringify(piiErr.offendingFields);
      expect(serializedFields).toContain("[redacted_key]");
      for (const secret of forbiddenSubstrings) {
        expect(piiErr.message).not.toContain(secret);
        expect(serializedFields).not.toContain(secret);
      }
    }
  });

  it("rejects unformatted 9-digit SSN strings while preserving UUIDs/alphanumeric IDs and avoids echoing custom pending reason strings (Round-9 P1-1)", () => {
    for (const bad of ["123456789", "ssn=123456789", "id: 123456789"]) {
      expect(() => assertNoRawPiiInText(bad, "ssn_text")).toThrow(CartridgePiiViolationError);
    }

    // Benign UUIDs and alphanumeric/underscore IDs pass cleanly.
    expect(() =>
      assertNoRawPiiInText(
        "trace=550e8400-e29b-41d4-a716-a12345678901 ref=id_123456789 ratio=0.123456789",
        "benign_text",
      ),
    ).not.toThrow();

    // Unformatted 9-digit SSN string in t7.reason is caught!
    const clean = buildMatureCohort("cand_r9_ssn_base", {
      learnerCount: 25,
      repairedCount: 23,
      t7PassedCount: 24,
    });
    const ssnPending: CartridgeCandidateMetrics = {
      ...clean,
      candidateId: "cand_ssn_reason",
      t7: {
        status: "pending",
        passedFreshTransferCount: 0,
        eligibleFollowupCohortCount: 0,
        pendingCohortCount: 5,
        reason: "pending review for 123456789",
      },
    };
    expect(() =>
      evaluateParetoFrontierAndPromotion([ssnPending], {
        baseline: { cRate: 0.8, t7Rate: 0.72 },
      }),
    ).toThrow(CartridgePiiViolationError);

    // Custom benign pending reason maps to fixed diagnostic code in promotionBlockers (never echoes arbitrary text).
    const customPending: CartridgeCandidateMetrics = {
      ...clean,
      candidateId: "cand_custom_pending_reason",
      t7: {
        status: "pending",
        passedFreshTransferCount: 0,
        eligibleFollowupCohortCount: 0,
        pendingCohortCount: 5,
        reason: "internal_custom_note_xyz",
      },
    };
    const pendingRes = evaluateParetoFrontierAndPromotion([customPending], {
      baseline: { cRate: 0.8, t7Rate: 0.72 },
    });
    expect(pendingRes.results[0]!.promotionBlockers).toEqual(["t7_pending:immature_followup_window"]);
    expect(JSON.stringify(pendingRes)).not.toContain("internal_custom_note_xyz");
  });

  it("scans PII before GEPA patch schema validation and redacts unexpected keys in validateAndApplyGepaPatch (Round-9 P1-2)", () => {
    const base = makeBasePolicy();

    // PII-bearing unexpected top-level key MUST trigger CartridgePiiViolationError (not schema error) and NEVER echo the email!
    let piiCaught: unknown;
    try {
      validateAndApplyGepaPatch(base, {
        surface: "approvedTemplateSlots",
        summary: "Test patch",
        payload: { slotA: "Check premise" },
        "alice@example.com": 1,
      });
    } catch (err) {
      piiCaught = err;
    }
    expect(piiCaught).toBeInstanceOf(CartridgePiiViolationError);
    expect((piiCaught as CartridgePiiViolationError).message).not.toContain("alice@example.com");
    expect(JSON.stringify((piiCaught as CartridgePiiViolationError).offendingFields)).not.toContain(
      "alice@example.com",
    );

    // Non-PII unexpected key MUST throw GepaInvalidPatchPayloadError WITHOUT echoing the raw key name!
    let schemaCaught: unknown;
    try {
      validateAndApplyGepaPatch(base, {
        surface: "moveRules",
        summary: "Extra non-PII key",
        payload: [
          {
            id: "r1",
            conceptId: "alg.zero_product_property",
            triggerRuleId: "err.divide_by_variable",
            missingPremise: "x != 0",
            move: "targeted_scaffold",
            priority: 10,
            secretInternalPropName: "value",
          },
        ],
      });
    } catch (err) {
      schemaCaught = err;
    }
    expect(schemaCaught).toBeInstanceOf(GepaInvalidPatchPayloadError);
    const invalidErr = schemaCaught as GepaInvalidPatchPayloadError;
    expect(invalidErr.message).not.toContain("secretInternalPropName");
    expect(JSON.stringify(invalidErr.issues)).not.toContain("secretInternalPropName");
    expect(JSON.stringify(invalidErr.issues)).toContain("unexpected_patch_field");
  });

  it("vetoes individual malformed receipts (l: null, c: null, t7: null) without crashing batch evaluation of valid siblings (Round-9 P1-4)", () => {
    const validPromotable = buildMatureCohort("cand_valid_sibling", {
      learnerCount: 25,
      repairedCount: 22,
      t7PassedCount: 24,
    });

    const nullL = {
      ...validPromotable,
      candidateId: "cand_null_l",
      l: null,
    } as unknown as CartridgeCandidateMetrics;

    const nullC = {
      ...validPromotable,
      candidateId: "cand_null_c",
      c: null,
    } as unknown as CartridgeCandidateMetrics;

    const nullT7 = {
      ...validPromotable,
      candidateId: "cand_null_t7",
      t7: null,
    } as unknown as CartridgeCandidateMetrics;

    const result = evaluateParetoFrontierAndPromotion(
      [nullL, nullC, nullT7, validPromotable],
      {
        baseline: { cRate: 0.85, t7Rate: 0.72 },
        minT7Gain: 0.05,
        nonInferiorityMargin: 0.02,
        minClusterCount: 5,
      },
    );

    expect(result.vetoedCandidateIds).toEqual(["cand_null_l", "cand_null_c", "cand_null_t7"]);
    expect(result.frontierCandidateIds).toEqual(["cand_valid_sibling"]);
    expect(result.promotedCandidateIds).toEqual(["cand_valid_sibling"]);

    const nullLEval = result.results.find((r) => r.candidateId === "cand_null_l")!;
    expect(nullLEval.status).toBe("vetoed_leakage");
    expect(nullLEval.vetoReasons).toEqual(["invalid_leakage_telemetry"]);

    const nullCEval = result.results.find((r) => r.candidateId === "cand_null_c")!;
    expect(nullCEval.status).toBe("vetoed_invalid_telemetry");
    expect(nullCEval.vetoReasons).toEqual(["invalid_objective_telemetry:missing_c"]);

    const nullT7Eval = result.results.find((r) => r.candidateId === "cand_null_t7")!;
    expect(nullT7Eval.status).toBe("vetoed_invalid_telemetry");
    expect(nullT7Eval.vetoReasons).toEqual(["invalid_t7_status"]);
  });

  it("catches space/dot-separated SSNs and scrubs caller free text from metrics.t7.reason and metrics.l.telemetryIssues (Round-10 P1-1)", () => {
    for (const ssnVariant of ["123 45 6789", "123.45.6789", "123-45-6789", "123456789"]) {
      expect(() => assertNoRawPiiInText(`id ${ssnVariant}`, "ssn_variants")).toThrow(
        CartridgePiiViolationError,
      );
    }

    const clean = buildMatureCohort("cand_r10_scrub_base", {
      learnerCount: 25,
      repairedCount: 23,
      t7PassedCount: 24,
    });

    // Space-separated SSN inside t7.reason is caught and throws CartridgePiiViolationError!
    const spacedSsnReason: CartridgeCandidateMetrics = {
      ...clean,
      candidateId: "cand_spaced_ssn_reason",
      t7: {
        status: "pending",
        passedFreshTransferCount: 0,
        eligibleFollowupCohortCount: 0,
        pendingCohortCount: 5,
        reason: "Waiting on cohort 123 45 6789",
      },
    };
    expect(() =>
      evaluateParetoFrontierAndPromotion([spacedSsnReason], {
        baseline: { cRate: 0.8, t7Rate: 0.72 },
      }),
    ).toThrow(CartridgePiiViolationError);

    // Caller free text in t7.reason and l.telemetryIssues is NEVER echoed verbatim in returned metrics or diagnostics!
    const freeTextReceipt: CartridgeCandidateMetrics = {
      ...clean,
      candidateId: "cand_free_text_scrub",
      l: {
        ...clean.l,
        telemetryIssues: ["Alice Smith custom raw telemetry note"],
      },
      t7: {
        status: "pending",
        passedFreshTransferCount: 0,
        eligibleFollowupCohortCount: 0,
        pendingCohortCount: 5,
        reason: "Bob Jones awaiting teacher grading",
      },
    };
    const res = evaluateParetoFrontierAndPromotion([freeTextReceipt], {
      baseline: { cRate: 0.8, t7Rate: 0.72 },
    });
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain("Alice Smith");
    expect(serialized).not.toContain("Bob Jones");
    expect(res.results[0]!.metrics.l.telemetryIssues).toEqual(["telemetry_issue_reported"]);
    expect(res.results[0]!.metrics.t7.status).toBe("pending");
    if (res.results[0]!.metrics.t7.status === "pending") {
      expect(res.results[0]!.metrics.t7.reason).toBe("immature_followup_window");
    }
  });

  it("never echoes unexpected ancestor keys in nested forbidden-surface GEPA errors (Round-10 P1-2)", () => {
    const base = makeBasePolicy();
    let caught: unknown;
    try {
      validateAndApplyGepaPatch(base, {
        surface: "approvedTemplateSlots",
        summary: "Attempt nested forbidden key under learner name",
        payload: {
          "Alice Smith": {
            permissions: { allowAll: true },
          },
        },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(GepaForbiddenSurfaceError);
    const surfErr = caught as GepaForbiddenSurfaceError;
    expect(surfErr.message).not.toContain("Alice Smith");
    expect(surfErr.attemptedSurface).not.toContain("Alice Smith");
    expect(surfErr.attemptedSurface).toBe("approvedTemplateSlots.<unexpected_key>.permissions");
  });

  it("isolates null/undefined/malformed scorer receipts in runGepaOptimizationRound without aborting valid sibling candidates (Round-10 P1-4)", () => {
    const records: ErrorTrajectoryRecord[] = [];
    for (let comp = 0; comp < 4; comp += 1) {
      for (let i = 0; i < 6; i += 1) {
        records.push(
          makeTrajectory({
            trajectoryId: `r10_null_c${comp}_t${i}`,
            learnerPseudoId: `pseudo_r10_c${comp}_u${i}`,
            itemFamilyId: `fam_r10_c${comp}`,
          }),
        );
      }
    }
    const split = createDisjointTrajectorySplit(records, { seed: 2026 });

    const round = runGepaOptimizationRound({
      basePolicy: makeBasePolicy(),
      split,
      clusteringOptions: { minSupport: 5 },
      extraCandidatePatches: [
        {
          candidateId: "cand_null_receipt",
          patches: [
            {
              surface: "approvedTemplateSlots",
              summary: "Slot 1",
              payload: { s1: "Verify premise" },
            },
          ],
        },
        {
          candidateId: "cand_valid_sibling_1",
          patches: [
            {
              surface: "approvedTemplateSlots",
              summary: "Slot 2",
              payload: { s2: "Verify premise carefully" },
            },
          ],
        },
        {
          candidateId: "cand_valid_sibling_2",
          patches: [
            {
              surface: "approvedTemplateSlots",
              summary: "Slot 3",
              payload: { s3: "Check edge case" },
            },
          ],
        },
      ],
      scoreCandidate: (candidate) => {
        if (candidate.candidateId === "cand_null_receipt") {
          return null as unknown as CartridgeCandidateMetrics;
        }
        return buildMatureCohort(candidate.candidateId, {
          learnerCount: 25,
          repairedCount: 23,
          t7PassedCount: 24,
        });
      },
      paretoOptions: {
        baseline: { cRate: 0.85, t7Rate: 0.72 },
        minT7Gain: 0.05,
        nonInferiorityMargin: 0.02,
        minClusterCount: 5,
      },
    });

    expect(round.pareto.vetoedCandidateIds).toContain("cand_null_receipt");
    expect(round.pareto.promotedCandidateIds).toContain("cand_valid_sibling_1");
    expect(round.pareto.promotedCandidateIds).toContain("cand_valid_sibling_2");
    const nullEntry = round.pareto.results.find((r) => r.candidateId === "cand_null_receipt")!;
    expect(nullEntry.status).toBe("vetoed_leakage");
    expect(nullEntry.onParetoFrontier).toBe(false);
  });

  it("catches formatted SSNs followed by sentence punctuation while excluding dotted version/IP tokens (Round-11 P1-1)", () => {
    for (const ssnWithPunct of [
      "Learner SSN is 123-45-6789.",
      "Learner SSN is 123 45 6789.",
      "Learner SSN is 123.45.6789.",
      "Verify 123-45-6789, please.",
      "Verify 123 45 6789; next.",
      "Verify 123-45-6789: done",
      "Is it 123-45-6789?",
      "Stop 123-45-6789!",
      "(123-45-6789)",
    ]) {
      expect(() => assertNoRawPiiInText(ssnWithPunct, "ssn_sentence_end")).toThrow(
        CartridgePiiViolationError,
      );
    }

    // Dotted version / IP-like tokens with a trailing or leading numeric segment remain excluded.
    expect(() =>
      assertNoRawPiiInText("Release 123.45.6789.1 and host 1.123.45.6789 passed.", "dotted_version"),
    ).not.toThrow();

    // Sentence-ending SSN inside a GEPA patch and trajectory snippet MUST be blocked!
    expect(() =>
      validateAndApplyGepaPatch(makeBasePolicy(), {
        surface: "approvedTemplateSlots",
        summary: "Note 123-45-6789.",
        payload: { s1: "Check premise" },
      }),
    ).toThrow(CartridgePiiViolationError);
    expect(() =>
      clusterErrorTrajectories([
        makeTrajectory({
          trajectoryId: "r11_ssn_punct_t1",
          snippet: "Student wrote 123 45 6789.",
        }),
      ]),
    ).toThrow(CartridgePiiViolationError);
  });

  it("redacts unexpected object keys as <unexpected_key> in recursive PII scanner error paths (Round-11 P1-2)", () => {
    // Direct recursive value scan with unrecognized ancestor key ("Alice Smith")
    let directErr: unknown;
    try {
      assertNoRawPiiInValue({ "Alice Smith": { note: "alice@example.com" } }, "audit_payload");
    } catch (err) {
      directErr = err;
    }
    expect(directErr).toBeInstanceOf(CartridgePiiViolationError);
    const piiDirect = directErr as CartridgePiiViolationError;
    expect(piiDirect.message).toContain("<unexpected_key>");
    expect(JSON.stringify(piiDirect.offendingFields)).toContain("<unexpected_key>");
    expect(piiDirect.message).not.toContain("Alice Smith");
    expect(JSON.stringify(piiDirect.offendingFields)).not.toContain("Alice Smith");
    expect(piiDirect.message).not.toContain("alice@example.com");

    // GEPA patch with unrecognized ancestor key ("Alice Smith") wrapping PII leaf
    let patchErr: unknown;
    try {
      validateAndApplyGepaPatch(makeBasePolicy(), {
        surface: "approvedTemplateSlots",
        summary: "Nested PII under learner name key",
        payload: {
          "Alice Smith": { note: "alice@example.com" },
        },
      });
    } catch (err) {
      patchErr = err;
    }
    expect(patchErr).toBeInstanceOf(CartridgePiiViolationError);
    const piiPatch = patchErr as CartridgePiiViolationError;
    expect(piiPatch.message).toContain("<unexpected_key>");
    expect(JSON.stringify(piiPatch.offendingFields)).toContain("<unexpected_key>");
    expect(piiPatch.message).not.toContain("Alice Smith");
    expect(JSON.stringify(piiPatch.offendingFields)).not.toContain("Alice Smith");
    expect(piiPatch.message).not.toContain("alice@example.com");
  });

  it("allocates collision-free synthetic malformed-receipt IDs so valid '__malformed_candidate_0' and '__malformed_receipt_0' siblings still promote (Round-11 P1-4)", () => {
    const validCand0 = buildMatureCohort("__malformed_candidate_0", {
      learnerCount: 25,
      repairedCount: 23,
      t7PassedCount: 24,
    });
    const validReceipt0 = buildMatureCohort("__malformed_receipt_0", {
      learnerCount: 25,
      repairedCount: 23,
      t7PassedCount: 24,
    });
    const missingIdReceipt = {
      c: validCand0.c,
      l: validCand0.l,
      t7: validCand0.t7,
    } as unknown as CartridgeCandidateMetrics;

    // 1) Direct Pareto evaluation: null receipt at index 0 alongside valid "__malformed_candidate_0" and "__malformed_receipt_0"
    const resNull = evaluateParetoFrontierAndPromotion(
      [null as unknown as CartridgeCandidateMetrics, validCand0, validReceipt0],
      {
        baseline: { cRate: 0.85, t7Rate: 0.72 },
        minT7Gain: 0.05,
        nonInferiorityMargin: 0.02,
        minClusterCount: 5,
      },
    );
    expect(resNull.promotedCandidateIds).toContain("__malformed_candidate_0");
    expect(resNull.promotedCandidateIds).toContain("__malformed_receipt_0");
    expect(resNull.vetoedCandidateIds).toHaveLength(1);
    expect(resNull.vetoedCandidateIds[0]).not.toBe("__malformed_candidate_0");
    expect(resNull.vetoedCandidateIds[0]).not.toBe("__malformed_receipt_0");

    // 2) Direct Pareto evaluation: missing-ID receipt at index 0 alongside valid "__malformed_candidate_0" and "__malformed_receipt_0"
    const resMissingId = evaluateParetoFrontierAndPromotion(
      [missingIdReceipt, validCand0, validReceipt0],
      {
        baseline: { cRate: 0.85, t7Rate: 0.72 },
        minT7Gain: 0.05,
        nonInferiorityMargin: 0.02,
        minClusterCount: 5,
      },
    );
    expect(resMissingId.promotedCandidateIds).toContain("__malformed_candidate_0");
    expect(resMissingId.promotedCandidateIds).toContain("__malformed_receipt_0");
    expect(resMissingId.vetoedCandidateIds).toHaveLength(1);
    expect(resMissingId.vetoedCandidateIds[0]).not.toBe("__malformed_candidate_0");
    expect(resMissingId.vetoedCandidateIds[0]).not.toBe("__malformed_receipt_0");

    // 3) Full GEPA round: null receipt for one candidate alongside valid "__malformed_candidate_0" and "__malformed_receipt_0"
    const records: ErrorTrajectoryRecord[] = [];
    for (let comp = 0; comp < 4; comp += 1) {
      for (let i = 0; i < 6; i += 1) {
        records.push(
          makeTrajectory({
            trajectoryId: `r11_col_c${comp}_t${i}`,
            learnerPseudoId: `pseudo_r11_c${comp}_u${i}`,
            itemFamilyId: `fam_r11_c${comp}`,
          }),
        );
      }
    }
    const split = createDisjointTrajectorySplit(records, { seed: 2027 });
    const round = runGepaOptimizationRound({
      basePolicy: makeBasePolicy(),
      split,
      clusteringOptions: { minSupport: 5 },
      extraCandidatePatches: [
        {
          candidateId: "cand_r11_missing_receipt",
          patches: [
            {
              surface: "approvedTemplateSlots",
              summary: "Slot 0",
              payload: { s0: "Verify premise" },
            },
          ],
        },
        {
          candidateId: "__malformed_candidate_0",
          patches: [
            {
              surface: "approvedTemplateSlots",
              summary: "Slot 1",
              payload: { s1: "Verify premise carefully" },
            },
          ],
        },
        {
          candidateId: "__malformed_receipt_0",
          patches: [
            {
              surface: "approvedTemplateSlots",
              summary: "Slot 2",
              payload: { s2: "Check boundary condition" },
            },
          ],
        },
      ],
      scoreCandidate: (candidate) => {
        if (candidate.candidateId === "cand_r11_missing_receipt") {
          return null as unknown as CartridgeCandidateMetrics;
        }
        return buildMatureCohort(candidate.candidateId, {
          learnerCount: 25,
          repairedCount: 23,
          t7PassedCount: 24,
        });
      },
      paretoOptions: {
        baseline: { cRate: 0.85, t7Rate: 0.72 },
        minT7Gain: 0.05,
        nonInferiorityMargin: 0.02,
        minClusterCount: 5,
      },
    });
    expect(round.pareto.vetoedCandidateIds).toContain("cand_r11_missing_receipt");
    expect(round.pareto.promotedCandidateIds).toContain("__malformed_candidate_0");
    expect(round.pareto.promotedCandidateIds).toContain("__malformed_receipt_0");
  });

  it("blocks non-enumerable, symbol-keyed, and accessor properties carrying PII or hidden slots in clustering and GEPA patch application (Round-12 P1-1)", () => {
    const base = makeBasePolicy();

    // 1) Non-enumerable PII slot inside GEPA approvedTemplateSlots MUST throw CartridgePiiViolationError (never copy into policy!)
    const hiddenPiiSlots: Record<string, string> = {};
    Object.defineProperty(hiddenPiiSlots, "hint", {
      value: "SSN 123-45-6789",
      enumerable: false,
      configurable: true,
    });
    expect(() =>
      validateAndApplyGepaPatch(base, {
        surface: "approvedTemplateSlots",
        summary: "Hidden non-enumerable PII slot",
        payload: hiddenPiiSlots,
      }),
    ).toThrow(CartridgePiiViolationError);

    // 2) Clean non-enumerable slot property MUST still be rejected fail-closed by GEPA schema/application!
    const hiddenCleanSlots: Record<string, string> = {};
    Object.defineProperty(hiddenCleanSlots, "hint", {
      value: "Check boundary premise",
      enumerable: false,
      configurable: true,
    });
    expect(() =>
      validateAndApplyGepaPatch(base, {
        surface: "approvedTemplateSlots",
        summary: "Hidden non-enumerable clean slot",
        payload: hiddenCleanSlots,
      }),
    ).toThrow(GepaInvalidPatchPayloadError);

    // 3) Symbol-keyed PII in GEPA slot payload and clustering trajectory MUST fail closed without echoing description or PII
    const symKey = Symbol("secret_student_key");
    const symbolPiiSlots: Record<string | symbol, string> = {
      [symKey]: "alice@example.com",
    };
    let symErr: unknown;
    try {
      validateAndApplyGepaPatch(base, {
        surface: "approvedTemplateSlots",
        summary: "Symbol-keyed PII slot",
        payload: symbolPiiSlots,
      });
    } catch (err) {
      symErr = err;
    }
    expect(symErr).toBeInstanceOf(CartridgePiiViolationError);
    expect((symErr as CartridgePiiViolationError).message).not.toContain("alice@example.com");
    expect((symErr as CartridgePiiViolationError).message).not.toContain("secret_student_key");

    const trajWithHiddenPii = makeTrajectory({ trajectoryId: "r12_non_enum_traj" });
    Object.defineProperty(trajWithHiddenPii, "hiddenSecret", {
      value: "123-45-6789",
      enumerable: false,
      configurable: true,
    });
    expect(() => clusterErrorTrajectories([trajWithHiddenPii])).toThrow(CartridgePiiViolationError);

    const trajWithSymbolPii = makeTrajectory({ trajectoryId: "r12_sym_traj" }) as unknown as Record<
      string | symbol,
      unknown
    >;
    trajWithSymbolPii[Symbol("raw_note")] = "bob@university.edu";
    expect(() =>
      clusterErrorTrajectories([trajWithSymbolPii as unknown as ErrorTrajectoryRecord]),
    ).toThrow(CartridgePiiViolationError);

    // 4) Accessor getter descriptor MUST fail closed WITHOUT invoking the getter!
    let getterInvoked = false;
    const getterSlots: Record<string, string> = {};
    Object.defineProperty(getterSlots, "hint", {
      enumerable: true,
      get() {
        getterInvoked = true;
        return "123-45-6789";
      },
    });
    expect(() =>
      validateAndApplyGepaPatch(base, {
        surface: "approvedTemplateSlots",
        summary: "Getter slot",
        payload: getterSlots,
      }),
    ).toThrow(CartridgePiiViolationError);
    expect(getterInvoked).toBe(false);
  });

  it("scans raw PII strictly before holdout overlap checks so overlapping raw email/SSN learner IDs throw CartridgePiiViolationError without echoing PII (Round-12 P1-3)", () => {
    const trainEmailTraj = makeTrajectory({
      trajectoryId: "r12_p13_train_1",
      learnerPseudoId: "alice@example.com",
      itemFamilyId: "fam_r12_a",
    });
    const holdoutEmailTraj = makeTrajectory({
      trajectoryId: "r12_p13_holdout_1",
      learnerPseudoId: "alice@example.com",
      itemFamilyId: "fam_r12_b",
    });
    const taintedSplit: DisjointDatasetSplit = {
      train: [trainEmailTraj],
      dev: [],
      holdout: [holdoutEmailTraj],
      quarantinedCrossing: [],
      holdoutFirewall: {
        holdoutTrajectoryIds: [holdoutEmailTraj.trajectoryId],
        holdoutLearnerPseudoIds: [holdoutEmailTraj.learnerPseudoId],
        holdoutItemFamilyIds: [holdoutEmailTraj.itemFamilyId],
      },
    };

    // 1) Direct assertDisjointSplitInvariants MUST throw CartridgePiiViolationError (NOT HoldoutFirewallError) and never echo alice@example.com!
    let directErr: unknown;
    try {
      assertDisjointSplitInvariants(taintedSplit);
    } catch (err) {
      directErr = err;
    }
    expect(directErr).toBeInstanceOf(CartridgePiiViolationError);
    const directPii = directErr as CartridgePiiViolationError;
    expect(directPii.message).not.toContain("alice@example.com");
    expect(JSON.stringify(directPii)).not.toContain("alice@example.com");

    // 2) Full runGepaOptimizationRound MUST also throw CartridgePiiViolationError first and never echo alice@example.com!
    let roundErr: unknown;
    try {
      runGepaOptimizationRound({
        basePolicy: makeBasePolicy(),
        split: taintedSplit,
        scoreCandidate: (c) =>
          buildMatureCohort(c.candidateId, {
            learnerCount: 25,
            repairedCount: 23,
            t7PassedCount: 24,
          }),
        paretoOptions: {
          baseline: { cRate: 0.85, t7Rate: 0.72 },
        },
      });
    } catch (err) {
      roundErr = err;
    }
    expect(roundErr).toBeInstanceOf(CartridgePiiViolationError);
    const roundPii = roundErr as CartridgePiiViolationError;
    expect(roundPii.message).not.toContain("alice@example.com");
    expect(JSON.stringify(roundPii)).not.toContain("alice@example.com");

    // 3) Direct assertNoHoldoutLeakage with raw email in firewall/trajectories MUST throw CartridgePiiViolationError without echoing email!
    let fwErr: unknown;
    try {
      assertNoHoldoutLeakage([trainEmailTraj], taintedSplit.holdoutFirewall);
    } catch (err) {
      fwErr = err;
    }
    expect(fwErr).toBeInstanceOf(CartridgePiiViolationError);
    expect((fwErr as CartridgePiiViolationError).message).not.toContain("alice@example.com");
    expect(JSON.stringify(fwErr)).not.toContain("alice@example.com");
  });

  it("never invokes getters on trajectory identity or AST/premise fields in assertPseudonymizedTrajectory (Round-13 P1-1)", () => {
    let learnerGetterCalled = false;
    const trajLearnerGetter = makeTrajectory({ trajectoryId: "r13_getter_learner" });
    Object.defineProperty(trajLearnerGetter, "learnerPseudoId", {
      enumerable: true,
      configurable: true,
      get() {
        learnerGetterCalled = true;
        return "pseudo_clean_1";
      },
    });
    expect(() => clusterErrorTrajectories([trajLearnerGetter])).toThrow(CartridgePiiViolationError);
    expect(learnerGetterCalled).toBe(false);

    let astGetterCalled = false;
    let premiseGetterCalled = false;
    const trajAstGetter = makeTrajectory({ trajectoryId: "r13_getter_ast" });
    Object.defineProperty(trajAstGetter, "normalizedAstEdit", {
      enumerable: true,
      configurable: true,
      get() {
        astGetterCalled = true;
        return "DIVIDE_BY_VAR";
      },
    });
    Object.defineProperty(trajAstGetter, "missingPremise", {
      enumerable: true,
      configurable: true,
      get() {
        premiseGetterCalled = true;
        return "x != 0";
      },
    });
    expect(() => clusterErrorTrajectories([trajAstGetter])).toThrow(CartridgePiiViolationError);
    expect(astGetterCalled).toBe(false);
    expect(premiseGetterCalled).toBe(false);
  });

  it("blocks boxed primitives like new String('alice@example.com') in PII scans and never interpolates raw values in RangeError (Round-13 P1-3)", () => {
    const clean = buildMatureCohort("cand_r13_boxed", {
      learnerCount: 25,
      repairedCount: 23,
      t7PassedCount: 24,
    });
    const boxedEmail = new String("alice@example.com") as unknown as number;

    // 1) evaluateParetoFrontierAndPromotion option with boxed String PII -> throws CartridgePiiViolationError, zero raw email echo!
    let paretoErr: unknown;
    try {
      evaluateParetoFrontierAndPromotion([clean], {
        baseline: { cRate: boxedEmail, t7Rate: 0.72 },
      });
    } catch (err) {
      paretoErr = err;
    }
    expect(paretoErr).toBeInstanceOf(CartridgePiiViolationError);
    expect((paretoErr as Error).message).not.toContain("alice@example.com");
    expect(JSON.stringify(paretoErr)).not.toContain("alice@example.com");

    // 2) runGepaOptimizationRound option with boxed String PII -> throws CartridgePiiViolationError, zero raw email echo!
    const records: ErrorTrajectoryRecord[] = [];
    for (let comp = 0; comp < 4; comp += 1) {
      for (let i = 0; i < 6; i += 1) {
        records.push(
          makeTrajectory({
            trajectoryId: `r13_box_c${comp}_t${i}`,
            learnerPseudoId: `pseudo_r13_c${comp}_u${i}`,
            itemFamilyId: `fam_r13_c${comp}`,
          }),
        );
      }
    }
    const split = createDisjointTrajectorySplit(records, { seed: 2028 });
    let roundErr: unknown;
    try {
      runGepaOptimizationRound({
        basePolicy: makeBasePolicy(),
        split,
        scoreCandidate: (c) =>
          buildMatureCohort(c.candidateId, {
            learnerCount: 25,
            repairedCount: 23,
            t7PassedCount: 24,
          }),
        paretoOptions: {
          baseline: { cRate: 0.85, t7Rate: 0.72 },
          minClusterCount: boxedEmail,
        },
      });
    } catch (err) {
      roundErr = err;
    }
    expect(roundErr).toBeInstanceOf(CartridgePiiViolationError);
    expect((roundErr as Error).message).not.toContain("alice@example.com");
    expect(JSON.stringify(roundErr)).not.toContain("alice@example.com");

    // 3) clusterErrorTrajectories option with boxed String PII -> throws CartridgePiiViolationError, zero raw email echo!
    let clusterErr: unknown;
    try {
      clusterErrorTrajectories([makeTrajectory({ trajectoryId: "r13_box_clust" })], {
        minSupport: boxedEmail,
      });
    } catch (err) {
      clusterErr = err;
    }
    expect(clusterErr).toBeInstanceOf(CartridgePiiViolationError);
    expect((clusterErr as Error).message).not.toContain("alice@example.com");

    // 4) Non-PII invalid string option in RangeError MUST NOT echo raw value either!
    let rangeErr: unknown;
    try {
      evaluateParetoFrontierAndPromotion([clean], {
        baseline: { cRate: "secret_custom_token_value" as unknown as number, t7Rate: 0.72 },
      });
    } catch (err) {
      rangeErr = err;
    }
    expect(rangeErr).toBeInstanceOf(RangeError);
    expect((rangeErr as Error).message).not.toContain("secret_custom_token_value");
  });

  it("rejects sparse array holes cleanly in GEPA patch validation and compiler array inputs without TypeError crashes (Round-13 P2)", () => {
    const base = makeBasePolicy();
    const validRule = {
      id: "r13_rule_1",
      conceptId: "alg.zero_product_property",
      triggerRuleId: "err.divide_by_variable",
      missingPremise: "x != 0",
      move: "targeted_scaffold",
      priority: 10,
    };
    const validStep = {
      stage: 1,
      conceptId: "alg.zero_product_property",
      cueTemplate: "Check when the factor can equal zero.",
      revealsPremiseCheck: true,
    };

    // 1) Sparse moveRules array [rule0, , rule2] -> GepaInvalidPatchPayloadError (not TypeError!)
    // eslint-disable-next-line no-sparse-arrays
    const sparseMoveRules = [validRule, , { ...validRule, id: "r13_rule_2" }];
    expect(() =>
      validateAndApplyGepaPatch(base, {
        surface: "moveRules",
        summary: "Sparse move rules",
        payload: sparseMoveRules,
      }),
    ).toThrow(GepaInvalidPatchPayloadError);

    // 2) Sparse hintLadder array [step0, , step2] -> GepaInvalidPatchPayloadError (not TypeError!)
    // eslint-disable-next-line no-sparse-arrays
    const sparseHintLadder = [validStep, , { ...validStep, stage: 2 }];
    expect(() =>
      validateAndApplyGepaPatch(base, {
        surface: "hintLadder",
        summary: "Sparse hint ladder",
        payload: sparseHintLadder,
      }),
    ).toThrow(GepaInvalidPatchPayloadError);

    // 3) Sparse rubricAnchors & establishedPremises arrays -> GepaInvalidPatchPayloadError!
    const sparseRubric = new Array(2);
    expect(() =>
      validateAndApplyGepaPatch(base, {
        surface: "rubricAnchors",
        summary: "Sparse rubrics",
        payload: sparseRubric,
      }),
    ).toThrow(GepaInvalidPatchPayloadError);

    // 4) Sparse trajectories in clusterErrorTrajectories -> CartridgePiiViolationError (not TypeError!)
    // eslint-disable-next-line no-sparse-arrays
    const sparseTrajs = [makeTrajectory({ trajectoryId: "r13_sp_1" }), , makeTrajectory({ trajectoryId: "r13_sp_2" })] as unknown as ErrorTrajectoryRecord[];
    expect(() => clusterErrorTrajectories(sparseTrajs)).toThrow(CartridgePiiViolationError);

    // 5) Sparse candidates in evaluateParetoFrontierAndPromotion -> isolates hole cleanly while valid sibling promotes!
    const validCand = buildMatureCohort("cand_r13_sparse_valid", {
      learnerCount: 25,
      repairedCount: 23,
      t7PassedCount: 24,
    });
    // eslint-disable-next-line no-sparse-arrays
    const sparseCands = [, validCand] as unknown as CartridgeCandidateMetrics[];
    const sparseRes = evaluateParetoFrontierAndPromotion(sparseCands, {
      baseline: { cRate: 0.85, t7Rate: 0.72 },
      minT7Gain: 0.05,
      nonInferiorityMargin: 0.02,
      minClusterCount: 5,
    });
    expect(sparseRes.promotedCandidateIds).toEqual(["cand_r13_sparse_valid"]);
    expect(sparseRes.vetoedCandidateIds).toHaveLength(1);
  });

  it("never invokes Symbol.toStringTag getters or outer input getters in PII scanner and GEPA entrypoints (Round-14 P1-1)", () => {
    // 1) Throwing Symbol.toStringTag getter MUST be caught as CartridgePiiViolationError without invoking getter!
    let tagGetterCalled = false;
    const tagBomb: Record<string | symbol, unknown> = { ok: "clean" };
    Object.defineProperty(tagBomb, Symbol.toStringTag, {
      configurable: true,
      get() {
        tagGetterCalled = true;
        throw new Error("toStringTag getter exploded");
      },
    });
    expect(() => assertNoRawPiiInValue(tagBomb, "tag_bomb")).toThrow(CartridgePiiViolationError);
    expect(tagGetterCalled).toBe(false);

    // 2) Outer input getter on buildGepaReflectionContext MUST throw CartridgePiiViolationError without running getter!
    let reflectionGetterCalled = false;
    const reflectionInput = {} as Parameters<typeof buildGepaReflectionContext>[0];
    Object.defineProperty(reflectionInput, "policy", {
      enumerable: true,
      get() {
        reflectionGetterCalled = true;
        return makeBasePolicy();
      },
    });
    expect(() => buildGepaReflectionContext(reflectionInput)).toThrow(CartridgePiiViolationError);
    expect(reflectionGetterCalled).toBe(false);

    // 3) Outer input getter on runGepaOptimizationRound MUST throw CartridgePiiViolationError without running getter!
    let roundGetterCalled = false;
    const roundInput = {} as Parameters<typeof runGepaOptimizationRound>[0];
    Object.defineProperty(roundInput, "split", {
      enumerable: true,
      get() {
        roundGetterCalled = true;
        return {
          train: [],
          dev: [],
          holdout: [],
          quarantinedCrossing: [],
          holdoutFirewall: {
            holdoutTrajectoryIds: [],
            holdoutLearnerPseudoIds: [],
            holdoutItemFamilyIds: [],
          },
        };
      },
    });
    expect(() => runGepaOptimizationRound(roundInput)).toThrow(CartridgePiiViolationError);
    expect(roundGetterCalled).toBe(false);
  });

  it("rejects custom-prototype arrays and overridden Symbol.iterator on GEPA patch payloads (Round-14 P1-2)", () => {
    const base = makeBasePolicy();
    const validRule = {
      id: "r14_rule_1",
      conceptId: "alg.zero_product_property",
      triggerRuleId: "err.divide_by_variable",
      missingPremise: "x != 0",
      move: "targeted_scaffold",
      priority: 10,
    };
    const smuggledRule = {
      ...validRule,
      id: "r14_smuggled_pii",
      move: "email alice@example.com",
    };

    // 1) Custom-prototype array with overridden [Symbol.iterator]
    const customProto = Object.create(Array.prototype);
    customProto[Symbol.iterator] = function* () {
      yield smuggledRule;
    };
    const protoArray = [validRule];
    Object.setPrototypeOf(protoArray, customProto);
    expect(() =>
      validateAndApplyGepaPatch(base, {
        surface: "moveRules",
        summary: "Custom prototype array",
        payload: protoArray,
      }),
    ).toThrow(CartridgePiiViolationError);

    // 2) Own Symbol.iterator override directly on array
    const iterArray = [validRule];
    Object.defineProperty(iterArray, Symbol.iterator, {
      value: function* () {
        yield smuggledRule;
      },
      configurable: true,
    });
    expect(() =>
      validateAndApplyGepaPatch(base, {
        surface: "moveRules",
        summary: "Own iterator override array",
        payload: iterArray,
      }),
    ).toThrow(CartridgePiiViolationError);
  });

  it("allows 9-digit numeric PRNG split seed while still rejecting string/boxed/non-exempt 9-digit SSNs (Round-14 P1-5)", () => {
    const records: ErrorTrajectoryRecord[] = [];
    for (let comp = 0; comp < 4; comp += 1) {
      for (let i = 0; i < 4; i += 1) {
        records.push(
          makeTrajectory({
            trajectoryId: `r14_seed_c${comp}_t${i}`,
            learnerPseudoId: `pseudo_r14_c${comp}_u${i}`,
            itemFamilyId: `fam_r14_c${comp}`,
          }),
        );
      }
    }

    // Valid 9-digit numeric seed MUST succeed cleanly!
    const split = createDisjointTrajectorySplit(records, { seed: 123456789 });
    expect(split.train.length + split.dev.length + split.holdout.length).toBe(records.length);

    // String 9-digit SSN or boxed Number in seed MUST still throw CartridgePiiViolationError!
    expect(() =>
      createDisjointTrajectorySplit(records, { seed: "123456789" as unknown as number }),
    ).toThrow(CartridgePiiViolationError);
    expect(() =>
      createDisjointTrajectorySplit(records, { seed: "123-45-6789" as unknown as number }),
    ).toThrow(CartridgePiiViolationError);
    expect(() =>
      createDisjointTrajectorySplit(records, { seed: new Number(123456789) as unknown as number }),
    ).toThrow(CartridgePiiViolationError);
    // Non-exempt 9-digit integer field in options still fails closed as numeric_ssn_pii!
    expect(() =>
      createDisjointTrajectorySplit(records, {
        seed: 123456789,
        extraSecret: 123456789,
      } as unknown as Parameters<typeof createDisjointTrajectorySplit>[1]),
    ).toThrow(CartridgePiiViolationError);
  });
});
