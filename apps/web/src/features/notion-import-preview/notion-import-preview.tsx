"use client";

import { Archive, Loader2, TriangleAlert } from "lucide-react";
import { useCallback, useState } from "react";
import JSZip from "jszip";

import { DropZone } from "./import-panel";
import { ImportResultView } from "./import-result-view";
import {
  indexNotionZip,
  type ImportAttachment,
  type ImportedPage,
  type ImportReport,
  type ZipEntry,
} from "./notion-import-parser";
import {
  NotionImportWorkspace,
  WorkspaceCollapseButton,
  type WorkspacePanel,
  type WorkspaceTextStyle,
} from "./notion-import-workspace";

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
  const [error, setError] = useState("");
  const [panel, setPanel] = useState<WorkspacePanel>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [fullWidth, setFullWidth] = useState(false);
  const [textStyle, setTextStyle] = useState<WorkspaceTextStyle>("default");

  const reset = useCallback(() => {
    setState("idle");
    setPages([]);
    setAttachments([]);
    setReport(null);
    setSelectedId(null);
    setError("");
    setPanel(null);
  }, []);

  const handleEntries = useCallback(async (entries: ZipEntry[]) => {
    setState("loading");
    setError("");
    try {
      const result = indexNotionZip(entries);
      const firstPage = result.pages[0];
      if (!firstPage) throw new Error("ZIP 中没有找到 Notion 页面（.html 文件）");
      setPages(result.pages);
      setAttachments(result.attachments);
      setReport(result.report);
      setSelectedId(firstPage.id);
      setState("done");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "解析失败，请确认这是 Notion 导出的 ZIP");
      setState("error");
    }
  }, []);

  const handleFile = useCallback((file: File) => {
    void readZip(file).then(handleEntries).catch((cause) => {
      setError(cause instanceof Error ? cause.message : "无法读取 ZIP 文件");
      setState("error");
    });
  }, [handleEntries]);

  const handleSample = useCallback(() => {
    void fetch("/notion-export-sample.zip")
      .then((response) => {
        if (!response.ok) throw new Error(`示例导出加载失败 (${response.status})`);
        return response.arrayBuffer();
      })
      .then(readZip)
      .then(handleEntries)
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : "示例导出加载失败");
        setState("error");
      });
  }, [handleEntries]);

  const selected = pages.find((page) => page.id === selectedId) ?? pages[0] ?? null;
  const selectedTitle = selected?.title ?? "Notion 导入预览";

  if (state === "idle" || state === "error") {
    return (
      <main className="notebook-preview scheme-dark min-h-screen bg-[#191919] px-4 py-12 text-stone-100 sm:px-6">
        <section className="mx-auto max-w-xl pt-10">
          <div className="mb-7 flex items-center gap-2 text-sm text-stone-500"><Archive aria-hidden="true" size={16} />AIstudy / 导入</div>
          <h1 className="text-3xl font-semibold text-stone-50">导入 Notion 笔记</h1>
          <p className="mt-3 text-sm leading-6 text-stone-400">在浏览器中本地解析 Notion 导出，生成页面、块结构、附件引用与格式损失报告。不会上传内容。</p>
          <div className="mt-7"><DropZone onFile={handleFile} onSample={handleSample} /></div>
          {error ? <p className="mt-4 flex items-center gap-2 rounded-lg border border-red-300/30 bg-red-300/10 px-3 py-2 text-sm text-red-200"><TriangleAlert aria-hidden="true" size={15} />{error}</p> : null}
        </section>
      </main>
    );
  }

  if (state === "loading") {
    return <main className="notebook-preview scheme-dark flex min-h-screen flex-col items-center justify-center gap-3 bg-[#191919] text-stone-400"><Loader2 aria-hidden="true" className="animate-spin" size={22} /><p className="text-sm">正在解析导出文件…</p></main>;
  }

  if (!report) return null;

  return (
    <>
      <NotionImportWorkspace
        documentTitle={selectedTitle}
        fullWidth={fullWidth}
        onClosePanel={() => setPanel(null)}
        onOpenPage={(title) => {
          const page = pages.find((candidate) => candidate.title === title);
          if (page) setSelectedId(page.id);
        }}
        onReset={reset}
        onTextStyleChange={setTextStyle}
        onToggleFullWidth={() => setFullWidth((value) => !value)}
        onTogglePanel={(nextPanel) => setPanel((current) => current === nextPanel ? null : nextPanel)}
        onToggleSidebar={() => setSidebarOpen((value) => !value)}
        pageCount={pages.length}
        panel={panel}
        selectedPageTitle={selectedTitle}
        sidebarOpen={sidebarOpen}
        textStyle={textStyle}
      >
        <ImportResultView attachments={attachments} fullWidth={fullWidth} onOpenPage={setSelectedId} pages={pages} report={report} selected={selected} textStyle={textStyle} />
      </NotionImportWorkspace>
      {!sidebarOpen ? <WorkspaceCollapseButton onClick={() => setSidebarOpen(true)} /> : null}
    </>
  );
}
