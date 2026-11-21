import type {
  CartridgeCandidateMetrics,
  ErrorTrajectoryRecord,
  ParetoCandidateEvaluation,
  ParetoCandidateStatus,
  ParetoEvaluationOptions,
  ParetoEvaluationResult,
  T7Metric,
} from "./types";

const EPSILON = 1e-12;
export const DEFAULT_ONE_SIDED_95_Z = 1.6448536269514722;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export interface ComputeCandidateMetricsOptions {
  /** One-sided z-score for student-clustered lower confidence bound (default 95% = 1.64485). */
  readonly confidenceZ?: number;
  /**
   * When false (default), any pending follow-up records keep T7 as `{ status: "pending" }`
   * instead of fabricating 0 or 1 before the 7-day window matures.
   */
  readonly allowPartialMaturity?: boolean;
}

/**
 * Computes exact (C, -L, T7) metrics with explicit denominators and
 * student-clustered ratio-estimator lower confidence bound for mature T7.
 */
export function computeCandidateMetrics(
  candidateId: string,
  trajectories: readonly ErrorTrajectoryRecord[],
  options: ComputeCandidateMetricsOptions = {},
): CartridgeCandidateMetrics {
  const confidenceZ = options.confidenceZ ?? DEFAULT_ONE_SIDED_95_Z;
  const allowPartialMaturity = options.allowPartialMaturity ?? false;

  let verifiableFirstErrorCount = 0;
  let repairedCount = 0;
  let abandonedCount = 0;
  let totalReleasedTurns = 0;
  let leakedReleasedTurns = 0;
  let severeLeakCount = 0;
  let guardBlockedCount = 0;

  const matureFollowups: ErrorTrajectoryRecord[] = [];
  let pendingCohortCount = 0;

  for (const t of trajectories) {
    if (t.verifiableFirstError) {
      verifiableFirstErrorCount += 1;
      if (t.selfRepairedInSession) {
        repairedCount += 1;
      }
    }
    if (t.abandoned) {
      abandonedCount += 1;
    }
    totalReleasedTurns += Math.max(0, t.totalReleasedTurns);
    leakedReleasedTurns += Math.max(0, t.leakedReleasedTurns);
    severeLeakCount += Math.max(0, t.severeLeakCount);
    guardBlockedCount += Math.max(0, t.guardBlockedCount);

    if (t.day7FollowupStatus === "mature") {
      matureFollowups.push(t);
    } else if (t.day7FollowupStatus === "pending") {
      pendingCohortCount += 1;
    }
  }

  const cRate = verifiableFirstErrorCount > 0 ? repairedCount / verifiableFirstErrorCount : 0;
  const abandonmentRate = trajectories.length > 0 ? abandonedCount / trajectories.length : 0;
  const lRate = totalReleasedTurns > 0 ? leakedReleasedTurns / totalReleasedTurns : 0;

  const passedMatureCount = matureFollowups.filter((t) => t.passedFreshFamilyTransfer === true).length;
  const eligibleMatureCount = matureFollowups.length;

  let t7: T7Metric;
  if (eligibleMatureCount === 0) {
    t7 = {
      status: "pending",
      passedFreshTransferCount: 0,
      eligibleFollowupCohortCount: 0,
      pendingCohortCount,
      reason:
        pendingCohortCount > 0
          ? "followup_window_immature"
          : "no_eligible_followup_cohort",
    };
  } else if (pendingCohortCount > 0 && !allowPartialMaturity) {
    t7 = {
      status: "pending",
      passedFreshTransferCount: passedMatureCount,
      eligibleFollowupCohortCount: eligibleMatureCount,
      pendingCohortCount,
      reason: "followup_window_partially_immature",
    };
  } else {
    const rate = passedMatureCount / eligibleMatureCount;
    const byLearner = new Map<string, { passed: number; eligible: number }>();
    for (const t of matureFollowups) {
      const current = byLearner.get(t.learnerPseudoId) ?? { passed: 0, eligible: 0 };
      current.eligible += 1;
      if (t.passedFreshFamilyTransfer === true) {
        current.passed += 1;
      }
      byLearner.set(t.learnerPseudoId, current);
    }

    const clusters = [...byLearner.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, stats]) => stats);
    const clusterCount = clusters.length;
    const learnerClusterMean =
      clusterCount > 0
        ? clusters.reduce((sum, cl) => sum + cl.passed / cl.eligible, 0) / clusterCount
        : 0;

    let standardError: number;
    if (clusterCount <= 1) {
      standardError = 1;
    } else {
      const sumSqResidual = clusters.reduce((sum, cl) => {
        const residual = cl.passed - rate * cl.eligible;
        return sum + residual * residual;
      }, 0);
      const ratioVariance =
        (clusterCount / (clusterCount - 1)) *
        (sumSqResidual / (eligibleMatureCount * eligibleMatureCount));
      // Finite-sample continuity floor avoids SE = 0 overconfidence when all clusters agree.
      const continuityFloorSe = Math.sqrt(1 / (4 * clusterCount * clusterCount + 4 * clusterCount));
      standardError = Math.max(Math.sqrt(Math.max(0, ratioVariance)), continuityFloorSe);
    }

    const learnerClusterLowerBound = clamp01(rate - confidenceZ * standardError);

    t7 = {
      status: "mature",
      rate,
      passedFreshTransferCount: passedMatureCount,
      eligibleFollowupCohortCount: eligibleMatureCount,
      learnerClusterCount: clusterCount,
      learnerClusterMean,
      standardError,
      learnerClusterLowerBound,
    };
  }

  return {
    candidateId,
    c: {
      rate: cRate,
      repairedCount,
      verifiableFirstErrorCount,
      abandonedCount,
      abandonmentRate,
    },
    l: {
      rate: lRate,
      leakedReleasedTurns,
      totalReleasedTurns,
      severeLeakCount,
      guardBlockedCount,
    },
    t7,
  };
}

