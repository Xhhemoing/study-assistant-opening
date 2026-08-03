"use client";

import { BookOpen, Plus, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { coursePath, type CourseSummary } from "./course-model";

export function CourseListLoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <section className="space-y-3 border-y border-line py-8" role="alert"><p className="text-sm text-danger">{message}</p><button className="inline-flex min-h-10 items-center gap-2 rounded-md border border-line px-3 text-sm text-text hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={onRetry} type="button"><RefreshCw aria-hidden="true" size={16} />重试</button></section>;
}

export function CourseList() {
  const [courses, setCourses] = useState<CourseSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);

  const loadCourses = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/courses", { cache: "no-store" });
      if (!response.ok) throw new Error("课程加载失败");
      const body = await response.json() as { courses?: CourseSummary[] };
      setCourses(body.courses ?? []);
    } catch {
      setError("课程列表加载失败，请重试。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadCourses(); }, [loadCourses, reloadToken]);

  return <main className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
    <header className="flex flex-col gap-4 border-b border-line pb-6 sm:flex-row sm:items-end sm:justify-between"><div className="space-y-2"><p className="text-xs text-text-dim">学习空间</p><h1 className="text-2xl font-semibold tracking-[-0.02em] text-text">课程</h1><p className="max-w-prose text-sm leading-6 text-text-dim">把长期学习材料放在一个可以持续调整的容器里。</p></div><Link className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-ink hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" href="/learn/courses/new"><Plus aria-hidden="true" size={16} />新建课程</Link></header>
    {loading ? <p className="border-y border-line py-8 text-sm text-text-dim" role="status">正在读取课程…</p> : null}
    {error ? <CourseListLoadError message={error} onRetry={() => setReloadToken((value) => value + 1)} /> : null}
    {!loading && !error && courses.length === 0 ? <section className="space-y-3 border-y border-line py-10"><BookOpen aria-hidden="true" className="text-primary" size={22} /><h2 className="text-base font-semibold text-text">还没有课程</h2><p className="text-sm leading-6 text-text-dim">先创建一个长期学习容器，再把笔记和目标逐步接入。</p><Link className="inline-flex min-h-10 items-center rounded-md bg-primary px-3 text-sm font-semibold text-ink hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" href="/learn/courses/new">创建第一门课程</Link></section> : null}
    {!loading && !error && courses.length > 0 ? <ul className="divide-y divide-line border-y border-line">{courses.map((course) => <li key={course.id}><Link className="flex items-start justify-between gap-4 px-4 py-4 transition-colors hover:bg-surface-2/70 focus-visible:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary" href={coursePath(course.id)}><span className="flex min-w-0 gap-3"><BookOpen aria-hidden="true" className="mt-0.5 shrink-0 text-primary" size={18} /><span className="min-w-0 space-y-1"><span className="block truncate text-sm font-semibold text-text">{course.title}</span><span className="block truncate text-xs text-text-dim">{course.slug} · {course.description || "尚未添加描述"}</span></span></span><span className="shrink-0 text-xs text-text-dim">查看课程</span></Link></li>)}</ul> : null}
  </main>;
}
