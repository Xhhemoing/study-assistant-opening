"use client";

import { useCallback, useEffect, useState } from "react";
import type { AssistantCandidateRecord } from "@aistudy/contracts";
import type { OpeningApi } from "../client/api";

export function MemoryPanel({ api }: { api: OpeningApi }) {
  const [candidates, setCandidates] = useState<AssistantCandidateRecord[]>([]);
  const [memories, setMemories] = useState<Awaited<ReturnType<OpeningApi["listMemory"]>>["items"]>([]);
  const [message, setMessage] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [rows, memoryState] = await Promise.all([api.listCandidates(), api.listMemory()]);
    setCandidates(rows.filter((row) => row.candidate.kind === "memory" && row.status === "pending"));
    setMemories(memoryState.items.filter((item) => item.status === "active" && item.kind !== "candidate"));
  }, [api]);

  useEffect(() => {
    void refresh().catch((error) => setMessage(error instanceof Error ? error.message : "候选记忆暂时无法读取"));
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
    setBusyId(memory.id);
    setMessage("");
    try {
      await api.decideMemory({
        id: memory.id,
        expectedVersion: memory.version,
        action: "delete",
        clientKey: `memory-delete-${memory.id}-${memory.version}`,
      });
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "记忆删除失败；请刷新后重试");
    } finally {
      setBusyId(null);
    }
  }

  if (candidates.length === 0 && memories.length === 0 && !message) return null;
  return (
    <section className="border-b border-zinc-200 bg-amber-50/60 p-3" aria-label="记忆管理">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-zinc-900">待确认的记忆</h2>
        <span className="text-xs text-zinc-500">模型建议不是事实</span>
      </div>
      {message ? <p className="mt-2 text-sm text-red-700" role="alert">{message}</p> : null}
      {memories.length > 0 ? (
        <div className="mt-3 space-y-2">
          <p className="text-xs font-medium text-zinc-600">已确认记忆</p>
          {memories.map((memory) => (
            <div key={memory.id} className="rounded-lg border border-zinc-200 bg-white p-3">
              <p className="text-sm text-zinc-800">{memory.text}</p>
              <p className="mt-1 text-xs text-zinc-500">{memory.kind === "temporary" ? "临时记忆" : "确认记忆"} · {memory.sourceTurnIds.length} 个来源轮次</p>
              <button type="button" disabled={busyId === memory.id} onClick={() => void removeMemory(memory)} className="mt-2 min-h-9 rounded-md border border-red-200 px-3 text-sm text-red-700 disabled:opacity-50">删除记忆</button>
            </div>
          ))}
          <p className="text-xs text-zinc-500">删除的是记忆条目；原始学习材料不会因此删除。</p>
        </div>
      ) : null}
      <ul className="mt-3 space-y-2">
        {candidates.map((row) => {
          if (row.candidate.kind !== "memory") return null;
          return (
            <li key={row.id} className="rounded-lg border border-amber-200 bg-white p-3">
              <p className="text-sm text-zinc-800">{row.candidate.text}</p>
              <p className="mt-1 text-xs text-zinc-500">来源：本轮回答关联的材料；确认后才会进入后续上下文。</p>
              <div className="mt-2 flex gap-2">
                <button type="button" disabled={busyId === row.id} onClick={() => void decide(row, "confirm")} className="min-h-9 rounded-md bg-zinc-900 px-3 text-sm text-white disabled:opacity-50">确认</button>
                <button type="button" disabled={busyId === row.id} onClick={() => void decide(row, "reject")} className="min-h-9 rounded-md border border-zinc-300 px-3 text-sm text-zinc-700 disabled:opacity-50">不记住</button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
