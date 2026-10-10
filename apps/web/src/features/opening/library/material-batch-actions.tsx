"use client";
import { FolderInput, Trash2, Unlink, X } from "lucide-react";
import { useState } from "react";
import type { MaterialCourse } from "./material-organization-client";
import { ui } from "../design/ui";

const danger = `${ui.secondary} border-red-200 text-red-700 hover:bg-red-50`;

export function MaterialBatchActions({ count, courses, busy, courseId, onAdd, onRemove, onDelete, onClear }: {
  count: number; courses: MaterialCourse[]; busy: boolean; courseId: string | null;
  onAdd: (target: string, role: "core" | "reference" | "optional") => Promise<void>;
  onRemove: () => Promise<void>;
  onDelete?: () => Promise<void>;
  onClear: () => void;
}) {
  const [target, setTarget] = useState(""), [role, setRole] = useState<"core" | "reference" | "optional">("reference");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const active = courses.filter(course => !course.archived);
  return <section aria-label="批量整理材料" className="space-y-3 border-y border-emerald-200 bg-emerald-50/50 px-3 py-3">
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-xs font-medium text-zinc-900">已选择 {count} 份</span>
      <label className="min-w-0"><span className="sr-only">归入课程</span><select aria-label="归入课程" className={`${ui.input} w-44`} disabled={busy} value={target} onChange={event => setTarget(event.target.value)}>
        <option value="">选择课程</option>{active.map(course => <option key={course.id} value={course.id}>{course.title}</option>)}
      </select></label>
      <label><span className="sr-only">材料用途</span><select aria-label="材料用途" className={`${ui.input} w-32`} disabled={busy} value={role} onChange={event => setRole(event.target.value as typeof role)}>
        <option value="reference">参考资料</option><option value="core">核心教材</option><option value="optional">拓展阅读</option>
      </select></label>
      <button type="button" disabled={busy || !target} className={ui.primary} onClick={() => void onAdd(target, role)}><FolderInput size={14} aria-hidden="true" />{busy ? "正在整理…" : "归入课程"}</button>
      {courseId ? <button type="button" disabled={busy} className={ui.quiet} onClick={() => { setConfirmDelete(false); setConfirmRemove(true); }}><Unlink size={14} aria-hidden="true" />移除课程引用</button> : null}
      {onDelete ? <button type="button" disabled={busy} className={danger} onClick={() => { setConfirmRemove(false); setConfirmDelete(true); }}><Trash2 size={14} aria-hidden="true" />删除材料</button> : null}
      <button type="button" disabled={busy} className={ui.icon} aria-label="取消所有材料选择" title="取消选择" onClick={onClear}><X size={14} aria-hidden="true" /></button>
    </div>
    <p className="text-xs text-zinc-500">已有课程引用保留原用途。</p>
    {confirmRemove ? <div className="flex flex-wrap items-center gap-3 text-xs"><p>仅移除当前课程中的引用，原件及其他课程引用保留。</p>
      <button type="button" disabled={busy} className={ui.secondary} onClick={() => { setConfirmRemove(false); void onRemove(); }}>确认移除引用</button>
      <button type="button" disabled={busy} className={ui.quiet} onClick={() => setConfirmRemove(false)}>取消</button>
    </div> : null}
    {confirmDelete && onDelete ? <div className="space-y-2 text-xs text-zinc-700">
      <p>将永久删除所选 {count} 份材料：移除全部课程引用，并清理已知原件与衍生图片。此操作不可撤销；已下载或外部副本不在清理范围内。</p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" disabled={busy} className={danger} onClick={() => { setConfirmDelete(false); void onDelete(); }}>{busy ? "正在删除…" : "确认删除材料"}</button>
        <button type="button" disabled={busy} className={ui.quiet} onClick={() => setConfirmDelete(false)}>取消</button>
      </div>
    </div> : null}
  </section>;
}
