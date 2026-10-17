import type { MeasurementAttempt, MeasurementOverview } from "@aistudy/contracts";
import { describe, expect, it } from "vitest";
import { activeMeasurementAttempt, actualDelay, measurementCanContinue } from "./measurement-model";

function overview(attempts: Partial<MeasurementAttempt>[] = [], nextDueAt: string | null = null): MeasurementOverview {
  return { trial: { status: "active", practiceCompletedAt: "2026-10-16T10:00:00Z" }, attempts, nextDueAt } as MeasurementOverview;
}

describe("measurement progress and timing", () => {
  it("continues after a submitted delayed answer whose outcome is concealed", () => {
    const state = overview([{ answeredAt: "2026-10-18T12:00:00Z", outcome: null, retractedAt: null, feedbackWithheld: true }]);
    expect(activeMeasurementAttempt(state)).toBeNull();
    expect(measurementCanContinue(state, Date.parse("2026-10-18T12:00:01Z"))).toBe(true);
  });
  it("resumes the same unanswered attempt and blocks early probes and paused trials", () => {
    const state = overview([{ id: "pending", answeredAt: null, retractedAt: null }]);
    expect(activeMeasurementAttempt(state)?.id).toBe("pending");
    expect(measurementCanContinue(state, Date.now())).toBe(false);
    const due = overview([], "2026-10-18T10:00:00Z");
    expect(measurementCanContinue(due, Date.parse("2026-10-18T09:59:59Z"))).toBe(false);
    expect(measurementCanContinue(due, Date.parse("2026-10-18T10:00:00Z"))).toBe(true);
    due.trial!.status = "paused";
    expect(measurementCanContinue(due, Date.parse("2026-10-19T10:00:00Z"))).toBe(false);
  });
  it("shows the actual late return interval rather than calling it exactly 48 hours", () => {
    const attempt = { item: { phase: "delay_48h" }, answeredAt: "2026-10-19T11:30:00Z", presentedAt: "2026-10-19T11:00:00Z" } as MeasurementAttempt;
    expect(actualDelay(attempt, overview())).toBe("73.5 小时");
    attempt.item.phase = "practice";
    expect(actualDelay(attempt, overview())).toBeNull();
  });
});
