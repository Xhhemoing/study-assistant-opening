// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NativePdfPreview, pdfPageScale, pdfPreviewLocation } from "./native-pdf-preview";
const pdf = vi.hoisted(() => ({ render: vi.fn(), text: vi.fn(), destroy: vi.fn(), getDocument: vi.fn(), cancel: vi.fn(),
  createWorker: vi.fn(), workers: [] as Array<{ worker: object; destroy: ReturnType<typeof vi.fn> }> }));
vi.mock("./native-pdf-runtime", () => ({ createPdfWorker: pdf.createWorker, loadPdfRuntime: async () => ({
  getDocument: pdf.getDocument,
  TextLayer: class {
    constructor(options: unknown) { pdf.text(options); }
    render() { return Promise.resolve(); }
    cancel() { pdf.cancel(); }
  },
}) }));
let host: HTMLDivElement, root: Root, resize: ResizeObserverCallback;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  pdf.workers.length = 0;
  pdf.createWorker.mockImplementation(() => { const owned = { worker: {}, destroy: vi.fn() }; pdf.workers.push(owned); return owned; });
  pdf.destroy.mockResolvedValue(undefined);
  vi.stubGlobal("ResizeObserver", class { constructor(callback: ResizeObserverCallback) { resize = callback; } observe() {} disconnect() {} });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
  pdf.render.mockImplementation(() => ({ promise: Promise.resolve(), cancel: pdf.cancel }));
  const page = { getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale, scale, userUnit: 1 }), getTextContent: async () => ({ items: [] }), render: pdf.render };
  pdf.getDocument.mockReturnValue({ promise: Promise.resolve({ numPages: 9, getPage: async () => page }), destroy: pdf.destroy });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); });
async function width(value: number) { await act(async () => resize([{ contentRect: { width: value } } as ResizeObserverEntry], {} as ResizeObserver)); }

