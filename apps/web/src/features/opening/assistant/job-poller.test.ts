import { afterEach, describe, expect, it, vi } from "vitest";
import { createJobPoller } from "./job-poller";

const job = { id: "job-1", status: "running" as const, error: null, updatedAt: "2026-10-17T12:00:00.000Z" };
class Visibility extends EventTarget {
  hidden = false;
  show(hidden: boolean) { this.hidden = hidden; this.dispatchEvent(new Event("visibilitychange")); }
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

describe("job poller recovery and visibility", () => {
  afterEach(() => vi.useRealTimers());

  it("backs off errors to the cap and resets the interval after a successful read", async () => {
    vi.useFakeTimers();
    const getJob = vi.fn().mockRejectedValue(new Error("offline"));
    const onError = vi.fn();
    const poller = createJobPoller({ getJob, onStatus: vi.fn(), onError, intervalMs: 100, maxRetryMs: 500 });
    poller.start();
    await flush();
    for (const [delay, calls] of [[200, 2], [400, 3], [500, 4]] as const) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(getJob).toHaveBeenCalledTimes(calls - 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(getJob).toHaveBeenCalledTimes(calls);
    }
    getJob.mockResolvedValue(job);
    await vi.advanceTimersByTimeAsync(500);
    expect(getJob).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(100);
    expect(getJob).toHaveBeenCalledTimes(6);
    expect(onError).toHaveBeenCalledTimes(4);
    poller.cancel();
  });

  it("does not poll a hidden tab and resumes immediately when it becomes visible", async () => {
    vi.useFakeTimers();
    const visibility = new Visibility();
    visibility.hidden = true;
    const getJob = vi.fn(async () => job);
    const poller = createJobPoller({ getJob, onStatus: vi.fn(), visibility, intervalMs: 100 });
    poller.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getJob).not.toHaveBeenCalled();
    visibility.show(false);
    await flush();
    expect(getJob).toHaveBeenCalledOnce();
    visibility.show(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getJob).toHaveBeenCalledOnce();
    visibility.show(false);
    await flush();
    expect(getJob).toHaveBeenCalledTimes(2);
    poller.cancel();
    visibility.show(false);
    expect(getJob).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts and ignores a late hidden-tab response without reporting an error", async () => {
    vi.useFakeTimers();
    const visibility = new Visibility();
    let resolve!: (value: typeof job) => void;
    const getJob = vi.fn((_signal: AbortSignal) => new Promise<typeof job>(done => { resolve = done; }));
    const onStatus = vi.fn();
    const onError = vi.fn();
    const poller = createJobPoller({ getJob, onStatus, onError, visibility });
    poller.start();
    visibility.show(true);
    expect(getJob.mock.calls[0]?.[0].aborted).toBe(true);
    resolve(job);
    await flush();
    expect(onStatus).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    poller.cancel();
  });

  it("retries a terminal job when restoring its conversation fails", async () => {
    vi.useFakeTimers();
    const getJob = vi.fn(async () => ({ ...job, status: "succeeded" as const }));
    const onStatus = vi.fn().mockRejectedValueOnce(new Error("history unavailable")).mockResolvedValueOnce(undefined);
    const poller = createJobPoller({ getJob, onStatus, intervalMs: 100 });
    poller.start();
    await flush();
    await vi.advanceTimersByTimeAsync(200);
    expect(onStatus).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