export type ParetoObjectiveMode = "3d_c_neg_l_t7" | "2d_c_neg_l";

/**
 * Exact Pareto dominance check: returns true iff `a` dominates `b` (`a ≻ b`),
 * meaning `a` is >= `b` on every active objective and strictly > on at least one.
 */
export function dominatesInObjectiveSpace(
  a: CartridgeCandidateMetrics,
  b: CartridgeCandidateMetrics,
  mode: ParetoObjectiveMode,
): boolean {
  const vecA =
    mode === "3d_c_neg_l_t7"
      ? [a.c.rate, -a.l.rate, a.t7.status === "mature" ? a.t7.rate : Number.NEGATIVE_INFINITY]
      : [a.c.rate, -a.l.rate];
  const vecB =
    mode === "3d_c_neg_l_t7"
      ? [b.c.rate, -b.l.rate, b.t7.status === "mature" ? b.t7.rate : Number.NEGATIVE_INFINITY]
      : [b.c.rate, -b.l.rate];

  let strictlyBetter = false;
  for (let i = 0; i < vecA.length; i += 1) {
    const av = vecA[i]!;
    const bv = vecB[i]!;
    if (av + EPSILON < bv) {
      return false;
    }
    if (av > bv + EPSILON) {
      strictlyBetter = true;
    }
  }
  return strictlyBetter;
}

/**
 * Runs:
 * 1) Hard Pre-Pareto Veto on leakage (`severeLeakCount > 0` or `L > maxAllowedLeakageRate`)
 *    BEFORE any Pareto dominance comparison so high C can never mask answer leakage,
 * 2) Exact non-dominated Pareto frontier ranking on `(C, -L, T7)` for mature candidates
 *    and `(C, -L)` shadow ranking for pending-T7 candidates,
 * 3) Promotion gate requiring mature T7, student-clustered LCB >= baselineT7 + minT7Gain,
 *    minimum cluster count, and C >= baselineC - nonInferiorityMargin.
 */
