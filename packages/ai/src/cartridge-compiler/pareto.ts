import { assertNoRawPiiInText, canonicalizeIdentifier } from "./clustering";
import {
  CandidateIdentityError,
  type CartridgeCandidateMetrics,
  type ErrorTrajectoryRecord,
  type ParetoCandidateEvaluation,
  type ParetoCandidateStatus,
  type ParetoEvaluationOptions,
  type ParetoEvaluationResult,
  type T7Metric,
} from "./types";

const EPSILON = 1e-12;
export const DEFAULT_ONE_SIDED_95_Z = 1.6448536269514722;
export const DEFAULT_ONE_SIDED_95_ALPHA = 0.05;
export const MAX_PROMOTION_ALPHA = 0.05;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

/** Lanczos approximation of ln(Gamma(z)) for z > 0 (accurate to < 1e-14). */
function logGamma(z: number): number {
  const coefficients = [
    0.9999999999998099,
    676.5203681218851,
    -1259.1392167224028,
    771.3234287776531,
    -176.6150291621406,
    12.507343278686905,
    -0.13857109526572012,
    9.984369578019572e-6,
    1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  const shifted = z - 1;
  let x = coefficients[0]!;
  for (let i = 1; i < coefficients.length; i += 1) {
    x += coefficients[i]! / (shifted + i);
  }
  const t = shifted + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(x);
}

/** Modified Lentz continued fraction for regularized incomplete beta I_x(a, b). */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const maxIter = 200;
  const eps = 3e-14;
  const fpMin = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;

  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < fpMin) d = fpMin;
  d = 1 / d;
  let h = d;

  for (let m = 1; m <= maxIter; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpMin) d = fpMin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpMin) c = fpMin;
    d = 1 / d;
    h *= d * c;

    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpMin) d = fpMin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpMin) c = fpMin;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < eps) break;
  }

  return h;
}

/** Regularized incomplete beta function I_x(a, b) for 0 <= x <= 1, a > 0, b > 0. */
function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  if (x < (a + 1) / (a + b + 2)) {
    return clamp01((bt * betaContinuedFraction(a, b, x)) / a);
  }
  return clamp01(1 - (bt * betaContinuedFraction(b, a, 1 - x)) / b);
}

