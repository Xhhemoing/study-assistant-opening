"use client";

import { Link2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { DocumentLink, StudyDataProvider } from "../../lib/data/types";

export function BacklinksPanel({ targetTitle, provider }: { targetTitle: string; provider: StudyDataProvider | null }) {
  const [links, setLinks] = useState<DocumentLink[] | null>(null);

  useEffect(() => {
    if (!provider) return;
    let active = true;
    setLinks(null);
    provider.listBacklinks(targetTitle).then((nextLinks) => {
      if (active) setLinks(nextLinks);
    }).catch(() => {
      if (active) setLinks([]);
    });
    return () => { active = false; };
  }, [provider, targetTitle]);

  return (
    <section className="rounded-lg border border-line bg-surface p-4" aria-labelledby="document-backlinks-title">
      <div className="mb-3 flex items-center gap-2"><Link2 aria-hidden="true" className="text-primary" size={16} /><h2 className="text-sm font-semibold text-text" id="document-backlinks-title">反向链接</h2></div>
      {links === null ? <p className="text-xs text-text-dim">正在读取链接...</p> : null}
      {links?.length === 0 ? <p className="text-xs text-text-dim">还没有其他笔记链接到这里</p> : null}
      {links && links.length > 0 ? <ul className="grid gap-2">{links.map((link) => <li key={`${link.sourceDocumentId}:${link.sourceTitle}`}><Link className="flex items-center justify-between rounded-md border border-line px-3 py-2 text-sm text-text hover:bg-surface-2" href={`/library/${encodeURIComponent(link.sourceDocumentId)}`}><span className="truncate">{link.sourceTitle}</span><span className="text-xs text-text-dim">打开</span></Link></li>)}</ul> : null}
    </section>
  );
}
