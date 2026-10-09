import {
  isoDateTimeSchema,
  retestActivitySchema,
  type RetestActivity,
  type RetestActivityResult,
  type RetestActivityStatus,
} from "@aistudy/contracts";

type VersionGuard = { expectedVersion?: number };

export type RetestActivityCommand = VersionGuard & (
  | { type: "accept"; at: string; taskId?: string | null }
  | { type: "start"; at: string }
  | { type: "complete"; at: string; result?: RetestActivityResult; hasObservation?: boolean }
  | { type: "decline"; at: string; reason?: string }
  | { type: "skip"; at: string }
  | { type: "cancel"; at: string; reason?: string }
  | { type: "invalidate"; at: string; reason?: string }
  | { type: "supersede"; at: string; reason?: string }
  | { type: "snooze"; until: string | null }
);

export type RetestActivityReopenInput = {
  activityId: string;
  cycleId: string;
  candidateId?: string | null;
  taskId?: string | null;
  proposedAt?: string | null;
  notBeforeAt?: string | null;
  recommendedAt?: string | null;
  scheduledStartAt?: string | null;
  deadlineAt?: string | null;
};

export class RetestActivityTransitionError extends Error {
  readonly code = "INVALID_TRANSITION" as const;

  constructor(message: string) {
    super(message);
    this.name = "RetestActivityTransitionError";
  }
}

const terminalStatuses = new Set<RetestActivityStatus>([
  "completed",
  "declined",
  "cancelled",
  "invalidated",
  "superseded",
]);

function timestamp(value: string, label: string): string {
  if (!isoDateTimeSchema.safeParse(value).success) {
    throw new RetestActivityTransitionError(`${label} must be an ISO timestamp`);
  }
  return value;
}

function nextVersion(activity: RetestActivity, command: VersionGuard): number {
  if (command.expectedVersion !== undefined && command.expectedVersion !== activity.version) {
    throw new RetestActivityTransitionError("activity version is stale");
  }
  return activity.version + 1;
}

function activeFor(status: RetestActivityStatus, allowed: RetestActivityStatus[]): void {
  if (!allowed.includes(status)) {
    throw new RetestActivityTransitionError(`cannot transition from ${status}`);
  }
}

export function transitionRetestActivity(
  input: RetestActivity,
  command: RetestActivityCommand,
): RetestActivity {
  const current = retestActivitySchema.parse(input);
  const version = nextVersion(current, command);
  if (command.type === "snooze") {
    activeFor(current.status, ["accepted", "in_progress"]);
    const snoozedUntil = command.until == null ? null : timestamp(command.until, "snoozedUntil");
    return retestActivitySchema.parse({ ...current, version, snoozedUntil });
  }

  const at = timestamp(command.at, "at");
  const next: RetestActivity = {
    ...current,
    version,
    times: { ...current.times },
  };
  switch (command.type) {
    case "accept":
      activeFor(current.status, ["proposed"]);
      next.status = "accepted";
      next.taskId = command.taskId ?? current.taskId;
      next.times.acceptedAt = at;
      break;
    case "start":
      activeFor(current.status, ["accepted"]);
      next.status = "in_progress";
      next.times.startedAt = at;
      next.snoozedUntil = null;
      break;
    case "complete":
      activeFor(current.status, ["accepted", "in_progress"]);
      next.status = "completed";
      next.result = command.hasObservation === true && command.result ? command.result : "unverified";
      next.times.completedAt = at;
      next.snoozedUntil = null;
      break;
    case "decline":
      activeFor(current.status, ["proposed", "accepted"]);
      next.status = "declined";
      next.reason = command.reason ?? "user_declined";
      next.times.declinedAt = at;
      next.snoozedUntil = null;
      break;
    case "skip":
      activeFor(current.status, ["accepted", "in_progress"]);
      next.status = "cancelled";
      next.reason = "user_skipped";
      next.times.cancelledAt = at;
      next.snoozedUntil = null;
      break;
    case "cancel":
      activeFor(current.status, ["proposed", "accepted", "in_progress"]);
      next.status = "cancelled";
      next.reason = command.reason ?? "user_cancelled";
      next.times.cancelledAt = at;
      next.snoozedUntil = null;
      break;
    case "invalidate":
      activeFor(current.status, ["proposed", "accepted", "in_progress", "completed"]);
      next.status = "invalidated";
      next.reason = command.reason ?? "evidence_changed";
      next.times.invalidatedAt = at;
      next.snoozedUntil = null;
      break;
    case "supersede":
      activeFor(current.status, ["proposed", "accepted", "in_progress", "completed"]);
      next.status = "superseded";
      next.reason = command.reason ?? "new_cycle";
      next.times.supersededAt = at;
      next.snoozedUntil = null;
      break;
  }
  return retestActivitySchema.parse(next);
}

export function isRetestActivityDue(input: RetestActivity, now: Date | string): boolean {
  const activity = retestActivitySchema.parse(input);
  if (activity.status !== "accepted" && activity.status !== "in_progress") return false;
  const currentTime = typeof now === "string" ? Date.parse(timestamp(now, "now")) : now.getTime();
  if (!Number.isFinite(currentTime)) throw new RetestActivityTransitionError("now must be a valid date");
  const target = activity.times.scheduledStartAt ?? activity.times.recommendedAt;
  if (!target || Date.parse(target) > currentTime) return false;
  if (activity.times.notBeforeAt && Date.parse(activity.times.notBeforeAt) > currentTime) return false;
  if (activity.snoozedUntil && Date.parse(activity.snoozedUntil) > currentTime) return false;
  return true;
}

