import type { JobStatusResponse, TurnRecord } from "@aistudy/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UnknownTurnNotice } from "./unknown-turn-notice";
import { UNKNOWN_TURN_RETRY_DELAY_MS, sameUnknownJob, turnsWithKnownOutcome, unknownTurnQuestion, unknownTurnRecovery } from "./unknown-turn-recovery";

const now = Date.parse("2026-10-15T00:00:00.000Z");
const job: JobStatusResponse = {
  id: "33333333-3333-4333-8333-333333333333", status: "outcome_unknown",
  error: { message: "provider outcome unknown; usage reconciliation pending" }, updatedAt: new Date(now).toISOString(),
};
function turn(role: TurnRecord["role"], status: TurnRecord["status"]): TurnRecord {
  return { id: role, conversationId: "conversation", role, status, text: role === "user" ? "解释导数" : "unknown", citations: [], createdAt: new Date(now - 300_000).toISOString(), mode: "hint" };
}

describe("unknown turn recovery", () => {
  it("opens a manual retry at the exact window boundary without rewriting the original outcome", () => {
    const snapshot = structuredClone(job);
    expect(unknownTurnRecovery(job, now + UNKNOWN_TURN_RETRY_DELAY_MS - 1)?.canRetry).toBe(false);
    expect(unknownTurnRecovery(job, now + UNKNOWN_TURN_RETRY_DELAY_MS)?.canRetry).toBe(true);
    expect(job).toEqual(snapshot);
  });

  it("restores the same deadline from the server timestamp after reload, not the old request creation time", () => {
    const restored = structuredClone(job);
    expect(unknownTurnRecovery(restored, now + 20_000)).toEqual({ readyAt: now + UNKNOWN_TURN_RETRY_DELAY_MS, canRetry: false });
    expect(unknownTurnRecovery(restored, now + 120_000)?.canRetry).toBe(true);
  });

  it.each(["queued", "running", "failed", "cancelled", "succeeded"] as const)("does not offer unknown recovery for %s", status => {
    expect(unknownTurnRecovery({ ...job, status }, now + 120_000)).toBeNull();
  });

  it("recovers only the paired user question and original mode", () => {
    expect(unknownTurnQuestion([turn("user", "complete"), turn("assistant", "outcome_unknown")])).toEqual({ text: "解释导数", mode: "hint" });
  });

  it.each(["pending", "complete", "failed", "clarify"] as const)("does not reuse an older unknown when the latest assistant is %s", status => {
    expect(unknownTurnQuestion([turn("user", "complete"), turn("assistant", "outcome_unknown"), turn("user", "complete"), turn("assistant", status)])).toBeNull();
  });

  it("does not invent a question when its user turn is unavailable", () => {
    expect(unknownTurnQuestion([])).toBeNull();
    expect(unknownTurnQuestion([turn("assistant", "outcome_unknown")])).toBeNull();
  });

  it("requires the same unknown job around the turn read instead of mixing different rounds", () => {
    expect(sameUnknownJob(job, structuredClone(job))).toBe(true);
    expect(sameUnknownJob(job, null)).toBe(false);
    expect(sameUnknownJob(job, { ...job, id: "another-job" })).toBe(false);
    expect(sameUnknownJob(job, { ...job, status: "succeeded" })).toBe(false);
    expect(sameUnknownJob(job, { ...job, updatedAt: new Date(now + 1).toISOString() })).toBe(false);
  });

  it("recovers a legacy pending placeholder only when the latest server job confirms an unknown outcome", () => {
    const turns = [turn("user", "complete"), turn("assistant", "pending")];
    expect(unknownTurnQuestion(turnsWithKnownOutcome(turns, job))).toEqual({ text: "解释导数", mode: "hint" });
    expect(turns.at(-1)?.status).toBe("pending");
    expect(turnsWithKnownOutcome(turns, { ...job, status: "running" })).toBe(turns);
    const completed = [turn("user", "complete"), turn("assistant", "complete")];
    expect(turnsWithKnownOutcome(completed, job)).toBe(completed);
  });

  it("keeps the unknown outcome and extra charge warning visible after the retry becomes available", () => {
    const html = renderToStaticMarkup(createElement(UnknownTurnNotice, { job, canRetry: true, disabled: false, onRetry: () => undefined }));
    expect(html).toContain("还不确定这次是否答完");
    expect(html).toContain("可能产生额外费用");
    expect(html).toContain("会把问题放回输入框");
    expect(html).not.toContain('disabled=""');
  });
});
