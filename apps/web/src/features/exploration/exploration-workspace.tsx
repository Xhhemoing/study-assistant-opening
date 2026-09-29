"use client";

import { ArrowLeft, ArrowUpRight, GitBranch, Plus, RefreshCw, Save, XCircle } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { ExplorationBlockKind, PersistedExploration } from "@aistudy/contracts";
import { EmptyState, LoadError, LoadingRows, PageHeading, textareaClass, ui } from "../opening/design/ui";
import { explorationApi, ExplorationApiError, type ExplorationDetailResponse } from "./exploration-api";

const kindLabels: Record<ExplorationBlockKind, string> = { scratch: "草稿", hypothesis: "假设", open_question: "开放问题" };
const statusLabels = { open: "进行中", closed: "已关闭" } as const;
function errorText(error: unknown): string { return error instanceof ExplorationApiError ? error.message : "探索请求失败，请重试。"; }
function formatDate(value: string): string { return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }

export function ExplorationWorkspaceList() {
  const [items, setItems] = useState<PersistedExploration[]>([]);
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => { setLoading(true); setError(""); try { setItems(await explorationApi.list()); } catch (cause) { setError(errorText(cause)); } finally { setLoading(false); } }, []);
  useEffect(() => { void load(); }, [load]);
  async function submit(event: FormEvent) { event.preventDefault(); if (!title.trim() || busy) return; setBusy(true); setError(""); try { const created = await explorationApi.create({ title }); window.location.assign(`/explore/${created.id}`); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); } }
  return <main className="min-w-0 bg-white">
    <PageHeading title="自由探索" description="保存问题、假设和线索，再决定哪些内容值得沉淀。" />
    <div className="mx-auto max-w-5xl space-y-6 px-5 py-5">
      <form className="flex flex-col gap-2 sm:flex-row" onSubmit={submit} aria-label="开始探索">
        <label className="sr-only" htmlFor="exploration-title">探索主题</label>
        <input className={`${ui.input} flex-1`} id="exploration-title" maxLength={120} onChange={(event) => setTitle(event.target.value)} placeholder="你想弄清楚什么？" value={title} />
        <button className={ui.primary} disabled={busy || !title.trim()} type="submit"><Plus aria-hidden="true" size={15} />{busy ? "创建中" : "开始探索"}</button>
      </form>
      {error ? <LoadError message={error} onRetry={() => void load()} /> : null}
      <section aria-labelledby="exploration-list-heading">
        <div className="flex min-h-10 items-center justify-between border-b border-zinc-200 pb-2">
          <h2 className="text-xs font-medium text-zinc-600" id="exploration-list-heading">我的探索{!loading && !error ? ` · ${items.length}` : ""}</h2>
          <button aria-label="刷新探索列表" className={ui.icon} disabled={loading} onClick={() => void load()} type="button"><RefreshCw aria-hidden="true" size={15} /></button>
        </div>
        {loading ? <LoadingRows label="正在加载探索" /> : null}
        {!loading && !error && items.length === 0 ? <EmptyState title="还没有探索" description="输入一个主题开始，不需要先创建课程或目标。" /> : null}
        {!loading && !error && items.length > 0 ? <ul className="divide-y divide-zinc-100">{items.map((item) => <li key={item.id}>
          <Link className="grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-3 py-3 transition-colors duration-150 hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-700 motion-reduce:transition-none sm:grid-cols-[minmax(0,1fr)_7rem_9rem]" href={`/explore/${item.id}`}>
            <span className="truncate text-sm font-medium text-zinc-800">{item.title}</span>
            <span className={`text-xs ${item.status === "open" ? "text-emerald-700" : "text-zinc-500"}`}>{statusLabels[item.status]}</span>
            <span className="col-span-2 text-xs tabular-nums text-zinc-500 sm:col-span-1 sm:text-right">{formatDate(item.updatedAt)}</span>
          </Link>
        </li>)}</ul> : null}
      </section>
    </div>
  </main>;
}