/** Approximate upper-tail probability Phi(-z) = 0.5 * erfc(z / sqrt(2)). */
function oneSidedAlphaFromZ(z: number): number {
  if (!Number.isFinite(z) || z <= 0) return 0.5;
  if (Math.abs(z - DEFAULT_ONE_SIDED_95_Z) < 1e-6) return DEFAULT_ONE_SIDED_95_ALPHA;
  // Abramowitz & Stegun 7.1.26 approximation for erfc(x), max error 1.5e-7.
  const x = z / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const poly =
    t *
    (0.254829592 +
      t *
        (-0.284496736 +
          t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erfcApprox = poly * Math.exp(-x * x);
  return clamp01(0.5 * erfcApprox);
}

/**
 * Exact one-sided Clopper-Pearson (1 - alpha) lower confidence bound for
 * `successes` observed in `trials` independent effective units (`0 <= successes <= trials`).
 *
 * - When `successes >= trials`, evaluates exact closed form `alpha ** (1 / trials)`
 *   (e.g., for 5/5 at 95% one-sided: `0.05 ** (1/5) = 0.549280...`).
 * - When `0 < successes < trials`, solves `I_p(successes, trials - successes + 1) = alpha`.
 */
export function exactClopperPearsonLowerBound(
  successes: number,
  trials: number,
  alpha: number = DEFAULT_ONE_SIDED_95_ALPHA,
): number {
  if (
    !Number.isFinite(trials) ||
    trials <= 0 ||
    !Number.isFinite(successes) ||
    successes <= 0 ||
    !Number.isFinite(alpha) ||
    alpha <= 0
  ) {
    return 0;
  }
  if (alpha >= 1) return 1;
  if (successes >= trials - EPSILON) {
    return clamp01(Math.pow(alpha, 1 / trials));
  }

  const a = successes;
  const b = trials - successes + 1;
  let lo = 0;
  let hi = 1;
  for (let iter = 0; iter < 64; iter += 1) {
    const mid = 0.5 * (lo + hi);
    if (regularizedIncompleteBeta(mid, a, b) < alpha) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return clamp01(lo);
}

export interface ComputeCandidateMetricsOptions {
  /** One-sided z-score for student-clustered lower confidence bound (default 95% = 1.64485). */
  readonly confidenceZ?: number;
  /** Explicit one-sided alpha for Clopper-Pearson bound (derived from confidenceZ when omitted). */
  readonly alpha?: number;
  /**
   * When false (default), any pending follow-up records keep T7 as `{ status: "pending" }`
   * instead of fabricating 0 or 1 before the 7-day window matures.
   */
  readonly allowPartialMaturity?: boolean;
}

/**
 * Computes exact (C, -L, T7) metrics with explicit denominators, fail-closed
 * leakage telemetry validation, canonicalized learner clustering, and exact
 * cluster-level Clopper-Pearson lower confidence bound capping.
 */
export function computeCandidateMetrics(
  candidateId: string,
  trajectories: readonly ErrorTrajectoryRecord[],
  options: ComputeCandidateMetricsOptions = {},
): CartridgeCandidateMetrics {
  const canonicalCandidateId = canonicalizeIdentifier(candidateId, "candidateId");
  assertNoRawPiiInText(canonicalCandidateId, "candidateId");

  const confidenceZ = options.confidenceZ ?? DEFAULT_ONE_SIDED_95_Z;
  if (!Number.isFinite(confidenceZ) || confidenceZ < DEFAULT_ONE_SIDED_95_Z - 1e-6) {
    throw new RangeError(
      `computeCandidateMetrics requires one-sided confidenceZ >= ${DEFAULT_ONE_SIDED_95_Z} (alpha <= ${MAX_PROMOTION_ALPHA}); received ${String(confidenceZ)}.`,
    );
  }
  const alpha = options.alpha ?? oneSidedAlphaFromZ(confidenceZ);
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha > MAX_PROMOTION_ALPHA + 1e-9) {
    throw new RangeError(
      `computeCandidateMetrics requires one-sided alpha in (0, ${MAX_PROMOTION_ALPHA}] (at least 95% confidence); received ${String(alpha)}.`,
    );
  }
  const effectiveAlpha = Math.min(alpha, MAX_PROMOTION_ALPHA);
  const allowPartialMaturity = options.allowPartialMaturity ?? false;

  let verifiableFirstErrorCount = 0;
  let repairedCount = 0;
  let abandonedCount = 0;
  let totalReleasedTurns = 0;
  let leakedReleasedTurns = 0;
  let severeLeakCount = 0;
  let guardBlockedCount = 0;
  const telemetryIssues: string[] = [];

  const matureFollowups: { learnerId: string; passed: boolean }[] = [];
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

    const validTotal = isNonNegativeInteger(t.totalReleasedTurns);
    const validLeaked = isNonNegativeInteger(t.leakedReleasedTurns);
    const validSevere = isNonNegativeInteger(t.severeLeakCount);
    const validGuard = isNonNegativeInteger(t.guardBlockedCount);

    if (!validTotal) {
      telemetryIssues.push(
        `trajectory:${t.trajectoryId}:invalid_totalReleasedTurns(${String(t.totalReleasedTurns)})`,
      );
    }
    if (!validLeaked) {
      telemetryIssues.push(
        `trajectory:${t.trajectoryId}:invalid_leakedReleasedTurns(${String(t.leakedReleasedTurns)})`,
      );
    }
    if (validTotal && validLeaked && t.leakedReleasedTurns > t.totalReleasedTurns) {
      telemetryIssues.push(
        `trajectory:${t.trajectoryId}:leakedReleasedTurns(${t.leakedReleasedTurns})>totalReleasedTurns(${t.totalReleasedTurns})`,
      );
    }
    if (!validSevere) {
      telemetryIssues.push(
        `trajectory:${t.trajectoryId}:invalid_severeLeakCount(${String(t.severeLeakCount)})`,
      );
    }
    if (!validGuard) {
      telemetryIssues.push(
        `trajectory:${t.trajectoryId}:invalid_guardBlockedCount(${String(t.guardBlockedCount)})`,
      );
    }

    // Preserve raw addition so NaN/negative/inconsistent values are never masked.
    totalReleasedTurns += t.totalReleasedTurns;
    leakedReleasedTurns += t.leakedReleasedTurns;
    severeLeakCount += t.severeLeakCount;
    guardBlockedCount += t.guardBlockedCount;

    if (t.day7FollowupStatus === "mature") {
      const canonicalLearner = canonicalizeIdentifier(
        t.learnerPseudoId,
        "learnerPseudoId",
        t.trajectoryId,
      );
      matureFollowups.push({
        learnerId: canonicalLearner,
        passed: t.passedFreshFamilyTransfer === true,
      });
    } else if (t.day7FollowupStatus === "pending") {
      pendingCohortCount += 1;
    }
  }

  if (!isNonNegativeInteger(totalReleasedTurns) || totalReleasedTurns <= 0) {
    telemetryIssues.push(`aggregate:totalReleasedTurns_must_be_positive(${String(totalReleasedTurns)})`);
  }

  const cRate = verifiableFirstErrorCount > 0 ? repairedCount / verifiableFirstErrorCount : 0;
  const abandonmentRate = trajectories.length > 0 ? abandonedCount / trajectories.length : 0;
  const lRate =
    telemetryIssues.length === 0 && totalReleasedTurns > 0
      ? leakedReleasedTurns / totalReleasedTurns
      : Number.NaN;

  const passedMatureCount = matureFollowups.filter((m) => m.passed).length;
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
    for (const m of matureFollowups) {
      const current = byLearner.get(m.learnerId) ?? { passed: 0, eligible: 0 };
      current.eligible += 1;
      if (m.passed) {
        current.passed += 1;
      }
      byLearner.set(m.learnerId, current);
    }

    const clusters = [...byLearner.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, stats]) => stats);
    const clusterCount = clusters.length;
    const learnerClusterMean =
      clusterCount > 0
        ? clusters.reduce((sum, cl) => sum + cl.passed / cl.eligible, 0) / clusterCount
        : 0;

    const learnerOutcomeCounts = clusters.map((cl) => cl.eligible);

    // Kish design-effect effective cluster sample size, bounded strictly above by distinct learner count.
    const sumSqClusterSize = learnerOutcomeCounts.reduce((sum, size) => sum + size * size, 0);
    const kishClusters =
      sumSqClusterSize > 0
        ? (eligibleMatureCount * eligibleMatureCount) / sumSqClusterSize
        : 0;
    const effectiveClusterSampleSize = Math.min(clusterCount, kishClusters);
    const effectiveSuccesses = rate * effectiveClusterSampleSize;
    const clopperPearsonLowerBound = exactClopperPearsonLowerBound(
      effectiveSuccesses,
      effectiveClusterSampleSize,
      effectiveAlpha,
    );

    let ratioSe: number;
    let normalClusterLcb: number;
    if (clusterCount <= 1) {
      ratioSe = 1;
      normalClusterLcb = 0;
    } else {
      const sumSqResidual = clusters.reduce((sum, cl) => {
        const residual = cl.passed - rate * cl.eligible;
        return sum + residual * residual;
      }, 0);
      const ratioVariance =
        (clusterCount / (clusterCount - 1)) *
        (sumSqResidual / (eligibleMatureCount * eligibleMatureCount));
      ratioSe = Math.sqrt(Math.max(0, ratioVariance));
      normalClusterLcb = clamp01(rate - confidenceZ * ratioSe);
    }

    // Intersect cluster-adjusted ratio bound with exact cluster-level Clopper-Pearson bound
    // so zero-variance small samples (e.g., 5/5 -> 0.5493) can never falsely clear promotion floors.
    const learnerClusterLowerBound = Math.min(normalClusterLcb, clopperPearsonLowerBound);
    const effectiveSe =
      clusterCount <= 1
        ? 1
        : Math.max(
            ratioSe,
            confidenceZ > 0 ? Math.max(0, rate - learnerClusterLowerBound) / confidenceZ : ratioSe,
          );

    t7 = {
      status: "mature",
      rate,
      passedFreshTransferCount: passedMatureCount,
      eligibleFollowupCohortCount: eligibleMatureCount,
      learnerClusterCount: clusterCount,
      learnerOutcomeCounts,
      effectiveClusterSampleSize,
      learnerClusterMean,
      standardError: effectiveSe,
      clopperPearsonLowerBound,
      learnerClusterLowerBound,
      alpha: effectiveAlpha,
    };
  }

  return {
    candidateId: canonicalCandidateId,
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
      ...(telemetryIssues.length > 0 ? { telemetryIssues } : {}),
    },
    t7,
  };
}

