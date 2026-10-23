"use client";

import { useDiagnosticsEnabled } from "../settings/appearance-preferences";
import type { ObservationRevisionDraft } from "./observation-revision-model";

const fieldClass = "mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring";

export function ObservationRevisionFields({ draft, courses, onChange }: {
  draft: ObservationRevisionDraft;
  courses: Array<{ id: string; title: string }>;
  onChange: (draft: ObservationRevisionDraft) => void;
}) {
  const diagnostics = useDiagnosticsEnabled();
  const change = (patch: Partial<ObservationRevisionDraft>) => onChange({ ...draft, ...patch });
  return <div className="space-y-3">
    <label className="block text-sm text-text">纠正后的回答<textarea className={fieldClass} maxLength={20000} value={draft.answer} onChange={(event) => change({ answer: event.target.value })} rows={4} /></label>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="block text-sm text-text">自报结果<select className={fieldClass} value={draft.outcome} onChange={(event) => change({ outcome: event.target.value as ObservationRevisionDraft["outcome"] })}><option value="unverified">尚未评分</option><option value="correct">自报正确</option><option value="incorrect">自报错误</option></select></label>
      <label className="block text-sm text-text">自报帮助情况<select className={fieldClass} value={draft.assistance} onChange={(event) => change({ assistance: event.target.value as ObservationRevisionDraft["assistance"] })}><option value="unknown">不确定</option><option value="independent">独立完成</option><option value="hinted">使用过提示</option><option value="revealed">看过讲解</option></select></label>
      <label className="block text-sm text-text">所属课程<select className={fieldClass} value={draft.courseId} onChange={(event) => change({ courseId: event.target.value })}>{!courses.some((course) => course.id === draft.courseId) ? <option value={draft.courseId}>记录原所属课程</option> : null}{courses.map((course) => <option key={course.id} value={course.id}>{course.title}</option>)}</select></label>
      <label className="block text-sm text-text">知识点<input className={fieldClass} required maxLength={200} value={draft.skillLabel} onChange={(event) => change({ skillLabel: event.target.value })} /></label>
    </div>
    {diagnostics ? <label className="block text-sm text-text">要求标识（可留空）<input className={fieldClass} maxLength={200} value={draft.requirementKey} onChange={(event) => change({ requirementKey: event.target.value })} /></label> : null}
    <p className="text-xs leading-5 text-text-3">纠正会保留历史作答和帮助记录。参考答案需按纠正后的内容重新核对。</p>
  </div>;
}
