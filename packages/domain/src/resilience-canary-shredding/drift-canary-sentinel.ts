import type {
  CrossFamilyFallbackConfig,
  DriftSentinelDecision,
  DriftSentinelInput,
  DriftSentinelThresholds,
  DriftThresholdMetric,
  FailoverBillingSettlementInput,
  FailoverBillingSettlementResult,
  KeepPrimaryReason,
  ModelAttemptBillingRecord,
  SanitizedCanaryProbeSignal,
  SanitizedDriftWindowMetrics,
  TaskRouteSpec,
} from "./types";

export const CANARY_PROBE_INTERVAL_MS = 60_000 as const;
export const DRIFT_WINDOW_MS = 5 * 60_000;
export const MIN_DECISIONS_PER_WINDOW = 100 as const;
export const MAX_SWITCHOVER_DETECTION_MS = 15 * 60_000;

function assertNonEmptyString(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new RangeError(`${fieldName} must be a non-empty string`);
  }
  return trimmed;
}

function assertUnitRate(value: number, fieldName: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${fieldName} must be a finite rate in [0, 1]`);
  }
  return value;
}

function assertNonNegativeFinite(value: number, fieldName: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${fieldName} must be a non-negative finite number`);
  }
  return value;
}

function validateRouteConfig(route: CrossFamilyFallbackConfig): void {
  const primaryFamily = assertNonEmptyString(
    route.primary.providerFamily,
    "route.primary.providerFamily",
  );
  assertNonEmptyString(route.primary.modelId, "route.primary.modelId");
  const primaryTask = assertNonEmptyString(
    route.primary.taskKind,
    "route.primary.taskKind",
  );

  const fallbackFamily = assertNonEmptyString(
    route.fallback.providerFamily,
    "route.fallback.providerFamily",
  );
  assertNonEmptyString(route.fallback.modelId, "route.fallback.modelId");
  const fallbackTask = assertNonEmptyString(
    route.fallback.taskKind,
    "route.fallback.taskKind",
  );

  if (fallbackFamily === primaryFamily) {
    throw new RangeError(
      "Cross-family fallback requires fallback.providerFamily !== primary.providerFamily",
    );
  }
  if (fallbackTask !== primaryTask) {
    throw new RangeError(
      "Cross-family fallback route must target the same taskKind as primary",
    );
  }
}

function validateThresholds(thresholds: DriftSentinelThresholds): void {
  assertUnitRate(thresholds.maxErrorRate, "thresholds.maxErrorRate");
  assertNonNegativeFinite(thresholds.maxP95TtftMs, "thresholds.maxP95TtftMs");
  assertUnitRate(
    thresholds.maxVerifierContradictionRate,
    "thresholds.maxVerifierContradictionRate",
  );
  assertUnitRate(
    thresholds.maxCanaryFailureRate,
    "thresholds.maxCanaryFailureRate",
  );
}

function validateWindowBase(window: SanitizedDriftWindowMetrics): void {
  assertNonEmptyString(window.taskKind, "window.taskKind");
  if (
    !Number.isFinite(window.windowStartMs) ||
    window.windowStartMs < 0 ||
    !Number.isFinite(window.windowEndMs) ||
    window.windowEndMs < window.windowStartMs
  ) {
    throw new RangeError(
      "Drift window bounds must be finite non-negative timestamps with windowEndMs >= windowStartMs",
    );
  }
  if (!Number.isInteger(window.decisionCount) || window.decisionCount < 0) {
    throw new RangeError(
      "window.decisionCount must be a non-negative integer",
    );
  }
  assertUnitRate(window.errorRate, "window.errorRate");
  assertNonNegativeFinite(window.p95TtftMs, "window.p95TtftMs");
  assertUnitRate(
    window.verifierContradictionRate,
    "window.verifierContradictionRate",
  );
  assertUnitRate(window.canaryFailureRate, "window.canaryFailureRate");
}

