// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NativePdfPreview, pdfPageScale, pdfPreviewLocation } from "./native-pdf-preview";
const pdf = vi.hoisted(() => ({ render: vi.fn(), text: vi.fn(), destroy: vi.fn(), getDocument: vi.fn(), cancel: vi.fn() }));
vi.mock("./native-pdf-runtime", () => ({ loadPdfRuntime: async () => ({
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
  expect(pdf.getDocument).toHaveBeenCalledWith(expect.objectContaining({ url: "/api/source?version=2", withCredentials: true, cMapPacked: true, useWorkerFetch: true,
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
