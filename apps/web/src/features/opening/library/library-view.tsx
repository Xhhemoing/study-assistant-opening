"use client";

import { BookOpen, FilePlus2, Files, Info, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { createOpeningApi, type OpeningApi } from "../client/api";
import { ui } from "../design/ui";
import { LibraryDocumentList } from "../../workspace/library-document-list";
import { MemoryPanel } from "../assistant/memory-panel";
import { MaterialLibrary } from "./material-library";

const tabs = [{ id: "notes", label: "笔记", icon: BookOpen }, { id: "materials", label: "材料", icon: Files }, { id: "review", label: "AI 记忆与审核", icon: ShieldCheck }];

export function LibraryView({ tab = "notes", basePath = "/opening/library", api: supplied }: { tab?: string; basePath?: "/library" | "/opening/library"; api?: OpeningApi }) {
  const api = useMemo(() => supplied ?? createOpeningApi(), [supplied]);
  const selected = tabs.some((item) => item.id === tab) ? tab : "notes";
  return <section className="flex h-full min-h-0 flex-col bg-white text-zinc-800">
    <header className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-zinc-200 px-5 py-2.5"><h1 className="text-sm font-semibold">知识库</h1><div className="flex flex-wrap gap-2"><Link className={ui.quiet} href="/preview/notion-import">Notion 本地预览</Link><Link className={ui.quiet} href="/settings/export">导出与备份</Link><Link className={ui.primary} href="/library/new"><FilePlus2 size={14} aria-hidden="true" />新建笔记</Link></div></header>
    <nav aria-label="知识库分类" className="flex shrink-0 items-center gap-4 overflow-x-auto border-b border-zinc-200 px-5">{tabs.map(({ id, label, icon: Icon }) => <Link key={id} aria-current={selected === id ? "page" : undefined} href={`${basePath}?tab=${id}`} className={`flex min-h-11 shrink-0 items-center gap-1.5 border-b px-1 text-xs transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-700 motion-reduce:transition-none ${selected === id ? "border-emerald-700 font-medium text-emerald-800" : "border-transparent text-zinc-500 hover:text-zinc-900"}`}><Icon size={13} aria-hidden="true" />{label}</Link>)}</nav>
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{selected === "notes" ? <LibraryDocumentList /> : selected === "materials" ? <MaterialLibrary api={api} /> : <><p className="mb-4 flex items-start gap-2 text-xs leading-6 text-zinc-500"><Info size={14} className="mt-1 shrink-0" aria-hidden="true" />确认后才用于后续对话，不自动变成笔记。</p><MemoryPanel api={api} /></>}</div>
    <p className="shrink-0 border-t border-zinc-200 px-5 py-2 text-xs leading-5 text-zinc-500">笔记、材料与 AI 记忆分别保存，共用一个知识空间。</p>
  </section>;
}
