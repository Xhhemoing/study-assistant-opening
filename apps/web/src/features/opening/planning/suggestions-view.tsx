"use client";

import Link from "next/link";
import { useMemo } from "react";
import { MemoryPanel } from "../assistant/memory-panel";
import { createOpeningApi } from "../client/api";
import { ui } from "../design/ui";
import { ReviewView } from "./review-view";
import { PageHeader as V3PageHeader } from "../v3/shell/page-header";

export function SuggestionsView({ tab }: { tab?: string }) {
  const api = useMemo(() => createOpeningApi(), []);
  const memory = tab === "memory";
  return <section className="flex h-full min-h-0 flex-col bg-bg text-text">
    <nav aria-label="AI 建议与记忆" className="flex shrink-0 gap-2 border-b border-line p-3">
      <Link className={memory ? ui.quiet : ui.secondary} aria-current={!memory ? "page" : undefined} href="/opening/suggestions">AI 建议</Link>
      <Link className={memory ? ui.secondary : ui.quiet} aria-current={memory ? "page" : undefined} href="/opening/suggestions?tab=memory">AI 记忆</Link>
    </nav>
    {memory ? <div className="min-h-0 flex-1 overflow-y-auto"><V3PageHeader title="AI 记忆" fact="由你确认后用于后续对话，不自动变成笔记或掌握记录。" /><div className="px-4 pb-6 md:px-6"><MemoryPanel api={api} /></div></div> : <div className="min-h-0 flex-1"><ReviewView api={api} /></div>}
  </section>;
}
