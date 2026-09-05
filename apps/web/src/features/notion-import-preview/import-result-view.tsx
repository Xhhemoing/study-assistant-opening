import { FileText } from "lucide-react";

import { DocumentPreview } from "./document-preview";
import { ReportCard } from "./import-panel";
import type { ImportAttachment, ImportedPage, ImportReport } from "./notion-import-parser";

type ImportResultViewProps = {
  attachments: ImportAttachment[];
  fullWidth: boolean;
  onOpenPage: (pageId: string) => void;
  pages: ImportedPage[];
  report: ImportReport;
  selected: ImportedPage | null;
  textStyle: "default" | "serif" | "mono";
};

function textStyleClass(textStyle: ImportResultViewProps["textStyle"]) {
  if (textStyle === "serif") return "font-serif";
  if (textStyle === "mono") return "font-mono";
  return "font-sans";
}

export function ImportResultView({
  attachments,
  fullWidth,
  onOpenPage,
  pages,
  report,
  selected,
  textStyle,
}: ImportResultViewProps) {
  return (
    <div className="grid gap-6 py-8 lg:grid-cols-[17rem_minmax(0,1fr)]">
      <aside className="space-y-4 px-4 sm:px-0">
        <ReportCard report={report} />
        <section aria-label="导入页面列表" className="rounded-lg border border-white/10 p-3">
          <h2 className="flex items-center gap-2 px-1 text-sm font-semibold text-stone-100">
            <FileText aria-hidden="true" size={15} />页面
            <span className="ml-auto font-mono text-[11px] font-normal text-stone-500">{pages.length}</span>
          </h2>
          <ul className="mt-2 space-y-0.5">
            {pages.map((page) => (
              <li key={page.id}>
                <button
                  aria-pressed={selected?.id === page.id}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
                    selected?.id === page.id
                      ? "bg-white/10 text-stone-50"
                      : "text-stone-400 hover:bg-white/5 hover:text-stone-100"
                  }`}
                  onClick={() => onOpenPage(page.id)}
                  type="button"
                >
                  <FileText aria-hidden="true" className="shrink-0 text-stone-500" size={14} />
                  <span className="min-w-0 flex-1 truncate">{page.title}</span>
                  <span className="shrink-0 font-mono text-[11px] text-stone-500">{page.blocks.length}</span>
                </button>
              </li>
            ))}
          </ul>
          {attachments.length > 0 ? <p className="mt-3 border-t border-white/10 px-1 pt-3 text-[11px] text-stone-500">{attachments.length} 个附件随页面入库并重写引用</p> : null}
        </section>
      </aside>
      <section className={`min-w-0 rounded-lg border border-white/10 bg-[#1f1f1f] ${textStyleClass(textStyle)}`}>
        {selected ? <DocumentPreview fullWidth={fullWidth} page={selected} /> : null}
      </section>
    </div>
  );
}
