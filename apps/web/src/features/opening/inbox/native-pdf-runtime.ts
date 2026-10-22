/** PDF.js and its matching worker stay in the client bundle, never an external CDN. */
export async function loadPdfRuntime() {
  const pdf = await import("pdfjs-dist");
  if (!pdf.GlobalWorkerOptions.workerPort) {
    pdf.GlobalWorkerOptions.workerPort = new Worker(new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url), { type: "module" });
  }
  return pdf;
}
export type PdfRuntime = Awaited<ReturnType<typeof loadPdfRuntime>>;
