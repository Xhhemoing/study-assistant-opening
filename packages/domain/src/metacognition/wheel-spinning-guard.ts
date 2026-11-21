import type {
  MicroConsolidationPlan,
  ScheduleBlockProjection,
  ScheduleTimeBlock,
  WheelSpinningAttemptEvent,
  WheelSpinningGuardDecision,
  WheelSpinningGuardInput,
  WheelSpinningSignals,
  WheelSpinningThresholds,
} from "./types";

export const WHEEL_SPINNING_WINDOW_MS = 20 * 60_000; // 1_200_000 ms
export const WHEEL_SPINNING_CONSECUTIVE_FAILURE_THRESHOLD = 3;
export const WHEEL_SPINNING_DWELL_STALL_MS = 12 * 60_000; // 720_000 ms
export const WHEEL_SPINNING_DEFAULT_LATENCY_SPIKE_MS = 4 * 60_000; // 240_000 ms
export const WHEEL_SPINNING_HINT_ESCALATION_THRESHOLD = 2;
export const WHEEL_SPINNING_LOW_VELOCITY_THRESHOLD = 0.25;

const MICRO_CONSOLIDATION_PLAN: MicroConsolidationPlan = Object.freeze({
  durationMinMinutes: 2,
  durationMaxMinutes: 3,
  targetStrategy: "prerequisite_micro_consolidation_success_anchor",
  pauseAfterConsolidation: true,
});

function resolveThresholds(
  overrides: WheelSpinningThresholds | undefined,
): Required<WheelSpinningThresholds> {
  const windowMs = overrides?.windowMs ?? WHEEL_SPINNING_WINDOW_MS;
  const consecutiveFailureThreshold =
    overrides?.consecutiveFailureThreshold ?? WHEEL_SPINNING_CONSECUTIVE_FAILURE_THRESHOLD;
  const dwellStallMs = overrides?.dwellStallMs ?? WHEEL_SPINNING_DWELL_STALL_MS;
  const latencySpikeThresholdMs =
    overrides?.latencySpikeThresholdMs ?? WHEEL_SPINNING_DEFAULT_LATENCY_SPIKE_MS;
  const hintEscalationThreshold =
    overrides?.hintEscalationThreshold ?? WHEEL_SPINNING_HINT_ESCALATION_THRESHOLD;
  const lowVelocityThreshold =
    overrides?.lowVelocityThreshold ?? WHEEL_SPINNING_LOW_VELOCITY_THRESHOLD;

  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new RangeError(`windowMs must be a positive finite number, received: ${String(windowMs)}`);
  }
  if (!Number.isInteger(consecutiveFailureThreshold) || consecutiveFailureThreshold < 1) {
    throw new RangeError(
      `consecutiveFailureThreshold must be a positive integer, received: ${String(consecutiveFailureThreshold)}`,
    );
  }
  if (!Number.isFinite(dwellStallMs) || dwellStallMs <= 0) {
    throw new RangeError(`dwellStallMs must be a positive finite number, received: ${String(dwellStallMs)}`);
  }
  if (!Number.isFinite(latencySpikeThresholdMs) || latencySpikeThresholdMs <= 0) {
    throw new RangeError(
      `latencySpikeThresholdMs must be a positive finite number, received: ${String(latencySpikeThresholdMs)}`,
    );
  }
  if (!Number.isInteger(hintEscalationThreshold) || hintEscalationThreshold < 1) {
    throw new RangeError(
      `hintEscalationThreshold must be a positive integer, received: ${String(hintEscalationThreshold)}`,
    );
  }
  if (
    !Number.isFinite(lowVelocityThreshold) ||
    lowVelocityThreshold <= 0 ||
    lowVelocityThreshold > 1
  ) {
    throw new RangeError(
      `lowVelocityThreshold must be in (0, 1], received: ${String(lowVelocityThreshold)}`,
    );
  }

  return {
    windowMs,
    consecutiveFailureThreshold,
    dwellStallMs,
    latencySpikeThresholdMs,
    hintEscalationThreshold,
    lowVelocityThreshold,
  };
}

function validateEvent(event: WheelSpinningAttemptEvent, index: number): void {
  if (!Number.isFinite(event.timestampMs)) {
    throw new RangeError(`events[${index}].timestampMs must be finite`);
  }
  if (!Number.isFinite(event.dwellMs) || event.dwellMs < 0) {
    throw new RangeError(`events[${index}].dwellMs must be a finite non-negative number`);
  }
  if (
    event.latencyMs !== undefined &&
    (!Number.isFinite(event.latencyMs) || event.latencyMs < 0)
  ) {
    throw new RangeError(`events[${index}].latencyMs must be a finite non-negative number`);
  }
  if (
    event.hintEscalations !== undefined &&
    (!Number.isInteger(event.hintEscalations) || event.hintEscalations < 0)
  ) {
    throw new RangeError(`events[${index}].hintEscalations must be a non-negative integer`);
  }
}

