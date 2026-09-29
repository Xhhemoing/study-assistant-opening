import { Paperclip } from "lucide-react";

import { DocumentPreview } from "./document-preview";
import { ReportCard } from "./import-panel";
import type { ImportAttachment, ImportedPage, ImportReport } from "./notion-import-parser";

type ImportResultViewProps = {
  attachments: ImportAttachment[];
  fullWidth: boolean;
  report: ImportReport;
  selected: ImportedPage | null;
  textStyle: "default" | "serif" | "mono";
};

export function ImportResultView({ attachments, fullWidth, report, selected, textStyle }: ImportResultViewProps) {
  const font = textStyle === "serif" ? "font-serif" : textStyle === "mono" ? "font-mono" : "font-sans";
  return <>
    <details className="border-b border-zinc-200 px-4 py-3 sm:px-6"><summary className="cursor-pointer text-xs font-medium text-zinc-600">导入报告 · {report.pages} 页 · {report.blocks} 个块 · {report.attachments} 个附件</summary><div className="mt-4 grid gap-6 lg:grid-cols-2"><ReportCard report={report} /><section aria-label="附件列表"><h2 className="mb-2 flex items-center gap-2 text-sm font-medium text-zinc-800"><Paperclip size={14} aria-hidden="true" />附件索引</h2>{attachments.length ? <ul className="max-h-60 divide-y divide-zinc-200 overflow-y-auto">{attachments.map(attachment => <li key={attachment.path} className="flex items-start justify-between gap-3 py-2 text-xs text-zinc-600"><span className="min-w-0 break-all" title={attachment.path}>{attachment.path}</span><span className="shrink-0 tabular-nums">{attachment.size.toLocaleString()} B</span></li>)}</ul> : <p className="text-xs text-zinc-500">未检测到附件。</p>}<p className="mt-2 text-xs leading-6 text-zinc-500">这里只索引附件与页面引用，不会上传或存储附件。</p></section></div></details>
    <section className={`min-w-0 text-sm leading-7 ${font}`}>{selected ? <DocumentPreview fullWidth={fullWidth} page={selected} /> : <p className="p-6 text-zinc-500">请选择一个已解析页面。</p>}</section>
  </>;
}
