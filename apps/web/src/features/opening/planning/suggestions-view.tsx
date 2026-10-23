"use client";

import Link from "next/link";
import { useMemo } from "react";
import { MemoryPanel } from "../assistant/memory-panel";
import { createOpeningApi } from "../client/api";
import { ReviewView } from "./review-view";
import { PageHeader as V3PageHeader } from "../v3/shell/page-header";

export function SuggestionsView({ tab }: { tab?: string }) {
  const api = useMemo(() => createOpeningApi(), []);
  const memory = tab === "memory";
  const tabs = <nav aria-label="AI 建议与记忆" className="flex shrink-0 items-center gap-0.5 rounded-pill bg-surface-2 p-0.5">
      <Link className={`rounded-pill px-3 py-1.5 text-ui ${memory ? "text-text-2" : "bg-surface font-medium text-text shadow-[0_1px_2px_rgb(0_0_0/.06)]"}`} aria-current={!memory ? "page" : undefined} href="/opening/suggestions">AI 建议</Link>
      <Link className={`rounded-pill px-3 py-1.5 text-ui ${memory ? "bg-surface font-medium text-text shadow-[0_1px_2px_rgb(0_0_0/.06)]" : "text-text-2"}`} aria-current={memory ? "page" : undefined} href="/opening/suggestions?tab=memory">AI 记忆</Link>
    </nav>;
  return <section className="flex h-full min-h-0 flex-col bg-bg text-text">
    <V3PageHeader title={memory ? "AI 记忆" : "待确认建议"} action={tabs} />
    {memory ? <div className="min-h-0 flex-1 overflow-y-auto"><div className="px-4 pb-6 md:px-6"><MemoryPanel api={api} /></div></div> : <div className="min-h-0 flex-1 overflow-y-auto"><ReviewView api={api} embedded /></div>}
  </section>;
}
