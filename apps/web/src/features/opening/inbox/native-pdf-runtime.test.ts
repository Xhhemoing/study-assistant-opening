import { afterEach, expect, it, vi } from "vitest";
import { createPdfWorker, type PdfRuntime } from "./native-pdf-runtime";

afterEach(() => vi.unstubAllGlobals());

it("gives each PDFWorker its own bundled port and releases both exactly once", () => {
  const ports: Array<{ terminate: ReturnType<typeof vi.fn> }> = [];
  const workerConstructor = vi.fn();
  vi.stubGlobal("Worker", class { terminate = vi.fn(); constructor(url: URL, options: WorkerOptions) { workerConstructor(url, options); ports.push(this); } });
  const wrappers: Array<{ destroy: ReturnType<typeof vi.fn> }> = [];
  const runtime = { PDFWorker: class { destroy = vi.fn(); constructor({ port }: { port: Worker }) { expect(ports).toContain(port); wrappers.push(this); } } } as unknown as PdfRuntime;
  const first = createPdfWorker(runtime), second = createPdfWorker(runtime);
  expect(first.worker).not.toBe(second.worker);
  expect(workerConstructor.mock.calls[0]![0].href).toContain("pdfjs-dist/build/pdf.worker.min.mjs");
  expect(workerConstructor.mock.calls[0]![1]).toEqual({ type: "module" });
  first.destroy(); first.destroy();
  expect(wrappers[0]!.destroy).toHaveBeenCalledOnce();
  expect(ports[0]!.terminate).toHaveBeenCalledOnce();
  expect(wrappers[1]!.destroy).not.toHaveBeenCalled();
  expect(ports[1]!.terminate).not.toHaveBeenCalled();
  second.destroy();
});

it("terminates a raw worker when PDFWorker construction fails", () => {
  const terminate = vi.fn();
  vi.stubGlobal("Worker", class { terminate = terminate; });
  const runtime = { PDFWorker: class { constructor() { throw new Error("wrapper failed"); } } } as unknown as PdfRuntime;
  expect(() => createPdfWorker(runtime)).toThrow("wrapper failed");
  expect(terminate).toHaveBeenCalledOnce();
});

it("still terminates the owned port once if PDFWorker destruction throws", () => {
  const terminate = vi.fn();
  vi.stubGlobal("Worker", class { terminate = terminate; });
  const runtime = { PDFWorker: class { destroy() { throw new Error("wrapper teardown failed"); } } } as unknown as PdfRuntime;
  const owned = createPdfWorker(runtime);
  expect(() => owned.destroy()).toThrow("wrapper teardown failed");
  owned.destroy();
  expect(terminate).toHaveBeenCalledOnce();
});