function validateFullWindowDuration(window: SanitizedDriftWindowMetrics): void {
  if (window.windowEndMs - window.windowStartMs !== DRIFT_WINDOW_MS) {
    throw new RangeError(
      `Drift window duration must equal DRIFT_WINDOW_MS (${DRIFT_WINDOW_MS} ms)`,
    );
  }
}

function routeMatchesProbe(
  primary: TaskRouteSpec,
  probe: SanitizedCanaryProbeSignal,
): boolean {
  return (
    probe.providerFamily === primary.providerFamily &&
    probe.modelId === primary.modelId &&
    probe.taskKind === primary.taskKind
  );
}

function routeMatchesWindow(
  primary: TaskRouteSpec,
  window: SanitizedDriftWindowMetrics,
): boolean {
  if (window.taskKind !== primary.taskKind) return false;
  if (
    window.providerFamily !== undefined &&
    window.providerFamily !== primary.providerFamily
  ) {
    return false;
  }
  if (
    window.modelId !== undefined &&
    window.modelId !== primary.modelId
  ) {
    return false;
  }
  return true;
}

function formatRouteKey(route: TaskRouteSpec): string {
  return `${route.providerFamily}:${route.modelId}:${route.taskKind}`;
}

function collectBreachedMetrics(
  window: SanitizedDriftWindowMetrics,
  thresholds: DriftSentinelThresholds,
): DriftThresholdMetric[] {
  const breached: DriftThresholdMetric[] = [];
  if (window.errorRate > thresholds.maxErrorRate) {
    breached.push("errorRate");
  }
  if (window.p95TtftMs > thresholds.maxP95TtftMs) {
    breached.push("p95TtftMs");
  }
  if (
    window.verifierContradictionRate > thresholds.maxVerifierContradictionRate
  ) {
    breached.push("verifierContradictionRate");
  }
  if (window.canaryFailureRate > thresholds.maxCanaryFailureRate) {
    breached.push("canaryFailureRate");
  }
  return breached;
}

export function alignDriftWindowStart(timestampMs: number): number {
  assertNonNegativeFinite(timestampMs, "timestampMs");
  return Math.floor(timestampMs / DRIFT_WINDOW_MS) * DRIFT_WINDOW_MS;
}

