import { describe, expect, it } from "vitest";
import { retestActivitySchema, type RetestActivity } from "@aistudy/contracts";
import {
  assertRetestSubmitEarliestAllowed,
  isRetestActivityDue,
  reopenRetestActivity,
  retestSubmitTooEarly,
  RetestSubmitTooEarlyError,
  RETEST_SUBMIT_TOO_EARLY_CODE,
  RETEST_SUBMIT_TOO_EARLY_MESSAGE,
  transitionRetestActivity,
} from "./retest-activity";

const activityId = "11111111-1111-4111-8111-111111111111";
const cycleId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const candidateId = "44444444-4444-4444-8444-444444444444";
const base: RetestActivity = {
  activityId,
  cycleId,
  courseId: "55555555-5555-4555-8555-555555555555",
  skillLabel: "fractions",
  requirementKey: "algebra",
  purpose: "retest",
  status: "accepted",
  result: null,
  taskId,
  candidateId,
  version: 1,
  snoozedUntil: null,
  reason: null,
  reopenedFromActivityId: null,
  times: {
    proposedAt: "2026-09-13T10:00:00.000Z",
    acceptedAt: "2026-09-13T10:05:00.000Z",
    startedAt: null,
    completedAt: null,
    declinedAt: null,
    cancelledAt: null,
    invalidatedAt: null,
    supersededAt: null,
    notBeforeAt: null,
    recommendedAt: "2026-09-15T10:00:00.000Z",
    scheduledStartAt: null,
    deadlineAt: null,
  },
};

describe("retest activity contract", () => {
  it("accepts the full lifecycle record shape", () => {
    expect(retestActivitySchema.parse(base)).toEqual(base);
  });
});

describe("transitionRetestActivity", () => {
  it("accepts a proposed activity and attaches its task", () => {
    const proposed: RetestActivity = { ...base, status: "proposed", taskId: null, times: { ...base.times, acceptedAt: null } };
    const accepted = transitionRetestActivity(proposed, {
      type: "accept",
      at: "2026-09-14T10:00:00.000Z",
      taskId,
    });
    expect(accepted).toMatchObject({ status: "accepted", taskId, version: 2 });
  });

  it("moves accepted to in_progress and completed with an observed result", () => {
    const started = transitionRetestActivity(base, {
      type: "start",
      at: "2026-09-15T10:01:00.000Z",
    });
    const completed = transitionRetestActivity(started, {
      type: "complete",
      at: "2026-09-15T10:08:00.000Z",
      result: "correct",
      hasObservation: true,
    });
    expect(started.status).toBe("in_progress");
    expect(completed).toMatchObject({
      status: "completed",
      result: "correct",
      version: 3,
    });
    expect(completed.times.completedAt).toBe("2026-09-15T10:08:00.000Z");
  });

  it("records done without an observation as unverified", () => {
    const completed = transitionRetestActivity(base, {
      type: "complete",
      at: "2026-09-15T10:08:00.000Z",
      result: "correct",
      hasObservation: false,
    });
    expect(completed.status).toBe("completed");
    expect(completed.result).toBe("unverified");
  });

  it.each([
    ["decline", "declined"],
    ["cancel", "cancelled"],
    ["invalidate", "invalidated"],
    ["supersede", "superseded"],
  ] as const)("supports %s into the %s terminal state", (type, status) => {
    const next = transitionRetestActivity(base, {
      type,
      at: "2026-09-15T10:08:00.000Z",
      reason: "user decision",
    });
    expect(next.status).toBe(status);
  });

  it("maps skip to cancellation and preserves a reason", () => {
    const next = transitionRetestActivity(base, {
      type: "skip",
      at: "2026-09-15T10:08:00.000Z",
    });
    expect(next).toMatchObject({ status: "cancelled", reason: "user_skipped" });
  });

  it("snoozes without changing status and suppresses due until the snooze ends", () => {
    const snoozed = transitionRetestActivity(base, {
      type: "snooze",
      until: "2026-09-16T10:00:00.000Z",
    });
    expect(snoozed).toMatchObject({ status: "accepted", snoozedUntil: "2026-09-16T10:00:00.000Z", version: 2 });
    expect(isRetestActivityDue(snoozed, "2026-09-15T12:00:00.000Z")).toBe(false);
    expect(isRetestActivityDue(snoozed, "2026-09-16T10:00:00.000Z")).toBe(true);
  });

  it("does not mark a future activity due or terminal activity due", () => {
    expect(isRetestActivityDue(base, "2026-09-14T10:00:00.000Z")).toBe(false);
    const completed = transitionRetestActivity(base, {
      type: "complete",
      at: "2026-09-15T10:08:00.000Z",
      hasObservation: false,
    });
    expect(isRetestActivityDue(completed, "2026-09-20T10:00:00.000Z")).toBe(false);
  });

  it("reopens a terminal activity as a new evidence cycle", () => {
    const completed = transitionRetestActivity(base, {
      type: "complete",
      at: "2026-09-15T10:08:00.000Z",
      result: "incorrect",
      hasObservation: true,
    });
    const reopened = reopenRetestActivity(completed, {
      activityId: "55555555-5555-4555-8555-555555555555",
      cycleId: "66666666-6666-4666-8666-666666666666",
      proposedAt: "2026-09-20T10:00:00.000Z",
    });
    expect(reopened).toMatchObject({
      status: "proposed",
      result: null,
      version: 1,
      taskId: null,
      candidateId: null,
      reopenedFromActivityId: activityId,
      courseId: base.courseId,
      skillLabel: base.skillLabel,
      requirementKey: base.requirementKey,
    });
    expect(reopened.cycleId).not.toBe(completed.cycleId);
    expect(reopened.times.recommendedAt).toBe(base.times.recommendedAt);
    expect(completed.status).toBe("completed");
  });
});

