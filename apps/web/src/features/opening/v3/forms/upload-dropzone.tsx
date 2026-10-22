"use client";
import { useRef, useState } from "react";
import { Upload, X } from "lucide-react";

export type UploadItem = { id: string; name: string; status: "uploading" | "processing" | "ready" | "failed"; percent?: number };
const STATUS: Record<UploadItem["status"], string> = { uploading: "上传中", processing: "处理中", ready: "可阅读", failed: "未能提取" };

/**
 * 上传区（资料上传、拍题批量导入）：拖入时边框与底色过渡；每个文件一行，
 * 上传进度用原生 <progress>（与仓库 live-task-card 一致），处理中用 AI 流光，失败可移除。
 */
export function UploadDropzone({ items, onFiles, onRemove, accept }: { items: UploadItem[]; onFiles: (files: File[]) => void; onRemove: (id: string) => void; accept?: string }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="space-y-3">
      <div data-over={over}
        onDragOver={event => { event.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={event => { event.preventDefault(); setOver(false); onFiles(Array.from(event.dataTransfer.files)); }}
        className="grid place-items-center gap-2 rounded-card border border-dashed border-line-strong px-4 py-10 text-center transition-[background-color,border-color,transform] duration-(--duration-state) ease-standard data-[over=true]:scale-[1.01] data-[over=true]:border-accent data-[over=true]:bg-accent-soft">
        <Upload size={22} aria-hidden="true" className="text-text-2" />
        <p className="text-[15px] text-text">拖入 PDF 或照片</p>
        <input ref={input} type="file" multiple accept={accept} hidden onChange={event => onFiles(Array.from(event.target.files ?? []))} />
        <button type="button" onClick={() => input.current?.click()} className="min-h-11 rounded-md border border-text-3 px-4 text-[15px] text-text hover:bg-surface-2">选择文件</button>
      </div>
      {items.length > 0 && (
        <ul className="divide-y divide-line rounded-card border border-line bg-surface">
          {items.map(item => (
            <li key={item.id} className="px-4 py-3 motion-safe:animate-enter">
              <div className="flex items-center gap-3">
                <span className="min-w-0 flex-1 truncate text-[15px] text-text">{item.name}</span>
                <span className={`text-[13px] ${item.status === "failed" ? "text-danger" : item.status === "ready" ? "text-accent" : "text-text-2"}`}>{STATUS[item.status]}</span>
                {item.status === "failed" && <button type="button" aria-label={`移除 ${item.name}`} onClick={() => onRemove(item.id)} className="grid size-9 place-items-center rounded-sm text-text-3 hover:bg-surface-2"><X size={14} aria-hidden="true" /></button>}
              </div>
              {item.status === "uploading" && <progress max={100} value={item.percent ?? 0} aria-label={`${item.name} 上传进度`} className="mt-2 block h-1 w-full appearance-none overflow-hidden rounded-pill [&::-moz-progress-bar]:bg-accent [&::-webkit-progress-bar]:bg-surface-2 [&::-webkit-progress-value]:bg-accent [&::-webkit-progress-value]:transition-[width] [&::-webkit-progress-value]:duration-300" />}
              {item.status === "processing" && <div aria-hidden="true" className="relative mt-2 h-1 overflow-hidden rounded-pill bg-surface-2"><span className="absolute inset-0 bg-linear-to-r from-ai-1/40 via-ai-2/50 to-ai-3/40 motion-safe:animate-shimmer" /></div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
