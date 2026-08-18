"use client";

import { FileDown, LoaderCircle, RefreshCw } from "lucide-react";
import { useState } from "react";
import type { AnkiExportResponse, MarkdownExportResponse } from "@aistudy/contracts";
import {
  ankiExportCopy,
  buildAnkiExportRequest,
  buildMarkdownExportRequest,
  markdownExportCopy,
} from "./export-menu-model";

type ExportKind = "markdown" | "anki";

export function ExportMenu({ documentId }: { documentId?: string }) {
  const [pending, setPending] = useState<ExportKind | null>(null);
  const [error, setError] = useState("");
  const [kind, setKind] = useState<ExportKind>("markdown");
  const [markdown, setMarkdown] = useState<MarkdownExportResponse | null>(null);
  const [anki, setAnki] = useState<AnkiExportResponse | null>(null);

  async function runExport(next: ExportKind) {
    setPending(next);
    setError("");
    setKind(next);
    try {
      const response = await fetch(next === "markdown" ? "/api/exports/markdown" : "/api/exports/anki", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          next === "markdown" ? buildMarkdownExportRequest(documentId) : buildAnkiExportRequest(),
        ),
      });
      if (!response.ok) throw new Error();
      if (next === "markdown") {
        const body = await response.json() as MarkdownExportResponse;
        setMarkdown(body);
        downloadFile(body.markdown, "aistudy-notes.md", "text/markdown;charset=utf-8");
      } else {
        const body = await response.json() as AnkiExportResponse;
        setAnki(body);
        downloadFile(body.ankiTsv, "aistudy-cards.txt", "text/tab-separated-values;charset=utf-8");
      }
    } catch {
      setError(next === "markdown" ? "暂时无法导出 Markdown，请稍后重试。" : "暂时无法导出 Anki 投影，请稍后重试。");
    } finally {
      setPending(null);
    }
  }

  const copy = kind === "anki"
    ? ankiExportCopy(anki?.lossReport ?? { claimedLossless: false, losses: [] })
    : markdownExportCopy(markdown?.lossReport ?? { claimedLossless: false, losses: [] });
  const hasResult = kind === "anki" ? Boolean(anki) : Boolean(markdown);

  return (
    <section className="space-y-4" aria-labelledby="export-heading">
      <div className="space-y-1">
        <h2 className="text-base font-semibold text-text" id="export-heading">{copy.headline}</h2>
        <p className="text-sm leading-6 text-text-dim">{copy.disclaimer}</p>
      </div>
      <div className="flex flex-wrap gap-3">
        <ExportButton disabled={pending !== null} label="导出 Markdown" pending={pending === "markdown"} onClick={() => void runExport("markdown")} />
        <ExportButton disabled={pending !== null} label="导出 Anki" pending={pending === "anki"} onClick={() => void runExport("anki")} />
      </div>
      {error ? (
        <div className="flex flex-wrap items-center gap-3" role="alert">
          <p className="text-sm text-danger">{error}</p>
          <button className="inline-flex min-h-9 items-center gap-2 rounded-md border border-line px-3 text-xs text-text hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={() => void runExport(kind)} type="button">
            <RefreshCw aria-hidden="true" size={14} />重试
          </button>
        </div>
      ) : null}
      {hasResult ? <p className="text-sm leading-6 text-text-dim" role="status">损失报告：{copy.lossSummary}</p> : null}
    </section>
  );
}

function ExportButton({
  label,
  pending,
  disabled,
  onClick,
}: {
  label: string;
  pending: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className="inline-flex min-h-10 items-center gap-2 rounded-md bg-primary px-3 text-sm font-semibold text-ink hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-60"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {pending ? <LoaderCircle aria-hidden="true" className="animate-spin" size={16} /> : <FileDown aria-hidden="true" size={16} />}
      {label}
    </button>
  );
}

function downloadFile(content: string, filename: string, type: string) {
  if (typeof document === "undefined") return;
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
