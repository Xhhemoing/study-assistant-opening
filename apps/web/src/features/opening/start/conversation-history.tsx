"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { ConversationSummary } from "@aistudy/contracts";
import { createOpeningApi, type OpeningApi } from "../client/api";
import { LoadingRows, PageHeader, ui } from "../design/ui";

export function ConversationHistory({ api: apiProp }: { api?: OpeningApi }) {
  const api = useMemo(() => apiProp ?? createOpeningApi(), [apiProp]);
  const [rows, setRows] = useState<ConversationSummary[] | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setError("");
    void api.listConversations().then(value => { if (active) setRows(value); })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "对话暂时无法读取。"); });
    return () => { active = false; };
  }, [api, revision]);
  return <section className="mx-auto w-full max-w-[720px]">
    <PageHeader title="全部对话" action={<Link href="/opening/today" className={ui.secondary}>新对话</Link>} />
    {error ? <p role="alert" className="px-5 py-4 text-sm text-danger">{error}<button type="button" className={ui.quiet} onClick={() => setRevision(value => value + 1)}>重新读取</button></p>
      : rows === null ? <div className="p-5"><LoadingRows label="正在读取对话…" /></div>
        : rows.length ? <ul className="divide-y divide-line px-5" aria-label="对话历史">{rows.map(row => <li key={row.id}>
          <Link href={`/opening/assistant?conversation=${encodeURIComponent(row.id)}`} className="block min-h-11 py-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring">
            <span className="block text-[15px] font-medium text-text">{row.title}</span>
            {row.lastTurnPreview ? <span className="mt-1 line-clamp-2 block text-[13px] leading-6 text-text-2">{row.lastTurnPreview}</span> : null}
          </Link>
        </li>)}</ul> : <p className="px-5 py-8 text-sm text-text-2">还没有保存的对话。<Link href="/opening/today" className={ui.quiet}>开始提问</Link></p>}
  </section>;
}
