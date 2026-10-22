"use client";
import { useRef } from "react";
import { ArrowLeft, ArrowRight, Camera, ImagePlus, X } from "lucide-react";
import { ui } from "@aistudy/ui";

export type PhotoItem = { id: string; url: string; name: string };

type Props = {
  kind: "question" | "answer";
  items: PhotoItem[];
  onAdd: (files: File[]) => void;
  onRemove: (id: string) => void;
  onMove: (id: string, delta: -1 | 1) => void;
  onPreview: (item: PhotoItem) => void;
  disabled?: boolean;
};

const COPY = { question: { label: "题目照片", help: "拍下题目，便于识别原题", Icon: Camera }, answer: { label: "我的解答照片", help: "手写过程，可多张，按顺序排列", Icon: ImagePlus } } as const;

/** 拍照作答：题目与解答分开；缩略图可预览、删除、调整顺序。图片内容由真实上传服务保存。 */
export function PhotoAttachments({ kind, items, onAdd, onRemove, onMove, onPreview, disabled = false }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const { label, help, Icon } = COPY[kind];
  return (
    <div className="rounded-md border border-dashed border-line-strong p-2 transition-colors hover:border-text-3">
      <input ref={input} type="file" accept="image/*" capture="environment" multiple={kind === "answer"} hidden onChange={event => { onAdd(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
      <button type="button" disabled={disabled} onClick={() => input.current?.click()} className="flex min-h-11 w-full items-center gap-2 rounded-sm px-1 text-left disabled:opacity-50">
        <Icon size={18} aria-hidden="true" className="text-text-2" />
        <span><span className="block text-[15px] text-text">{label}</span><span className="block text-[12px] text-text-2">{items.length ? `${items.length} 张` : help}</span></span>
      </button>
      {items.length > 0 && (
        <ol className="mt-2 flex flex-wrap gap-2">
          {items.map((item, index) => (
            <li key={item.id} className="group relative motion-safe:animate-pop">
              <button type="button" onClick={() => onPreview(item)} aria-label={`预览${label} ${index + 1}`} className="block size-16 overflow-hidden rounded-sm border border-line bg-surface-2">
                <img src={item.url} alt="" className="size-full object-cover" />
              </button>
              <span className="absolute left-1 top-1 rounded-pill bg-ink/70 px-1.5 text-[11px] leading-4 text-on-ink">{index + 1}</span>
              {!disabled && <div className="mt-1 flex justify-center gap-0.5">
                {kind === "answer" && items.length > 1 && <>
                  <button type="button" aria-label={`第 ${index + 1} 张前移`} disabled={index === 0} onClick={() => onMove(item.id, -1)} className={`${ui.icon} size-7 min-h-0`}><ArrowLeft size={12} aria-hidden="true" /></button>
                  <button type="button" aria-label={`第 ${index + 1} 张后移`} disabled={index === items.length - 1} onClick={() => onMove(item.id, 1)} className={`${ui.icon} size-7 min-h-0`}><ArrowRight size={12} aria-hidden="true" /></button>
                </>}
                <button type="button" aria-label={`删除第 ${index + 1} 张`} onClick={() => onRemove(item.id)} className={`${ui.icon} size-7 min-h-0`}><X size={12} aria-hidden="true" /></button>
              </div>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
