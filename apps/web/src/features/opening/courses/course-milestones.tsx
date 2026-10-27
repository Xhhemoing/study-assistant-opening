"use client";

import { useEffect, useRef, useState } from "react";
import { courseMilestoneUpdateSchema, type CourseGoal, type CourseMilestone, type CourseMilestoneEvidenceRef, type CourseMilestoneUpdate } from "@aistudy/contracts";
import { createCourseHistoryClient } from "../client/history-client";
import { OpeningApiError, type OpeningApi } from "../client/api";
import { ui } from "../design/ui";
import { Drawer } from "@aistudy/ui";

type EvidenceOption = { ref: CourseMilestoneEvidenceRef; label: string };
type MilestoneApi = Pick<OpeningApi, "patchAdaptivePrefs" | "getAdaptivePrefs" | "listTeachingActivities">;

export function milestoneUpdate(item: CourseMilestone, confirm?: boolean): CourseMilestoneUpdate {
  return { id: item.id, title: item.title, successCriteria: item.successCriteria, targetDate: item.targetDate,
    evidenceRefs: item.evidenceRefs, ...(confirm === undefined ? {} : { confirm }) };
}

export function CourseMilestoneHistory({ item }: { item: CourseMilestone }) {
  return <ol className="space-y-4">{item.history.map(version => <li key={version.revision} className="space-y-2 border-b border-line pb-4 text-sm text-text-2"><h4 className="font-medium text-text">{version.title}</h4><p className="whitespace-pre-wrap leading-6">{version.successCriteria}</p><p className="text-xs">关联 {version.evidenceRefs.length} 条记录 · {version.status === "confirmed_by_learner" ? "曾由你确认" : "待核对"}</p></li>)}</ol>;
}