export function evaluateDriftCanarySentinel(
  input: DriftSentinelInput,
): DriftSentinelDecision {
  validateRouteConfig(input.route);
  validateThresholds(input.thresholds);
  if (input.evaluatedAtMs !== undefined) {
    assertNonNegativeFinite(input.evaluatedAtMs, "evaluatedAtMs");
  }

  const primary = input.route.primary;
  const fallback = input.route.fallback;
  const routeKey = formatRouteKey(primary);

  const matchingProbes = (input.probes ?? [])
    .filter((probe) => {
      assertNonEmptyString(probe.probeId, "probe.probeId");
      assertNonNegativeFinite(probe.observedAtMs, "probe.observedAtMs");
      return routeMatchesProbe(primary, probe);
    })
    .sort((a, b) => a.observedAtMs - b.observedAtMs);

  const leakedProbe = matchingProbes.find((probe) => probe.sseAnswerMarkerLeak);
  if (leakedProbe) {
    return {
      action: "immediate_circuit_break",
      triggerLatencyMs: 0,
      detectionElapsedMs: 0,
      withinDetectionSla: true,
      waitedForWindowCompletion: false,
      scopedTaskKind: primary.taskKind,
      isolatedRoute: primary,
      fallbackRoute: fallback,
      isolatedRouteKey: routeKey,
      leakSource: leakedProbe.probeSource,
      triggerProbeId: leakedProbe.probeId,
      breachedMetrics: [],
      reason: "sse_answer_marker_leak",
    };
  }

  for (const window of input.windows) {
    validateWindowBase(window);
  }

  const scopedWindows = input.windows
    .filter((window) => routeMatchesWindow(primary, window))
    .sort((a, b) => a.windowStartMs - b.windowStartMs);

  const leakedWindow = scopedWindows.find(
    (window) => window.sseAnswerMarkerLeak === true,
  );
  if (leakedWindow) {
    return {
      action: "immediate_circuit_break",
      triggerLatencyMs: 0,
      detectionElapsedMs: 0,
      withinDetectionSla: true,
      waitedForWindowCompletion: false,
      scopedTaskKind: primary.taskKind,
      isolatedRoute: primary,
      fallbackRoute: fallback,
      isolatedRouteKey: routeKey,
      leakSource: "live_sse_guard",
      triggerProbeId: null,
      breachedMetrics: [],
      reason: "sse_answer_marker_leak",
    };
  }

  for (const window of scopedWindows) {
    validateFullWindowDuration(window);
  }

  for (let i = 1; i < scopedWindows.length; i += 1) {
    const prev = scopedWindows[i - 1]!;
    const curr = scopedWindows[i]!;
    if (curr.windowStartMs < prev.windowEndMs) {
      throw new RangeError(
        "Overlapping or duplicate drift windows for the same route are not allowed",
      );
    }
  }

  let sawSingleQualifiedBreach = false;
  let sawDisjointBreachPair = false;
  let sawNonConsecutiveBreach = false;
  let qualifiedBreachWindows = 0;

  for (let i = 0; i < scopedWindows.length; i += 1) {
    const curr = scopedWindows[i]!;
    if (curr.decisionCount < MIN_DECISIONS_PER_WINDOW) {
      continue;
    }

    const currBreaches = collectBreachedMetrics(curr, input.thresholds);
    if (currBreaches.length > 0) {
      qualifiedBreachWindows += 1;
      sawSingleQualifiedBreach = true;
    }

    if (i === 0) continue;
    const prev = scopedWindows[i - 1]!;
    if (
      prev.windowStartMs + DRIFT_WINDOW_MS !== curr.windowStartMs ||
      prev.windowEndMs !== curr.windowStartMs ||
      prev.decisionCount < MIN_DECISIONS_PER_WINDOW
    ) {
      continue;
    }

    const prevBreaches = collectBreachedMetrics(prev, input.thresholds);
    if (prevBreaches.length === 0 || currBreaches.length === 0) {
      continue;
    }

    const sharedBreaches = prevBreaches.filter((metric) =>
      currBreaches.includes(metric),
    );
    if (sharedBreaches.length === 0) {
      sawDisjointBreachPair = true;
      continue;
    }

    const windowSpanMs = curr.windowEndMs - prev.windowStartMs;
    const detectionElapsedMs =
      input.evaluatedAtMs !== undefined
        ? Math.max(windowSpanMs, input.evaluatedAtMs - prev.windowStartMs)
        : windowSpanMs;

    return {
      action: "switch_task_to_cross_family_fallback",
      triggerLatencyMs: windowSpanMs,
      detectionElapsedMs,
      withinDetectionSla: detectionElapsedMs <= MAX_SWITCHOVER_DETECTION_MS,
      waitedForWindowCompletion: true,
      scopedTaskKind: primary.taskKind,
      isolatedRoute: primary,
      fallbackRoute: fallback,
      isolatedRouteKey: routeKey,
      breachedMetrics: sharedBreaches,
      triggerWindowPair: [prev, curr],
      reason: "consecutive_dual_window_threshold_breach",
    };
  }

  if (qualifiedBreachWindows >= 2 && !sawDisjointBreachPair) {
    sawNonConsecutiveBreach = true;
  }

  const qualifiedWindowCount = scopedWindows.filter(
    (window) => window.decisionCount >= MIN_DECISIONS_PER_WINDOW,
  ).length;

  let reason: KeepPrimaryReason = "within_thresholds";
  if (sawDisjointBreachPair) {
    reason = "disjoint_threshold_breaches";
  } else if (sawNonConsecutiveBreach) {
    reason = "non_consecutive_breach_windows";
  } else if (sawSingleQualifiedBreach) {
    reason = "single_window_breach_not_confirmed";
  } else if (qualifiedWindowCount < 2) {
    reason = "insufficient_qualified_windows";
  }

  return {
    action: "keep_primary",
    triggerLatencyMs: null,
    detectionElapsedMs: 0,
    withinDetectionSla: true,
    waitedForWindowCompletion: false,
    scopedTaskKind: primary.taskKind,
    isolatedRoute: null,
    fallbackRoute: null,
    isolatedRouteKey: null,
    breachedMetrics: [],
    qualifiedWindowCount,
    evaluatedWindowCount: scopedWindows.length,
    reason,
  };
}

