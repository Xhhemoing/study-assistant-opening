import { afterEach, describe, expect, it, vi } from "vitest";
import { createParserHealthLease } from "./parser-health-lease";

const ready = { status: "ready" as const, directoryConfigured: true, directoryExists: true, missingFiles: [], inferenceMs: 1 };
afterEach(() => vi.useRealTimers());
function setup(refresh = vi.fn(async () => ready)) {
  vi.useFakeTimers();
  let clock = 0;
  const unavailable = vi.fn();
  const lease = createParserHealthLease({ reportedAt: 0, ttlMs: 1000, now: () => clock, refresh, onUnavailable: unavailable });
  return { lease, refresh, unavailable, setClock(value: number) { clock = value; } };
}
describe("parser report consumer lease", () => {
  it("requires a fresh successful report before consumption and renews conservatively", async () => {
    const f = setup();
    f.lease.assertCurrent();
    f.setClock(500); await vi.advanceTimersByTimeAsync(500);
    await f.lease.renew();
    f.setClock(1000); await vi.advanceTimersByTimeAsync(500);
    expect(f.unavailable).not.toHaveBeenCalled(); f.lease.assertCurrent();
    f.setClock(1500); await vi.advanceTimersByTimeAsync(500);
    expect(f.unavailable).toHaveBeenCalledTimes(1);
    expect(() => f.lease.assertCurrent()).toThrow(/no current/);
    f.lease.stop();
  });
  it("fails closed immediately on a failed renewal, before its database report expires", async () => {
    const f = setup(vi.fn().mockRejectedValue(new Error("database unavailable")));
    await expect(f.lease.renew()).rejects.toThrow("database unavailable");
    expect(() => f.lease.assertCurrent()).toThrow();
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.unavailable).toHaveBeenCalledTimes(1);
  });
  it("does not rely on timers to detect expiry after event-loop suspension", () => {
    const f = setup(); f.setClock(1001);
    expect(() => f.lease.assertCurrent()).toThrow();
    expect(f.unavailable).toHaveBeenCalledTimes(1);
  });
  it("expires a hung probe and never revives on its late success", async () => {
    let resolve!: (value: typeof ready) => void;
    const f = setup(vi.fn(() => new Promise<typeof ready>(done => { resolve = done; })));
    const renewing = f.lease.renew();
    const rejected = expect(renewing).rejects.toThrow();
    f.setClock(1001); await vi.advanceTimersByTimeAsync(1001);
    expect(f.unavailable).toHaveBeenCalledTimes(1);
    await rejected;
    resolve(ready); await Promise.resolve();
    expect(() => f.lease.assertCurrent()).toThrow();
  });
  it("stops consumption when the probe now fails even if writing its report succeeded", async () => {
    const f = setup(vi.fn().mockResolvedValue({ ...ready, status: "preflight_failed", inferenceMs: null }));
    await expect(f.lease.renew()).rejects.toThrow(/preflight failed/);
    expect(f.unavailable).toHaveBeenCalledTimes(1);
  });
  it("normal shutdown clears timers and cannot restart the consumer", async () => {
    const f = setup(); f.lease.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.unavailable).not.toHaveBeenCalled();
    expect(() => f.lease.assertCurrent()).toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("shutdown drains a hung renewal without waiting for the abandoned probe", async () => {
    const f = setup(vi.fn(() => new Promise<typeof ready>(() => {})));
    const renewing = f.lease.renew();
    const rejected = expect(renewing).rejects.toThrow(/stopped/);
    await Promise.resolve(); f.lease.stop();
    await rejected;
    expect(f.unavailable).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
