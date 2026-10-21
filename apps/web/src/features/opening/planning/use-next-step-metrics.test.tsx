// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { useNextStepMetrics } from "./use-next-step-metrics";
const record = vi.hoisted(() => vi.fn());
vi.mock("../client/learning-experience", () => ({ recordLearningExperience: record }));
let visible: (entries: Partial<IntersectionObserverEntry>[]) => void, host: HTMLDivElement, root: Root;
function Harness() {
  const measurement = useNextStepMetrics({ targetType: "course", targetId: "course" });
  return <div ref={measurement.ref}><button data-today-primary-cta="true" onClick={measurement.clicked}>开始</button></div>;
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); record.mockReset().mockResolvedValue(true);
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.stubGlobal("IntersectionObserver", class { constructor(callback: typeof visible) { visible = callback; } observe() {} disconnect() {} });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("records visible suggestions and orders their start click after an exposure receipt", async () => {
  await act(async () => root.render(<Harness />));
  await act(async () => host.querySelector("button")!.click()); expect(record).not.toHaveBeenCalled();
  await act(async () => visible([{ isIntersecting: true, intersectionRatio: 1 }]));
  expect(record).toHaveBeenCalledTimes(1); expect(record.mock.calls[0]![0].kind).toBe("next_step_shown");
  await act(async () => host.querySelector("button")!.click());
  expect(record.mock.calls.slice(-2).map(call => call[0].kind)).toEqual(["next_step_shown", "next_step_started"]);
  await act(async () => visible([{ isIntersecting: false, intersectionRatio: 0 }]));
  await act(async () => host.querySelector("button")!.click()); expect(record).toHaveBeenCalledTimes(3);
});
it("does not count a click when the display receipt failed", async () => {
  record.mockResolvedValue(false); await act(async () => root.render(<Harness />));
  await act(async () => visible([{ isIntersecting: true, intersectionRatio: 1 }]));
  await act(async () => host.querySelector("button")!.click());
  expect(record.mock.calls.every(call => call[0].kind === "next_step_shown")).toBe(true);
});
