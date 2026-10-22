"use client";

import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask, TextLayer } from "pdfjs-dist";
import { ui } from "../design/ui";
import { loadPdfRuntime, type PdfRuntime } from "./native-pdf-runtime";
import { rememberSourceReaderPage } from "./source-reader-position";

export function pdfPreviewLocation(href: string): { url: string; page: number } {
  const [url, fragment] = href.split("#");
  const page = Number(new URLSearchParams(fragment).get("page"));
  return { url: url!, page: Number.isSafeInteger(page) && page > 0 ? page : 1 };
}

/** Fit responds to the actual container; a chosen percentage is independent of its width. */
export function pdfPageScale(width: number, pageWidth: number, zoom: number | "fit"): number {
  return zoom === "fit" ? Math.max(0.05, width / pageWidth) : zoom / 100;
}

type LoadedPdf = { document: PDFDocumentProxy; runtime: PdfRuntime };
export function NativePdfPreview({ href, name, fillHeight = false, sourceId, version, onExplain }: {
  href: string; name: string; fillHeight?: boolean; toolsOpen?: boolean;
  sourceId?: string; version?: number; onExplain?: (page: number) => void;
}) {
  const container = useRef<HTMLDivElement>(null), scroll = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null), layer = useRef<HTMLDivElement>(null), pageFrame = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState<LoadedPdf | null>(null);
  const [page, setPage] = useState(() => pdfPreviewLocation(href).page);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [width, setWidth] = useState(0), [pageWidth, setPageWidth] = useState(0);
  const [error, setError] = useState(""), [loading, setLoading] = useState(true), [rendering, setRendering] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    let task: ReturnType<PdfRuntime["getDocument"]> | undefined;
    setLoaded(null); setError(""); setLoading(true); setPage(pdfPreviewLocation(href).page); setPageWidth(0);
    void loadPdfRuntime().then(async runtime => {
      if (!active) return;
      const assets = new URL("/api/opening/pdfjs-assets/5.4.624/", window.location.origin).href;
      task = runtime.getDocument({ url: pdfPreviewLocation(href).url, withCredentials: true,
        cMapUrl: `${assets}cmaps/`, cMapPacked: true, standardFontDataUrl: `${assets}standard_fonts/`,
        wasmUrl: `${assets}wasm/`, iccUrl: `${assets}iccs/`, useWorkerFetch: true });
      const document = await task.promise;
      if (!active) return;
      if (pdfPreviewLocation(href).page > document.numPages) throw new Error("引用页码已失效，请重新选择页码。");
      setLoaded({ document, runtime });
    }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "PDF 暂不可读取，请重试或打开原件。"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; if (task) void task.destroy(); };
  }, [href, revision]);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const update = (value: number) => { if (value > 0) setWidth(Math.max(1, Math.floor(scroll.current?.clientWidth || value) - 24)); };
    update(element.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(entries => update(entries[0]?.contentRect.width ?? 0));
    observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!loaded) return;
    let active = true;
    setPageWidth(0);
    void loaded.document.getPage(page).then(value => { if (active) setPageWidth(value.getViewport({ scale: 1 }).width); })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "此页暂不可读取。"); });
    return () => { active = false; };
  }, [loaded, page]);
  const scale = pageWidth && width ? pdfPageScale(width, pageWidth, zoom) : 0;
  useEffect(() => {
    if (!loaded || !scale || !canvas.current || !layer.current || !pageFrame.current) return;
    let active = true, renderTask: RenderTask | undefined, textLayer: TextLayer | undefined;
    const surface = canvas.current, text = layer.current, frame = pageFrame.current;
    const topRatio = scroll.current && scroll.current.scrollHeight ? scroll.current.scrollTop / scroll.current.scrollHeight : 0;
    setRendering(true); setError(""); text.replaceChildren();
    void loaded.document.getPage(page).then(async pdfPage => {
      if (!active) return;
      const viewport = pdfPage.getViewport({ scale });
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      surface.width = Math.ceil(viewport.width * pixelRatio); surface.height = Math.ceil(viewport.height * pixelRatio);
      // PDF.js requires exact runtime geometry. All surrounding UI uses Tailwind.
      surface.style.width = `${viewport.width}px`; surface.style.height = `${viewport.height}px`;
      frame.style.width = `${viewport.width}px`; frame.style.height = `${viewport.height}px`;
      frame.style.setProperty("--total-scale-factor", String(viewport.scale * viewport.userUnit));
      if (scroll.current) scroll.current.scrollTop = topRatio * scroll.current.scrollHeight;
      const context = surface.getContext("2d");
      if (!context) throw new Error("此浏览器无法绘制 PDF，请打开原件。");
      const textContent = await pdfPage.getTextContent();
      if (!active) return;
      renderTask = pdfPage.render({ canvas: surface, canvasContext: context, viewport, transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0] });
      textLayer = new loaded.runtime.TextLayer({ textContentSource: textContent, container: text, viewport });
      if (!active) { renderTask.cancel(); textLayer.cancel(); return; }
      await Promise.all([renderTask.promise, textLayer.render()]);
      if (!active) return;
      if (sourceId && version !== undefined) rememberSourceReaderPage(sourceId, version, page);
    }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "PDF 绘制失败，原件仍可打开。"); })
      .finally(() => { if (active) setRendering(false); });
    return () => { active = false; renderTask?.cancel(); textLayer?.cancel(); text.replaceChildren(); };
  }, [loaded, page, scale, sourceId, version]);
  function navigate(next: number) {
    if (!loaded || next < 1 || next > loaded.document.numPages) return;
    setPage(next); if (scroll.current) scroll.current.scrollTop = 0;
  }
  return <div ref={container} className={`flex min-h-0 min-w-0 flex-1 flex-col bg-reader-mat ${fillHeight ? "h-full" : "h-[calc(100dvh-15rem)] min-h-80"}`}>
    <div className="flex shrink-0 flex-wrap items-center gap-2 bg-surface py-1 text-xs text-text-2" aria-label="PDF 阅读工具">
      <button type="button" className={ui.quiet} disabled={!loaded || page <= 1 || rendering} onClick={() => navigate(page - 1)}>上一页</button>
      <label className="flex items-center gap-1">第<input aria-label="PDF 页码" className={`${ui.input} w-16`} type="number" min={1} max={loaded?.document.numPages ?? 1} value={page} disabled={!loaded || rendering} onChange={event => navigate(Number(event.target.value))} /> / {loaded?.document.numPages ?? "…"} 页</label>
      <button type="button" className={ui.quiet} disabled={!loaded || page >= loaded.document.numPages || rendering} onClick={() => navigate(page + 1)}>下一页</button>
      <label className="flex items-center gap-1">缩放<select aria-label="PDF 缩放" className="min-h-11 rounded border border-line bg-surface px-2" value={zoom} onChange={event => setZoom(event.target.value === "fit" ? "fit" : Number(event.target.value))}><option value="fit">适宽</option>{[50, 75, 100, 125, 150, 200].map(value => <option key={value} value={value}>{value}%</option>)}</select></label>
      {onExplain ? <button type="button" className={ui.quiet} disabled={!loaded || rendering || Boolean(error)} onClick={() => onExplain(page)}>解释本页</button> : null}
    </div>
    {loading || rendering ? <p role="status" className="shrink-0 px-3 py-1 text-xs text-text-2">{loading ? "正在读取 PDF…" : "正在绘制本页…"}</p> : null}
    {error ? <div role="alert" className="flex shrink-0 flex-wrap items-center gap-2 px-3 py-2 text-xs text-danger"><p>PDF 读取未完成：{error}</p><button type="button" className={ui.secondary} onClick={() => setRevision(value => value + 1)}>重试</button><a className={ui.secondary} href={pdfPreviewLocation(href).url} target="_blank" rel="noreferrer">打开原件</a></div> : null}
    <div ref={scroll} className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain p-3 [scrollbar-gutter:stable]">
      <div ref={pageFrame} className="relative mx-auto [color-scheme:light] [--scale-round-x:1px] [--scale-round-y:1px]" hidden={!loaded || Boolean(error)} aria-busy={rendering}>
        <canvas ref={canvas} aria-label={`${name} · 第 ${page} 页`} className="block max-w-none" />
        <div ref={layer} className="study-pdf-text-layer" data-study-reading-text="true" data-source-id={sourceId} data-source-version={version} data-source-page={page} data-page-kind="physical" />
      </div>
    </div>
  </div>;
}