export type ParetoObjectiveMode = "3d_c_neg_l_t7" | "2d_c_neg_l";

function exactDerivedLeakageRate(candidate: CartridgeCandidateMetrics): number {
  const { leakedReleasedTurns, totalReleasedTurns, rate } = candidate.l;
  if (
    isNonNegativeInteger(totalReleasedTurns) &&
    totalReleasedTurns > 0 &&
    isNonNegativeInteger(leakedReleasedTurns) &&
    leakedReleasedTurns <= totalReleasedTurns
  ) {
    return leakedReleasedTurns / totalReleasedTurns;
  }
  return rate;
}

/**
 * Exact Pareto dominance check: returns true iff `a` dominates `b` (`a ≻ b`),
 * meaning `a` is >= `b` on every active objective and strictly > on at least one.
 */
export function dominatesInObjectiveSpace(
  a: CartridgeCandidateMetrics,
  b: CartridgeCandidateMetrics,
  mode: ParetoObjectiveMode,
): boolean {
  const aLeak = exactDerivedLeakageRate(a);
  const bLeak = exactDerivedLeakageRate(b);
  const vecA =
    mode === "3d_c_neg_l_t7"
      ? [a.c.rate, -aLeak, a.t7.status === "mature" ? a.t7.rate : Number.NEGATIVE_INFINITY]
      : [a.c.rate, -aLeak];
  const vecB =
    mode === "3d_c_neg_l_t7"
      ? [b.c.rate, -bLeak, b.t7.status === "mature" ? b.t7.rate : Number.NEGATIVE_INFINITY]
      : [b.c.rate, -bLeak];

  let strictlyBetter = false;
  for (let i = 0; i < vecA.length; i += 1) {
    const av = vecA[i]!;
    const bv = vecB[i]!;
    if (!Number.isFinite(av) || !Number.isFinite(bv)) {
      return false;
    }
    if (av + EPSILON < bv) {
      return false;
    }
    if (av > bv + EPSILON) {
      strictlyBetter = true;
    }
  }
  return strictlyBetter;
}

