"use client";

import { ArrowLeft, Save } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { PageHeader, ContentGrid, ContentBlock, LoadError, ui } from "../opening/design/ui";
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
  if (status === 409) return "课程可能已创建，请先查看课程列表。";
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
  const { title, description } = draft;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [nameConflict, setNameConflict] = useState(false);
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
    if (!nextTitle) {
      setError("请填写课程名称。");
      return;
    }
    // Keep the generated URL key with the input so an uncertain retry cannot create a duplicate.
    const nextSlug = normalizeCourseSlug(currentDraft.current.slug) || `course-${crypto.randomUUID()}`;
    if (currentDraft.current.slug !== nextSlug) updateDraft("slug", nextSlug);
    requestPending.current = true;
    setSaving(true);
    setError("");
    setNameConflict(false);
    try {
      const response = await fetch("/api/courses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: nextTitle, slug: nextSlug, description: description.trim() }) });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) { setNameConflict(response.status === 409); setError(courseCreationError(response.status, body)); return; }
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

  return <div className="flex h-full min-h-0 flex-col bg-bg text-text"><PageHeader title="新建课程" action={<Link className={ui.quiet} href={coursesPath}><ArrowLeft aria-hidden="true" size={14} />全部课程</Link>} /><div className="min-h-0 flex-1 overflow-y-auto"><ContentGrid className="px-5 py-6 sm:px-7"><ContentBlock width="prose"><form className="space-y-5" onSubmit={submit} aria-busy={saving}><div className="space-y-1.5"><label className={ui.label} htmlFor="course-title">课程名称</label><input className={ui.input} id="course-title" required maxLength={120} disabled={saving} onChange={(event) => updateDraft("title", event.target.value)} placeholder="例如：高等数学" value={title} /></div><div className="space-y-1.5"><label className={ui.label} htmlFor="course-description">描述</label><textarea className={`${ui.input} min-h-28 leading-7`} id="course-description" maxLength={500} disabled={saving} onChange={(event) => updateDraft("description", event.target.value)} placeholder="想学会什么？（选填）" value={description} /></div>{error ? <LoadError message={error} /> : null}{nameConflict ? <div className="flex flex-wrap gap-2"><Link className={ui.quiet} href={coursesPath}>查看课程列表</Link><button className={ui.secondary} type="button" onClick={() => { updateDraft("slug", `course-${crypto.randomUUID()}`); setNameConflict(false); setError(""); }}>另建一门课程</button></div> : null}<button className={ui.primary} disabled={saving} type="submit"><Save aria-hidden="true" size={14} />{saving ? "创建中" : "创建课程"}</button></form></ContentBlock></ContentGrid></div></div>;
}
