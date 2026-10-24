"use client";

import { TransitionLink as Link } from "../v3/motion/view-transition";
import type { SourceRecord } from "@aistudy/contracts";

export type GradingPhotoSelection = { workSourceId: string; workSourceVersion: number; physicalPage: number };
export const emptyGradingPhoto: GradingPhotoSelection = { workSourceId: "", workSourceVersion: 0, physicalPage: 1 };

/** Uploaded images can be read directly; document pages still need parsing. */
export function gradingPhotoSources(sources: SourceRecord[]) {
  return sources.filter(source => source.uploadState === "uploaded" && (["image/jpeg", "image/png", "image/webp"].includes(source.mime) || source.mime === "application/pdf" && source.parseState === "ready"));
}

export function AiGradingPhotoFields({ sources, value, onChange, disabled = false, onRefresh }: {
  sources: SourceRecord[]; value: GradingPhotoSelection; onChange: (value: GradingPhotoSelection) => void; disabled?: boolean; onRefresh?: () => void;
}) {
  const options = gradingPhotoSources(sources);
  const selected = options.find(source => source.id === value.workSourceId && source.version === value.workSourceVersion);
  return <details className="rounded-lg border border-line px-3 py-2" open={Boolean(value.workSourceId)}>
    <summary className="min-h-9 cursor-pointer py-1 text-sm text-text-2">{value.workSourceId ? "已附作答照片" : "添加作答照片（可选）"}</summary>
    <div className="mt-2 space-y-3">
      <label className="block text-sm text-text">作答图片或文档
        <select className="mt-1 min-h-11 w-full rounded border border-line bg-surface px-3 py-2" value={selected ? `${selected.id}:${selected.version}` : value.workSourceId ? "unavailable" : ""} disabled={disabled} onChange={event => {
          const source = options.find(item => `${item.id}:${item.version}` === event.target.value);
          onChange(source ? { workSourceId: source.id, workSourceVersion: source.version, physicalPage: 1 } : emptyGradingPhoto);
        }}>
          <option value="">仅批改文字答案</option>
          {value.workSourceId && !selected ? <option value="unavailable">原选文件暂不可用，请刷新或重新选择</option> : null}
          {options.map(source => <option key={source.id} value={`${source.id}:${source.version}`}>{source.name}</option>)}
        </select>
      </label>
      {selected?.mime === "application/pdf" ? <label className="block text-sm text-text">作答所在页<input type="number" min={1} step={1} value={value.physicalPage} disabled={disabled} onChange={event => onChange({ ...value, physicalPage: Math.max(1, Math.trunc(Number(event.target.value)) || 1) })} className="ml-2 min-h-10 w-20 rounded border border-line bg-surface px-2" /></label> : null}
      <div className="flex flex-wrap items-center gap-4 text-xs text-accent">
        <Link href="/opening/library?tab=materials#upload" className="min-h-10 py-2 underline underline-offset-4">上传作答照片</Link>
        {onRefresh ? <button type="button" className="min-h-10 py-2 underline underline-offset-4 disabled:opacity-50" disabled={disabled} onClick={onRefresh}>刷新文件</button> : null}
      </div>
    </div>
  </details>;
}
