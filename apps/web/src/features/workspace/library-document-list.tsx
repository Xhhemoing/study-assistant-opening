"use client";

import { FileText, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

type LibraryDocument = {
  id: string;
  title: string;
  lifecycle: string;
  updatedAt: string;
};

const lifecycleLabels: Record<string, string> = {
  scratch: "草稿",
  active: "使用中",
  archived: "已归档",
};

export function LibraryDocumentList() {
  const [documents, setDocuments] = useState<LibraryDocument[] | null>(null);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setError("");
    setDocuments(null);
    fetch("/api/documents", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const body = await response.json() as { documents: LibraryDocument[] };
        if (active) setDocuments(body.documents);
      })
      .catch(() => {
        if (active) setError("暂时无法读取笔记，请稍后重试。");
      });
    return () => { active = false; };
  }, [reloadKey]);

  if (error) {
    return (
      <section className="space-y-3 border-y border-line py-8" role="alert">
        <h2 className="text-base font-semibold text-text">笔记加载失败</h2>
        <p className="text-sm leading-6 text-danger">{error}</p>
        <button className="inline-flex min-h-10 items-center gap-2 rounded-md border border-line px-3 text-sm text-text hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" type="button" onClick={() => setReloadKey((value) => value + 1)}>
          <RefreshCw aria-hidden="true" size={17} /> 重试
        </button>
      </section>
    );
  }

  if (documents === null) {
    return <p className="border-y border-line py-8 text-sm text-text-dim" role="status" aria-live="polite">正在读取笔记...</p>;
  }

  if (documents.length === 0) {
    return (
      <section className="space-y-3 border-y border-line py-10">
        <h2 className="text-base font-semibold text-text">还没有笔记</h2>
        <p className="max-w-prose text-sm leading-6 text-text-dim">后续可在这里创建第一篇笔记，或把探索中的内容沉淀到知识库。</p>
      </section>
    );
  }

  return (
    <ul className="divide-y divide-line border-y border-line" aria-label="笔记列表">
      {documents.map((document) => (
        <li key={document.id} className="px-4 py-4">
          <Link className="flex min-w-0 items-start gap-3 rounded-md text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" href={`/library/${encodeURIComponent(document.id)}`}>
            <FileText aria-hidden="true" className="mt-0.5 shrink-0 text-primary" size={19} />
            <span className="min-w-0 space-y-1"><strong className="block truncate text-sm font-semibold">{document.title}</strong><span className="block truncate text-xs text-text-dim">{lifecycleLabels[document.lifecycle] ?? document.lifecycle} · 更新于 {new Date(document.updatedAt).toLocaleDateString("zh-CN")}</span></span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