export function ExplorationWorkspaceDetail({ explorationId }: { explorationId: string }) {
  const [detail, setDetail] = useState<ExplorationDetailResponse>();
  const [branchId, setBranchId] = useState("");
  const [kind, setKind] = useState<ExplorationBlockKind>("scratch");
  const [content, setContent] = useState("");
  const [branchTitle, setBranchTitle] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => { setLoading(true); setError(""); try { const next = await explorationApi.get(explorationId); setDetail(next); setBranchId((current) => current || next.branches[0]?.id || ""); } catch (cause) { setError(errorText(cause)); } finally { setLoading(false); } }, [explorationId]);
  useEffect(() => { void load(); }, [load]);
  const ancestry = useMemo(() => { if (!detail) return []; const byId = new Map(detail.branches.map((branch) => [branch.id, branch])); const result = []; let current = byId.get(branchId); while (current) { result.unshift(current.title); current = current.parentBranchId ? byId.get(current.parentBranchId) : undefined; } return result; }, [branchId, detail]);
  async function addBlock(event: FormEvent) { event.preventDefault(); if (!branchId || !content.trim() || busy) return; setBusy(true); setError(""); try { await explorationApi.createBlock(explorationId, { branchId, kind, content }); setContent(""); await load(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); } }
  async function addBranch(event: FormEvent) { event.preventDefault(); if (!branchId || !branchTitle.trim() || busy) return; setBusy(true); setError(""); try { const branch = await explorationApi.createBranch(explorationId, { title: branchTitle, parentBranchId: branchId }); setBranchTitle(""); setBranchId(branch.id); await load(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); } }
  async function toggleStatus() { if (!detail || busy) return; setBusy(true); setError(""); try { const exploration = await explorationApi.setStatus(explorationId, detail.exploration.status === "open" ? "closed" : "open"); setDetail((current) => current ? { ...current, exploration } : current); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); } }
  if (loading && !detail) return <LoadingRows label="正在加载探索" />;
  if (error && !detail) return <div className="p-5"><LoadError message={error} onRetry={() => void load()} /></div>;
  if (!detail) return null;
  const blocks = detail.blocks.filter((block) => block.branchId === branchId);
  const isClosed = detail.exploration.status === "closed";
  return <main className="min-w-0 bg-white">
    <PageHeading title={detail.exploration.title} description={`${statusLabels[detail.exploration.status]} · ${detail.branches.length} 个分支`} action={<div className="flex flex-wrap gap-1">
      <Link className={ui.quiet} href="/explore"><ArrowLeft aria-hidden="true" size={14} />返回探索</Link>
      <Link className={ui.secondary} href={`/explore/${explorationId}/promotions`}><ArrowUpRight aria-hidden="true" size={14} />候选沉淀</Link>
      <button className={ui.secondary} disabled={busy} onClick={() => void toggleStatus()} type="button">{isClosed ? <Save aria-hidden="true" size={14} /> : <XCircle aria-hidden="true" size={14} />}{isClosed ? "恢复探索" : "关闭探索"}</button>
    </div>} />
    <div className="grid min-w-0 lg:grid-cols-[260px_minmax(0,1fr)]">
      <aside className="space-y-5 border-b border-zinc-200 bg-zinc-50/60 p-4 lg:border-b-0 lg:border-r" aria-label="探索分支">
        <nav className="space-y-1" aria-label="分支谱系"><h2 className="mb-3 text-xs font-medium text-zinc-500">分支谱系</h2>{detail.branches.map((branch) => <button aria-current={branch.id === branchId ? "true" : undefined} className={`flex min-h-10 w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 motion-reduce:transition-none md:min-h-8 ${branch.id === branchId ? "bg-emerald-50 text-emerald-800" : "text-zinc-600 hover:bg-zinc-100"}`} key={branch.id} onClick={() => setBranchId(branch.id)} type="button"><GitBranch aria-hidden="true" className="shrink-0" size={14} /><span className="truncate">{branch.title}</span>{!branch.parentBranchId ? <span className="ml-auto shrink-0 text-[10px] text-zinc-500">根</span> : null}</button>)}</nav>
        <form className="space-y-2 border-t border-zinc-200 pt-4" onSubmit={addBranch}><label className={ui.label} htmlFor="branch-title">从当前分支继续</label><input className={ui.input} disabled={isClosed || busy} id="branch-title" maxLength={120} onChange={(event) => setBranchTitle(event.target.value)} placeholder="新分支标题" value={branchTitle} /><button className={ui.secondary} disabled={busy || isClosed || !branchTitle.trim()} type="submit"><Plus aria-hidden="true" size={14} />创建分支</button></form>
      </aside>
      <section className="min-w-0 space-y-5 px-5 py-5" aria-label="当前分支内容">
        <div className="flex flex-wrap items-center justify-between gap-2"><p className="break-words text-xs text-zinc-500">{ancestry.join(" / ") || "根分支"}</p><span className="text-xs text-zinc-500">{blocks.length} 条内容</span></div>
        {error ? <LoadError message={error} onRetry={() => void load()} /> : null}
        <div className="mx-auto max-w-3xl space-y-4" aria-live="polite">{blocks.length ? blocks.map((block) => <article className="border-b border-zinc-100 pb-4" key={block.id}><p className="mb-1 text-xs font-medium text-zinc-500">{kindLabels[block.kind]}</p><p className="whitespace-pre-wrap break-words text-sm leading-7 text-zinc-800">{block.content}</p></article>) : <EmptyState title="这个分支还没有内容" description="写下一个观察、假设或开放问题。" />}</div>
        <form className="sticky bottom-0 mx-auto max-w-3xl space-y-3 border-t border-zinc-200 bg-white pt-4" onSubmit={addBlock}>
          {isClosed ? <p className="text-xs text-zinc-500">探索已关闭，恢复后可继续添加内容。</p> : null}
          <label className="sr-only" htmlFor="block-content">探索内容</label><textarea className={textareaClass} disabled={busy || isClosed} id="block-content" maxLength={20000} onChange={(event) => setContent(event.target.value)} placeholder="写下一个观察、假设或问题…" value={content} />
          <div className="flex flex-wrap items-center justify-between gap-2"><label className="flex items-center gap-2 text-xs text-zinc-500" htmlFor="block-kind">内容类型<select className={`${ui.input} w-auto`} disabled={busy || isClosed} id="block-kind" onChange={(event) => setKind(event.target.value as ExplorationBlockKind)} value={kind}>{Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><button className={ui.primary} disabled={busy || isClosed || !content.trim()} type="submit"><Plus aria-hidden="true" size={14} />{busy ? "保存中" : "添加内容"}</button></div>
        </form>
      </section>
    </div>
  </main>;
}
