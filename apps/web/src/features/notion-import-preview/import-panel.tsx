"use client";

import { Archive, FileDown, FolderOpen, TriangleAlert } from "lucide-react";
import { useRef, useState } from "react";

import type { ImportReport } from "./notion-import-parser";

const lossLabels: Record<string, string> = {
  "toggle-flattened": "折叠展平",
  "callout-style": "提示框样式",
  "columns-flattened": "多栏展平",
  "embed-lost": "嵌入丢失",
  "equation-lost": "公式降级",
  "color-lost": "颜色丢失",
  "attribute-lost": "属性丢失",
};

export function DropZone({
  onFile,
  onSample,
}: {
  onFile: (file: File) => void;
  onSample: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  return (
    <div
      className={`relative rounded-xl border border-dashed px-6 py-10 text-center transition-colors ${
        dragging ? "border-sky-300/70 bg-sky-300/5" : "border-stone-700 hover:border-stone-500"
      }`}
      onDragLeave={() => setDragging(false)}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        const file = event.dataTransfer.files?.[0];
        if (file) onFile(file);
      }}
    >
      <Archive aria-hidden="true" className="mx-auto mb-3 text-stone-500" size={28} />
      <p className="text-sm text-stone-300">把 Notion 导出的 ZIP 拖到这里</p>
      <p className="mt-1 text-xs text-stone-500">支持 HTML 导出（保真）与 Markdown &amp; CSV 导出（有损）</p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
        <button
          className="inline-flex h-9 items-center gap-2 rounded-md bg-stone-100 px-3 text-sm font-medium text-stone-900 hover:bg-white"
          onClick={() => inputRef.current?.click()}
          type="button"
        >
          <FolderOpen aria-hidden="true" size={15} />选择 ZIP 文件
        </button>
        <button
          className="inline-flex h-9 items-center gap-2 rounded-md border border-white/15 px-3 text-sm font-medium text-stone-200 hover:bg-white/10"
          onClick={onSample}
          type="button"
        >
          <FileDown aria-hidden="true" size={15} />使用示例导出
        </button>
      </div>
      <input
        accept=".zip,application/zip"
        aria-label="选择 Notion 导出 ZIP"
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onFile(file);
          event.target.value = "";
        }}
        ref={inputRef}
        type="file"
      />
    </div>
  );
}

export function ReportCard({ report }: { report: ImportReport }) {
  return (
    <section aria-label="导入报告" className="rounded-lg border border-white/10 p-4">
      <h2 className="text-sm font-semibold text-stone-100">导入报告</h2>
      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-md bg-white/5 px-2 py-2">
          <p className="text-lg font-semibold text-stone-50">{report.pages}</p>
          <p className="text-[11px] text-stone-500">页面</p>
        </div>
        <div className="rounded-md bg-white/5 px-2 py-2">
          <p className="text-lg font-semibold text-stone-50">{report.blocks}</p>
          <p className="text-[11px] text-stone-500">内容块</p>
        </div>
        <div className="rounded-md bg-white/5 px-2 py-2">
          <p className="text-lg font-semibold text-stone-50">{report.attachments}</p>
          <p className="text-[11px] text-stone-500">附件</p>
        </div>
      </div>
      {report.losses.length > 0 ? (
        <ul className="mt-3 space-y-1 border-t border-white/10 pt-3">
          {report.losses.map((loss) => (
            <li className="flex items-center justify-between text-xs text-stone-400" key={loss.kind}>
              <span className="inline-flex items-center gap-1.5">
                <TriangleAlert aria-hidden="true" className="text-amber-300" size={12} />
                {lossLabels[loss.kind] ?? loss.kind}
              </span>
              <span className="font-mono text-stone-500">{loss.count}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 border-t border-white/10 pt-3 text-xs text-emerald-300">未检测到格式损失</p>
      )}
      <p className="mt-3 text-[11px] leading-5 text-stone-500">
        原始 ZIP 会作为来源证据保留；任何页面都可随时重新导入。
      </p>
    </section>
  );
}