function validateBillingAttempt(
  attempt: ModelAttemptBillingRecord,
  label: string,
): void {
  assertNonEmptyString(attempt.providerFamily, `${label}.providerFamily`);
  assertNonEmptyString(attempt.modelId, `${label}.modelId`);
  assertNonNegativeFinite(
    attempt.providerCostMicroUnits,
    `${label}.providerCostMicroUnits`,
  );
  assertNonNegativeFinite(
    attempt.quotedLearnerDebitMicroUnits,
    `${label}.quotedLearnerDebitMicroUnits`,
  );
}

export function reconcileFailoverBillingSettlement(
  input: FailoverBillingSettlementInput,
): FailoverBillingSettlementResult {
  const requestId = assertNonEmptyString(input.requestId, "requestId");
  const taskKind = assertNonEmptyString(input.taskKind, "taskKind");
  validateBillingAttempt(input.primaryAttempt, "primaryAttempt");
  const primaryProviderFamily = input.primaryAttempt.providerFamily.trim();

  const fallback = input.fallbackAttempt ?? null;
  if (fallback) {
    validateBillingAttempt(fallback, "fallbackAttempt");
    if (fallback.providerFamily.trim() === primaryProviderFamily) {
      throw new RangeError(
        "Cross-family failover billing requires fallbackAttempt.providerFamily !== primaryAttempt.providerFamily",
      );
    }
  }

  const primarySucceeded = input.primaryAttempt.outcome === "succeeded";
  const fallbackSucceeded = fallback?.outcome === "succeeded";

  const primaryLearnerChargeMicroUnits = primarySucceeded
    ? input.primaryAttempt.quotedLearnerDebitMicroUnits
    : 0;

  const fallbackLearnerChargeMicroUnits =
    !primarySucceeded && fallbackSucceeded && fallback
      ? fallback.quotedLearnerDebitMicroUnits
      : 0;

  const totalLearnerChargeMicroUnits =
    primaryLearnerChargeMicroUnits + fallbackLearnerChargeMicroUnits;

  const primaryProviderCostMicroUnits =
    input.primaryAttempt.providerCostMicroUnits;
  const fallbackProviderCostMicroUnits = fallback
    ? fallback.providerCostMicroUnits
    : 0;

  return {
    requestId,
    taskKind,
    primaryLearnerChargeMicroUnits,
    fallbackLearnerChargeMicroUnits,
    totalLearnerChargeMicroUnits,
    voidedFailedPrimary: !primarySucceeded,
    voidedFailedFallback: fallback !== null && !fallbackSucceeded,
    duplicateChargePrevented: primarySucceeded && Boolean(fallbackSucceeded),
    billedExecution: primarySucceeded
      ? "primary"
      : fallbackSucceeded
        ? "fallback"
        : null,
    internalProviderTelemetry: {
      primaryProviderCostMicroUnits,
      fallbackProviderCostMicroUnits,
      totalInternalProviderCostMicroUnits:
        primaryProviderCostMicroUnits + fallbackProviderCostMicroUnits,
      primaryOutcome: input.primaryAttempt.outcome,
      fallbackOutcome: fallback?.outcome ?? null,
    },
  };
}
