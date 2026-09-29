"use client";

import type { LearningPreferences } from "@aistudy/contracts";
import { Archive, ArchiveRestore, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { LoadError, ui } from "../opening/design/ui";
import type { CourseSummary } from "./course-model";
import { createCourseStateClient } from "./course-state-client";
import { courseRestrictionDraft, courseRestrictionUpdate } from "./course-state-model";

const client = createCourseStateClient();
const fields: Array<{ key: keyof LearningPreferences; label: string }> = [
  { key: "assessmentEnabled", label: "自动评价" },
  { key: "retestSuggestionsEnabled", label: "补测建议" },
  { key: "automaticRemindersEnabled", label: "自动学习提醒" },
];

export function CourseSettingsPanel({ course, onChange }: { course: CourseSummary; onChange: (course: CourseSummary) => void }) {
  const [draft, setDraft] = useState(() => courseRestrictionDraft(course.learningPreferenceOverrides));
  const [account, setAccount] = useState<LearningPreferences | null>(null);
  const [effective, setEffective] = useState<LearningPreferences | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [message, setMessage] = useState("");
  const [confirmArchive, setConfirmArchive] = useState(false), [retry, setRetry] = useState(0);
  useEffect(() => { setDraft(courseRestrictionDraft(course.learningPreferenceOverrides)); }, [course.id, course.learningPreferenceOverrides]);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(""); setEffective(null); setAccount(null);
    Promise.all([client.getAccountPreferences(), client.getPreferences(course.id)])
      .then(([currentAccount, currentEffective]) => { if (active) { setAccount(currentAccount); setEffective(currentEffective); } })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "课程设置读取失败，请重试。"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [course.id, course.archivedAt, retry]);

  async function save() {
    setBusy(true); setError(""); setMessage("");
    try {
      setEffective(await client.savePreferences(course.id, draft));
      onChange({ ...course, learningPreferenceOverrides: courseRestrictionUpdate(draft) });
      setMessage("课程设置已保存。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "课程设置保存失败，请重试。"); }
    finally { setBusy(false); }
  }
  async function changeArchive() {
    setBusy(true); setError(""); setMessage("");
    try {
      const saved = await client.setArchived(course.id, !course.archivedAt);
      onChange(saved); setConfirmArchive(false);
      setMessage(saved.archivedAt ? "课程已归档，材料和学习记录仍保留。" : "课程已恢复，不会重发归档前积压的自动建议或提醒。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "课程状态保存失败，请重试。"); }
    finally { setBusy(false); }
  }
  const savedDraft = courseRestrictionDraft(course.learningPreferenceOverrides);
  const changed = fields.some(({ key }) => draft[key] !== savedDraft[key]);
  return <section aria-labelledby="course-settings-heading" className="space-y-3 border-t border-zinc-200 pt-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold" id="course-settings-heading">课程设置</h2><span className="text-xs text-zinc-500">{course.archivedAt ? "已归档" : "进行中"}</span></div>
    <p className="text-xs leading-6 text-zinc-500">课程设置只能进一步关闭自动行为。“跟随账号”不会开启账号中已关闭的项目。手动记录和已接受任务仍可继续。</p>
    {course.archivedAt ? <p className="text-xs leading-6 text-zinc-600">归档期间停止此课程的自动评价、补测建议和学习提醒。恢复后沿用保存的限制，不补发历史积压。</p> : account && !account.assessmentEnabled ? <p className="text-xs leading-6 text-zinc-600">账号已关闭自动评价，此课程的三项自动行为当前均关闭。</p> : null}
    {loading ? <p className="text-xs text-zinc-500" role="status">正在读取课程设置…</p> : <div className="space-y-3">{fields.map(({ key, label }) => <div className="flex flex-wrap items-center gap-3" key={key}>
      <label className="w-28 text-xs font-medium" htmlFor={`course-setting-${key}`}>{label}</label>
      <select className={`${ui.input} max-w-40`} id={`course-setting-${key}`} disabled={busy || !effective} value={draft[key] ? "inherit" : "off"} onChange={(event) => { setDraft((current) => ({ ...current, [key]: event.target.value === "inherit" })); setMessage(""); }}><option value="inherit">跟随账号</option><option value="off">此课程关闭</option></select>
      {effective ? <span className="text-xs text-zinc-500">当前生效：{effective[key] ? "开启" : "关闭"}</span> : null}
    </div>)}<button className={ui.secondary} disabled={busy || !effective || !changed} onClick={() => void save()} type="button"><Save aria-hidden="true" size={14} />{busy ? "保存中…" : "保存课程设置"}</button></div>}
    {error ? <LoadError message={error} onRetry={() => setRetry((value) => value + 1)} /> : null}
    {message ? <p className="text-xs leading-6 text-zinc-600" role="status">{message}</p> : null}
    <div className="space-y-2 border-t border-zinc-100 pt-3">
      {confirmArchive && !course.archivedAt ? <div className="space-y-2"><p className="text-xs leading-6 text-zinc-600">归档会暂停自动学习行为。原件、其他课程引用、笔记、证据和已接受任务都会保留。</p><div className="flex gap-2"><button className={ui.secondary} disabled={busy} onClick={() => void changeArchive()} type="button">确认归档</button><button className={ui.quiet} disabled={busy} onClick={() => setConfirmArchive(false)} type="button">取消</button></div></div> : <button className={ui.secondary} disabled={busy || loading} onClick={() => course.archivedAt ? void changeArchive() : setConfirmArchive(true)} type="button">{course.archivedAt ? <ArchiveRestore aria-hidden="true" size={14} /> : <Archive aria-hidden="true" size={14} />}{course.archivedAt ? "恢复课程" : "归档课程"}</button>}
    </div>
  </section>;
}
