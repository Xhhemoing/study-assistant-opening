"use client";

import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { Diagnostics } from "@aistudy/contracts";
import type { StudyDataProvider } from "../../lib/data/types";
import { StatusBadge } from "@aistudy/ui";
import { diagnosticsVersionEntries, recentDiagnosticsEvents } from "./diagnostics-model";

export function DiagnosticsPanel({ provider }: { provider: StudyDataProvider | null }) {
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!provider) return;
    let active = true;
    setLoading(true);
    setError("");
    provider.getDiagnostics().then((next) => { if (active) setDiagnostics(next); }).catch(() => { if (active) setError("诊断信息暂时无法读取，请重试。"); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [provider, reloadToken]);

  return <section className="border-t border-line pt-6" aria-labelledby="diagnostics-heading"><details><summary className="cursor-pointer text-base font-semibold text-text" id="diagnostics-heading">开发者诊断（只读）</summary><div className="mt-4 space-y-5">{loading ? <p className="text-sm text-text-dim" role="status">正在读取诊断信息…</p> : null}{error ? <div className="flex flex-wrap items-center gap-3" role="alert"><p className="text-sm text-danger">{error}</p><button aria-label="重试读取诊断" className="inline-grid size-9 place-items-center rounded-md border border-line text-text-dim hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={() => setReloadToken((value) => value + 1)} title="重试读取诊断" type="button"><RefreshCw aria-hidden="true" size={14} /></button></div> : null}{!loading && !error && diagnostics ? <div className="grid gap-5 text-sm"><section aria-labelledby="diagnostics-versions"><h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-text-dim" id="diagnostics-versions">版本</h3><dl className="grid gap-2 sm:grid-cols-2">{diagnosticsVersionEntries(diagnostics).map(([key, value]) => <div className="flex items-center justify-between gap-4 border-b border-line pb-2" key={key}><dt className="text-text-dim">{key}</dt><dd className="font-mono text-xs text-text">{value}</dd></div>)}</dl></section><section aria-labelledby="diagnostics-events"><h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-text-dim" id="diagnostics-events">最近作答</h3>{recentDiagnosticsEvents(diagnostics).length > 0 ? <ul className="grid gap-2">{recentDiagnosticsEvents(diagnostics).map((event) => <li className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-2" key={event.id}><span className="text-text">{event.correct ? "答对" : "答错"} · 信心 {event.confidence}</span><time className="text-xs text-text-dim" dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString("zh-CN")}</time></li>)}</ul> : <p className="text-text-dim">还没有作答事件。</p>}</section><section aria-labelledby="diagnostics-statuses"><h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-text-dim" id="diagnostics-statuses">能力状态</h3><ul className="grid gap-2">{diagnostics.statuses.slice(0, 10).map((status) => <li className="flex items-center justify-between gap-3 border-b border-line pb-2" key={status.syllabusPointId}><span className="truncate text-text">{status.syllabusPointId}</span><StatusBadge status={status.status} /></li>)}</ul></section><section aria-labelledby="diagnostics-plan"><h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-text-dim" id="diagnostics-plan">计划排序理由</h3>{diagnostics.planTaskReasons.length > 0 ? <ul className="grid gap-2">{diagnostics.planTaskReasons.map((item) => <li className="flex gap-3 border-b border-line pb-2" key={item.taskId}><span className="font-mono text-xs text-text-dim">{item.taskId}</span><span className="text-text">{item.reason}</span></li>)}</ul> : <p className="text-text-dim">今天没有计划任务。</p>}</section></div> : null}</div></details></section>;
}