function validateLeakageTelemetryFailClosed(
  candidate: CartridgeCandidateMetrics,
  maxAllowedLeakageRate: number,
): string[] {
  const vetoReasons: string[] = [];
  const l = candidate.l;

  if (l.telemetryIssues && l.telemetryIssues.length > 0) {
    vetoReasons.push(...l.telemetryIssues.map((issue) => `telemetry_integrity:${issue}`));
  }

  const validTotal = isNonNegativeInteger(l.totalReleasedTurns) && l.totalReleasedTurns > 0;
  if (!validTotal) {
    vetoReasons.push(
      `invalid_totalReleasedTurns:must_be_positive_integer(got=${String(l.totalReleasedTurns)})`,
    );
  }

  const validLeaked = isNonNegativeInteger(l.leakedReleasedTurns);
  if (!validLeaked) {
    vetoReasons.push(
      `invalid_leakedReleasedTurns:must_be_nonnegative_integer(got=${String(l.leakedReleasedTurns)})`,
    );
  }

  if (validTotal && validLeaked && l.leakedReleasedTurns > l.totalReleasedTurns) {
    vetoReasons.push(
      `inconsistent_leak_counts:leaked(${l.leakedReleasedTurns})>total(${l.totalReleasedTurns})`,
    );
  }

  if (!isNonNegativeInteger(l.severeLeakCount)) {
    vetoReasons.push(
      `invalid_severeLeakCount:must_be_nonnegative_integer(got=${String(l.severeLeakCount)})`,
    );
  } else if (l.severeLeakCount > 0) {
    vetoReasons.push(`severeLeakCount=${l.severeLeakCount} exceeds 0`);
  }

  if (!isNonNegativeInteger(l.guardBlockedCount)) {
    vetoReasons.push(
      `invalid_guardBlockedCount:must_be_nonnegative_integer(got=${String(l.guardBlockedCount)})`,
    );
  }

  const validCounts = validTotal && validLeaked && l.leakedReleasedTurns <= l.totalReleasedTurns;
  const derivedLeakageRate = validCounts ? l.leakedReleasedTurns / l.totalReleasedTurns : Number.NaN;

  if (validCounts) {
    // Enforce cap directly against the exact count-derived ratio (no rounding/tolerance bypass).
    if (derivedLeakageRate > maxAllowedLeakageRate) {
      vetoReasons.push(
        `derived_leakageRate=${derivedLeakageRate.toFixed(9)} (${l.leakedReleasedTurns}/${l.totalReleasedTurns}) exceeds maxAllowedLeakageRate=${maxAllowedLeakageRate}`,
      );
    }
    if (maxAllowedLeakageRate === 0 && l.leakedReleasedTurns !== 0) {
      vetoReasons.push(
        `zero_leakage_policy_violated:leakedReleasedTurns=${l.leakedReleasedTurns}`,
      );
    }
  }

  if (typeof l.rate !== "number" || !Number.isFinite(l.rate) || l.rate < 0 || l.rate > 1) {
    vetoReasons.push(`invalid_leakageRate:must_be_finite_in_0_1(got=${String(l.rate)})`);
  } else {
    if (validCounts && Math.abs(l.rate - derivedLeakageRate) > 1e-9) {
      vetoReasons.push(
        `inconsistent_leakageRate:reported(${l.rate})!=derived(${derivedLeakageRate})`,
      );
    }
    if (l.rate > maxAllowedLeakageRate) {
      vetoReasons.push(
        `leakageRate=${l.rate.toFixed(9)} exceeds maxAllowedLeakageRate=${maxAllowedLeakageRate}`,
      );
    }
    if (maxAllowedLeakageRate === 0 && l.rate !== 0) {
      vetoReasons.push(`zero_leakage_policy_violated:rate=${String(l.rate)}`);
    }
  }

  return vetoReasons;
}

