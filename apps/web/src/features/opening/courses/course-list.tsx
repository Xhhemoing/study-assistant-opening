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
  return <section className="flex min-h-full flex-col bg-bg text-text">
    <PageHeader title="课程" action={<Link className={ui.primary} href={createHref}><Plus size={14} aria-hidden="true" />新建课程</Link>} />
    <div className="flex-1">
      <div className="mx-auto w-full max-w-[1040px] px-4 py-5 sm:px-6">
        <div className="mb-5 flex flex-wrap items-center gap-2.5">
          <div role="group" aria-label="课程状态" className={ui.segment}>
            {([{ value: "active", label: "进行中" }, { value: "archived", label: "已归档" }] as const).map((item) => (
              <button className={ui.segmentItem} type="button" key={item.value} aria-pressed={state === item.value} onClick={() => setState(item.value)}>{item.label}</button>
            ))}
          </div>
          <label className="relative min-w-48 flex-1 sm:max-w-xs">
            <Search size={14} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-3" />
            <input aria-label="搜索课程" placeholder="搜索课程或描述…" className={`${ui.input} pl-9`} value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <div role="group" aria-label="视图切换" className={`${ui.segment} ml-auto`}>
            <button type="button" aria-label="列表视图" aria-pressed={!grid} onClick={() => setGrid(false)} className={`${ui.segmentItem} px-2.5`}><List size={15} aria-hidden="true" /></button>
            <button type="button" aria-label="卡片视图" aria-pressed={grid} onClick={() => setGrid(true)} className={`${ui.segmentItem} px-2.5`}><LayoutGrid size={15} aria-hidden="true" /></button>
          </div>
        </div>
        {loading ? <LoadingRows label="正在读取课程…" /> : error ? <CourseListLoadError message={error} onRetry={reload} /> : !rows.length ? <EmptyState title="还没有课程" description="课程是可选的长期容器。你也可以直接探索或写笔记。" action={<Link className={ui.primary} href={createHref}>创建第一门课程</Link>} /> : !courses.length ? <EmptyState title={query.trim() ? "没有匹配的课程" : state === "archived" ? "还没有归档课程" : "没有进行中的课程"} description={query.trim() ? "试试更短的关键词，或清空后查看当前分类。" : state === "archived" ? "归档后课程会出现在这里，随时可以恢复。" : "你可以切换到已归档课程，或创建一门新课程。"} action={query.trim() ? <button className={ui.secondary} type="button" onClick={() => setQuery("")}>清空搜索</button> : undefined} /> : <ul aria-label="课程列表" className={grid ? "grid gap-4 sm:grid-cols-2 lg:grid-cols-3" : "divide-y divide-line overflow-hidden rounded-card border border-line bg-surface shadow-card"}>{courses.map(course => {
          const hasSprint = opening && !course.archivedAt;
          return <li key={course.id} className={grid ? "flex flex-col justify-between overflow-hidden rounded-card border border-line bg-surface shadow-card transition-[border-color,box-shadow] duration-150 ease-out-strong hover:border-line-strong" : "flex flex-wrap items-center gap-2 bg-surface sm:flex-nowrap"}>
            <Link href={opening ? `/opening/courses/${encodeURIComponent(course.id)}` : coursePath(course.id)} vtSource="object-title" direction="forward" className={`group flex min-w-0 flex-1 gap-3.5 px-4 py-4 transition-colors duration-150 ease-out-strong hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent motion-reduce:transition-none ${grid ? "min-h-36 flex-col items-start" : "items-center"}`}>
              <div className={grid ? "flex w-full items-center justify-between gap-2" : "shrink-0"}>
                <CourseCover initial={Array.from(course.title.trim())[0]?.toLocaleUpperCase() ?? "课"} hue={courseHue(course.id)} />
                {grid ? <span className="flex items-center gap-1.5 text-xs tabular-nums text-text-3"><span>{displayDate(course.updatedAt)}</span><ArrowUpRight size={14} aria-hidden="true" className="transition-transform duration-150 ease-out-strong group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-text" /></span> : null}
              </div>
              <span className="min-w-0 flex-1">
                <strong data-vt-title className="block truncate font-serif text-base font-semibold text-text">{course.title}</strong>
                {course.archivedAt ? <span className="mt-1 block text-xs text-text-3">已归档 · 可恢复</span> : null}
                <span className="mt-1 block line-clamp-2 text-xs leading-5 text-text-3">{course.description || "尚未添加描述"}</span>
              </span>
              {!grid ? <>
                <span className="hidden shrink-0 text-xs tabular-nums text-text-3 sm:block">{displayDate(course.updatedAt)}</span>
                <ArrowUpRight size={14} aria-hidden="true" className="shrink-0 text-text-3 transition-transform duration-150 ease-out-strong group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-text" />
              </> : null}
            </Link>
            {hasSprint ? <div className={grid ? "flex items-center justify-end border-t border-line bg-surface-2/35 px-3.5 py-2" : "shrink-0 pb-3 pl-4 pr-3 sm:py-2 sm:pl-0"}><Link href={`/opening/sprint?courseId=${encodeURIComponent(course.id)}`} className={ui.secondary}>考前冲刺</Link></div> : null}
          </li>;
        })}</ul>}
      </div>
    </div>
  </section>;
}
