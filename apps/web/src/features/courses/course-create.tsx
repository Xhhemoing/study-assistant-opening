"use client";

import { ArrowLeft, Save } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { coursePath, normalizeCourseSlug } from "./course-model";

export function CourseCreate() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextTitle = title.trim();
    const nextSlug = normalizeCourseSlug(slug);
    if (!nextTitle || !nextSlug || saving) {
      setError("请填写课程名称和英文 slug。");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/courses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: nextTitle, slug: nextSlug, description: description.trim() }) });
      if (!response.ok) throw new Error();
      const body = await response.json() as { course?: { id: string } };
      if (!body.course?.id) throw new Error();
      router.push(coursePath(body.course.id));
    } catch {
      setError("课程创建失败，请检查 slug 是否重复后重试。");
    } finally {
      setSaving(false);
    }
  }

  return <main className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8"><header className="space-y-3 border-b border-line pb-6"><Link className="inline-flex items-center gap-2 text-sm text-text-dim hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" href="/learn/courses"><ArrowLeft aria-hidden="true" size={16} />返回课程</Link><div className="space-y-1"><p className="text-xs text-text-dim">学习空间 / 课程</p><h1 className="text-2xl font-semibold text-text">新建课程</h1></div></header><form className="space-y-6" onSubmit={submit}><div className="grid gap-2"><label className="text-sm font-semibold text-text" htmlFor="course-title">课程名称</label><input className="min-h-11 rounded-md border border-line bg-surface px-3 text-sm text-text outline-none focus:border-primary focus:ring-2 focus:ring-primary/30" id="course-title" maxLength={120} onChange={(event) => setTitle(event.target.value)} placeholder="例如：高等数学" value={title} /></div><div className="grid gap-2"><label className="text-sm font-semibold text-text" htmlFor="course-slug">Slug</label><input className="min-h-11 rounded-md border border-line bg-surface px-3 text-sm text-text outline-none focus:border-primary focus:ring-2 focus:ring-primary/30" id="course-slug" onChange={(event) => setSlug(event.target.value)} placeholder="例如：calculus" value={slug} /><p className="text-xs text-text-dim">仅使用英文、数字和短横线。</p></div><div className="grid gap-2"><label className="text-sm font-semibold text-text" htmlFor="course-description">描述</label><textarea className="min-h-28 resize-y rounded-md border border-line bg-surface px-3 py-2 text-sm leading-6 text-text outline-none focus:border-primary focus:ring-2 focus:ring-primary/30" id="course-description" maxLength={500} onChange={(event) => setDescription(event.target.value)} placeholder="记录这门课程要解决的长期问题" value={description} /></div>{error ? <p className="text-sm text-danger" role="alert">{error}</p> : null}<button className="inline-flex min-h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-ink hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50" disabled={saving} type="submit"><Save aria-hidden="true" size={16} />{saving ? "创建中" : "创建课程"}</button></form></main>;
}
