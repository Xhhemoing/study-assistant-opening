"use client";

import { ArrowUpRight, BookOpen, Download, FilePlus2, Files, Import, Info, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { createOpeningApi, type OpeningApi } from "../client/api";
import { ui } from "../design/ui";
import { LibraryDocumentList } from "../../workspace/library-document-list";
import { MemoryPanel } from "../assistant/memory-panel";
import { MaterialLibrary } from "./material-library";
import type { SourceViewerTarget } from "../inbox/source-viewer";

const tabs = [{ id: "notes", label: "笔记", icon: BookOpen }, { id: "materials", label: "材料", icon: Files }, { id: "review", label: "AI 记忆", icon: ShieldCheck }];

export function LibraryView({ tab = "notes", basePath = "/opening/library", api: supplied, courseId = null, initialOpen = null }: { tab?: string; basePath?: "/library" | "/opening/library"; api?: OpeningApi; courseId?: string | null; initialOpen?: SourceViewerTarget | null }) {
  const api = useMemo(() => supplied ?? createOpeningApi(), [supplied]);
  const selected = tabs.some((item) => item.id === tab) ? tab : "notes";
  return <section className="flex h-full min-h-0 flex-col bg-white text-zinc-800">
    <header className="flex min-h-16 shrink-0 flex-wrap items-end justify-between gap-3 border-b border-zinc-200/80 px-5 pb-4 pt-5 sm:px-7"><div className="min-w-0 motion-safe:animate-enter"><h1 className="text-lg font-semibold text-zinc-950">知识库</h1><p className="mt-0.5 text-[13px] text-zinc-500">笔记、材料与 AI 记忆分别保存，共用一个知识空间。</p></div><div className="flex flex-wrap items-center gap-1.5"><Link className={ui.quiet} href="/preview/notion-import" title="从 Notion 导出文件本地预览导入"><Import size={14} aria-hidden="true" />导入</Link><Link className={ui.quiet} href="/settings/export"><Download size={14} aria-hidden="true" />导出</Link>{selected === "materials" ? <a className={ui.primary} href="#upload"><FilePlus2 size={14} aria-hidden="true" />上传材料</a> : <Link className={ui.primary} href="/library/new"><FilePlus2 size={14} aria-hidden="true" />新建笔记</Link>}</div></header>
    <nav aria-label="知识库分类" className="flex shrink-0 items-center gap-5 overflow-x-auto border-b border-zinc-200/80 px-5 sm:px-7">{tabs.map(({ id, label, icon: Icon }) => <Link key={id} aria-current={selected === id ? "page" : undefined} href={`${basePath}?tab=${id}`} className={`flex min-h-11 shrink-0 items-center gap-2 border-b-2 px-1 text-[13px] font-medium transition-[color,border-color] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-600/50 motion-reduce:transition-none ${selected === id ? "border-emerald-600 text-emerald-900" : "border-transparent text-zinc-500 hover:border-zinc-300 hover:text-zinc-900"}`}><Icon size={14} aria-hidden="true" />{label}</Link>)}</nav>
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-7">{selected === "notes" ? <LibraryDocumentList /> : selected === "materials" ? <MaterialLibrary api={api} courseId={courseId} initialOpen={initialOpen} /> : <><div className="mb-5 flex flex-wrap items-start justify-between gap-3"><p className="flex items-start gap-2 text-sm leading-6 text-zinc-500"><Info size={15} className="mt-0.5 shrink-0" aria-hidden="true" />确认后才用于后续对话，不自动变成笔记。</p><Link className={ui.secondary} href="/opening/review">审核待确认建议<ArrowUpRight size={13} aria-hidden="true" /></Link></div><MemoryPanel api={api} /></>}</div>
  </section>;
}
