"use client";

import { Link2, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { KnowledgeLink } from "@aistudy/contracts";
import { createKnowledgeLinksApi } from "./knowledge-links-api";

type BacklinksPanelProps = { documentId: string };

type LinkState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; links: KnowledgeLink[] };

function endpointLabel(endpoint: KnowledgeLink["from"]): string {
  if (endpoint.status === "broken") return "链接目标已失效";
  if (endpoint.type === "block" && endpoint.text) return `${endpoint.title ?? "未命名笔记"} · ${endpoint.text}`;
  return endpoint.title ?? "未命名笔记";
}

export function BacklinksPanel({ documentId }: BacklinksPanelProps) {
  const api = useMemo(() => createKnowledgeLinksApi(), []);
  const [reloadToken, setReloadToken] = useState(0);
  const [state, setState] = useState<LinkState>({ status: "loading" });

  const reload = useCallback(() => setReloadToken((value) => value + 1), []);

  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    api.list(documentId)
      .then((links) => {
        if (active) setState({ status: "ready", links });
      })
      .catch(() => {
        if (active) setState({ status: "error", message: "链接暂时无法读取。" });
      });
    return () => { active = false; };
  }, [api, documentId, reloadToken]);

  const links = state.status === "ready"
    ? state.links.filter((link) => link.isIncoming)
    : [];

  return (
    <section className="rounded-lg border border-line bg-surface p-4" aria-labelledby="document-backlinks-title">
      <div className="mb-3 flex items-center gap-2"><Link2 aria-hidden="true" className="text-primary" size={16} /><h2 className="text-sm font-semibold text-text" id="document-backlinks-title">反向链接</h2></div>
      {state.status === "loading" ? <p className="text-xs text-text-dim" role="status">正在读取链接...</p> : null}
      {state.status === "error" ? <div className="flex items-center gap-2" role="alert"><p className="text-xs text-danger">{state.message}</p><button aria-label="重试读取链接" className="inline-grid size-8 place-items-center rounded-md border border-line text-text-dim hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={reload} title="重试读取链接" type="button"><RefreshCw aria-hidden="true" size={14} /></button></div> : null}
      {state.status === "ready" && links.length === 0 ? <p className="text-xs text-text-dim">还没有其他笔记链接到这里</p> : null}
      {state.status === "ready" && links.length > 0 ? <ul className="grid gap-2">{links.map((link) => {
        const source = link.from;
        const broken = source.status === "broken";
        const label = endpointLabel(source);
        const sourceView = broken || !source.documentId
          ? label
          : <Link className="truncate hover:text-primary" href={`/library/${encodeURIComponent(source.documentId)}`}>{label}</Link>;
        return <li key={link.id} className="rounded-md border border-line px-3 py-2 text-sm text-text"><div className="flex items-center justify-between gap-3"><span className="truncate">{sourceView}</span><span className="shrink-0 text-xs text-text-dim">{link.relationType}</span></div></li>;
      })}</ul> : null}
    </section>
  );
}
