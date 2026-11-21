import {
  assertNoRawPiiInText,
  assertNoRawPiiInValue,
  canonicalizeIdentifier,
} from "./clustering";
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

const KNOWN_PENDING_T7_REASONS: ReadonlySet<string> = new Set([
  "followup_window_immature",
  "no_eligible_followup_cohort",
  "followup_window_partially_immature",
  "immature_followup_window",
  "redacted_invalid_reason",
  "redacted_invalid_t7_status",
]);

const KNOWN_TELEMETRY_ISSUE_CODES: ReadonlySet<string> = new Set([
  "trajectory_malformed",
  "trajectory_invalid_totalReleasedTurns",
  "trajectory_invalid_leakedReleasedTurns",
  "trajectory_leaked_gt_total",
  "trajectory_invalid_severeLeakCount",
  "trajectory_invalid_guardBlockedCount",
  "aggregate_totalReleasedTurns_must_be_positive",
  "telemetry_issue_reported",
  "invalid_telemetry_issue_entry",
  "missing_scorer_receipt",
]);

function canonicalizePendingReason(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return "redacted_invalid_reason";
  }
  return KNOWN_PENDING_T7_REASONS.has(raw) ? raw : "immature_followup_window";
}

function canonicalizeTelemetryIssues(raw: unknown): readonly string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return ["invalid_telemetry_issue_entry"];
  if (raw.length === 0) return undefined;
  const codes = new Set<string>();
  for (let i = 0; i < raw.length; i += 1) {
    if (!Object.prototype.hasOwnProperty.call(raw, i)) {
      codes.add("invalid_telemetry_issue_entry");
      continue;
    }
    const entry = raw[i];
    if (typeof entry !== "string") {
      codes.add("invalid_telemetry_issue_entry");
    } else if (KNOWN_TELEMETRY_ISSUE_CODES.has(entry)) {
      codes.add(entry);
    } else {
      codes.add("telemetry_issue_reported");
    }
  }
  return [...codes];
}

function isNonNullRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
  assertNoRawPiiInValue(options, `computeCandidateMetrics[${canonicalCandidateId}].options`);
  assertNoRawPiiInValue(trajectories, `computeCandidateMetrics[${canonicalCandidateId}].trajectories`);

  const confidenceZ = options.confidenceZ ?? DEFAULT_ONE_SIDED_95_Z;
  if (!Number.isFinite(confidenceZ) || confidenceZ < DEFAULT_ONE_SIDED_95_Z - 1e-6) {
    throw new RangeError(
      `computeCandidateMetrics requires one-sided confidenceZ >= ${DEFAULT_ONE_SIDED_95_Z} (alpha <= ${MAX_PROMOTION_ALPHA}); received invalid ${typeof confidenceZ}.`,
    );
  }
  const alpha = options.alpha ?? oneSidedAlphaFromZ(confidenceZ);
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha > MAX_PROMOTION_ALPHA + 1e-9) {
    throw new RangeError(
      `computeCandidateMetrics requires one-sided alpha in (0, ${MAX_PROMOTION_ALPHA}] (at least 95% confidence); received invalid ${typeof alpha}.`,
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

  for (let i = 0; i < trajectories.length; i += 1) {
    const hasOwn = Object.prototype.hasOwnProperty.call(trajectories, i);
    const t = hasOwn ? trajectories[i] : undefined;
    if (!hasOwn || !isNonNullRecord(t)) {
      telemetryIssues.push("trajectory_malformed");
      continue;
    }
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
      telemetryIssues.push("trajectory_invalid_totalReleasedTurns");
    }
    if (!validLeaked) {
      telemetryIssues.push("trajectory_invalid_leakedReleasedTurns");
    }
    if (validTotal && validLeaked && t.leakedReleasedTurns > t.totalReleasedTurns) {
      telemetryIssues.push("trajectory_leaked_gt_total");
    }
    if (!validSevere) {
      telemetryIssues.push("trajectory_invalid_severeLeakCount");
    }
    if (!validGuard) {
      telemetryIssues.push("trajectory_invalid_guardBlockedCount");
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
    telemetryIssues.push("aggregate_totalReleasedTurns_must_be_positive");
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

  const metrics: CartridgeCandidateMetrics = {
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
  assertNoRawPiiInValue(metrics, `computeCandidateMetrics[${canonicalCandidateId}].output`);
  return metrics;
}

export type ParetoObjectiveMode = "3d_c_neg_l_t7" | "2d_c_neg_l";

function exactDerivedLeakageRate(candidate: CartridgeCandidateMetrics): number {
  const rawL = candidate.l as CartridgeCandidateMetrics["l"] | null | undefined;
  if (!isNonNullRecord(rawL)) return Number.NaN;
  const { leakedReleasedTurns, totalReleasedTurns, rate } = rawL;
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
  const l = candidate.l as CartridgeCandidateMetrics["l"] | null | undefined;
  if (!isNonNullRecord(l)) {
    return ["invalid_leakage_telemetry"];
  }

  if (l.telemetryIssues !== undefined) {
    if (!Array.isArray(l.telemetryIssues)) {
      vetoReasons.push("telemetry_integrity:telemetryIssues_must_be_string_array");
    } else if (l.telemetryIssues.length > 0) {
      let hasNonStringOrHole = false;
      for (let i = 0; i < l.telemetryIssues.length; i += 1) {
        if (
          !Object.prototype.hasOwnProperty.call(l.telemetryIssues, i) ||
          typeof l.telemetryIssues[i] !== "string"
        ) {
          hasNonStringOrHole = true;
          break;
        }
      }
      if (hasNonStringOrHole) {
        vetoReasons.push("telemetry_integrity:non_string_telemetryIssue");
      } else {
        vetoReasons.push("telemetry_integrity:reported_issues");
      }
    }
  }

  const validTotal = isNonNegativeInteger(l.totalReleasedTurns) && l.totalReleasedTurns > 0;
  if (!validTotal) {
    vetoReasons.push("invalid_totalReleasedTurns:must_be_positive_integer");
  }

  const validLeaked = isNonNegativeInteger(l.leakedReleasedTurns);
  if (!validLeaked) {
    vetoReasons.push("invalid_leakedReleasedTurns:must_be_nonnegative_integer");
  }

  if (validTotal && validLeaked && l.leakedReleasedTurns > l.totalReleasedTurns) {
    vetoReasons.push(
      `inconsistent_leak_counts:leaked(${l.leakedReleasedTurns})>total(${l.totalReleasedTurns})`,
    );
  }

  if (!isNonNegativeInteger(l.severeLeakCount)) {
    vetoReasons.push("invalid_severeLeakCount:must_be_nonnegative_integer");
  } else if (l.severeLeakCount > 0) {
    vetoReasons.push(`severeLeakCount=${l.severeLeakCount} exceeds 0`);
  }

  if (!isNonNegativeInteger(l.guardBlockedCount)) {
    vetoReasons.push("invalid_guardBlockedCount:must_be_nonnegative_integer");
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
    vetoReasons.push("invalid_leakageRate:must_be_finite_in_0_1");
  } else {
    if (validCounts && Math.abs(l.rate - derivedLeakageRate) > 1e-9) {
      vetoReasons.push(
        `inconsistent_leakageRate:reported(${l.rate.toFixed(9)})!=derived(${derivedLeakageRate.toFixed(9)})`,
      );
    }
    if (l.rate > maxAllowedLeakageRate) {
      vetoReasons.push(
        `leakageRate=${l.rate.toFixed(9)} exceeds maxAllowedLeakageRate=${maxAllowedLeakageRate}`,
      );
    }
    if (maxAllowedLeakageRate === 0 && l.rate !== 0) {
      vetoReasons.push(`zero_leakage_policy_violated:rate=${l.rate.toFixed(9)}`);
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
    telemetryIssues.push("invalid_t7_eligibleFollowupCohortCount");
  }

  const validPassed =
    isNonNegativeInteger(t7.passedFreshTransferCount) &&
    validEligible &&
    t7.passedFreshTransferCount <= t7.eligibleFollowupCohortCount;
  if (!validPassed) {
    telemetryIssues.push("invalid_t7_passedFreshTransferCount");
  }

  const validClusters =
    isNonNegativeInteger(t7.learnerClusterCount) &&
    t7.learnerClusterCount > 0 &&
    validEligible &&
    t7.learnerClusterCount <= t7.eligibleFollowupCohortCount;
  if (!validClusters) {
    telemetryIssues.push("invalid_t7_learnerClusterCount");
  }

  let exactKishNEff = 0;
  if (!Array.isArray(t7.learnerOutcomeCounts)) {
    telemetryIssues.push("missing_t7_learnerOutcomeCounts");
  } else if (validClusters && t7.learnerOutcomeCounts.length !== t7.learnerClusterCount) {
    telemetryIssues.push("inconsistent_t7_learnerOutcomeCounts_length");
  } else {
    let sumCounts = 0;
    let sumSq = 0;
    let allPosInt = true;
    for (let i = 0; i < t7.learnerOutcomeCounts.length; i += 1) {
      const c = t7.learnerOutcomeCounts[i];
      if (!isNonNegativeInteger(c) || c <= 0) {
        allPosInt = false;
        telemetryIssues.push("invalid_t7_learnerOutcomeCounts_entry");
        break;
      }
      sumCounts += c;
      sumSq += c * c;
    }
    if (allPosInt && validEligible) {
      if (sumCounts !== t7.eligibleFollowupCohortCount) {
        telemetryIssues.push("inconsistent_t7_learnerOutcomeCounts_sum");
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
    telemetryIssues.push("invalid_t7_rate");
  } else if (Number.isFinite(exactRate) && Math.abs(t7.rate - exactRate) > 1e-9) {
    telemetryIssues.push(
      `inconsistent_t7_rate:reported(${t7.rate.toFixed(9)})!=derived(${exactRate.toFixed(9)})`,
    );
  }

  if (
    typeof t7.effectiveClusterSampleSize !== "number" ||
    !Number.isFinite(t7.effectiveClusterSampleSize) ||
    t7.effectiveClusterSampleSize <= 0 ||
    (exactKishNEff > 0 && t7.effectiveClusterSampleSize > exactKishNEff + 1e-9)
  ) {
    telemetryIssues.push("inflated_or_invalid_effectiveClusterSampleSize");
  }

  if (
    typeof t7.learnerClusterMean !== "number" ||
    !Number.isFinite(t7.learnerClusterMean) ||
    t7.learnerClusterMean < 0 ||
    t7.learnerClusterMean > 1
  ) {
    telemetryIssues.push("invalid_t7_learnerClusterMean");
  }

  if (
    typeof t7.standardError !== "number" ||
    !Number.isFinite(t7.standardError) ||
    t7.standardError < 0
  ) {
    telemetryIssues.push("invalid_t7_standardError");
  }

  if (
    typeof t7.clopperPearsonLowerBound !== "number" ||
    !Number.isFinite(t7.clopperPearsonLowerBound) ||
    t7.clopperPearsonLowerBound < 0 ||
    t7.clopperPearsonLowerBound > 1
  ) {
    telemetryIssues.push("invalid_t7_clopperPearsonLowerBound");
  }

  if (
    typeof t7.learnerClusterLowerBound !== "number" ||
    !Number.isFinite(t7.learnerClusterLowerBound) ||
    t7.learnerClusterLowerBound < 0 ||
    t7.learnerClusterLowerBound > 1
  ) {
    telemetryIssues.push("invalid_t7_learnerClusterLowerBound");
  }

  if (
    t7.alpha !== undefined &&
    (typeof t7.alpha !== "number" ||
      !Number.isFinite(t7.alpha) ||
      t7.alpha <= 0 ||
      t7.alpha > MAX_PROMOTION_ALPHA + 1e-9)
  ) {
    telemetryIssues.push("t7_alpha_exceeds_max_0_05");
  }

  const boundedNEff =
    exactKishNEff > 0 &&
    typeof t7.effectiveClusterSampleSize === "number" &&
    Number.isFinite(t7.effectiveClusterSampleSize) &&
    t7.effectiveClusterSampleSize > 0
      ? Math.min(exactKishNEff, t7.effectiveClusterSampleSize)
      : exactKishNEff;
  const certifiedCp95Lcb =
    Number.isFinite(exactRate) && boundedNEff > 0
      ? exactClopperPearsonLowerBound(exactRate * boundedNEff, boundedNEff, MAX_PROMOTION_ALPHA)
      : 0;

  if (
    Number.isFinite(exactRate) &&
    boundedNEff > 0 &&
    typeof t7.clopperPearsonLowerBound === "number" &&
    Number.isFinite(t7.clopperPearsonLowerBound) &&
    t7.clopperPearsonLowerBound > certifiedCp95Lcb + 1e-9
  ) {
    telemetryIssues.push(
      `t7_cp_lcb_exceeds_certified_cp95:${t7.clopperPearsonLowerBound.toFixed(4)}>${certifiedCp95Lcb.toFixed(4)}`,
    );
  }

  if (
    Number.isFinite(exactRate) &&
    boundedNEff > 0 &&
    typeof t7.learnerClusterLowerBound === "number" &&
    Number.isFinite(t7.learnerClusterLowerBound) &&
    t7.learnerClusterLowerBound > certifiedCp95Lcb + 1e-9
  ) {
    telemetryIssues.push(
      `t7_lcb_exceeds_certified_cp95:${t7.learnerClusterLowerBound.toFixed(4)}>${certifiedCp95Lcb.toFixed(4)}`,
    );
  }

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
  const c = candidate.c as CartridgeCandidateMetrics["c"] | null | undefined;

  if (!isNonNullRecord(c)) {
    issues.push("invalid_objective_telemetry:missing_c");
  } else {
    const validVerifiable = isNonNegativeInteger(c.verifiableFirstErrorCount);
    const validRepaired = isNonNegativeInteger(c.repairedCount);
    if (!validVerifiable) {
      issues.push("invalid_c_verifiableFirstErrorCount");
    }
    if (!validRepaired) {
      issues.push("invalid_c_repairedCount");
    }
    if (validVerifiable && validRepaired && c.repairedCount > c.verifiableFirstErrorCount) {
      issues.push("inconsistent_c_counts");
    }
    if (!isNonNegativeInteger(c.abandonedCount)) {
      issues.push("invalid_c_abandonedCount");
    }
    if (
      typeof c.abandonmentRate !== "number" ||
      !Number.isFinite(c.abandonmentRate) ||
      c.abandonmentRate < 0 ||
      c.abandonmentRate > 1
    ) {
      issues.push("invalid_c_abandonmentRate");
    }
    if (typeof c.rate !== "number" || !Number.isFinite(c.rate) || c.rate < 0 || c.rate > 1) {
      issues.push("invalid_c_rate");
    } else if (validVerifiable && validRepaired && c.repairedCount <= c.verifiableFirstErrorCount) {
      const expectedC =
        c.verifiableFirstErrorCount > 0 ? c.repairedCount / c.verifiableFirstErrorCount : 0;
      if (Math.abs(c.rate - expectedC) > 1e-9) {
        issues.push(
          `inconsistent_c_rate:reported(${c.rate.toFixed(9)})!=derived(${expectedC.toFixed(9)})`,
        );
      }
    }
  }

  let matureCert: MatureTransferCertification | null = null;
  const rawT7 = candidate.t7 as T7Metric | null | undefined;
  if (!isNonNullRecord(rawT7) || (rawT7.status !== "mature" && rawT7.status !== "pending")) {
    // Fixed constant code — never echo raw malformed status values.
    issues.push("invalid_t7_status");
  } else if (rawT7.status === "mature") {
    matureCert = certifyMatureTransferLowerBound(rawT7);
    if (!matureCert.validTelemetry) {
      issues.push(...matureCert.telemetryIssues);
    }
  } else if (rawT7.status === "pending") {
    const t7p = rawT7;
    if (!isNonNegativeInteger(t7p.eligibleFollowupCohortCount)) {
      issues.push("invalid_pending_t7_eligibleFollowupCohortCount");
    }
    if (!isNonNegativeInteger(t7p.passedFreshTransferCount)) {
      issues.push("invalid_pending_t7_passedFreshTransferCount");
    }
    if (
      isNonNegativeInteger(t7p.eligibleFollowupCohortCount) &&
      isNonNegativeInteger(t7p.passedFreshTransferCount) &&
      t7p.passedFreshTransferCount > t7p.eligibleFollowupCohortCount
    ) {
      issues.push("inconsistent_pending_t7_counts");
    }
    if (!isNonNegativeInteger(t7p.pendingCohortCount)) {
      issues.push("invalid_pending_t7_pendingCohortCount");
    }
    if (typeof t7p.reason !== "string" || t7p.reason.trim().length === 0) {
      issues.push("invalid_pending_t7_reason");
    }
  }

  return { issues, matureCert };
}

/**
 * Projects any candidate receipt strictly onto declared schema fields so neither
 * vetoed nor non-vetoed results can leak undeclared extra properties or non-string raw fields.
 */
function projectDeclaredCandidateMetrics(
  candidate: CartridgeCandidateMetrics,
): CartridgeCandidateMetrics {
  const rawC = candidate.c as CartridgeCandidateMetrics["c"] | null | undefined;
  const rawL = candidate.l as CartridgeCandidateMetrics["l"] | null | undefined;
  const safeTelemetryIssues = isNonNullRecord(rawL)
    ? canonicalizeTelemetryIssues(rawL.telemetryIssues)
    : undefined;

  const rawT7 = candidate.t7 as T7Metric | null | undefined;
  let safeT7: T7Metric;
  if (isNonNullRecord(rawT7) && rawT7.status === "mature") {
    safeT7 = {
      status: "mature",
      rate: typeof rawT7.rate === "number" ? rawT7.rate : Number.NaN,
      passedFreshTransferCount:
        typeof rawT7.passedFreshTransferCount === "number"
          ? rawT7.passedFreshTransferCount
          : Number.NaN,
      eligibleFollowupCohortCount:
        typeof rawT7.eligibleFollowupCohortCount === "number"
          ? rawT7.eligibleFollowupCohortCount
          : Number.NaN,
      learnerClusterCount:
        typeof rawT7.learnerClusterCount === "number" ? rawT7.learnerClusterCount : Number.NaN,
      learnerOutcomeCounts: Array.isArray(rawT7.learnerOutcomeCounts)
        ? rawT7.learnerOutcomeCounts.filter(
            (n): n is number => typeof n === "number" && Number.isFinite(n),
          )
        : [],
      effectiveClusterSampleSize:
        typeof rawT7.effectiveClusterSampleSize === "number"
          ? rawT7.effectiveClusterSampleSize
          : Number.NaN,
      learnerClusterMean:
        typeof rawT7.learnerClusterMean === "number" ? rawT7.learnerClusterMean : Number.NaN,
      standardError: typeof rawT7.standardError === "number" ? rawT7.standardError : Number.NaN,
      clopperPearsonLowerBound:
        typeof rawT7.clopperPearsonLowerBound === "number"
          ? rawT7.clopperPearsonLowerBound
          : Number.NaN,
      learnerClusterLowerBound:
        typeof rawT7.learnerClusterLowerBound === "number"
          ? rawT7.learnerClusterLowerBound
          : Number.NaN,
      ...(typeof rawT7.alpha === "number" ? { alpha: rawT7.alpha } : {}),
    };
  } else if (isNonNullRecord(rawT7) && rawT7.status === "pending") {
    safeT7 = {
      status: "pending",
      passedFreshTransferCount:
        typeof rawT7.passedFreshTransferCount === "number"
          ? rawT7.passedFreshTransferCount
          : Number.NaN,
      eligibleFollowupCohortCount:
        typeof rawT7.eligibleFollowupCohortCount === "number"
          ? rawT7.eligibleFollowupCohortCount
          : Number.NaN,
      pendingCohortCount:
        typeof rawT7.pendingCohortCount === "number" ? rawT7.pendingCohortCount : Number.NaN,
      reason: canonicalizePendingReason(rawT7.reason),
    };
  } else {
    safeT7 = {
      status: "pending",
      passedFreshTransferCount: 0,
      eligibleFollowupCohortCount: 0,
      pendingCohortCount: 0,
      reason: "redacted_invalid_t7_status",
    };
  }

  return {
    candidateId: candidate.candidateId,
    c: {
      rate: isNonNullRecord(rawC) && typeof rawC.rate === "number" ? rawC.rate : Number.NaN,
      repairedCount:
        isNonNullRecord(rawC) && typeof rawC.repairedCount === "number"
          ? rawC.repairedCount
          : Number.NaN,
      verifiableFirstErrorCount:
        isNonNullRecord(rawC) && typeof rawC.verifiableFirstErrorCount === "number"
          ? rawC.verifiableFirstErrorCount
          : Number.NaN,
      abandonedCount:
        isNonNullRecord(rawC) && typeof rawC.abandonedCount === "number"
          ? rawC.abandonedCount
          : Number.NaN,
      abandonmentRate:
        isNonNullRecord(rawC) && typeof rawC.abandonmentRate === "number"
          ? rawC.abandonmentRate
          : Number.NaN,
    },
    l: {
      rate: isNonNullRecord(rawL) && typeof rawL.rate === "number" ? rawL.rate : Number.NaN,
      leakedReleasedTurns:
        isNonNullRecord(rawL) && typeof rawL.leakedReleasedTurns === "number"
          ? rawL.leakedReleasedTurns
          : Number.NaN,
      totalReleasedTurns:
        isNonNullRecord(rawL) && typeof rawL.totalReleasedTurns === "number"
          ? rawL.totalReleasedTurns
          : Number.NaN,
      severeLeakCount:
        isNonNullRecord(rawL) && typeof rawL.severeLeakCount === "number"
          ? rawL.severeLeakCount
          : Number.NaN,
      guardBlockedCount:
        isNonNullRecord(rawL) && typeof rawL.guardBlockedCount === "number"
          ? rawL.guardBlockedCount
          : Number.NaN,
      ...(safeTelemetryIssues && safeTelemetryIssues.length > 0
        ? { telemetryIssues: safeTelemetryIssues }
        : {}),
    },
    t7: safeT7,
  };
}

function validateParetoEvaluationOptions(options: ParetoEvaluationOptions): {
  readonly baselineCRate: number;
  readonly baselineT7Rate: number;
  readonly maxAllowedLeakageRate: number;
  readonly minT7Gain: number;
  readonly nonInferiorityMargin: number;
  readonly minClusterCount: number;
} {
  if (!options || typeof options !== "object" || !options.baseline || typeof options.baseline !== "object") {
    throw new RangeError("Pareto evaluation requires a valid baseline { cRate, t7Rate } object.");
  }

  const baselineCRate = options.baseline.cRate;
  const baselineT7Rate = options.baseline.t7Rate;
  const maxAllowedLeakageRate = options.maxAllowedLeakageRate ?? 0;
  const minT7Gain = options.minT7Gain ?? 0.05;
  const nonInferiorityMargin = options.nonInferiorityMargin ?? 0.02;
  const minClusterCount = options.minClusterCount ?? 5;

  for (const [name, value] of [
    ["baseline.cRate", baselineCRate],
    ["baseline.t7Rate", baselineT7Rate],
    ["maxAllowedLeakageRate", maxAllowedLeakageRate],
    ["minT7Gain", minT7Gain],
    ["nonInferiorityMargin", nonInferiorityMargin],
  ] as const) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new RangeError(
        `${name} must be a finite number in [0, 1] (received invalid ${typeof value}).`,
      );
    }
  }

  if (
    typeof minClusterCount !== "number" ||
    !Number.isFinite(minClusterCount) ||
    !Number.isInteger(minClusterCount) ||
    minClusterCount < 1
  ) {
    throw new RangeError(
      `minClusterCount must be a positive integer >= 1 (received invalid ${typeof minClusterCount}).`,
    );
  }

  return {
    baselineCRate,
    baselineT7Rate,
    maxAllowedLeakageRate,
    minT7Gain,
    nonInferiorityMargin,
    minClusterCount,
  };
}

/**
 * Runs:
 * 1) Fail-closed validation of all promotion thresholds & margins,
 * 2) Canonicalization, PII check across entire receipts (including numeric PII), and uniqueness enforcement,
 * 3) Fail-closed Hard Pre-Pareto Veto on leakage telemetry AND objective (`C`, `T7`)
 *    telemetry integrity BEFORE any Pareto dominance comparison so neither leakage
 *    nor malformed `C`/`T7` counts can ever enter the frontier or dominate a valid candidate,
 * 4) Exact non-dominated Pareto frontier ranking on `(C, -L, T7)` for mature candidates
 *    and `(C, -L)` shadow ranking for pending-T7 candidates,
 * 5) Promotion gate requiring mature T7, independently certified Kish `n_eff` and
 *    exact one-sided 95% (`alpha <= 0.05`) Clopper-Pearson LCB >= baselineT7 + minT7Gain,
 *    minimum cluster count, and C >= baselineC - nonInferiorityMargin.
 */
export function evaluateParetoFrontierAndPromotion(
  candidates: readonly CartridgeCandidateMetrics[],
  options: ParetoEvaluationOptions,
): ParetoEvaluationResult {
  // Scan ALL options and candidate receipts for raw PII FIRST before option RangeErrors or duplicate-ID errors.
  assertNoRawPiiInValue(options, "pareto_options");
  assertNoRawPiiInValue(candidates, "pareto_candidates");

  const {
    baselineCRate,
    baselineT7Rate,
    maxAllowedLeakageRate,
    minT7Gain,
    nonInferiorityMargin,
    minClusterCount,
  } = validateParetoEvaluationOptions(options);

  // Pre-collect all caller-supplied candidateId strings across candidates and baseline so
  // synthetic malformed-receipt placeholders can NEVER collide with any valid sibling candidateId.
  const reservedIds = new Set<string>();
  const rawBaseline = options.baseline as unknown;
  if (isNonNullRecord(rawBaseline) && typeof rawBaseline.candidateId === "string") {
    reservedIds.add(rawBaseline.candidateId);
    const trimmedBase = rawBaseline.candidateId.normalize("NFKC").trim();
    if (trimmedBase.length > 0) reservedIds.add(trimmedBase);
  }
  for (let i = 0; i < candidates.length; i += 1) {
    if (!Object.prototype.hasOwnProperty.call(candidates, i)) continue;
    const rawCandidate = candidates[i];
    if (isNonNullRecord(rawCandidate) && typeof rawCandidate.candidateId === "string") {
      reservedIds.add(rawCandidate.candidateId);
      const trimmedId = rawCandidate.candidateId.normalize("NFKC").trim();
      if (trimmedId.length > 0) reservedIds.add(trimmedId);
    }
  }
  const allocateSyntheticMalformedId = (idx: number): string => {
    let synthId = `__malformed_receipt_${idx}`;
    while (reservedIds.has(synthId)) {
      synthId += "_x";
    }
    reservedIds.add(synthId);
    return synthId;
  };

  // Canonicalize, scan ENTIRE candidate receipt for raw PII, and enforce strict candidateId uniqueness upfront.
  // Malformed non-object, sparse-hole, or missing-ID elements are isolated under collision-free synthetic IDs so valid siblings still evaluate.
  const seenCandidateIds = new Set<string>();
  const malformedEntryIds = new Set<string>();
  const canonicalCandidates: CartridgeCandidateMetrics[] = [];
  for (let idx = 0; idx < candidates.length; idx += 1) {
    const hasOwn = Object.prototype.hasOwnProperty.call(candidates, idx);
    const rawCandidate = hasOwn ? candidates[idx] : undefined;
    if (!hasOwn || !isNonNullRecord(rawCandidate)) {
      const placeholderId = allocateSyntheticMalformedId(idx);
      malformedEntryIds.add(placeholderId);
      seenCandidateIds.add(placeholderId);
      canonicalCandidates.push({
        candidateId: placeholderId,
        c: null as unknown as CartridgeCandidateMetrics["c"],
        l: null as unknown as CartridgeCandidateMetrics["l"],
        t7: null as unknown as CartridgeCandidateMetrics["t7"],
      });
      continue;
    }
    // Always scan the entire receipt for raw PII first before isolating missing/non-string candidateId.
    assertNoRawPiiInValue(rawCandidate, `pareto_candidate[${idx}]`);
    const rawId = rawCandidate.candidateId;
    if (typeof rawId !== "string" || rawId.normalize("NFKC").trim().length === 0) {
      const placeholderId = allocateSyntheticMalformedId(idx);
      malformedEntryIds.add(placeholderId);
      seenCandidateIds.add(placeholderId);
      canonicalCandidates.push({
        candidateId: placeholderId,
        c: null as unknown as CartridgeCandidateMetrics["c"],
        l: null as unknown as CartridgeCandidateMetrics["l"],
        t7: null as unknown as CartridgeCandidateMetrics["t7"],
      });
      continue;
    }
    const candidate = rawCandidate as unknown as CartridgeCandidateMetrics;
    const canonicalId = canonicalizeIdentifier(rawId, "candidateId");
    assertNoRawPiiInText(canonicalId, "candidateId");
    if (seenCandidateIds.has(canonicalId)) {
      throw new CandidateIdentityError(
        `Duplicate candidateId "${canonicalId}" in Pareto evaluation.`,
        "duplicate_candidate_id",
        canonicalId,
      );
    }
    seenCandidateIds.add(canonicalId);
    canonicalCandidates.push(
      canonicalId === candidate.candidateId ? candidate : { ...candidate, candidateId: canonicalId },
    );
  }

  const vetoMap = new Map<
    string,
    { status: "vetoed_leakage" | "vetoed_invalid_telemetry"; reasons: string[] }
  >();
  const matureCertMap = new Map<string, MatureTransferCertification>();
  const safeMature: CartridgeCandidateMetrics[] = [];
  const safePending: CartridgeCandidateMetrics[] = [];

  for (const candidate of canonicalCandidates) {
    if (malformedEntryIds.has(candidate.candidateId)) {
      vetoMap.set(candidate.candidateId, {
        status: "vetoed_invalid_telemetry",
        reasons: ["invalid_candidate_receipt"],
      });
      continue;
    }

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
    } else if (candidate.t7.status === "pending") {
      safePending.push(candidate);
    } else {
      vetoMap.set(candidate.candidateId, {
        status: "vetoed_invalid_telemetry",
        reasons: ["invalid_t7_status"],
      });
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
    const projectedMetrics = projectDeclaredCandidateMetrics(candidate);
    const veto = vetoMap.get(candidate.candidateId);
    if (veto) {
      return {
        candidateId: candidate.candidateId,
        metrics: projectedMetrics,
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
        metrics: projectedMetrics,
        status: "dominated",
        onParetoFrontier: false,
        dominatedBy,
        vetoReasons: [],
        promotionBlockers: [`dominated_by:${dominatedBy.join(",")}`],
      };
    }

    // Non-dominated safe candidate on Pareto frontier: check promotion gate (fail-closed on NaN/invalid).
    const promotionBlockers: string[] = [];
    if (candidate.t7.status === "pending") {
      promotionBlockers.push(`t7_pending:${canonicalizePendingReason(candidate.t7.reason)}`);
    } else if (candidate.t7.status === "mature") {
      const t7 = candidate.t7;
      const cert = matureCertMap.get(candidate.candidateId) ?? certifyMatureTransferLowerBound(t7);

      if (!cert.validTelemetry) {
        promotionBlockers.push(...cert.telemetryIssues);
      }

      if (
        t7.alpha !== undefined &&
        !(
          typeof t7.alpha === "number" &&
          Number.isFinite(t7.alpha) &&
          t7.alpha > 0 &&
          t7.alpha <= MAX_PROMOTION_ALPHA + 1e-9
        )
      ) {
        promotionBlockers.push("t7_alpha_exceeds_max_0_05");
      }

      if (!(t7.learnerClusterCount >= minClusterCount)) {
        promotionBlockers.push("insufficient_student_clusters");
      }

      if (
        !(
          Number.isFinite(t7.learnerClusterLowerBound) &&
          Number.isFinite(cert.certifiedCp95Lcb) &&
          t7.learnerClusterLowerBound <= cert.certifiedCp95Lcb + 1e-9
        )
      ) {
        promotionBlockers.push("t7_lcb_exceeds_certified_cp95");
      }

      const verifiedLcb = Math.min(t7.learnerClusterLowerBound, cert.certifiedCp95Lcb);
      const requiredT7Lcb = baselineT7Rate + minT7Gain;
      if (!(Number.isFinite(verifiedLcb) && verifiedLcb + EPSILON >= requiredT7Lcb)) {
        promotionBlockers.push(
          `t7_lcb_below_gain_threshold:${Number.isFinite(verifiedLcb) ? verifiedLcb.toFixed(4) : "non_finite"}<${requiredT7Lcb.toFixed(4)}`,
        );
      }
      const minAllowedC = baselineCRate - nonInferiorityMargin;
      if (!(Number.isFinite(candidate.c.rate) && candidate.c.rate + EPSILON >= minAllowedC)) {
        promotionBlockers.push(
          `c_below_non_inferiority:${Number.isFinite(candidate.c.rate) ? candidate.c.rate.toFixed(4) : "non_finite"}<${minAllowedC.toFixed(4)}`,
        );
      }
    } else {
      promotionBlockers.push("invalid_t7_status");
    }

    const status: ParetoCandidateStatus =
      promotionBlockers.length === 0 ? "promoted" : "shadow_candidate";

    return {
      candidateId: candidate.candidateId,
      metrics: projectedMetrics,
      status,
      onParetoFrontier: true,
      dominatedBy: [],
      vetoReasons: [],
      promotionBlockers,
    };
  });

  const output: ParetoEvaluationResult = {
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
  assertNoRawPiiInValue(output, "pareto_evaluation_output");
  return output;
}
