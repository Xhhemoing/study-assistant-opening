"use client";
import { BookOpen, CheckCircle2, Files, Inbox, Plus, TriangleAlert } from "lucide-react";
import { useState } from "react";
import type { SourceRecord } from "@aistudy/contracts";
import type { MaterialOrganization } from "./material-organization-client";
import { materialsInSpace, type MaterialSpace } from "./material-spaces";
import { ui } from "../design/ui";

export function MaterialSpaceNav({ sources, organization, space, onSpace, onCreate, disabled }: {
  sources: SourceRecord[]; organization: MaterialOrganization; space: MaterialSpace;
  onSpace: (space: MaterialSpace) => void; onCreate: (title: string) => Promise<void>; disabled: boolean;
}) {
  const [creating, setCreating] = useState(false), [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const views = [{ id: "all", title: "全部原件", icon: Files }, { id: "inbox", title: "待整理", icon: Inbox },
    { id: "ready", title: "可用于提问", icon: CheckCircle2 }, { id: "attention", title: "需处理", icon: TriangleAlert }] as const;
  async function create() {
    if (!title.trim() || disabled) return;
    setError("");
    try { await onCreate(title); setTitle(""); setCreating(false); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "课程创建失败"); }
  }
  return <aside className="min-w-0 lg:border-r lg:border-zinc-200 lg:pr-4">
    <h2 className="mb-2 text-xs font-semibold text-zinc-500">资料视图</h2>
    <nav aria-label="资料视图" className="flex gap-1 overflow-x-auto lg:flex-col">
      {views.map(({ id, title: label, icon: Icon }) => <button key={id} disabled={disabled} type="button" aria-pressed={space === id}
        className={`${ui.quiet} shrink-0 justify-between gap-3 lg:w-full ${space === id ? "bg-emerald-50 text-emerald-900" : ""}`} onClick={() => onSpace(id)}>
        <span className="flex items-center gap-2"><Icon size={14} aria-hidden="true" />{label}</span><span className="tabular-nums">{materialsInSpace(sources, organization, id).length}</span>
      </button>)}
    </nav>
    <div className="mb-2 mt-6 flex items-center justify-between"><h2 className="text-xs font-semibold text-zinc-500">课程空间</h2>
      <button type="button" className={ui.icon} aria-label="新建课程空间" title="新建课程空间" disabled={disabled} onClick={() => setCreating(value => !value)}><Plus size={14} aria-hidden="true" /></button>
    </div>
    {creating ? <form className="mb-3 space-y-2" onSubmit={event => { event.preventDefault(); void create(); }}>
      <input aria-label="新课程名称" placeholder="课程名称" maxLength={120} className={ui.input} value={title} onChange={event => setTitle(event.target.value)} />
      <div className="flex gap-1"><button type="submit" disabled={!title.trim() || disabled} className={ui.primary}>创建</button><button type="button" disabled={disabled} className={ui.quiet} onClick={() => setCreating(false)}>取消</button></div>
      {error ? <p role="alert" className="text-xs text-red-700">{error}</p> : null}
    </form> : null}
    <nav aria-label="课程资料空间" className="flex gap-1 overflow-x-auto lg:flex-col">
      {organization.courses.map(course => <button key={course.id} type="button" disabled={disabled} aria-pressed={space === `course:${course.id}`} title={course.title}
        className={`${ui.quiet} shrink-0 justify-between gap-2 lg:w-full ${space === `course:${course.id}` ? "bg-emerald-50 text-emerald-900" : ""}`} onClick={() => onSpace(`course:${course.id}`)}>
        <BookOpen size={14} className="shrink-0" aria-hidden="true" /><span className="min-w-0 flex-1 break-words text-left">{course.title}{course.archived ? "（已归档）" : ""}</span>
        <span className="tabular-nums">{organization.memberships.filter(item => item.courseId === course.id).length}</span>
      </button>)}
    </nav>
    {!organization.courses.length ? <p className="py-2 text-xs leading-5 text-zinc-500">暂无课程空间</p> : null}
  </aside>;
}