function validateScheduleBlock(block: ScheduleTimeBlock, index: number): void {
  if (!block.blockId || typeof block.blockId !== "string") {
    throw new RangeError(`scheduleBlocks[${index}].blockId must be a non-empty string`);
  }
  if (!block.taskId || typeof block.taskId !== "string") {
    throw new RangeError(`scheduleBlocks[${index}].taskId must be a non-empty string`);
  }
  if (!Number.isFinite(block.startMs) || !Number.isFinite(block.endMs) || block.endMs < block.startMs) {
    throw new RangeError(`scheduleBlocks[${index}] must have finite startMs <= endMs`);
  }
}

function computeMedian(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid]!;
  }
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function freezeBlockCopy(block: ScheduleTimeBlock): ScheduleTimeBlock {
  return Object.freeze({ ...block });
}

function projectScheduleBlocks(
  blocks: readonly ScheduleTimeBlock[],
  taskId: string,
  nowMs: number,
  triggered: boolean,
): ScheduleBlockProjection {
  const projected: ScheduleTimeBlock[] = [];
  const preservedCompleted: ScheduleTimeBlock[] = [];
  const truncatedActiveBlockIds: string[] = [];
  const carriedOverBlockIds: string[] = [];
  let carryOverDurationMs = 0;

  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]!;
    validateScheduleBlock(block, index);

    // Non-destructive past history invariant: completed historical blocks are
    // NEVER mutated, truncated, re-labeled, or deleted under any circumstance.
    if (block.status === "completed") {
      const immutableCompleted = freezeBlockCopy(block);
      projected.push(immutableCompleted);
      preservedCompleted.push(immutableCompleted);
      continue;
    }

    if (!triggered || block.taskId !== taskId) {
      projected.push(freezeBlockCopy(block));
      continue;
    }

    if (block.status === "active") {
      const truncatedEndMs = Math.min(block.endMs, Math.max(block.startMs, nowMs));
      const remainingSuffixMs = Math.max(0, block.endMs - truncatedEndMs);
      carryOverDurationMs += remainingSuffixMs;
      truncatedActiveBlockIds.push(block.blockId);

      projected.push(
        Object.freeze({
          ...block,
          endMs: truncatedEndMs,
          status: "wrapped_up",
        }),
      );
      continue;
    }

    if (block.status === "scheduled") {
      carryOverDurationMs += block.endMs - block.startMs;
      carriedOverBlockIds.push(block.blockId);

      projected.push(
        Object.freeze({
          ...block,
          status: "carried_over",
        }),
      );
      continue;
    }

    // Already wrapped_up or carried_over blocks remain untouched.
    projected.push(freezeBlockCopy(block));
  }

  return Object.freeze({
    blocks: Object.freeze(projected),
    preservedCompletedBlocks: Object.freeze(preservedCompleted),
    truncatedActiveBlockIds: Object.freeze(truncatedActiveBlockIds),
    carriedOverBlockIds: Object.freeze(carriedOverBlockIds),
    carryOverDurationMs,
  });
}

/**
 * Exact Boolean trigger formula for wheel-spinning detection:
 *   A = R && ((D && H) || (L && (D || H)))
 */
export function evaluateWheelSpinningFormula(signals: WheelSpinningSignals): boolean {
  const {
    repeatedFailure: R,
    dwellStall: D,
    hintSaturation: H,
    lowVelocity: L,
  } = signals;
  return R && ((D && H) || (L && (D || H)));
}

/**
 * 20-minute sliding-window wheel-spinning guard with productive-failure reset,
 * exact `taskId` carry-over preservation, and immutable historical schedule projection.
 */
