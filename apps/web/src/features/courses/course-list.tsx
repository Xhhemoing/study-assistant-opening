"use client";

import { ArrowUpRight, BookOpen, LayoutGrid, List, Plus, Search } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { coursePath, type CourseSummary } from "./course-model";
import { filterCourses } from "./course-state-model";
import { EmptyState, LoadError, LoadingRows, ui } from "../opening/design/ui";
import { displayDate, hasStringFields, useJsonList } from "../opening/design/use-json-list";

const isCourse = (value: unknown): value is CourseSummary => hasStringFields(value, ["id", "title", "slug", "description", "createdAt", "updatedAt"]);
export function CourseListLoadError({ message, onRetry }: { message: string; onRetry: () => void }) { return <LoadError message={message} onRetry={onRetry} />; }

export function CourseList({ opening = false }: { opening?: boolean }) {
  const { rows, loading, error, reload } = useJsonList<CourseSummary>("/api/courses?includeArchived=true", "courses", isCourse);
  const [query, setQuery] = useState("");
  const [grid, setGrid] = useState(false);
  const [state, setState] = useState<"active" | "archived">("active");
  const courses = useMemo(() => filterCourses(rows, query, state), [rows, query, state]);
  return <section className="flex h-full min-h-0 flex-col bg-white text-zinc-800">
    <header className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-zinc-200 px-5 py-2.5"><h1 className="text-sm font-semibold">课程</h1><Link className={ui.primary} href="/learn/courses/new"><Plus size={14} aria-hidden="true" />新建课程</Link></header>
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      <div aria-label="课程状态" className="mb-3 flex gap-1">{([{ value: "active", label: "进行中" }, { value: "archived", label: "已归档" }] as const).map((item) => <button className={`${ui.quiet} ${state === item.value ? "bg-emerald-50 text-emerald-800" : ""}`} type="button" key={item.value} aria-pressed={state === item.value} onClick={() => setState(item.value)}>{item.label}</button>)}</div>
      <div className="mb-4 flex flex-wrap items-center gap-2"><label className="relative min-w-0 flex-1 sm:max-w-xs"><Search size={13} aria-hidden="true" className="pointer-events-none absolute left-2.5 top-3.5 text-zinc-500 md:top-2.5" /><input aria-label="搜索课程" placeholder="搜索课程或描述…" className={`${ui.input} pl-8`} value={query} onChange={(event) => setQuery(event.target.value)} /></label><div className="ml-auto flex rounded border border-zinc-200 p-0.5"><button type="button" aria-label="列表视图" aria-pressed={!grid} onClick={() => setGrid(false)} className={`${ui.icon} ${!grid ? "bg-emerald-50 text-emerald-800" : ""}`}><List size={14} aria-hidden="true" /></button><button type="button" aria-label="卡片视图" aria-pressed={grid} onClick={() => setGrid(true)} className={`${ui.icon} ${grid ? "bg-emerald-50 text-emerald-800" : ""}`}><LayoutGrid size={14} aria-hidden="true" /></button></div></div>
      {loading ? <LoadingRows label="正在读取课程…" /> : error ? <CourseListLoadError message={error} onRetry={reload} /> : !rows.length ? <EmptyState title="还没有课程" description="课程是可选的长期容器。你也可以直接探索或写笔记。" action={<Link className={ui.primary} href="/learn/courses/new">创建第一门课程</Link>} /> : !courses.length ? <EmptyState title={query.trim() ? "没有匹配的课程" : state === "archived" ? "还没有归档课程" : "没有进行中的课程"} description={query.trim() ? "试试更短的关键词。" : state === "archived" ? "归档后课程会出现在这里，随时可以恢复。" : "你可以切换到已归档课程，或创建一门新课程。"} /> : <ul aria-label="课程列表" className={grid ? "grid gap-px overflow-hidden border border-zinc-200 bg-zinc-200 sm:grid-cols-2 xl:grid-cols-3" : "divide-y divide-zinc-200 border-y border-zinc-200"}>{courses.map((course) => <li key={course.id} className="bg-white"><Link href={opening ? `/opening/courses/${encodeURIComponent(course.id)}` : coursePath(course.id)} className={`group flex gap-3 px-3 py-4 transition-colors duration-150 hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-700 motion-reduce:transition-none ${grid ? "min-h-40 flex-col" : "items-center"}`}><span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-zinc-100 text-zinc-600"><BookOpen size={16} aria-hidden="true" /></span><span className="min-w-0 flex-1"><strong className="block truncate text-sm font-medium">{course.title}</strong>{course.archivedAt ? <span className="mt-1 block text-xs text-zinc-500">已归档 · 可恢复</span> : null}<span className="mt-1 block line-clamp-2 text-xs leading-5 text-zinc-500">{course.description || "尚未添加描述"}</span></span><span className="hidden shrink-0 text-xs text-zinc-500 sm:block">{displayDate(course.updatedAt)}</span><ArrowUpRight size={14} aria-hidden="true" className="shrink-0 text-zinc-400 group-hover:text-zinc-800" /></Link></li>)}</ul>}
    </div><p className="shrink-0 border-t border-zinc-200 px-5 py-2 text-xs text-zinc-500">课程用于组织材料与目标，不限制自由探索。</p>
  </section>;
}
