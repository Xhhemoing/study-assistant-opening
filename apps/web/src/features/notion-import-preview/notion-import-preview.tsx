"use client";

import { FileText, Loader2, RotateCcw, TriangleAlert } from "lucide-react";
import { useCallback, useState } from "react";
import JSZip from "jszip";

import { DocumentPreview } from "./document-preview";
import { DropZone, ReportCard } from "./import-panel";
import {
  indexNotionZip,
  type ImportAttachment,
  type ImportedPage,
  type ImportReport,
  type ZipEntry,
} from "./notion-import-parser";

type ImportState = "idle" | "loading" | "done" | "error";

async function readZip(file: File | ArrayBuffer): Promise<ZipEntry[]> {
  const zip = await JSZip.loadAsync(file);
  const jobs: Promise<ZipEntry>[] = [];
  zip.forEach((path, entry) => {
    if (entry.dir) return;
    const isText = /\.(html|csv)$/iu.test(path);
    jobs.push(entry.async(isText ? "string" : "uint8array").then((content) => ({ path, content })));
  });
  return Promise.all(jobs);
}

export function NotionImportPreview() {
  const [state, setState] = useState<ImportState>("idle");
  const [pages, setPages] = useState<ImportedPage[]>([]);
  const [attachments, setAttachments] = useState<ImportAttachment[]>([]);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");

  const handleEntries = useCallback(async (entries: ZipEntry[], name: string) => {
    setState("loading");
    setError("");
    try {
      const result = indexNotionZip(entries);
      const firstPage = result.pages[0];
      if (!firstPage) {
        throw new Error("ZIP 中没有找到 Notion 页面（.html 文件）");
      }
      setPages(result.pages);
      setAttachments(result.attachments);
      setReport(result.report);
      setSelectedId(firstPage.id);
      setFileName(name);
      setState("done");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "解析失败，请确认这是 Notion 导出的 ZIP");
      setState("error");
    }
  }, []);

  const handleFile = useCallback(
    (file: File) => {
      void readZip(file).then((entries) => handleEntries(entries, file.name));
    },
    [handleEntries],
  );

  const handleSample = useCallback(() => {
    void fetch("/notion-export-sample.zip")
      .then((response) => {
        if (!response.ok) throw new Error(`示例导出加载失败 (${response.status})`);
        return response.arrayBuffer();
      })
      .then((buffer) => readZip(buffer))
      .then((entries) => handleEntries(entries, "notion-export-sample.zip"));
  }, [handleEntries]);

  const reset = useCallback(() => {
    setState("idle");
    setPages([]);
    setAttachments([]);
    setReport(null);
    setSelectedId(null);
    setFileName("");
    setError("");
  }, []);

  const selected = pages.find((page) => page.id === selectedId) ?? pages[0] ?? null;

  return (
    <main className="notebook-preview scheme-dark min-h-screen overflow-x-hidden bg-[#191919] text-stone-100">
      <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-white/10 bg-[#191919]/95 px-4 backdrop-blur sm:px-6">
        <div className="min-w-0 truncate text-sm text-stone-400">
          <span className="font-medium text-stone-100">AIstudy</span>
          <span className="mx-2 text-stone-600">/</span>
          <span>Notion 导入预览</span>
        </div>
        {state === "done" ? (
          <button
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-stone-400 hover:bg-white/10 hover:text-white"
            onClick={reset}
            type="button"
          >
            <RotateCcw aria-hidden="true" size={14} />重新导入
          </button>
        ) : null}
      </header>

      <div className="mx-auto max-w-[72rem] px-4 py-8 sm:px-6">
        {state === "idle" || state === "error" ? (
          <section className="mx-auto max-w-xl pt-10">
            <h1 className="text-2xl font-semibold text-stone-50">导入 Notion 笔记</h1>
            <p className="mt-2 text-sm leading-6 text-stone-400">
              在浏览器中本地解析你的 Notion 导出文件，预览转换后的块结构、页面属性与格式损失报告。
              不会上传任何内容。
            </p>
            <div className="mt-6">
              <DropZone onFile={handleFile} onSample={handleSample} />
            </div>
            {error ? (
              <p className="mt-4 flex items-center gap-2 rounded-lg border border-red-300/30 bg-red-300/10 px-3 py-2 text-sm text-red-200">
                <TriangleAlert aria-hidden="true" size={15} />{error}
              </p>
            ) : null}
          </section>
        ) : null}

        {state === "loading" ? (
          <section className="flex flex-col items-center gap-3 pt-24 text-stone-400">
            <Loader2 aria-hidden="true" className="animate-spin" size={22} />
            <p className="text-sm">正在解析导出文件…</p>
          </section>
        ) : null}

        {state === "done" && report ? (
          <div className="grid gap-6 lg:grid-cols-[19rem_minmax(0,1fr)]">
            <aside className="space-y-4">
              <ReportCard report={report} />
              <section aria-label="导入页面列表" className="rounded-lg border border-white/10 p-4">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-stone-100">
                  <FileText aria-hidden="true" size={15} />页面
                  <span className="ml-auto truncate text-[11px] font-normal text-stone-500">{fileName}</span>
                </h2>
                <ul className="mt-3 space-y-1">
                  {pages.map((page) => (
                    <li key={page.id}>
                      <button
                        aria-pressed={selected?.id === page.id}
                        className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm ${
                          selected?.id === page.id
                            ? "bg-white/10 text-stone-50"
                            : "text-stone-300 hover:bg-white/5 hover:text-stone-100"
                        }`}
                        onClick={() => setSelectedId(page.id)}
                        type="button"
                      >
                        <FileText aria-hidden="true" className="shrink-0 text-stone-500" size={14} />
                        <span className="min-w-0 flex-1 truncate">{page.title}</span>
                        <span className="shrink-0 font-mono text-[11px] text-stone-500">{page.blocks.length}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                {attachments.length > 0 ? (
                  <p className="mt-3 border-t border-white/10 pt-3 text-[11px] text-stone-500">
                    {attachments.length} 个附件会随页面入库并重写引用
                  </p>
                ) : null}
              </section>
            </aside>

            <section className="min-w-0 rounded-lg border border-white/10 bg-[#1f1f1f]">
              {selected ? <DocumentPreview page={selected} /> : null}
            </section>
          </div>
        ) : null}
      </div>
    </main>
  );
}
