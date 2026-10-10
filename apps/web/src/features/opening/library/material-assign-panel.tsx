"use client";

import { FolderInput } from "lucide-react";
import { useState } from "react";
import { ui } from "../design/ui";
import type { MaterialCourse } from "./material-organization-client";

export type MaterialAssignRole = "core" | "optional" | "reference";

export function MaterialAssignPanel({
  courses,
  busy,
  onConfirm,
  onCancel,
}: {
  courses: MaterialCourse[];
  busy: boolean;
  onConfirm: (courseId: string, role: MaterialAssignRole) => Promise<void>;
  onCancel: () => void;
}) {
  const [target, setTarget] = useState("");
  const [role, setRole] = useState<MaterialAssignRole>("reference");
  const active = courses.filter((course) => !course.archived);
  return (
    <section aria-label="归入课程" className="space-y-2 border-t border-emerald-100 bg-emerald-50/40 px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="min-w-0">
          <span className="sr-only">归入课程</span>
          <select
            aria-label="归入课程"
            className={`${ui.input} w-44`}
            disabled={busy}
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          >
            <option value="">选择课程</option>
            {active.map((course) => (
              <option key={course.id} value={course.id}>{course.title}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">材料用途</span>
          <select
            aria-label="材料用途"
            className={`${ui.input} w-32`}
            disabled={busy}
            value={role}
            onChange={(event) => setRole(event.target.value as MaterialAssignRole)}
          >
            <option value="reference">参考资料</option>
            <option value="core">核心教材</option>
            <option value="optional">拓展阅读</option>
          </select>
        </label>
        <button
          type="button"
          className={ui.primary}
          disabled={busy || !target}
          onClick={() => void onConfirm(target, role)}
        >
          <FolderInput size={14} aria-hidden="true" />
          {busy ? "正在整理…" : "确认归入"}
        </button>
        <button type="button" className={ui.quiet} disabled={busy} onClick={onCancel}>取消</button>
      </div>
      {!active.length ? <p className="text-xs text-zinc-500">暂无可用课程，请先新建课程空间。</p> : null}
    </section>
  );
}