export function wheelSpinningGuard(
  input: WheelSpinningGuardInput,
): WheelSpinningGuardDecision {
  if (!input.taskId || typeof input.taskId !== "string" || input.taskId.trim().length === 0) {
    throw new RangeError("taskId must be a non-empty string");
  }
  if (!Number.isFinite(input.nowMs)) {
    throw new RangeError(`nowMs must be a finite epoch timestamp, received: ${String(input.nowMs)}`);
  }

  const additionalActiveDwellMs = input.additionalActiveDwellMs ?? 0;
  if (!Number.isFinite(additionalActiveDwellMs) || additionalActiveDwellMs < 0) {
    throw new RangeError(
      `additionalActiveDwellMs must be a finite non-negative number, received: ${String(additionalActiveDwellMs)}`,
    );
  }

  const thresholds = resolveThresholds(input.thresholds);
  const windowEndMs = input.nowMs;
  const windowStartMs = windowEndMs - thresholds.windowMs;

  const indexedInWindow: Array<{ event: WheelSpinningAttemptEvent; originalIndex: number }> = [];
  let expiredEventCount = 0;

  for (let index = 0; index < input.events.length; index++) {
    const event = input.events[index]!;
    validateEvent(event, index);

    if (event.timestampMs < windowStartMs) {
      expiredEventCount += 1;
      continue;
    }
    if (event.timestampMs > windowEndMs) {
      continue;
    }
    indexedInWindow.push({ event, originalIndex: index });
  }

  // Chronological order with deterministic tie-breaking by input order.
  indexedInWindow.sort(
    (a, b) => a.event.timestampMs - b.event.timestampMs || a.originalIndex - b.originalIndex,
  );
  const inWindowEvents = indexedInWindow.map((entry) => entry.event);

  let trailingNonProductiveErrors = 0;
  let activeWindowDwellMs = additionalActiveDwellMs;
  let hasUnassistedPassInWindow = false;
  let hintEscalationCount = 0;
  let bottomOutReached = false;
  let productiveAttemptCount = 0;
  const latencies: number[] = [];

  for (const event of inWindowEvents) {
    activeWindowDwellMs += event.dwellMs;
    hintEscalationCount += event.hintEscalations ?? 0;
    if (event.bottomOutReached === true) {
      bottomOutReached = true;
    }

    if (event.latencyMs !== undefined) {
      latencies.push(event.latencyMs);
    }

    const isUnassistedPass = event.isCorrect && !event.assisted;
    if (isUnassistedPass) {
      hasUnassistedPassInWindow = true;
    }

    if (event.hasValidIntermediateSteps || isUnassistedPass) {
      productiveAttemptCount += 1;
    }

    // Productive Failure Interruption: any correct outcome or valid intermediate
    // derivation step resets the consecutive non-productive error streak.
    if (event.isCorrect || event.hasValidIntermediateSteps) {
      trailingNonProductiveErrors = 0;
    } else {
      trailingNonProductiveErrors += 1;
    }
  }

  const medianLatencyMs = computeMedian(latencies);
  const latestEvent = inWindowEvents[inWindowEvents.length - 1];
  const latestLatencyMs = latestEvent?.latencyMs ?? null;

  const latencySpikeDetected =
    (medianLatencyMs !== null && medianLatencyMs > thresholds.latencySpikeThresholdMs) ||
    (latestLatencyMs !== null && latestLatencyMs > thresholds.latencySpikeThresholdMs);

  const productiveStepRatio =
    inWindowEvents.length > 0 ? productiveAttemptCount / inWindowEvents.length : null;

  const signals: WheelSpinningSignals = Object.freeze({
    repeatedFailure: trailingNonProductiveErrors >= thresholds.consecutiveFailureThreshold,
    dwellStall:
      (activeWindowDwellMs >= thresholds.dwellStallMs && !hasUnassistedPassInWindow) ||
      latencySpikeDetected,
    hintSaturation:
      hintEscalationCount >= thresholds.hintEscalationThreshold || bottomOutReached,
    lowVelocity:
      productiveStepRatio !== null && productiveStepRatio < thresholds.lowVelocityThreshold,
  });

  const triggered = evaluateWheelSpinningFormula(signals);
  const scheduleProjection = projectScheduleBlocks(
    input.scheduleBlocks ?? [],
    input.taskId,
    input.nowMs,
    triggered,
  );

  return Object.freeze({
    schemaVersion: 1,
    taskId: input.taskId,
    skillId: input.skillId ?? null,
    triggered,
    action: triggered ? "micro_consolidation_and_graceful_wrapup" : "continue",
    signals,
    metrics: Object.freeze({
      windowStartMs,
      windowEndMs,
      inWindowEventCount: inWindowEvents.length,
      expiredEventCount,
      trailingNonProductiveErrors,
      activeWindowDwellMs,
      hasUnassistedPassInWindow,
      medianLatencyMs,
      latestLatencyMs,
      latencySpikeDetected,
      hintEscalationCount,
      bottomOutReached,
      productiveAttemptCount,
      productiveStepRatio,
    }),
    microConsolidationPlan: triggered ? MICRO_CONSOLIDATION_PLAN : null,
    carryOverTaskId: triggered ? input.taskId : null,
    rescheduleReason: triggered ? "wheel_spinning_graceful_carryover" : null,
    scheduleProjection,
  });
}
