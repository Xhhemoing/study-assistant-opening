"use client";

import { ArrowLeft, Save } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { PageHeading, LoadError, ui } from "../opening/design/ui";
import { coursePath, normalizeCourseSlug } from "./course-model";

export function CourseCreate({ opening = false }: { opening?: boolean }) {
  const router = useRouter();
  const coursesPath = opening ? "/opening/courses" : "/learn/courses";
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
      router.push(opening ? `/opening/courses/${encodeURIComponent(body.course.id)}` : coursePath(body.course.id));
    } catch {
      setError("课程创建失败，请检查 slug 是否重复后重试。");
    } finally {
      setSaving(false);
    }
  }

  return <main className="h-full overflow-y-auto bg-white text-zinc-800"><PageHeading title="新建课程" description="课程是组织长期学习材料的可选容器。" action={<Link className={ui.quiet} href={coursesPath}><ArrowLeft aria-hidden="true" size={14} />全部课程</Link>} /><form className="mx-auto max-w-xl space-y-5 px-5 py-6" onSubmit={submit}><div className="space-y-1.5"><label className={ui.label} htmlFor="course-title">课程名称</label><input className={ui.input} id="course-title" required maxLength={120} onChange={(event) => setTitle(event.target.value)} placeholder="例如：高等数学" value={title} /></div><div className="space-y-1.5"><label className={ui.label} htmlFor="course-slug">Slug</label><input className={ui.input} id="course-slug" required onChange={(event) => setSlug(event.target.value)} placeholder="例如：calculus" value={slug} /><p className="text-xs text-zinc-500">仅使用英文、数字和短横线。</p></div><div className="space-y-1.5"><label className={ui.label} htmlFor="course-description">描述</label><textarea className={`${ui.input} min-h-28 leading-7`} id="course-description" maxLength={500} onChange={(event) => setDescription(event.target.value)} placeholder="记录这门课程要解决的长期问题" value={description} /></div>{error ? <LoadError message={error} /> : null}<button className={ui.primary} disabled={saving} type="submit"><Save aria-hidden="true" size={14} />{saving ? "创建中" : "创建课程"}</button></form></main>;
}
