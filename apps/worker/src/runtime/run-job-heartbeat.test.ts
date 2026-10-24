import { afterEach, describe, expect, it, vi } from "vitest";
import { BudgetReplayError } from "@aistudy/ai";
import type { OpeningJobRecord } from "@aistudy/database";
import { runJob, type JobRepository } from "./run-job";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function setup() {
  const job: OpeningJobRecord = { id: "job", workspaceId: "ws", ownerUserId: "owner", key: "grade:1",
    kind: "grade-observation", payload: {}, result: null, state: "running", privacyEpoch: 0, claimToken: "first" };
  let state = "queued", token = "first", updatedAt = Date.now();
  const heartbeat = vi.fn(async (id: string, claimToken: string, scope: { workspaceId: string; ownerUserId: string }) => {
    if (id !== job.id || claimToken !== token || state !== "running"
      || scope.workspaceId !== job.workspaceId || scope.ownerUserId !== job.ownerUserId) return false;
    updatedAt = Date.now();
    return true;
  });
  const repository: JobRepository = {
    claim: vi.fn(async () => {
      if (state !== "queued") return null;
      state = "running";
      return { ...job };
    }),
    heartbeat,
    finish: vi.fn(async (_id, next, _value, claimToken) => {
      if (state !== "running" || claimToken !== token) return false;
      state = next;
      return true;
    }),
  };
  return { repository, heartbeat, state: () => state,
    cancel: () => { state = "cancelled"; }, changeToken: () => { token = "second"; },
    recoverExpired: () => { if (state === "running" && updatedAt < Date.now() - 300_000) state = "outcome_unknown"; } };
}

afterEach(() => { vi.useRealTimers(); });

describe("grade-observation runtime heartbeat", () => {
  it("keeps a six-minute handler alive through recovery sweeps and stops after success", async () => {
    vi.useFakeTimers();
    const f = setup(), gate = deferred(), handler = vi.fn(() => gate.promise);
    const running = runJob(f.repository, "job", handler);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(f.heartbeat).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    for (let minute = 1; minute <= 6; minute += 1) {
      if (minute > 1) await vi.advanceTimersByTimeAsync(60_000);
      f.recoverExpired();
      expect(f.state()).toBe("running");
    }
    expect(f.heartbeat).toHaveBeenCalledTimes(6);
    gate.resolve();
    expect(await running).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.heartbeat).toHaveBeenCalledTimes(6);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["cancel", "changeToken"] as const)("stops scheduling when %s invalidates the claim", async action => {
    vi.useFakeTimers();
    const f = setup(), gate = deferred();
    const running = runJob(f.repository, "job", () => gate.promise);
    await vi.advanceTimersByTimeAsync(60_000);
    f[action]();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.heartbeat).toHaveBeenLastCalledWith("job", "first", expect.objectContaining({ workspaceId: "ws", ownerUserId: "owner" }));
    expect(await f.heartbeat.mock.results[1]!.value).toBe(false);
    await vi.advanceTimersByTimeAsync(360_000);
    expect(f.heartbeat).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    gate.resolve();
    expect(await running).toBe(false);
  });

  it.each(["failed", "unknown", "in_flight"] as const)("cleans up after %s without dispatching again", async outcome => {
    vi.useFakeTimers();
    const f = setup(), gate = deferred();
    const handler = vi.fn(async () => {
      await gate.promise;
      if (outcome === "failed") throw new Error("grading failed");
      throw new BudgetReplayError(outcome === "unknown"
        ? { kind: "unknown", reservationId: "r", pendingReconcileCents: 1, reconciled: false }
        : { kind: "in_flight", reservationId: "r" });
    });
    const running = runJob(f.repository, "job", handler);
    await vi.advanceTimersByTimeAsync(60_000);
    gate.resolve();
    expect(await running).toBe(true);
    expect(f.state()).toBe(outcome === "failed" ? "failed" : "outcome_unknown");
    await vi.advanceTimersByTimeAsync(360_000);
    expect(f.heartbeat).toHaveBeenCalledTimes(1);
    expect(await runJob(f.repository, "job", handler)).toBe(false);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never overlaps heartbeats and drains a late heartbeat after handler completion", async () => {
    vi.useFakeTimers();
    const f = setup(), gate = deferred(), tick = deferred();
    f.heartbeat.mockImplementationOnce(async () => { await tick.promise; return false; });
    const running = runJob(f.repository, "job", () => gate.promise);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(f.heartbeat).toHaveBeenCalledTimes(1);
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.state()).toBe("succeeded");
    expect(vi.getTimerCount()).toBe(0);
    tick.resolve();
    expect(await running).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.heartbeat).toHaveBeenCalledTimes(1);
  });
});
