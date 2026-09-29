"use client";

import { Archive, FileDown, FolderOpen, TriangleAlert } from "lucide-react";
import { useRef, useState } from "react";

import { ui } from "../opening/design/ui";
import type { ImportReport } from "./notion-import-parser";

const lossLabels: Record<string, string> = {
  "toggle-flattened": "折叠展平", "callout-style": "提示框样式", "columns-flattened": "多栏展平",
  "embed-lost": "嵌入丢失", "equation-lost": "公式降级", "color-lost": "颜色丢失", "attribute-lost": "属性丢失",
};

export function DropZone({ onFile, onSample }: { onFile: (file: File) => void; onSample: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  return <div className={`border border-dashed bg-white px-5 py-8 text-center transition-colors duration-150 motion-reduce:transition-none ${dragging ? "border-emerald-700 bg-emerald-50" : "border-zinc-300"}`}
    onDragLeave={() => setDragging(false)} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDrop={event => { event.preventDefault(); setDragging(false); const file = event.dataTransfer.files?.[0]; if (file) onFile(file); }}>
    <Archive aria-hidden="true" className="mx-auto mb-3 text-zinc-400" size={24} />
    <p className="text-sm text-zinc-700">把 Notion 导出的 ZIP 拖到这里</p><p className="mt-2 text-xs leading-6 text-zinc-500">请选择 HTML 导出；当前解析器不支持 Markdown 页面。格式差异会在报告中列出。</p>
    <div className="mt-4 flex flex-wrap items-center justify-center gap-2"><button className={ui.primary} onClick={() => inputRef.current?.click()} type="button"><FolderOpen aria-hidden="true" size={14} />选择 ZIP 文件</button><button className={ui.secondary} onClick={onSample} type="button"><FileDown aria-hidden="true" size={14} />使用示例导出</button></div>
    <input accept=".zip,application/zip" aria-label="选择 Notion 导出 ZIP" className="sr-only" onChange={event => { const file = event.target.files?.[0]; if (file) onFile(file); event.target.value = ""; }} ref={inputRef} type="file" />
  </div>;
}

export function ReportCard({ report }: { report: ImportReport }) {
  return <section aria-label="导入报告">
    <h2 className="text-sm font-medium text-zinc-800">解析结果</h2>
    <dl className="mt-2 divide-y divide-zinc-200">{[["页面", report.pages], ["内容块", report.blocks], ["附件", report.attachments]].map(([label, value]) => <div key={label} className="flex justify-between py-2 text-xs"><dt className="text-zinc-500">{label}</dt><dd className="tabular-nums text-zinc-800">{value}</dd></div>)}</dl>
    {report.losses.length ? <ul className="mt-3 space-y-2 border-t border-zinc-200 pt-3">{report.losses.map(loss => <li className="flex items-center justify-between gap-3 text-xs text-amber-800" key={loss.kind}><span className="inline-flex items-center gap-1.5"><TriangleAlert aria-hidden="true" size={12} />{lossLabels[loss.kind] ?? loss.kind}</span><span className="tabular-nums">{loss.count}</span></li>)}</ul> : <p className="mt-3 border-t border-zinc-200 pt-3 text-xs text-emerald-700">解析器未检测到已知格式损失</p>}
    <p className="mt-3 text-xs leading-6 text-zinc-500">预览不会保留原始 ZIP 或写入知识库，请自行保存原文件。未检测到损失不代表完整保真。</p>
  </section>;
}
