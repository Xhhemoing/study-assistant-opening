"use client";

import type { ConversationSummary } from "@aistudy/contracts";
import { PanelLeftClose, PanelLeftOpen, Plus, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createOpeningApi } from "../client/api";
import { ui } from "../v3/ui/controls";
import { AssistantView } from "./assistant-view";
import { userFacingMessage } from "../../../lib/user-facing-error";

/** 会话列表按最近更新排序，可按标题和最后一句过滤 */
export function filterConversations(rows: readonly ConversationSummary[], query: string): ConversationSummary[] {
  const needle = query.trim().toLocaleLowerCase();
  return [...rows]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .filter(row => !needle || row.title.toLocaleLowerCase().includes(needle) || (row.lastTurnPreview ?? "").toLocaleLowerCase().includes(needle));
}

/**
 * The full agent page opens a new conversation unless ?conversation= names one; it never
 * silently resumes the most recent (possibly failed) conversation. The rail keeps history.
 */
export function agentStartsFresh(selectedId: string | null): boolean {
  return selectedId === null;
}

/** 地址里的 ?conversation= 与当前会话同步（不新增历史记录、不触发路由刷新） */
function syncConversationUrl(id: string | null) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("conversation", id); else url.searchParams.delete("conversation");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

/**
 * Agent 全页（导航「助理」）：左 会话列表，中 对话（回答前查了哪些记录以步骤行显示），右 待确认的产出与 AI 记忆。
 * 不新增后台能力：对话、只读查询工具、需确认的写入提案都沿用既有接口；页面里的「问 AI」仍是右侧抽屉快问。
 */
export function AgentWorkspace({ initialConversationId = null }: { initialConversationId?: string | null }) {
  const api = useMemo(() => createOpeningApi(), []);
  const [rows, setRows] = useState<ConversationSummary[] | null>(null);
  const [listError, setListError] = useState("");
  const [query, setQuery] = useState("");
  const [railOpen, setRailOpen] = useState(true);
  // key 变化才重挂对话：选择会话 / 新建对话。对话内部新建出的会话只同步列表与地址，不重挂。
  const [selection, setSelection] = useState<{ id: string | null; key: number }>({ id: initialConversationId, key: 0 });
  const [current, setCurrent] = useState<string | null>(initialConversationId);

  const refresh = useCallback(async () => {
    try { setRows(await api.listConversations()); setListError(""); }
    catch (reason) { setListError(userFacingMessage(reason, "会话列表暂时无法读取")); setRows(value => value ?? []); }
  }, [api]);
  useEffect(() => { void refresh(); }, [refresh]);

  const select = (id: string | null) => {
    setSelection(value => ({ id, key: value.key + 1 }));
    setCurrent(id);
    syncConversationUrl(id);
  };
  const onConversationChange = useCallback((id: string | null) => {
    setCurrent(id);
    syncConversationUrl(id);
    if (id) void refresh();
  }, [refresh]);

  const visible = filterConversations(rows ?? [], query);

  return (
    <div className="flex h-full min-h-0" data-agent-workspace>
      <section aria-label="会话" data-open={railOpen}
        className="hidden w-64 shrink-0 flex-col border-r border-line bg-bg/60 transition-[width,opacity] duration-(--duration-panel) ease-out-expo data-[open=false]:w-0 data-[open=false]:opacity-0 lg:flex"
        inert={!railOpen}>
        <div className="flex h-(--topbar-h) shrink-0 items-center gap-1 px-3">
          <button type="button" className={`${ui.toolbarButton} flex-1 justify-start`} onClick={() => select(null)}><Plus size={14} aria-hidden="true" />新对话</button>
          <button type="button" className={ui.iconSm} aria-label="收起会话列表" onClick={() => setRailOpen(false)}><PanelLeftClose size={15} aria-hidden="true" /></button>
        </div>
        <label className="relative mx-3 mb-2 block">
          <Search size={13} aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-3" />
          <input aria-label="搜索会话" placeholder="搜索会话" value={query} onChange={event => setQuery(event.target.value)}
            className="h-(--control-h-sm) w-full rounded-pill bg-text/5 pl-8 pr-3 text-meta text-text outline-none placeholder:text-text-3 focus-visible:ring-2 focus-visible:ring-accent" />
        </label>
        <nav aria-label="最近会话" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {rows === null ? <p className="px-2 py-1 text-meta text-text-3">正在读取…</p>
            : listError && !rows.length ? <p role="status" className="px-2 py-1 text-meta text-warn">{listError}<button type="button" className="ml-1 underline" onClick={() => void refresh()}>重试</button></p>
              : !visible.length ? <p className="px-2 py-1 text-meta text-text-3">{query.trim() ? "没有匹配的会话" : "还没有会话"}</p>
                : <ul className="space-y-0.5 stagger">{visible.map(row => (
                  <li key={row.id}>
                    <button type="button" aria-current={row.id === current ? "true" : undefined} onClick={() => select(row.id)}
                      className="group relative block w-full rounded-ctl px-3 py-2 text-left transition-colors duration-(--duration-micro) hover:bg-text/5 aria-[current=true]:bg-surface aria-[current=true]:shadow-card">
                      <span className="block truncate text-ui text-text">{row.title}</span>
                      {row.lastTurnPreview ? <span className="block truncate text-meta text-text-3">{row.lastTurnPreview}</span> : null}
                    </button>
                  </li>
                ))}</ul>}
        </nav>
      </section>
      <div className="relative flex min-w-0 flex-1 flex-col">
        {!railOpen ? <button type="button" className={`${ui.iconSm} absolute left-2 top-2 z-30 hidden lg:inline-grid`} aria-label="展开会话列表" onClick={() => setRailOpen(true)}><PanelLeftOpen size={15} aria-hidden="true" /></button> : null}
        <AssistantView key={selection.key} agent initialConversationId={selection.id} startFresh={agentStartsFresh(selection.id)}
          initialTitle="助理" onConversationChange={onConversationChange} />
      </div>
    </div>
  );
}
