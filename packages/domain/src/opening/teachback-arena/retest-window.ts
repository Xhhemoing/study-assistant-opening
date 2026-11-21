import type { RetestActivity } from "@aistudy/contracts";
import type { RetestEvidenceIdentity } from "../learning-summary";

export type TeachbackTarget = Pick<RetestEvidenceIdentity, "courseId"> & (
  | { conceptId: string; requirementKey?: string | null }
  | { requirementKey: string; conceptId?: string | null }
);

/** Authoritative delayed retests for the current learner/workspace, including the waiting interval. */
export type TeachbackRetestWindow = Pick<RetestActivity, "courseId" | "requirementKey" | "status"> & {
  conceptId?: string | null;
  times: Pick<RetestActivity["times"], "deadlineAt">;
};

export type TeachbackWindowSnapshot = { now: Date; windows: readonly TeachbackRetestWindow[] };

export class ActiveRetestWindowConflict extends Error {
  readonly code = "ACTIVE_RETEST_WINDOW_CONFLICT";
  readonly httpStatus = 409;

  /** Seconds until retry. An open-ended retest requires a fresh lifecycle read after closure. */
  constructor(readonly retryAfter: number | null) {
    super("当前学习目标有尚未结束的延迟复测，请在复测结束后再进行讲解练习。");
    this.name = "ActiveRetestWindowConflict";
  }
}

export function checkTeachbackRetestConflict(target: TeachbackTarget, snapshot: TeachbackWindowSnapshot): ActiveRetestWindowConflict | null {
  const now = snapshot.now.getTime();
  if (!Number.isFinite(now)) throw new RangeError("Invalid teachback evaluation time");
  let latestDeadline = -Infinity;
  for (const window of snapshot.windows) {
    if (window.status !== "accepted" && window.status !== "in_progress") continue;
    if (window.courseId && window.courseId !== target.courseId) continue;
    // Different requirements can test the same concept. Both concepts must be
    // known to establish separation, and a shared requirement still protects both.
    const distinctConcepts = window.conceptId && target.conceptId && window.conceptId !== target.conceptId;
    const sharedRequirement = window.requirementKey && window.requirementKey === target.requirementKey;
    if (distinctConcepts && !sharedRequirement) continue;
    const end = window.times.deadlineAt === null ? Infinity : Date.parse(window.times.deadlineAt);
    if (Number.isNaN(end)) throw new RangeError("Invalid delayed retest deadline");
    if (end >= now) latestDeadline = Math.max(latestDeadline, end);
  }
  if (latestDeadline === -Infinity) return null;
  // The deadline itself is still a valid retest instant.
  return new ActiveRetestWindowConflict(latestDeadline === Infinity ? null : Math.ceil((latestDeadline - now + 1) / 1000));
}

export function assertTeachbackWindowClear(target: TeachbackTarget, snapshot: TeachbackWindowSnapshot): void {
  const conflict = checkTeachbackRetestConflict(target, snapshot);
  if (conflict) throw conflict;
}
