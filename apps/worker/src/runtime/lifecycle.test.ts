import { afterEach, describe, expect, it, vi } from "vitest";
import { createSerialTask, withJobHeartbeat } from "./lifecycle";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => { vi.useRealTimers(); });

describe("worker background lifecycle", () => {
  it("shares an active tick and drains it before stopping", async () => {
    const gate = deferred();
    const work = vi.fn(() => gate.promise);
    const task = createSerialTask(work, vi.fn());
    const first = task.run();
    expect(task.run()).toBe(first);
    await Promise.resolve();
    expect(work).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stopping = task.stop().then(() => { stopped = true; });
    await task.run();
    expect(stopped).toBe(false);
    gate.resolve();
    await stopping;
    await task.run();
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("handles an operational failure and allows the next tick", async () => {
    const failure = new Error("Redis disconnected");
    const error = vi.fn();
    const task = createSerialTask(vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined), error);
    await task.run();
    expect(error).toHaveBeenCalledWith(failure);
    await expect(task.run()).resolves.toBeUndefined();
    await task.stop();
  });

  it("heartbeats long work and clears its timer on failure", async () => {
    vi.useFakeTimers();
    const gate = deferred();
    const heartbeat = vi.fn(async () => true);
    const run = withJobHeartbeat(heartbeat, () => gate.promise.then(() => { throw new Error("parser interrupted"); }));
    const rejected = expect(run).rejects.toThrow("parser interrupted");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(heartbeat).toHaveBeenCalledTimes(2);
    gate.resolve();
    await rejected;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(heartbeat).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
