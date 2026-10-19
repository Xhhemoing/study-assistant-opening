import { afterEach, expect, it, vi } from "vitest";
import { withSystemQueryReadDeadline } from "./opening-system-query-deadline";
afterEach(() => vi.useRealTimers());
it("bounds a hung final permission read and never returns its late data", async () => {
  vi.useFakeTimers(); let resolve!: (value: string) => void;
  const pending = withSystemQueryReadDeadline(new AbortController().signal, () => new Promise<string>(done => { resolve = done; }));
  const assertion = expect(pending).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(12001); await assertion;
  resolve("private late result");
});
it("checks cancellation after an awaited read resolves", async () => {
  const controller = new AbortController();
  await expect(withSystemQueryReadDeadline(controller.signal, async () => {
    controller.abort(); return "must not escape";
  })).rejects.toThrow("cancelled");
});
