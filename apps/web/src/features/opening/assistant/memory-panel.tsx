"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { OpeningApi } from "../client/api";
import { TransitionLink as Link } from "../v3/motion/view-transition";
import { secondaryButtonClass } from "../design/ui";
import { userFacingMessage } from "../../../lib/user-facing-error";

export function memorySourceSummary(sourceTurnIds: string[], sourceIds?: string[]): string {
  const turns = `来源消息：${sourceTurnIds.length} 条`;
  return sourceIds === undefined
    ? turns
    : `${turns} · 关联资料：${sourceIds.length} 份`;
}

export function formatMemoryTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
}

export function MemoryPanel({ api }: { api: OpeningApi }) {
  const [memories, setMemories] = useState<Awaited<ReturnType<OpeningApi["listMemory"]>>["items"]>([]);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++requestId.current;
    const memoryState = await api.listMemory();
    if (request !== requestId.current) return;
    setMemories(memoryState.items.filter((item) => item.status === "active" && item.kind !== "candidate"));
  }, [api]);

  useEffect(() => {
    let active = true;
    void refresh()
      .catch((error) => { if (active) setMessage(userFacingMessage(error, "记忆暂时无法读取")); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [refresh]);

  async function removeMemory(memory: (typeof memories)[number]) {
    if (!window.confirm("删除这条已确认记忆？这不会自动删除来源对话文本。")) return;
    const deleteSourceText = window.confirm("同时删除来源对话文本？此操作不可恢复。点击“确定”将删除来源文本，点击“取消”只删除记忆。\n\n注意：原始上传材料不会被删除。\n");
    setBusyId(memory.id);
    setMessage("");
    try {
      await api.decideMemory({
        id: memory.id,
        expectedVersion: memory.version,
        action: "delete",
        deleteSourceText,
        clientKey: `memory-delete-${memory.id}-${memory.version}-${deleteSourceText ? "text" : "memory"}`,
      });
      await refresh();
    } catch (error) {
      setMessage(userFacingMessage(error, "记忆删除失败；请刷新后重试"));
    } finally {
      setBusyId(null);
    }
  }


  return (
    <section className="space-y-3 pt-3" aria-label="记忆管理">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-text">记忆管理</h2>
        <span className="text-xs text-text-2">记下的内容由你决定是否保留</span>
      </div>
      {message ? <div className="space-y-2"><p className="text-xs leading-5 text-danger" role="alert">{message}</p><button type="button" className={secondaryButtonClass} disabled={loading || Boolean(busyId)} onClick={() => { setLoading(true); setMessage(""); void refresh().catch((error) => setMessage(userFacingMessage(error, "记忆暂时无法读取"))).finally(() => setLoading(false)); }}>重新读取记忆</button></div> : null}
      {loading ? <p role="status" className="text-xs text-text-2">正在读取记忆…</p> : !message && !memories.length ? <p className="text-xs leading-5 text-text-2">暂无已确认记忆。</p> : null}
      {memories.length > 0 ? (
        <div className="mt-3 space-y-2">
          <p className="text-xs font-medium text-text-2">已确认记忆</p>
          {memories.map((memory) => (
            <div key={memory.id} className="border-b border-line py-3">
              <p className="text-sm text-text">{memory.text}</p>
              <p className="mt-1 break-all text-xs text-text-2">{memory.kind === "temporary" ? "临时记忆" : "确认记忆"} · {memorySourceSummary(memory.sourceTurnIds)} · 创建于 <time dateTime={memory.createdAt}>{formatMemoryTime(memory.createdAt)}</time></p>
              <button type="button" disabled={busyId === memory.id} onClick={() => void removeMemory(memory)} className={`${secondaryButtonClass} mt-2 text-danger`}>删除记忆</button>
            </div>
          ))}
          <p className="text-xs text-text-2">删除的是记忆条目；原始学习材料不会因此删除。</p>
        </div>
      ) : null}
      <Link href="/opening/suggestions" className={`${secondaryButtonClass} w-full`}>前往建议收件箱确认记忆</Link>
    </section>
  );
}
