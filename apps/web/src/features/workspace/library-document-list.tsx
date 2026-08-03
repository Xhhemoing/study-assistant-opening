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
      <div className="empty-state" role="alert">
        <strong>笔记加载失败</strong>
        <p>{error}</p>
        <button className="button button--secondary" type="button" onClick={() => setReloadKey((value) => value + 1)}>
          <RefreshCw aria-hidden="true" size={17} /> 重试
        </button>
      </div>
    );
  }

  if (documents === null) {
    return <div className="library-loading" aria-live="polite">正在读取笔记...</div>;
  }

  if (documents.length === 0) {
    return (
      <div className="empty-state">
        <strong>还没有笔记</strong>
        <p>后续可在这里创建第一篇笔记，或把探索中的内容沉淀到知识库。</p>
      </div>
    );
  }

  return (
    <ul className="document-list" aria-label="笔记列表">
      {documents.map((document) => (
        <li key={document.id} className="document-list__item">
          <Link className="flex min-w-0 flex-1 items-start gap-3 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" href={`/library/${encodeURIComponent(document.id)}`}>
            <FileText aria-hidden="true" size={19} />
            <span className="min-w-0"><strong className="block truncate">{document.title}</strong><span className="block">{lifecycleLabels[document.lifecycle] ?? document.lifecycle} · 更新于 {new Date(document.updatedAt).toLocaleDateString("zh-CN")}</span></span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
