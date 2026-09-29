"use client";

import { ArrowLeft, Check, FileText, Plus, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { PromotionCandidateKind, PromotionRecord } from "@aistudy/contracts";
import { EmptyState, LoadError, LoadingRows, PageHeading, textareaClass, ui } from "../opening/design/ui";
import { PromotionApi } from "./promotion-api";

const candidateKinds: Array<{ value: PromotionCandidateKind; label: string }> = [
  { value: "note", label: "笔记" }, { value: "card", label: "复习卡片" },
  { value: "question", label: "练习题" }, { value: "task", label: "学习任务" },
];
const statusLabels = { pending: "待确认", accepted: "已接受", rejected: "已拒绝" };

export function PromotionReview({ explorationId }: { explorationId: string }) {
  const [items, setItems] = useState<PromotionRecord[]>([]);
  const [kind, setKind] = useState<PromotionCandidateKind>("note");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    setLoading(true); setError(undefined);
    try { setItems(await PromotionApi.list(explorationId)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "候选读取失败，请重试。"); }
    finally { setLoading(false); }
  }, [explorationId]);
  useEffect(() => { void load(); }, [load]);

  async function createCandidate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(undefined);
    try {
      const created = await PromotionApi.create(explorationId, { kind, title, body });
      setItems((current) => [...current, created]); setTitle(""); setBody("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "候选创建失败，请重试。"); }
    finally { setBusy(false); }
  }
  async function decide(item: PromotionRecord, action: "accept" | "reject") {
    if (busy) return;
    setBusy(true); setError(undefined);
    try {
      const updated = await PromotionApi[action](item.id);
      setItems((current) => current.map((entry) => entry.id === updated.id ? updated : entry));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "审核失败，请重试。"); }
    finally { setBusy(false); }
  }

  return <main className="min-w-0 bg-white">
    <PageHeading title="候选沉淀" description="审核后再将探索内容转为正式内容。" action={<Link className={ui.quiet} href={`/explore/${explorationId}`}><ArrowLeft aria-hidden="true" size={14} />返回探索</Link>} />
    <div className="mx-auto grid max-w-6xl gap-6 p-5 lg:grid-cols-[minmax(0,1fr)_288px]">
      <section aria-label="候选审核" className="min-w-0">
        <div className="mb-3 flex items-center justify-between border-b border-zinc-200 pb-3"><h2 className="text-xs font-medium text-zinc-600">候选内容{!loading ? ` · ${items.length}` : ""}</h2><button className={ui.quiet} disabled={loading || busy} onClick={() => void load()} type="button">刷新</button></div>
        {error ? <LoadError message={error} onRetry={() => void load()} /> : null}
        {loading ? <LoadingRows label="正在读取候选内容" /> : null}
        {!loading && !error && items.length === 0 ? <EmptyState title="还没有候选内容" description="从探索中整理值得保存的内容，创建后再逐条确认。" /> : null}
        {!loading ? <div className="divide-y divide-zinc-200">{items.map((item) => <article className="space-y-3 py-4" key={item.id}>
          <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="min-w-0 break-words text-sm font-medium text-zinc-900">{item.title}</h3><span className={`text-xs ${item.status === "accepted" ? "text-emerald-700" : "text-zinc-500"}`}>{candidateKinds.find((candidate) => candidate.value === item.kind)?.label ?? item.kind} · {statusLabels[item.status]}</span></div>
          <p className="whitespace-pre-wrap break-words text-sm leading-7 text-zinc-700">{item.body}</p>
          {item.status === "pending" ? <div className="flex gap-2"><button aria-label="接受候选" className={ui.primary} disabled={busy} onClick={() => void decide(item, "accept")} type="button"><Check aria-hidden="true" size={14} />接受</button><button aria-label="拒绝候选" className={ui.secondary} disabled={busy} onClick={() => void decide(item, "reject")} type="button"><X aria-hidden="true" size={14} />拒绝</button></div> : null}
          {item.status === "accepted" && item.targetType === "document" ? <Link className={ui.secondary} href={`/library/${item.targetId}`}><FileText aria-hidden="true" size={14} />打开笔记</Link> : null}
        </article>)}</div> : null}
      </section>
      <aside className="space-y-4 border-t border-zinc-200 pt-5 lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
        <h2 className="text-sm font-medium text-zinc-800">新建候选</h2>
        <form className="grid gap-3" onSubmit={createCandidate}>
          <label className="grid gap-1.5"><span className={ui.label}>内容类型</span><select aria-label="候选类型" className={ui.input} disabled={busy} value={kind} onChange={(event) => setKind(event.target.value as PromotionCandidateKind)}>{candidateKinds.map((candidate) => <option key={candidate.value} value={candidate.value}>{candidate.label}</option>)}</select></label>
          <label className="grid gap-1.5"><span className={ui.label}>标题</span><input aria-label="候选标题" className={ui.input} disabled={busy} maxLength={200} required value={title} onChange={(event) => setTitle(event.target.value)} /></label>
          <label className="grid gap-1.5"><span className={ui.label}>内容</span><textarea aria-label="候选内容" className={textareaClass} disabled={busy} maxLength={20000} required value={body} onChange={(event) => setBody(event.target.value)} /></label>
          <button className={ui.primary} disabled={busy} type="submit"><Plus aria-hidden="true" size={14} />{busy ? "处理中" : "创建候选"}</button>
        </form>
      </aside>
    </div>
  </main>;
}
