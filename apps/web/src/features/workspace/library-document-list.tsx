"use client";

import { ArrowDownUp, ArrowUpRight, FileText, Search } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { EmptyState, LoadError, LoadingRows, ui } from "../opening/design/ui";
import { displayDate, hasStringFields, useJsonList } from "../opening/design/use-json-list";

type LibraryDocument = { id: string; title: string; lifecycle: string; updatedAt: string };
const isDocument = (value: unknown): value is LibraryDocument => hasStringFields(value, ["id", "title", "lifecycle", "updatedAt"]);
const lifecycleLabels: Record<string, string> = { scratch: "草稿", active: "使用中", archived: "已归档" };

export function LibraryDocumentList() {
  const { rows, loading, error, reload } = useJsonList<LibraryDocument>("/api/documents", "documents", isDocument);
  const [query, setQuery] = useState(""), [lifecycle, setLifecycle] = useState("all"), [oldest, setOldest] = useState(false);
  const visible = useMemo(() => rows.filter((row) => row.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) && (lifecycle === "all" || row.lifecycle === lifecycle)).sort((a, b) => ((Date.parse(a.updatedAt) || 0) - (Date.parse(b.updatedAt) || 0)) * (oldest ? 1 : -1)), [rows, query, lifecycle, oldest]);
  if (loading) return <LoadingRows label="正在读取笔记..." />;
  if (error) return <LoadError message={error} onRetry={reload} />;
  if (!rows.length) return <EmptyState title="还没有笔记" description="从一段话或一个问题开始，不必先创建课程。" action={<Link href="/library/new" className={ui.primary}>创建第一篇笔记</Link>} />;
  return <div>
    <div className="mb-4 flex flex-wrap items-center gap-2"><label className="relative min-w-0 flex-1 sm:max-w-xs"><Search size={13} aria-hidden="true" className="pointer-events-none absolute left-2.5 top-3.5 text-zinc-500 md:top-2.5" /><input aria-label="搜索笔记标题" placeholder="搜索笔记标题…" className={`${ui.input} pl-8`} value={query} onChange={(event) => setQuery(event.target.value)} /></label><select aria-label="筛选笔记状态" value={lifecycle} onChange={(event) => setLifecycle(event.target.value)} className={`${ui.input} max-w-28`}><option value="all">全部状态</option><option value="scratch">草稿</option><option value="active">使用中</option><option value="archived">已归档</option></select><button type="button" aria-label="切换更新时间排序" aria-pressed={oldest} className={ui.quiet} onClick={() => setOldest(!oldest)}><ArrowDownUp size={12} aria-hidden="true" />{oldest ? "较早更新" : "最近更新"}</button><span role="status" className="ml-auto text-xs text-zinc-500">{visible.length} / {rows.length} 篇</span></div>
    {!visible.length ? <EmptyState title="没有找到匹配的笔记" description="换一个关键词，或选择全部状态。" /> : <><div aria-hidden="true" className="grid grid-cols-[minmax(0,1fr)_64px] gap-3 border-y border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-500 sm:grid-cols-[minmax(0,1fr)_80px_110px_20px]"><span>标题</span><span>状态</span><span className="hidden sm:block">更新时间</span></div><ul aria-label="笔记列表" className="divide-y divide-zinc-200/80 border-b border-zinc-200">{visible.map((document) => <li key={document.id}><Link href={`/library/${encodeURIComponent(document.id)}`} className="group grid min-h-12 grid-cols-[minmax(0,1fr)_64px] items-center gap-3 px-3 py-2.5 transition-colors duration-150 hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-700 motion-reduce:transition-none sm:grid-cols-[minmax(0,1fr)_80px_110px_20px]"><span className="flex min-w-0 items-center gap-2.5"><FileText size={15} aria-hidden="true" className="shrink-0 text-zinc-500" /><span className="truncate text-sm font-medium text-zinc-800">{document.title}</span></span><span className={`w-fit rounded px-1.5 py-0.5 text-xs ${document.lifecycle === "active" ? "bg-emerald-50 text-emerald-800" : "bg-zinc-100 text-zinc-600"}`}>{lifecycleLabels[document.lifecycle] ?? "其他状态"}</span><span className="hidden text-xs tabular-nums text-zinc-500 sm:block">{displayDate(document.updatedAt)}</span><ArrowUpRight size={13} aria-hidden="true" className="hidden text-zinc-400 group-hover:text-zinc-800 sm:block" /></Link></li>)}</ul></>}
  </div>;
}