export function evaluateParetoFrontierAndPromotion(
  candidates: readonly CartridgeCandidateMetrics[],
  options: ParetoEvaluationOptions,
): ParetoEvaluationResult {
  const maxAllowedLeakageRate = options.maxAllowedLeakageRate ?? 0;
  const minT7Gain = options.minT7Gain ?? 0.05;
  const nonInferiorityMargin = options.nonInferiorityMargin ?? 0.02;
  const minClusterCount = options.minClusterCount ?? 5;

  const vetoMap = new Map<string, string[]>();
  const safeMature: CartridgeCandidateMetrics[] = [];
  const safePending: CartridgeCandidateMetrics[] = [];

  for (const candidate of candidates) {
    const vetoReasons: string[] = [];
    if (candidate.l.severeLeakCount > 0) {
      vetoReasons.push(`severeLeakCount=${candidate.l.severeLeakCount} exceeds 0`);
    }
    if (candidate.l.rate > maxAllowedLeakageRate + EPSILON) {
      vetoReasons.push(
        `leakageRate=${candidate.l.rate.toFixed(6)} exceeds maxAllowedLeakageRate=${maxAllowedLeakageRate}`,
      );
    }

    if (vetoReasons.length > 0) {
      vetoMap.set(candidate.candidateId, vetoReasons);
    } else if (candidate.t7.status === "mature") {
      safeMature.push(candidate);
    } else {
      safePending.push(candidate);
    }
  }

  const dominatedByMap = new Map<string, string[]>();

  for (const target of safeMature) {
    const dominators: string[] = [];
    for (const other of safeMature) {
      if (other.candidateId === target.candidateId) continue;
      if (dominatesInObjectiveSpace(other, target, "3d_c_neg_l_t7")) {
        dominators.push(other.candidateId);
      }
    }
    dominatedByMap.set(target.candidateId, dominators);
  }

  for (const target of safePending) {
    const dominators: string[] = [];
    for (const other of safePending) {
      if (other.candidateId === target.candidateId) continue;
      if (dominatesInObjectiveSpace(other, target, "2d_c_neg_l")) {
        dominators.push(other.candidateId);
      }
    }
    dominatedByMap.set(target.candidateId, dominators);
  }

  const results: ParetoCandidateEvaluation[] = candidates.map((candidate) => {
    const vetoReasons = vetoMap.get(candidate.candidateId);
    if (vetoReasons) {
      return {
        candidateId: candidate.candidateId,
        metrics: candidate,
        status: "vetoed_leakage",
        onParetoFrontier: false,
        dominatedBy: [],
        vetoReasons,
        promotionBlockers: vetoReasons,
      };
    }

    const dominatedBy = dominatedByMap.get(candidate.candidateId) ?? [];
    if (dominatedBy.length > 0) {
      return {
        candidateId: candidate.candidateId,
        metrics: candidate,
        status: "dominated",
        onParetoFrontier: false,
        dominatedBy,
        vetoReasons: [],
        promotionBlockers: [`dominated_by:${dominatedBy.join(",")}`],
      };
    }

    // Non-dominated safe candidate on Pareto frontier: check promotion gate.
    const promotionBlockers: string[] = [];
    if (candidate.t7.status === "pending") {
      promotionBlockers.push(`t7_pending:${candidate.t7.reason}`);
    } else {
      if (candidate.t7.learnerClusterCount < minClusterCount) {
        promotionBlockers.push(
          `insufficient_student_clusters:${candidate.t7.learnerClusterCount}<${minClusterCount}`,
        );
      }
      const requiredT7Lcb = options.baseline.t7Rate + minT7Gain;
      if (candidate.t7.learnerClusterLowerBound + EPSILON < requiredT7Lcb) {
        promotionBlockers.push(
          `t7_lcb_below_gain_threshold:${candidate.t7.learnerClusterLowerBound.toFixed(4)}<${requiredT7Lcb.toFixed(4)}`,
        );
      }
      const minAllowedC = options.baseline.cRate - nonInferiorityMargin;
      if (candidate.c.rate + EPSILON < minAllowedC) {
        promotionBlockers.push(
          `c_below_non_inferiority:${candidate.c.rate.toFixed(4)}<${minAllowedC.toFixed(4)}`,
        );
      }
    }

    const status: ParetoCandidateStatus =
      promotionBlockers.length === 0 ? "promoted" : "shadow_candidate";

    return {
      candidateId: candidate.candidateId,
      metrics: candidate,
      status,
      onParetoFrontier: true,
      dominatedBy: [],
      vetoReasons: [],
      promotionBlockers,
    };
  });

  return {
    results,
    frontierCandidateIds: results.filter((r) => r.onParetoFrontier).map((r) => r.candidateId),
    vetoedCandidateIds: results
      .filter((r) => r.status === "vetoed_leakage")
      .map((r) => r.candidateId),
    shadowCandidateIds: results
      .filter((r) => r.status === "shadow_candidate")
      .map((r) => r.candidateId),
    promotedCandidateIds: results
      .filter((r) => r.status === "promoted")
      .map((r) => r.candidateId),
    dominatedCandidateIds: results
      .filter((r) => r.status === "dominated")
      .map((r) => r.candidateId),
  };
}
