import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceRecord } from "@aistudy/contracts";
import { startSourceProcessingRefresh } from "./source-processing-refresh";
const queued = [{ id: "material", uploadState: "uploaded", parseState: "queued" }] as SourceRecord[];
const ready = [{ ...queued[0]!, parseState: "ready" }] as SourceRecord[];
const failed = [{ ...queued[0]!, parseState: "failed" }] as SourceRecord[];
afterEach(() => vi.useRealTimers());
function visibility() {
  let shown = true, changed = () => {};
  return { isVisible: () => shown, subscribeVisibility: (callback: () => void) => { changed = callback; return () => { changed = () => {}; }; }, set: (value: boolean) => { shown = value; changed(); } };
}
describe("assistant materials processing refresh", () => {
  it.each([{ terminal: ready }, { terminal: failed }])("publishes real terminal states and then stops polling", async ({ terminal }) => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValueOnce(queued).mockResolvedValue(terminal), accept = vi.fn();
    const controller = startSourceProcessingRefresh({ read, accept, onError: vi.fn(), ...visibility(), intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(accept).toHaveBeenLastCalledWith(terminal);
    controller.stop();
  });
  it("pauses hidden tabs and immediately verifies state when they return", async () => {
    vi.useFakeTimers();
    const view = visibility(), read = vi.fn(async () => queued);
    const controller = startSourceProcessingRefresh({ read, accept: vi.fn(), onError: vi.fn(), ...view, intervalMs: 100 });
    view.set(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).not.toHaveBeenCalled();
    view.set(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    controller.stop();
  });
  it("does not overlap requests and discards late hidden or disposed receipts", async () => {
    vi.useFakeTimers();
    const view = visibility(), accept = vi.fn(), onError = vi.fn();
    let complete!: (value: SourceRecord[]) => void;
    const read = vi.fn(() => new Promise<SourceRecord[]>(resolve => { complete = resolve; }));
    const controller = startSourceProcessingRefresh({ read, accept, onError, ...view, intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    view.set(false); view.set(true); controller.retry();
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledTimes(1);
    complete(ready);
    await vi.advanceTimersByTimeAsync(0);
    expect(accept).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(2);
    controller.stop(); complete(ready);
    await vi.advanceTimersByTimeAsync(1000);
    expect(accept).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
  it("shows a real read failure and supports manual serial retry without inventing ready", async () => {
    vi.useFakeTimers();
    const error = new Error("offline"), onError = vi.fn(), accept = vi.fn();
    const read = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(ready);
    const controller = startSourceProcessingRefresh({ read, accept, onError, ...visibility(), intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect(onError).toHaveBeenCalledWith(error);
    expect(accept).not.toHaveBeenCalled();
    controller.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(accept).toHaveBeenCalledWith(ready);
    controller.stop();
  });
  it("keeps polling when a receipt was superseded by another source read", async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => ready), accept = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    const controller = startSourceProcessingRefresh({ read, accept, onError: vi.fn(), ...visibility(), intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledTimes(2);
    controller.stop();
  });
});
