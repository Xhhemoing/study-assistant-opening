"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Minus, Plus, SunDim } from "lucide-react";
import { ui } from "@aistudy/ui";
import { SelectionAsk, useTextSelection, type TextSelection } from "./selection-ask";

export type ReaderZoom = "fit" | 0.75 | 1 | 1.25 | 1.5 | 2;
const STEPS: Exclude<ReaderZoom, "fit">[] = [0.75, 1, 1.25, 1.5, 2];
/** 页宽：816px（Letter @96dpi）基准的离散档位；字面量类名可被 Tailwind 扫描，宽度变化有过渡 */
const WIDTH: Record<ReaderZoom, string> = { fit: "w-full max-w-[1100px]", 0.75: "w-[612px]", 1: "w-[816px]", 1.25: "w-[1020px]", 1.5: "w-[1224px]", 2: "w-[1632px]" };

export type ReaderPageData = { number: number; content: ReactNode };

type Options = {
  pages: ReaderPageData[];
  zoom: ReaderZoom;
  onZoomChange: (zoom: ReaderZoom) => void;
  dim: boolean;
  onDimChange: (dim: boolean) => void;
  /** 当前页变化：同一对象内的位置，调用方用 replace 写入 URL */
  onPageChange: (page: number) => void;
  initialPage?: number;
  onAskSelection: (selection: TextSelection) => void;
};

/**
 * PDF / 照片阅读（col-full）。返回页面视图与底部控制，由 StudyWorkspace 放置。
 * 原页不反色、可降低亮度；页内文字用容器查询单位（cqw）随页宽缩放；可选文字块加 data-select-block。
 */
export function useDocumentReader({ pages, zoom, onZoomChange, dim, onDimChange, onPageChange, initialPage, onAskSelection }: Options) {
  const root = useRef<HTMLDivElement>(null);
  const [selection, clearSelection] = useTextSelection(root);
  const [fitScale, setFitScale] = useState(1);
  const [coarse, setCoarse] = useState(false);
  useEffect(() => { setCoarse(window.matchMedia("(pointer: coarse)").matches); }, []);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => { if (entry) setFitScale(Math.min(1100, entry.contentRect.width) / 816); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => { if (initialPage) root.current?.querySelector(`[data-page="${initialPage}"]`)?.scrollIntoView({ block: "start" }); }, []);

  useEffect(() => {
    const io = new IntersectionObserver(entries => {
      const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (visible) onPageChange(Number((visible.target as HTMLElement).dataset.page));
    }, { threshold: [0.3, 0.6] });
    root.current?.querySelectorAll("[data-page]").forEach(el => io.observe(el));
    return () => io.disconnect();
  }, [zoom, pages.length]);

  const scale = zoom === "fit" ? fitScale : zoom;
  const ask = () => { if (selection) { onAskSelection(selection); clearSelection(); } };
  const smaller = [...STEPS].reverse().find(step => step < scale - 0.01);
  const larger = STEPS.find(step => step > scale + 0.01);

  const view = (
    <div className="min-h-full overflow-x-auto bg-reader-mat px-4 py-6">
      <div ref={root} className="flex flex-col gap-4">
        {pages.map(page => (
          <article key={page.number} data-page={page.number} aria-label={`第 ${page.number} 页`}
            className={`@container mx-auto aspect-[8.5/11] shrink-0 bg-white text-[#1f1e1b] shadow-card transition-[width,filter] duration-(--duration-panel) ease-standard motion-reduce:transition-none ${WIDTH[zoom]} ${dim ? "brightness-[.82]" : ""}`}>
            {page.content}
          </article>
        ))}
      </div>
      <SelectionAsk selection={selection} onAsk={ask} />
    </div>
  );

  const controls = (
    <div className="flex items-center gap-0.5">
      {coarse && selection && <button type="button" onClick={ask} className={`${ui.primary} motion-safe:animate-pop`}>问选中内容</button>}
      <button type="button" onClick={() => onZoomChange("fit")} aria-pressed={zoom === "fit"} className={`${ui.quiet} aria-pressed:bg-surface-2 aria-pressed:text-text`}>适合宽度</button>
      <button type="button" aria-label="缩小" className={ui.icon} disabled={!smaller} onClick={() => smaller && onZoomChange(smaller)}><Minus size={16} aria-hidden="true" /></button>
      <span className="w-12 text-center text-[13px] tabular-nums text-text-2">{Math.round(scale * 100)}%</span>
      <button type="button" aria-label="放大" className={ui.icon} disabled={!larger} onClick={() => larger && onZoomChange(larger)}><Plus size={16} aria-hidden="true" /></button>
      <button type="button" aria-label="降低原页亮度" aria-pressed={dim} onClick={() => onDimChange(!dim)} className={ui.icon}><SunDim size={16} aria-hidden="true" /></button>
    </div>
  );

  return { view, controls, selection };
}
