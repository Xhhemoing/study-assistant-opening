"use client";

import { CourseCover, type CourseCoverProps } from "@aistudy/ui";
import { ArrowUpRight, LayoutGrid, List, Plus, Search } from "lucide-react";
import { TransitionLink as Link } from "../v3/motion/view-transition";
import { useMemo, useState } from "react";
import { coursePath, type CourseSummary } from "./course-model";
import { filterCourses } from "./course-state-model";
import { EmptyState, LoadError, LoadingRows, PageHeader, ui } from "../design/ui";
import { displayDate, hasStringFields, useJsonList } from "../design/use-json-list";

const isCourse = (value: unknown): value is CourseSummary => hasStringFields(value, ["id", "title", "slug", "description", "createdAt", "updatedAt"]);
function courseHue(id: string): CourseCoverProps["hue"] {
  const hues = ["blue", "amber", "green"] as const;
  const hash = Array.from(id).reduce((value, character) => value + character.codePointAt(0)!, 0);
  return hues[hash % hues.length];
}
export function CourseListLoadError({ message, onRetry }: { message: string; onRetry: () => void }) { return <LoadError message={message} onRetry={onRetry} />; }

export function CourseList({ opening = false }: { opening?: boolean }) {
  const { rows, loading, error, reload } = useJsonList<CourseSummary>("/api/courses?includeArchived=true", "courses", isCourse);
  const [query, setQuery] = useState("");
  const [grid, setGrid] = useState(false);
  const [state, setState] = useState<"active" | "archived">("active");
  const courses = useMemo(() => filterCourses(rows, query, state), [rows, query, state]);
  const createHref = opening ? "/opening/courses/new" : "/learn/courses/new";
  return <section className="flex h-full min-h-0 flex-col bg-bg text-text">
    <PageHeader title="课程" action={<Link className={ui.primary} href={createHref}><Plus size={14} aria-hidden="true" />新建课程</Link>} />
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      <div role="group" aria-label="课程状态" className="mb-3 flex gap-1">{([{ value: "active", label: "进行中" }, { value: "archived", label: "已归档" }] as const).map((item) => <button className={`${ui.quiet} ${state === item.value ? "bg-accent-soft text-accent" : ""}`} type="button" key={item.value} aria-pressed={state === item.value} onClick={() => setState(item.value)}>{item.label}</button>)}</div>
      <div className="mb-4 flex flex-wrap items-center gap-2"><label className="relative min-w-0 flex-1 sm:max-w-xs"><Search size={13} aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-3" /><input aria-label="搜索课程" placeholder="搜索课程或描述…" className={`${ui.input} pl-8`} value={query} onChange={(event) => setQuery(event.target.value)} /></label><div className="ml-auto flex rounded border border-line p-0.5"><button type="button" aria-label="列表视图" aria-pressed={!grid} onClick={() => setGrid(false)} className={`${ui.icon} ${!grid ? "bg-accent-soft text-accent" : ""}`}><List size={14} aria-hidden="true" /></button><button type="button" aria-label="卡片视图" aria-pressed={grid} onClick={() => setGrid(true)} className={`${ui.icon} ${grid ? "bg-accent-soft text-accent" : ""}`}><LayoutGrid size={14} aria-hidden="true" /></button></div></div>
      {loading ? <LoadingRows label="正在读取课程…" /> : error ? <CourseListLoadError message={error} onRetry={reload} /> : !rows.length ? <EmptyState title="还没有课程" description="课程是可选的长期容器。你也可以直接探索或写笔记。" action={<Link className={ui.primary} href={createHref}>创建第一门课程</Link>} /> : !courses.length ? <EmptyState title={query.trim() ? "没有匹配的课程" : state === "archived" ? "还没有归档课程" : "没有进行中的课程"} description={query.trim() ? "试试更短的关键词，或清空后查看当前分类。" : state === "archived" ? "归档后课程会出现在这里，随时可以恢复。" : "你可以切换到已归档课程，或创建一门新课程。"} action={query.trim() ? <button className={ui.secondary} type="button" onClick={() => setQuery("")}>清空搜索</button> : undefined} /> : <ul aria-label="课程列表" className={grid ? "grid gap-px overflow-hidden border border-line bg-line sm:grid-cols-2 xl:grid-cols-3" : "divide-y divide-line border-y border-line"}>{courses.map((course) => <li key={course.id} className="bg-surface"><Link href={opening ? `/opening/courses/${encodeURIComponent(course.id)}` : coursePath(course.id)} vtSource="object-title" direction="forward" className={`group flex gap-3 px-3 py-4 transition-colors duration-150 hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent motion-reduce:transition-none ${grid ? "min-h-40 flex-col" : "items-center"}`}><CourseCover initial={Array.from(course.title.trim())[0]?.toLocaleUpperCase() ?? "课"} hue={courseHue(course.id)} /><span className="min-w-0 flex-1"><strong data-vt-title className="block truncate font-serif text-base font-semibold">{course.title}</strong>{course.archivedAt ? <span className="mt-1 block text-xs text-text-3">已归档 · 可恢复</span> : null}<span className="mt-1 block line-clamp-2 text-xs leading-5 text-text-3">{course.description || "尚未添加描述"}</span></span><span className="hidden shrink-0 text-xs text-text-3 sm:block">{displayDate(course.updatedAt)}</span><ArrowUpRight size={14} aria-hidden="true" className="shrink-0 text-text-3 group-hover:text-text" /></Link></li>)}</ul>}

    </div>
  </section>;
}
