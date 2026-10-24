import { afterEach, describe, expect, it, vi } from "vitest";
import { createParserHealthLease } from "./parser-health-lease";

const ready = { status: "ready" as const, directoryConfigured: true, directoryExists: true, missingFiles: [], inferenceMs: 1 };
afterEach(() => vi.useRealTimers());
function setup(refresh: (signal: AbortSignal) => Promise<typeof ready> = vi.fn(async () => ready)) {
  vi.useFakeTimers();
  let clock = 0;
  const unavailable = vi.fn(), available = vi.fn();
  const lease = createParserHealthLease({ reportedAt: 0, ttlMs: 1000, renewalTimeoutMs: 2000,
    now: () => clock, refresh, onUnavailable: unavailable, onAvailable: available });
  return { lease, refresh, unavailable, available, setClock(value: number) { clock = value; } };
}
describe("recoverable parser report consumer lease", () => {
  it("tolerates one/two failures only while the old report is current, pauses at three and resumes after success", async () => {
    const refresh = vi.fn().mockRejectedValueOnce(new Error("one")).mockRejectedValueOnce(new Error("two"))
      .mockRejectedValueOnce(new Error("three")).mockResolvedValue(ready);
    const f = setup(refresh);
    for (const error of ["one", "two"]) {
      await expect(f.lease.renew()).rejects.toThrow(error);
      f.lease.assertCurrent();
      expect(f.unavailable).not.toHaveBeenCalled();
    }
    await expect(f.lease.renew()).rejects.toThrow("three");
    expect(() => f.lease.assertCurrent()).toThrow(/no current/);
    expect(f.unavailable).toHaveBeenCalledTimes(1);
    f.setClock(500); await f.lease.renew();
    f.lease.assertCurrent(); expect(f.available).toHaveBeenCalledTimes(1);
    await f.lease.renew(); expect(f.available).toHaveBeenCalledTimes(1);
    f.lease.stop();
  });
  it("resets the consecutive failure count after a successful renewal", async () => {
    const refresh = vi.fn().mockRejectedValueOnce(new Error("one")).mockResolvedValueOnce(ready)
      .mockRejectedValue(new Error("later"));
    const f = setup(refresh);
    await expect(f.lease.renew()).rejects.toThrow(); await f.lease.renew();
    await expect(f.lease.renew()).rejects.toThrow(); await expect(f.lease.renew()).rejects.toThrow();
    f.lease.assertCurrent(); expect(f.unavailable).not.toHaveBeenCalled(); f.lease.stop();
  });
  it("expires by TTL without waiting for three failures and recovers using a newly written report", async () => {
    const f = setup(); f.setClock(1000); await vi.advanceTimersByTimeAsync(1000);
    expect(f.lease.isCurrent()).toBe(false); expect(f.unavailable).toHaveBeenCalledTimes(1);
    await f.lease.renew(); f.lease.assertCurrent(); expect(f.available).toHaveBeenCalledOnce();
    f.lease.stop();
  });
  it("checks expiry synchronously after event-loop suspension", () => {
    const f = setup(); f.setClock(1001);
    expect(() => f.lease.assertCurrent()).toThrow(); expect(f.unavailable).toHaveBeenCalledOnce(); f.lease.stop();
  });
  it("allows a hung renewal to finish after TTL only if its own conservative report is still fresh", async () => {
    let resolve!: (value: typeof ready) => void;
    const f = setup(() => new Promise(done => { resolve = done; }));
    f.setClock(500); const pending = f.lease.renew(); await Promise.resolve();
    f.setClock(1001); await vi.advanceTimersByTimeAsync(1000);
    expect(f.lease.isCurrent()).toBe(false);
    resolve(ready); await pending;
    f.lease.assertCurrent(); expect(f.available).toHaveBeenCalledOnce(); f.lease.stop();
  });
  it("bounds hung renewal, aborts it, observes late success, then permits a separate recovery", async () => {
    let resolve!: (value: typeof ready) => void;
    let signal!: AbortSignal;
    const refresh = vi.fn().mockImplementationOnce((input: AbortSignal) => {
      signal = input; return new Promise(done => { resolve = done; });
    }).mockResolvedValue(ready);
    const f = setup(refresh);
    const pending = f.lease.renew(); const rejected = expect(pending).rejects.toThrow(/timed out/);
    expect(f.lease.renew()).toBe(pending);
    f.setClock(2000); await vi.advanceTimersByTimeAsync(2000); await rejected;
    expect(signal.aborted).toBe(true); resolve(ready); await Promise.resolve();
    expect(f.lease.isCurrent()).toBe(false); expect(f.available).not.toHaveBeenCalled();
    await f.lease.renew(); f.lease.assertCurrent(); f.lease.stop();
  });
  it("does not admit an already expired late report", async () => {
    let resolve!: (value: typeof ready) => void;
    const f = setup(() => new Promise(done => { resolve = done; }));
    const pending = f.lease.renew(); const rejected = expect(pending).rejects.toThrow(/already expired/);
    await Promise.resolve(); f.setClock(1001); resolve(ready); await rejected;
    expect(f.lease.isCurrent()).toBe(false); f.lease.stop();
  });
  it("counts measured OCR failure even when the database report write succeeded", async () => {
    const f = setup(vi.fn().mockResolvedValue({ ...ready, status: "preflight_failed", inferenceMs: null }));
    for (let i = 0; i < 3; i++) await expect(f.lease.renew()).rejects.toThrow(/preflight failed/);
    expect(f.unavailable).toHaveBeenCalledOnce(); f.lease.stop();
  });
  it("shutdown aborts a hung refresh, clears all timers and cannot resume on late completion", async () => {
    let resolve!: (value: typeof ready) => void;
    const f = setup(() => new Promise(done => { resolve = done; }));
    const pending = f.lease.renew(); const rejected = expect(pending).rejects.toThrow(/stopped/);
    await Promise.resolve(); f.lease.stop(); await rejected;
    resolve(ready); await Promise.resolve();
    expect(f.unavailable).not.toHaveBeenCalled(); expect(f.available).not.toHaveBeenCalled();
    expect(() => f.lease.assertCurrent()).toThrow(); expect(vi.getTimerCount()).toBe(0);
    await expect(f.lease.renew()).rejects.toThrow(/stopped/);
  });
});
