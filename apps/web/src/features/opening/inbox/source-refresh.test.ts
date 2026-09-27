import { afterEach, describe, expect, it, vi } from "vitest";
import { shouldRefreshSources, startSourceRefresh } from "./source-refresh";

afterEach(() => { vi.useRealTimers(); });
describe("source processing refresh", () => {
  it("refreshes uploaded processing sources until a terminal parse state is visible", () => {
    for (const parseState of ["not_started", "queued", "running"] as const) {
      expect(shouldRefreshSources([{ uploadState: "uploaded", parseState }])).toBe(true);
    }
    for (const parseState of ["ready", "failed", "unsupported"] as const) {
      expect(shouldRefreshSources([{ uploadState: "uploaded", parseState }])).toBe(false);
    }
    expect(shouldRefreshSources([{ uploadState: "pending", parseState: "not_started" }])).toBe(false);
  });
  it("refreshes serially and stops after disposal", async () => {
    vi.useFakeTimers();
    let reads = 0;
    const stop = startSourceRefresh({ refresh: async () => { reads++; }, onError: () => {}, intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(300);
    expect(reads).toBe(3);
    stop();
    await vi.advanceTimersByTimeAsync(300);
    expect(reads).toBe(3);
  });
  it("does not overlap a slow request or schedule more reads after disposal", async () => {
    vi.useFakeTimers();
    let reads = 0;
    let complete!: () => void;
    const pending = new Promise<void>((resolve) => { complete = resolve; });
    const stop = startSourceRefresh({ refresh: async () => { reads++; await pending; }, onError: () => {}, intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(reads).toBe(1);
    stop(); complete();
    await vi.advanceTimersByTimeAsync(1000);
    expect(reads).toBe(1);
  });
  it("reports a read failure and can recover on the next scheduled read", async () => {
    vi.useFakeTimers();
    let reads = 0;
    const errors: string[] = [];
    const stop = startSourceRefresh({ refresh: async () => { if (++reads === 1) throw new Error("offline"); },
      onError: (error) => errors.push((error as Error).message), intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(200);
    expect(errors).toEqual(["offline"]);
    expect(reads).toBe(2);
    stop();
  });
});
