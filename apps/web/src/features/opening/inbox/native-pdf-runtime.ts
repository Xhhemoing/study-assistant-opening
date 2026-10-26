/** PDF.js and its matching worker stay in the client bundle, never an external CDN. */
export async function loadPdfRuntime() {
  return import("pdfjs-dist");
}
export type PdfRuntime = Awaited<ReturnType<typeof loadPdfRuntime>>;

/** A document owns this pair; a pending teardown must never lend its port to another load. */
export function createPdfWorker(runtime: PdfRuntime) {
  const port = new Worker(new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url), { type: "module" });
  let worker: InstanceType<PdfRuntime["PDFWorker"]>;
  try {
    // 5.4.624 supports Worker ports at runtime; its constructor declaration incorrectly permits only null.
    worker = new runtime.PDFWorker({ port } as unknown as ConstructorParameters<PdfRuntime["PDFWorker"]>[0]);
  } catch (reason) { port.terminate(); throw reason; }
  let destroyed = false;
  return { worker, destroy() {
    if (destroyed) return;
    destroyed = true;
    try { worker.destroy(); } finally { port.terminate(); }
  } };
}