it("retains the authenticated URL and explicit locator, and distinguishes fit from manual zoom", () => {
  expect(pdfPreviewLocation("/api/source?version=2#page=3")).toEqual({ url: "/api/source?version=2", page: 3 });
  expect(pdfPreviewLocation("/api/source#page=-2").page).toBe(1);
  expect(pdfPageScale(480, 600, "fit")).toBe(0.8);
  expect(pdfPageScale(480, 600, 125)).toBe(1.25);
});
it("renders canvas and selectable text in the same viewport and refits only automatic zoom on resize", async () => {
  await act(async () => root.render(createElement(NativePdfPreview, { href: "/api/source?version=2#page=3", name: "lesson", sourceId: "source", version: 2, fillHeight: true })));
  await width(624);
  expect(host.querySelectorAll("canvas")).toHaveLength(1); expect(host.querySelector("iframe")).toBeNull();
  expect(pdf.getDocument).toHaveBeenCalledWith(expect.objectContaining({ url: "/api/source?version=2", withCredentials: true, worker: pdf.workers[0]!.worker, cMapPacked: true, useWorkerFetch: true,
    cMapUrl: expect.stringContaining("/5.4.624/cmaps/"), standardFontDataUrl: expect.stringContaining("/5.4.624/standard_fonts/"),
    wasmUrl: expect.stringContaining("/5.4.624/wasm/"), iccUrl: expect.stringContaining("/5.4.624/iccs/") }));
  expect(pdf.render.mock.lastCall![0].viewport).toBe(pdf.text.mock.lastCall![0].viewport);
  expect(pdf.text.mock.lastCall![0].viewport.scale).toBe(1);
  expect(host.querySelector('[data-study-reading-text]')?.getAttribute("data-source-page")).toBe("3");
  await width(324);
  expect(pdf.text.mock.lastCall![0].viewport.scale).toBe(0.5);
  await act(async () => { const select = host.querySelector<HTMLSelectElement>('select[aria-label="PDF 缩放"]')!; select.value = "125"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(pdf.text.mock.lastCall![0].viewport.scale).toBe(1.25);
  const renders = pdf.render.mock.calls.length;
  await width(824);
  expect(pdf.render).toHaveBeenCalledTimes(renders);
  expect(host.querySelector('input[aria-label="PDF 页码"]')?.getAttribute("value")).toBe("3");
});
it("shows an actionable failure and keeps the original available instead of displaying a sample", async () => {
  pdf.getDocument.mockReturnValue({ promise: Promise.reject(new Error("download denied")), destroy: pdf.destroy });
  await act(async () => root.render(createElement(NativePdfPreview, { href: "/api/source?version=2#page=3", name: "lesson" })));
  expect(host.textContent).not.toContain("download denied"); expect(host.textContent).toContain("PDF 暂不可读取"); expect(host.textContent).toContain("重试");
  expect(host.querySelector('a')?.getAttribute("href")).toBe("/api/source?version=2");
});

it.each(["resolve", "reject"])("uses a new worker while the previous href's task destruction is pending and later %s", async outcome => {
  let finishDestroy!: () => void, finishLoad!: (value: unknown) => void;
  const destroyOld = vi.fn(() => new Promise<void>((resolve, reject) => { finishDestroy = outcome === "resolve" ? resolve : () => reject(new Error("transport cleanup failed")); }));
  pdf.getDocument.mockReturnValueOnce({ promise: new Promise(resolve => { finishLoad = resolve; }), destroy: destroyOld });
  await act(async () => root.render(createElement(NativePdfPreview, { href: "/api/old-source", name: "old" })));
  const oldWorker = pdf.workers[0]!;
  await act(async () => root.render(createElement(NativePdfPreview, { href: "/api/new-source", name: "new" })));
  const newWorker = pdf.workers[1]!;
  expect(newWorker.worker).not.toBe(oldWorker.worker);
  expect(pdf.getDocument.mock.calls[1]![0].worker).toBe(newWorker.worker);
  expect(destroyOld).toHaveBeenCalledOnce();
  expect(oldWorker.destroy).not.toHaveBeenCalled();
  await act(async () => { finishLoad({ numPages: 1 }); finishDestroy(); });
  expect(oldWorker.destroy).toHaveBeenCalledOnce();
  expect(newWorker.destroy).not.toHaveBeenCalled();
  expect(host.querySelector('input[aria-label="PDF 页码"]')?.getAttribute("max")).toBe("9");
  expect(host.querySelector("canvas")?.getAttribute("aria-label")).toBe("new · 第 1 页");
});

it("retries a failed document with an independent worker before old cleanup completes", async () => {
  let finishDestroy!: () => void;
  const destroyOld = vi.fn(() => new Promise<void>(resolve => { finishDestroy = resolve; }));
  pdf.getDocument.mockReturnValueOnce({ promise: Promise.reject(new Error("read failed")), destroy: destroyOld });
  await act(async () => root.render(createElement(NativePdfPreview, { href: "/api/source", name: "lesson" })));
  expect(destroyOld).toHaveBeenCalledOnce();
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "重试")!.click());
  expect(pdf.workers).toHaveLength(2);
  expect(pdf.workers[1]!.worker).not.toBe(pdf.workers[0]!.worker);
  expect(pdf.workers[0]!.destroy).not.toHaveBeenCalled();
  await act(async () => finishDestroy());
  expect(pdf.workers[0]!.destroy).toHaveBeenCalledOnce();
  expect(pdf.workers[1]!.destroy).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it("releases the owned worker if getDocument throws before returning a task", async () => {
  pdf.getDocument.mockImplementationOnce(() => { throw new Error("document construction failed"); });
  await act(async () => root.render(createElement(NativePdfPreview, { href: "/api/source", name: "lesson" })));
  expect(pdf.workers[0]!.destroy).toHaveBeenCalledOnce();
  expect(pdf.destroy).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
});