export interface MatureTransferCertification {
  readonly validTelemetry: boolean;
  readonly telemetryIssues: readonly string[];
  readonly exactRate: number;
  readonly exactKishNEff: number;
  readonly certifiedCp95Lcb: number;
}

/**
 * Independently verifies mature T7 count consistency, per-learner outcome counts,
 * Kish effective cluster sample size `n_eff = min(M, N^2 / sum(c_i^2))`, and the
 * exact one-sided 95% (`alpha = 0.05`) Clopper-Pearson lower confidence bound.
 */
export function certifyMatureTransferLowerBound(
  t7: Extract<T7Metric, { status: "mature" }>,
): MatureTransferCertification {
  const telemetryIssues: string[] = [];

  const validEligible =
    isNonNegativeInteger(t7.eligibleFollowupCohortCount) && t7.eligibleFollowupCohortCount > 0;
  if (!validEligible) {
    telemetryIssues.push(
      `invalid_t7_eligibleFollowupCohortCount:${String(t7.eligibleFollowupCohortCount)}`,
    );
  }

  const validPassed =
    isNonNegativeInteger(t7.passedFreshTransferCount) &&
    validEligible &&
    t7.passedFreshTransferCount <= t7.eligibleFollowupCohortCount;
  if (!validPassed) {
    telemetryIssues.push(
      `invalid_t7_passedFreshTransferCount:${String(t7.passedFreshTransferCount)}/${String(t7.eligibleFollowupCohortCount)}`,
    );
  }

  const validClusters =
    isNonNegativeInteger(t7.learnerClusterCount) &&
    t7.learnerClusterCount > 0 &&
    validEligible &&
    t7.learnerClusterCount <= t7.eligibleFollowupCohortCount;
  if (!validClusters) {
    telemetryIssues.push(
      `invalid_t7_learnerClusterCount:${String(t7.learnerClusterCount)}/${String(t7.eligibleFollowupCohortCount)}`,
    );
  }

  let exactKishNEff = 0;
  if (!Array.isArray(t7.learnerOutcomeCounts)) {
    telemetryIssues.push("missing_t7_learnerOutcomeCounts");
  } else if (validClusters && t7.learnerOutcomeCounts.length !== t7.learnerClusterCount) {
    telemetryIssues.push(
      `inconsistent_t7_learnerOutcomeCounts_length:${t7.learnerOutcomeCounts.length}!=${t7.learnerClusterCount}`,
    );
  } else {
    let sumCounts = 0;
    let sumSq = 0;
    let allPosInt = true;
    for (let i = 0; i < t7.learnerOutcomeCounts.length; i += 1) {
      const c = t7.learnerOutcomeCounts[i];
      if (!isNonNegativeInteger(c) || c <= 0) {
        allPosInt = false;
        telemetryIssues.push(`invalid_t7_learnerOutcomeCounts[${i}]:${String(c)}`);
        break;
      }
      sumCounts += c;
      sumSq += c * c;
    }
    if (allPosInt && validEligible) {
      if (sumCounts !== t7.eligibleFollowupCohortCount) {
        telemetryIssues.push(
          `inconsistent_t7_learnerOutcomeCounts_sum:${sumCounts}!=${t7.eligibleFollowupCohortCount}`,
        );
      } else if (validClusters && sumSq > 0) {
        exactKishNEff = Math.min(
          t7.learnerClusterCount,
          (t7.eligibleFollowupCohortCount * t7.eligibleFollowupCohortCount) / sumSq,
        );
      }
    }
  }

  const exactRate =
    validEligible && validPassed
      ? t7.passedFreshTransferCount / t7.eligibleFollowupCohortCount
      : Number.NaN;

  if (typeof t7.rate !== "number" || !Number.isFinite(t7.rate) || t7.rate < 0 || t7.rate > 1) {
    telemetryIssues.push(`invalid_t7_rate:${String(t7.rate)}`);
  } else if (Number.isFinite(exactRate) && Math.abs(t7.rate - exactRate) > 1e-9) {
    telemetryIssues.push(`inconsistent_t7_rate:reported(${t7.rate})!=derived(${exactRate})`);
  }

  if (
    !Number.isFinite(t7.effectiveClusterSampleSize) ||
    t7.effectiveClusterSampleSize <= 0 ||
    (exactKishNEff > 0 && t7.effectiveClusterSampleSize > exactKishNEff + 1e-9)
  ) {
    telemetryIssues.push(
      `inflated_or_invalid_effectiveClusterSampleSize:reported(${String(t7.effectiveClusterSampleSize)})>kish(${exactKishNEff.toFixed(6)})`,
    );
  }

  if (
    typeof t7.learnerClusterMean !== "number" ||
    !Number.isFinite(t7.learnerClusterMean) ||
    t7.learnerClusterMean < 0 ||
    t7.learnerClusterMean > 1
  ) {
    telemetryIssues.push(`invalid_t7_learnerClusterMean:${String(t7.learnerClusterMean)}`);
  }

  if (typeof t7.standardError !== "number" || !Number.isFinite(t7.standardError) || t7.standardError < 0) {
    telemetryIssues.push(`invalid_t7_standardError:${String(t7.standardError)}`);
  }

  if (
    typeof t7.clopperPearsonLowerBound !== "number" ||
    !Number.isFinite(t7.clopperPearsonLowerBound) ||
    t7.clopperPearsonLowerBound < 0 ||
    t7.clopperPearsonLowerBound > 1
  ) {
    telemetryIssues.push(
      `invalid_t7_clopperPearsonLowerBound:${String(t7.clopperPearsonLowerBound)}`,
    );
  }

  if (
    typeof t7.learnerClusterLowerBound !== "number" ||
    !Number.isFinite(t7.learnerClusterLowerBound) ||
    t7.learnerClusterLowerBound < 0 ||
    t7.learnerClusterLowerBound > 1
  ) {
    telemetryIssues.push(
      `invalid_t7_learnerClusterLowerBound:${String(t7.learnerClusterLowerBound)}`,
    );
  }

  const boundedNEff =
    exactKishNEff > 0 &&
    Number.isFinite(t7.effectiveClusterSampleSize) &&
    t7.effectiveClusterSampleSize > 0
      ? Math.min(exactKishNEff, t7.effectiveClusterSampleSize)
      : exactKishNEff;
  const certifiedCp95Lcb =
    Number.isFinite(exactRate) && boundedNEff > 0
      ? exactClopperPearsonLowerBound(exactRate * boundedNEff, boundedNEff, MAX_PROMOTION_ALPHA)
      : 0;

  return {
    validTelemetry: telemetryIssues.length === 0,
    telemetryIssues,
    exactRate,
    exactKishNEff,
    certifiedCp95Lcb,
  };
}

