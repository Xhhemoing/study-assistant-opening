"use client";

import { ArrowLeft, Save } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { PageHeading, LoadError, ui } from "../opening/design/ui";
import { coursePath, normalizeCourseSlug } from "./course-model";

type CourseDraft = { title: string; slug: string; description: string };
const EMPTY_DRAFT: CourseDraft = { title: "", slug: "", description: "" };

function saveCourseDraft(key: string | null, draft: CourseDraft) {
  if (!key) return;
  try { window.sessionStorage.setItem(key, JSON.stringify(draft)); } catch { /* Storage is optional. */ }
}

function courseCreationError(status: number, body: unknown): string {
  if (status === 401) return "登录状态已过期，请重新登录后继续创建。";
  if (status === 403) return "当前账号没有创建课程的权限。";
  if (status === 409) return "这个 Slug 已被使用，请换一个后重试。";
  if (status >= 500) return "服务暂时不可用，请稍后重试。";
  if (body && typeof body === "object" && "error" in body) {
    const error = body.error;
    if (error && typeof error === "object" && "message" in error && typeof error.message === "string" && error.message.trim()) return error.message;
  }
  return "课程信息未通过校验，请检查填写内容后重试。";
}

export function CourseCreate({ opening = false }: { opening?: boolean }) {
  const router = useRouter();
  const coursesPath = opening ? "/opening/courses" : "/learn/courses";
  const [draft, setDraft] = useState<CourseDraft>(EMPTY_DRAFT);
  const { title, slug, description } = draft;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const currentDraft = useRef(EMPTY_DRAFT);
  const draftEdited = useRef(false);
  const draftStorageKey = useRef<string | null>(null);
  const requestPending = useRef(false);
  const created = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/auth/me", { cache: "no-store", signal: controller.signal }).then(async response => {
      if (!response.ok) return;
      const body = await response.json() as { user?: { id?: unknown; workspaceId?: unknown } };
      if (controller.signal.aborted || typeof body.user?.id !== "string" || typeof body.user.workspaceId !== "string") return;
      const key = `aistudy.course-draft.v1:${encodeURIComponent(body.user.workspaceId)}:${encodeURIComponent(body.user.id)}`;
      draftStorageKey.current = key;
      if (created.current) {
        try { window.sessionStorage.removeItem(key); } catch { /* Storage is optional. */ }
        return;
      }
      if (draftEdited.current) { saveCourseDraft(key, currentDraft.current); return; }
      try {
        const stored: unknown = JSON.parse(window.sessionStorage.getItem(key) ?? "null");
        if (!stored || typeof stored !== "object" || !("title" in stored) || !("slug" in stored) || !("description" in stored)) return;
        if (typeof stored.title !== "string" || typeof stored.slug !== "string" || typeof stored.description !== "string") return;
        if (stored.title.length > 120 || stored.description.length > 500) return;
        const restored = { title: stored.title, slug: stored.slug, description: stored.description };
        currentDraft.current = restored;
        setDraft(restored);
      } catch { /* A missing or unreadable draft must not block course creation. */ }
    }).catch(() => undefined);
    return () => controller.abort();
  }, []);

  function updateDraft(field: keyof CourseDraft, value: string) {
    draftEdited.current = true;
    const next = { ...currentDraft.current, [field]: value };
    currentDraft.current = next;
    setDraft(next);
    saveCourseDraft(draftStorageKey.current, next);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (requestPending.current) return;
    const nextTitle = title.trim();
    const nextSlug = normalizeCourseSlug(slug);
    if (!nextTitle || !nextSlug) {
      setError("请填写课程名称和英文 slug。");
      return;
    }
    requestPending.current = true;
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/courses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: nextTitle, slug: nextSlug, description: description.trim() }) });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) { setError(courseCreationError(response.status, body)); return; }
      const course = body && typeof body === "object" && "course" in body ? body.course : null;
      if (!course || typeof course !== "object" || !("id" in course) || typeof course.id !== "string" || !course.id) {
        setError("服务器返回的课程信息不完整，请先检查课程列表。该课程可能已创建。");
        return;
      }
      created.current = true;
      try { if (draftStorageKey.current) window.sessionStorage.removeItem(draftStorageKey.current); } catch { /* Storage is optional. */ }
      router.push(opening ? `/opening/courses/${encodeURIComponent(course.id)}` : coursePath(course.id));
    } catch {
      setError("网络连接异常，未能确认创建结果。请先检查课程列表，再决定是否重试。");
    } finally {
      requestPending.current = false;
      setSaving(false);
    }
  }

  return <div className="h-full overflow-y-auto bg-surface text-text"><PageHeading title="新建课程" description="课程是组织长期学习材料的可选容器。" action={<Link className={ui.quiet} href={coursesPath}><ArrowLeft aria-hidden="true" size={14} />全部课程</Link>} /><form className="mx-auto max-w-xl space-y-5 px-5 py-6" onSubmit={submit} aria-busy={saving}><div className="space-y-1.5"><label className={ui.label} htmlFor="course-title">课程名称</label><input className={ui.input} id="course-title" required maxLength={120} disabled={saving} onChange={(event) => updateDraft("title", event.target.value)} placeholder="例如：高等数学" value={title} /></div><div className="space-y-1.5"><label className={ui.label} htmlFor="course-slug">Slug</label><input className={ui.input} id="course-slug" required disabled={saving} onChange={(event) => updateDraft("slug", event.target.value)} placeholder="例如：calculus" value={slug} /><p className="text-xs text-text-3">仅使用英文、数字和短横线。</p></div><div className="space-y-1.5"><label className={ui.label} htmlFor="course-description">描述</label><textarea className={`${ui.input} min-h-28 leading-7`} id="course-description" maxLength={500} disabled={saving} onChange={(event) => updateDraft("description", event.target.value)} placeholder="记录这门课程要解决的长期问题" value={description} /></div>{error ? <LoadError message={error} /> : null}<button className={ui.primary} disabled={saving} type="submit"><Save aria-hidden="true" size={14} />{saving ? "创建中" : "创建课程"}</button></form></div>;
}