export function reopenRetestActivity(
  input: RetestActivity,
  reopen: RetestActivityReopenInput,
): RetestActivity {
  const current = retestActivitySchema.parse(input);
  if (!terminalStatuses.has(current.status)) {
    throw new RetestActivityTransitionError("only a terminal activity can be reopened");
  }
  if (reopen.activityId === current.activityId || reopen.cycleId === current.cycleId) {
    throw new RetestActivityTransitionError("reopened activity and cycle must be new");
  }
  const proposedAt = reopen.proposedAt == null ? null : timestamp(reopen.proposedAt, "proposedAt");
  return retestActivitySchema.parse({
    activityId: reopen.activityId,
    cycleId: reopen.cycleId,
    courseId: current.courseId,
    skillLabel: current.skillLabel,
    requirementKey: current.requirementKey,
    purpose: current.purpose,
    status: "proposed",
    result: null,
    taskId: reopen.taskId ?? null,
    candidateId: reopen.candidateId ?? null,
    version: 1,
    snoozedUntil: null,
    reason: null,
    reopenedFromActivityId: current.activityId,
    times: {
      proposedAt,
      acceptedAt: null,
      startedAt: null,
      completedAt: null,
      declinedAt: null,
      cancelledAt: null,
      invalidatedAt: null,
      supersededAt: null,
      notBeforeAt: reopen.notBeforeAt ?? current.times.notBeforeAt,
      recommendedAt: reopen.recommendedAt ?? current.times.recommendedAt,
      scheduledStartAt: reopen.scheduledStartAt ?? current.times.scheduledStartAt,
      deadlineAt: reopen.deadlineAt ?? current.times.deadlineAt,
    },
  });
}

/** Stable business code for API mapping when retest submit is before earliest allowed. */
export const RETEST_SUBMIT_TOO_EARLY_CODE = "RETEST_SUBMIT_TOO_EARLY" as const;

export const RETEST_SUBMIT_TOO_EARLY_MESSAGE =
  "补测尚未到最早可作答时间，请稍后再提交。" as const;

/** Timing fields used to decide whether a retest observation may be submitted yet. */
export type RetestSubmitEarliestTimes = {
  notBeforeAt?: string | null;
  recommendedAt?: string | null;
  scheduledStartAt?: string | null;
};

export type RetestSubmitTooEarlyResult = {
  code: typeof RETEST_SUBMIT_TOO_EARLY_CODE;
  reason: "not_before" | "scheduled_or_recommended";
  earliestAt: string;
  message: typeof RETEST_SUBMIT_TOO_EARLY_MESSAGE;
};

/**
 * Same spirit as {@link isRetestActivityDue} timing (ignore status/snooze):
 * due target = `scheduledStartAt ?? recommendedAt`; also respect `notBeforeAt`.
 * Effective earliest is the max of those present floors; future → too early.
 * Missing floors → not too early (no submit-time constraint).
 */
export function retestSubmitTooEarly(
  times: RetestSubmitEarliestTimes,
  now: Date | string,
): RetestSubmitTooEarlyResult | null {
  const currentTime = typeof now === "string" ? Date.parse(now) : now.getTime();
  if (!Number.isFinite(currentTime)) {
    throw new RetestActivityTransitionError("now must be a valid date");
  }

  const target = times.scheduledStartAt ?? times.recommendedAt ?? null;
  let earliestMs = Number.NEGATIVE_INFINITY;
  let earliestAt: string | null = null;
  let reason: RetestSubmitTooEarlyResult["reason"] = "scheduled_or_recommended";

  if (times.notBeforeAt) {
    const ms = Date.parse(times.notBeforeAt);
    if (Number.isFinite(ms) && ms > earliestMs) {
      earliestMs = ms;
      earliestAt = times.notBeforeAt;
      reason = "not_before";
    }
  }
  if (target) {
    const ms = Date.parse(target);
    if (Number.isFinite(ms) && ms > earliestMs) {
      earliestMs = ms;
      earliestAt = target;
      reason = "scheduled_or_recommended";
    }
  }

  if (earliestAt == null || earliestMs <= currentTime) return null;
  return {
    code: RETEST_SUBMIT_TOO_EARLY_CODE,
    reason,
    earliestAt,
    message: RETEST_SUBMIT_TOO_EARLY_MESSAGE,
  };
}

/** Thrown so API `mapDomainError` maps `code: VALIDATION` → 400 with Chinese message. */
export class RetestSubmitTooEarlyError extends Error {
  readonly code = "VALIDATION" as const;
  readonly businessCode = RETEST_SUBMIT_TOO_EARLY_CODE;
  readonly reason: RetestSubmitTooEarlyResult["reason"];
  readonly earliestAt: string;

  constructor(result: RetestSubmitTooEarlyResult) {
    super(result.message);
    this.name = "RetestSubmitTooEarlyError";
    this.reason = result.reason;
    this.earliestAt = result.earliestAt;
  }
}

export function assertRetestSubmitEarliestAllowed(
  times: RetestSubmitEarliestTimes,
  now: Date | string = new Date(),
): void {
  const early = retestSubmitTooEarly(times, now);
  if (early) throw new RetestSubmitTooEarlyError(early);
}