function validateObjectiveTelemetryFailClosed(
  candidate: CartridgeCandidateMetrics,
): { issues: string[]; matureCert: MatureTransferCertification | null } {
  const issues: string[] = [];
  const c = candidate.c;

  const validVerifiable = isNonNegativeInteger(c.verifiableFirstErrorCount);
  const validRepaired = isNonNegativeInteger(c.repairedCount);
  if (!validVerifiable) {
    issues.push(`invalid_c_verifiableFirstErrorCount:${String(c.verifiableFirstErrorCount)}`);
  }
  if (!validRepaired) {
    issues.push(`invalid_c_repairedCount:${String(c.repairedCount)}`);
  }
  if (validVerifiable && validRepaired && c.repairedCount > c.verifiableFirstErrorCount) {
    issues.push(`inconsistent_c_counts:repaired(${c.repairedCount})>verifiable(${c.verifiableFirstErrorCount})`);
  }
  if (!isNonNegativeInteger(c.abandonedCount)) {
    issues.push(`invalid_c_abandonedCount:${String(c.abandonedCount)}`);
  }
  if (
    typeof c.abandonmentRate !== "number" ||
    !Number.isFinite(c.abandonmentRate) ||
    c.abandonmentRate < 0 ||
    c.abandonmentRate > 1
  ) {
    issues.push(`invalid_c_abandonmentRate:${String(c.abandonmentRate)}`);
  }
  if (typeof c.rate !== "number" || !Number.isFinite(c.rate) || c.rate < 0 || c.rate > 1) {
    issues.push(`invalid_c_rate:${String(c.rate)}`);
  } else if (validVerifiable && validRepaired && c.repairedCount <= c.verifiableFirstErrorCount) {
    const expectedC =
      c.verifiableFirstErrorCount > 0 ? c.repairedCount / c.verifiableFirstErrorCount : 0;
    if (Math.abs(c.rate - expectedC) > 1e-9) {
      issues.push(`inconsistent_c_rate:reported(${c.rate})!=derived(${expectedC})`);
    }
  }

  let matureCert: MatureTransferCertification | null = null;
  if (candidate.t7.status === "mature") {
    matureCert = certifyMatureTransferLowerBound(candidate.t7);
    if (!matureCert.validTelemetry) {
      issues.push(...matureCert.telemetryIssues);
    }
  } else {
    const t7p = candidate.t7;
    if (!isNonNegativeInteger(t7p.eligibleFollowupCohortCount)) {
      issues.push(
        `invalid_pending_t7_eligibleFollowupCohortCount:${String(t7p.eligibleFollowupCohortCount)}`,
      );
    }
    if (!isNonNegativeInteger(t7p.passedFreshTransferCount)) {
      issues.push(
        `invalid_pending_t7_passedFreshTransferCount:${String(t7p.passedFreshTransferCount)}`,
      );
    }
    if (
      isNonNegativeInteger(t7p.eligibleFollowupCohortCount) &&
      isNonNegativeInteger(t7p.passedFreshTransferCount) &&
      t7p.passedFreshTransferCount > t7p.eligibleFollowupCohortCount
    ) {
      issues.push(
        `inconsistent_pending_t7_counts:passed(${t7p.passedFreshTransferCount})>eligible(${t7p.eligibleFollowupCohortCount})`,
      );
    }
    if (!isNonNegativeInteger(t7p.pendingCohortCount)) {
      issues.push(`invalid_pending_t7_pendingCohortCount:${String(t7p.pendingCohortCount)}`);
    }
    if (typeof t7p.reason !== "string" || t7p.reason.trim().length === 0) {
      issues.push("invalid_pending_t7_reason");
    }
  }

  return { issues, matureCert };
}