export function CourseMilestones({ courseId, goal, api, onSaved, disabled = false }: {
  courseId: string; goal: CourseGoal; api: MilestoneApi; onSaved: (goal: CourseGoal) => void; disabled?: boolean;
}) {
  const [editing, setEditing] = useState<CourseMilestoneUpdate | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [mustReload, setMustReload] = useState(false);
  const [options, setOptions] = useState<EvidenceOption[]>([]);
  const [loadingEvidence, setLoadingEvidence] = useState(false);
  const [evidenceNotice, setEvidenceNotice] = useState("");
  const [selected, setSelected] = useState("");
  const [historyId, setHistoryId] = useState<string | null>(null);
  const active = useRef(true);
  const busy = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const locked = disabled || pending || mustReload;
  const milestones = goal.milestones ?? [];
  const historyItem = milestones.find(item => item.id === historyId);

  async function save(change: CourseMilestoneUpdate) {
    if (busy.current || locked) return;
    const parsed = courseMilestoneUpdateSchema.safeParse(change);
    if (!parsed.success) { setError("请填写成果名称、成功标准和有效的日期。"); return; }
    busy.current = true;
    setPending(true); setError("");
    try {
      const result = await api.patchAdaptivePrefs({ courseGoal: { courseId, expectedRevision: goal.revision ?? 0,
        goal: { targetDate: goal.targetDate, weeklyMinutes: goal.weeklyMinutes, milestones: [parsed.data] } } });
      if (active.current) { onSaved(result.prefs.courseGoals[courseId]!); setEditing(null); }
    } catch (reason) {
      if (active.current) {
        const rejected = reason instanceof OpeningApiError && [400, 404, 422].includes(reason.status);
        setMustReload(!rejected);
        setError(rejected ? reason.message : "保存结果需要核对，请重新读取课程目标后继续。");
      }
    } finally {
      busy.current = false;
      if (active.current) setPending(false);
    }
  }

  async function reload() {
    if (busy.current) return;
    busy.current = true; setPending(true);
    try {
      const result = await api.getAdaptivePrefs();
      const fresh = result.prefs.courseGoals[courseId];
      if (active.current && fresh) { onSaved(fresh); setEditing(null); setMustReload(false); setError(""); }
      else if (active.current) setError("课程目标已清除，请重新进入课程页面。");
    } catch { if (active.current) setError("课程目标暂时无法读取，请稍后重试。"); }
    finally { busy.current = false; if (active.current) setPending(false); }
  }

  async function loadEvidence() {
    if (loadingEvidence) return;
    setLoadingEvidence(true); setEvidenceNotice("");
    const results = await Promise.allSettled([
      createCourseHistoryClient().getHistory({ courseId, limit: 50 }), api.listTeachingActivities(),
    ]);
    if (!active.current) return;
    const found: EvidenceOption[] = [];
    if (results[0].status === "fulfilled") {
      for (const record of results[0].value.observations) found.push({ ref: { kind: "observation", id: record.id },
        label: `${record.skillLabel} · ${record.occurredAt.slice(0, 10)} · 作答记录` });
    }
    if (results[1].status === "fulfilled") {
      for (const activity of results[1].value.filter(item => item.courseId === courseId)) {
        found.push({ ref: { kind: "teaching_activity", id: activity.id }, label: `${activity.intentSummary.slice(0, 80)} · 学习活动` });
      }
    }
    setOptions(found);
    setEvidenceNotice(results.some(result => result.status === "rejected") ? "部分记录读取失败，可重试；未读到的记录不表示没有学习。"
      : results[0].status === "fulfilled" && results[0].value.nextCursor ? "显示最近50条作答及本课程学习活动。" : found.length ? "选择与你的成功标准有关的记录。" : "本课程尚无可选学习记录。");
    setLoadingEvidence(false);
  }

  return <section className="space-y-3 border-t border-line pt-4" aria-labelledby="course-milestones-heading">
    <h3 id="course-milestones-heading" className="text-sm font-semibold text-text">阶段成果</h3>
    <p className="text-xs leading-6 text-text-3">写清能独立完成什么，可关联学习记录，再由你确认。投入分钟、任务完成和自评确认均不自动代表掌握。</p>
    {milestones.map(item => <article key={item.id} className="space-y-2 rounded-lg border border-line p-3">
      <div className="flex flex-wrap justify-between gap-2"><h4 className="text-sm font-medium text-text">{item.title}</h4>
        <span className="text-xs text-text-3">{item.status === "confirmed_by_learner" ? "已由你确认" : "待核对"}</span></div>
      <p className="whitespace-pre-wrap text-xs leading-6 text-text-2">{item.successCriteria}</p>
      <p className="text-xs text-text-3">{item.targetDate ? `目标 ${item.targetDate} · ` : ""}关联 {item.evidenceRefs.length} 条记录</p>
      <div className="flex flex-wrap gap-2"><button type="button" className={ui.quiet} disabled={locked} onClick={() => { setEditing(milestoneUpdate(item)); setError(""); }}>编辑成果</button>
        <button type="button" className={ui.secondary} disabled={locked || editing !== null} onClick={() => void save(milestoneUpdate(item, item.status !== "confirmed_by_learner"))}>{item.status === "confirmed_by_learner" ? "重新待核对" : "由我确认达成"}</button></div>
      {item.history.length ? <button type="button" className={ui.quiet} onClick={() => setHistoryId(item.id)}>查看此前标准与记录（{item.history.length}次）</button> : null}
    </article>)}
    {!editing && milestones.length < 8 ? <button type="button" className={ui.secondary} disabled={locked} onClick={() => { setEditing({ id: crypto.randomUUID(), title: "", successCriteria: "", targetDate: null, evidenceRefs: [] }); setError(""); }}>添加阶段成果</button> : null}
    {editing ? <div className="space-y-3 rounded-lg border border-accent bg-accent-soft p-3">
      <label className="block space-y-1"><span className={ui.label}>成果名称</span><input className={ui.input} maxLength={120} value={editing.title} disabled={locked} onChange={event => setEditing({ ...editing, title: event.target.value })} /></label>
      <label className="block space-y-1"><span className={ui.label}>成功标准</span><textarea className={ui.input} rows={3} maxLength={500} placeholder="例如：隔天无提示完成两道矩阵乘法变式，并解释维数要求。" value={editing.successCriteria} disabled={locked} onChange={event => setEditing({ ...editing, successCriteria: event.target.value })} /></label>
      <label className="block space-y-1"><span className={ui.label}>目标日期（可选）</span><input type="date" className={ui.input} value={editing.targetDate ?? ""} disabled={locked} onChange={event => setEditing({ ...editing, targetDate: event.target.value || null })} /></label>
      <button type="button" className={ui.quiet} disabled={locked || loadingEvidence} onClick={() => void loadEvidence()}>{loadingEvidence ? "读取学习记录…" : "选择本课程学习记录"}</button>
      {options.length ? <label className="block space-y-1"><span className={ui.label}>关联记录（最多8条）</span><select className={ui.input} disabled={locked || editing.evidenceRefs.length >= 8} value={selected} onChange={event => {
        setSelected(""); const option = options.find(item => `${item.ref.kind}:${item.ref.id}` === event.target.value);
        if (option && !editing.evidenceRefs.some(ref => ref.kind === option.ref.kind && ref.id === option.ref.id)) setEditing({ ...editing, evidenceRefs: [...editing.evidenceRefs, option.ref] });
      }}><option value="">选择一条记录</option>{options.map(option => <option key={`${option.ref.kind}:${option.ref.id}`} value={`${option.ref.kind}:${option.ref.id}`}>{option.label}</option>)}</select></label> : null}
      {evidenceNotice ? <p role="status" className="text-xs text-text-3">{evidenceNotice}</p> : null}
      {editing.evidenceRefs.map((ref, index) => <div key={`${ref.kind}:${ref.id}`} className="flex items-center justify-between gap-2 text-xs text-text-2"><span>{options.find(item => item.ref.kind === ref.kind && item.ref.id === ref.id)?.label ?? `已关联学习记录 ${index + 1}`}</span><button type="button" className={ui.quiet} disabled={locked} onClick={() => setEditing({ ...editing, evidenceRefs: editing.evidenceRefs.filter(item => item !== ref) })}>取消关联</button></div>)}
      <p className="text-xs leading-6 text-text-3">修改成功标准后回到待核对，旧标准和记录保留。保存后可另行确认达成。</p>
      <div className="flex gap-2"><button type="button" className={ui.secondary} disabled={locked} onClick={() => void save(editing)}>{pending ? "保存中…" : "保存成果"}</button><button type="button" className={ui.quiet} disabled={locked} onClick={() => setEditing(null)}>取消编辑</button></div>
    </div> : null}
    {error ? <p className="text-xs text-danger" role="alert">{error}</p> : null}
    {mustReload ? <button type="button" className={ui.secondary} disabled={pending || disabled} onClick={() => void reload()}>重新读取课程目标</button> : null}
    <Drawer open={Boolean(historyItem)} onClose={() => setHistoryId(null)} title="此前标准与记录" description={historyItem?.title}>
      {historyItem ? <CourseMilestoneHistory item={historyItem} /> : null}
    </Drawer>
  </section>;
}
