"use client";

import { useCallback, useEffect, useState } from "react";
import type { AssistantCandidateRecord } from "@aistudy/contracts";
import type { OpeningApi } from "../client/api";
import Link from "next/link";
import { buttonClass, secondaryButtonClass } from "../design/ui";

export function memorySourceSummary(sourceTurnIds: string[], sourceIds?: string[]): string {
  const turns = `来源轮次：${sourceTurnIds.length ? sourceTurnIds.join("、") : "无"}`;
  return sourceIds === undefined
    ? turns
    : `${turns} · 关联材料：${sourceIds.length ? sourceIds.join("、") : "无"}`;
}

export function formatMemoryTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
}

export function MemoryPanel({ api }: { api: OpeningApi }) {
  const [candidates, setCandidates] = useState<AssistantCandidateRecord[]>([]);
  const [memories, setMemories] = useState<Awaited<ReturnType<OpeningApi["listMemory"]>>["items"]>([]);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [rows, memoryState] = await Promise.all([api.listCandidates(), api.listMemory()]);
    setCandidates(rows.filter((row) => row.candidate.kind === "memory" && row.status === "pending"));
    setMemories(memoryState.items.filter((item) => item.status === "active" && item.kind !== "candidate"));
  }, [api]);

  useEffect(() => {
    void refresh().catch((error) => setMessage(error instanceof Error ? error.message : "候选记忆暂时无法读取")).finally(() => setLoading(false));
  }, [refresh]);

  async function decide(row: AssistantCandidateRecord, action: "confirm" | "reject") {
    setBusyId(row.id);
    setMessage("");
    try {
      if (row.candidate.kind !== "memory") return;
      await api.decideMemoryCandidate({
        id: row.id,
        expectedVersion: row.version,
        clientKey: `memory-ui-${row.id}-${action}`,
        action,
        expiresAt: row.candidate.temporary ? new Date(Date.now() + 86_400_000).toISOString() : null,
      });
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "记忆候选处理失败；请刷新后重试");
    } finally {
      setBusyId(null);
    }
  }

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
      setMessage(error instanceof Error ? error.message : "记忆删除失败；请刷新后重试");
    } finally {
      setBusyId(null);
    }
  }


  return (
    <section className="space-y-3 pt-3" aria-label="记忆管理">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-zinc-900">记忆管理</h2>
        <span className="text-xs text-zinc-500">模型建议不是事实</span>
      </div>
      {message ? <div className="space-y-2"><p className="text-xs leading-5 text-red-700" role="alert">{message}</p><button type="button" className={secondaryButtonClass} disabled={loading || Boolean(busyId)} onClick={() => { setLoading(true); setMessage(""); void refresh().catch((error) => setMessage(error instanceof Error ? error.message : "记忆暂时无法读取")).finally(() => setLoading(false)); }}>重新读取记忆</button></div> : null}
      {loading ? <p role="status" className="text-xs text-zinc-500">正在读取记忆…</p> : !message && !candidates.length && !memories.length ? <p className="text-xs leading-5 text-zinc-500">暂无已确认记忆或待确认记忆。</p> : null}
      {memories.length > 0 ? (
        <div className="mt-3 space-y-2">
          <p className="text-xs font-medium text-zinc-600">已确认记忆</p>
          {memories.map((memory) => (
            <div key={memory.id} className="border-b border-zinc-200 py-3">
              <p className="text-sm text-zinc-800">{memory.text}</p>
              <p className="mt-1 break-all text-xs text-zinc-500">{memory.kind === "temporary" ? "临时记忆" : "确认记忆"} · {memorySourceSummary(memory.sourceTurnIds)} · 创建于 <time dateTime={memory.createdAt}>{formatMemoryTime(memory.createdAt)}</time></p>
              <button type="button" disabled={busyId === memory.id} onClick={() => void removeMemory(memory)} className={`${secondaryButtonClass} mt-2 text-red-700`}>删除记忆</button>
            </div>
          ))}
          <p className="text-xs text-zinc-500">删除的是记忆条目；原始学习材料不会因此删除。</p>
        </div>
      ) : null}
      <ul className="mt-3 space-y-2">
        {candidates.map((row) => {
          if (row.candidate.kind !== "memory") return null;
          return (
            <li key={row.id} className="border-b border-zinc-200 py-3">
              <p className="text-sm text-zinc-800">{row.candidate.text}</p>
              <p className="mt-1 break-all text-xs text-zinc-500">{memorySourceSummary([row.sourceTurnId], row.sourceIds)} · 创建于 <time dateTime={row.createdAt}>{formatMemoryTime(row.createdAt)}</time>。确认后才会进入后续上下文。</p>
              <div className="mt-2 flex gap-2">
                <button type="button" disabled={busyId === row.id} onClick={() => void decide(row, "confirm")} className={buttonClass}>确认</button>
                <button type="button" disabled={busyId === row.id} onClick={() => void decide(row, "reject")} className={secondaryButtonClass}>不记住</button>
              </div>
            </li>
          );
        })}
      </ul>
      <Link href="/opening/review" className={`${secondaryButtonClass} w-full`}>审核任务、记忆与补测建议</Link>
    </section>
  );
}