/**
 * Runs:
 * 1) Canonicalization, PII check, and uniqueness enforcement on all `candidateId`s,
 * 2) Fail-closed Hard Pre-Pareto Veto on leakage telemetry AND objective (`C`, `T7`)
 *    telemetry integrity BEFORE any Pareto dominance comparison so neither leakage
 *    nor malformed `C`/`T7` counts can ever enter the frontier or dominate a valid candidate,
 * 3) Exact non-dominated Pareto frontier ranking on `(C, -L, T7)` for mature candidates
 *    and `(C, -L)` shadow ranking for pending-T7 candidates,
 * 4) Promotion gate requiring mature T7, independently certified Kish `n_eff` and
 *    exact one-sided 95% (`alpha <= 0.05`) Clopper-Pearson LCB >= baselineT7 + minT7Gain,
 *    minimum cluster count, and C >= baselineC - nonInferiorityMargin.
 */
export function evaluateParetoFrontierAndPromotion(
  candidates: readonly CartridgeCandidateMetrics[],
  options: ParetoEvaluationOptions,
): ParetoEvaluationResult {
  const maxAllowedLeakageRate = options.maxAllowedLeakageRate ?? 0;
  if (
    !Number.isFinite(maxAllowedLeakageRate) ||
    maxAllowedLeakageRate < 0 ||
    maxAllowedLeakageRate > 1
  ) {
    throw new RangeError(
      `maxAllowedLeakageRate must be a finite number in [0, 1] (received ${String(maxAllowedLeakageRate)}).`,
    );
  }
  const minT7Gain = options.minT7Gain ?? 0.05;
  const nonInferiorityMargin = options.nonInferiorityMargin ?? 0.02;
  const minClusterCount = options.minClusterCount ?? 5;

  // Canonicalize, PII-scan, and enforce strict uniqueness across all candidateIds upfront.
  const seenCandidateIds = new Set<string>();
  const canonicalCandidates: CartridgeCandidateMetrics[] = candidates.map((candidate) => {
    const canonicalId = canonicalizeIdentifier(candidate.candidateId, "candidateId");
    assertNoRawPiiInText(canonicalId, "candidateId");
    if (seenCandidateIds.has(canonicalId)) {
      throw new CandidateIdentityError(
        `Duplicate candidateId "${canonicalId}" in Pareto evaluation.`,
        "duplicate_candidate_id",
        canonicalId,
      );
    }
    seenCandidateIds.add(canonicalId);
    return canonicalId === candidate.candidateId
      ? candidate
      : { ...candidate, candidateId: canonicalId };
  });

  const vetoMap = new Map<
    string,
    { status: "vetoed_leakage" | "vetoed_invalid_telemetry"; reasons: string[] }
  >();
  const matureCertMap = new Map<string, MatureTransferCertification>();
  const safeMature: CartridgeCandidateMetrics[] = [];
  const safePending: CartridgeCandidateMetrics[] = [];

  for (const candidate of canonicalCandidates) {
    const leakVetoReasons = validateLeakageTelemetryFailClosed(candidate, maxAllowedLeakageRate);
    if (leakVetoReasons.length > 0) {
      vetoMap.set(candidate.candidateId, {
        status: "vetoed_leakage",
        reasons: leakVetoReasons,
      });
      continue;
    }

    const { issues: objectiveIssues, matureCert } = validateObjectiveTelemetryFailClosed(candidate);
    if (matureCert) {
      matureCertMap.set(candidate.candidateId, matureCert);
    }
    if (objectiveIssues.length > 0) {
      vetoMap.set(candidate.candidateId, {
        status: "vetoed_invalid_telemetry",
        reasons: objectiveIssues,
      });
      continue;
    }

    if (candidate.t7.status === "mature") {
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

  const results: ParetoCandidateEvaluation[] = canonicalCandidates.map((candidate) => {
    const veto = vetoMap.get(candidate.candidateId);
    if (veto) {
      return {
        candidateId: candidate.candidateId,
        metrics: candidate,
        status: veto.status,
        onParetoFrontier: false,
        dominatedBy: [],
        vetoReasons: veto.reasons,
        promotionBlockers: veto.reasons,
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
      const t7 = candidate.t7;
      const cert = matureCertMap.get(candidate.candidateId) ?? certifyMatureTransferLowerBound(t7);

      if (
        t7.alpha !== undefined &&
        (!Number.isFinite(t7.alpha) || t7.alpha <= 0 || t7.alpha > MAX_PROMOTION_ALPHA + 1e-9)
      ) {
        promotionBlockers.push(
          `t7_alpha_exceeds_max_0_05:${String(t7.alpha)}>${MAX_PROMOTION_ALPHA}`,
        );
      }

      if (t7.learnerClusterCount < minClusterCount) {
        promotionBlockers.push(
          `insufficient_student_clusters:${t7.learnerClusterCount}<${minClusterCount}`,
        );
      }

      if (t7.learnerClusterLowerBound > cert.certifiedCp95Lcb + 1e-9) {
        promotionBlockers.push(
          `t7_lcb_exceeds_certified_cp95:${t7.learnerClusterLowerBound.toFixed(4)}>${cert.certifiedCp95Lcb.toFixed(4)}`,
        );
      }

      const verifiedLcb = Math.min(t7.learnerClusterLowerBound, cert.certifiedCp95Lcb);
      const requiredT7Lcb = options.baseline.t7Rate + minT7Gain;
      if (verifiedLcb + EPSILON < requiredT7Lcb) {
        promotionBlockers.push(
          `t7_lcb_below_gain_threshold:${verifiedLcb.toFixed(4)}<${requiredT7Lcb.toFixed(4)}`,
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
      .filter((r) => r.status === "vetoed_leakage" || r.status === "vetoed_invalid_telemetry")
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