describe("retestSubmitTooEarly / assertRetestSubmitEarliestAllowed", () => {
  const now = "2026-09-15T12:00:00.000Z";

  it("allows submit when no earliest floors are set", () => {
    expect(retestSubmitTooEarly({}, now)).toBeNull();
    expect(retestSubmitTooEarly({ notBeforeAt: null, recommendedAt: null, scheduledStartAt: null }, now)).toBeNull();
    expect(() => assertRetestSubmitEarliestAllowed({}, now)).not.toThrow();
  });

  it("rejects when recommendedAt is still in the future", () => {
    const early = retestSubmitTooEarly({ recommendedAt: "2026-09-15T16:00:00.000Z" }, now);
    expect(early).toEqual({
      code: RETEST_SUBMIT_TOO_EARLY_CODE,
      reason: "scheduled_or_recommended",
      earliestAt: "2026-09-15T16:00:00.000Z",
      message: RETEST_SUBMIT_TOO_EARLY_MESSAGE,
    });
  });

  it("prefers scheduledStartAt over recommendedAt as the due target", () => {
    const early = retestSubmitTooEarly(
      {
        recommendedAt: "2026-09-15T10:00:00.000Z",
        scheduledStartAt: "2026-09-15T18:00:00.000Z",
      },
      now,
    );
    expect(early?.earliestAt).toBe("2026-09-15T18:00:00.000Z");
    expect(early?.reason).toBe("scheduled_or_recommended");
  });

  it("rejects on notBeforeAt even when recommendedAt is already past", () => {
    const early = retestSubmitTooEarly(
      {
        recommendedAt: "2026-09-14T10:00:00.000Z",
        notBeforeAt: "2026-09-15T16:00:00.000Z",
      },
      now,
    );
    expect(early).toMatchObject({
      reason: "not_before",
      earliestAt: "2026-09-15T16:00:00.000Z",
    });
  });

  it("uses the later of notBeforeAt and due target as effective earliest", () => {
    const early = retestSubmitTooEarly(
      {
        notBeforeAt: "2026-09-15T14:00:00.000Z",
        recommendedAt: "2026-09-15T16:00:00.000Z",
      },
      now,
    );
    expect(early?.earliestAt).toBe("2026-09-15T16:00:00.000Z");
    expect(early?.reason).toBe("scheduled_or_recommended");
  });

  it("allows submit once now reaches the earliest floor", () => {
    expect(
      retestSubmitTooEarly(
        { recommendedAt: "2026-09-15T12:00:00.000Z", notBeforeAt: "2026-09-15T11:00:00.000Z" },
        now,
      ),
    ).toBeNull();
  });

  it("assert throws RetestSubmitTooEarlyError with VALIDATION code and Chinese message", () => {
    expect(() =>
      assertRetestSubmitEarliestAllowed({ recommendedAt: "2026-09-20T10:00:00.000Z" }, now),
    ).toThrow(RetestSubmitTooEarlyError);
    try {
      assertRetestSubmitEarliestAllowed({ recommendedAt: "2026-09-20T10:00:00.000Z" }, now);
    } catch (error) {
      expect(error).toBeInstanceOf(RetestSubmitTooEarlyError);
      expect((error as RetestSubmitTooEarlyError).code).toBe("VALIDATION");
      expect((error as RetestSubmitTooEarlyError).businessCode).toBe(RETEST_SUBMIT_TOO_EARLY_CODE);
      expect((error as RetestSubmitTooEarlyError).message).toBe(RETEST_SUBMIT_TOO_EARLY_MESSAGE);
    }
  });
});
