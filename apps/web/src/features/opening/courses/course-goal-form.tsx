"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { learningGoalCreateSchema, learningGoalSelectSchema, learningGoalUpdateSchema, type CourseGoal, type CourseGoalUpdate, type LearningGoal, type LearningGoalCreate, type LearningGoalList, type OpeningAdaptivePrefsPatch } from "@aistudy/contracts";
import { createOpeningApi, type OpeningApi } from "../client/api";
import { ui } from "../design/ui";
import { CourseMilestones } from "./course-milestones";
import { createLearningGoalClient, LearningGoalRequestError, type LearningGoalClient } from "./learning-goal-client";
import { userFacingMessage } from "../../../lib/user-facing-error";

export function todayLocalDate(now: Date = new Date()) { return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`; }
export function parseWeeklyMinutes(raw: string): { ok: true; value: number } | { ok: false; error: string } {
  const value = Number(raw.trim());
  return raw.trim() && Number.isInteger(value) && value >= 0 && value <= 3000 ? { ok: true, value } : { ok: false, error: "每周投入分钟须为 0–3000 的整数。" };
}
export function buildCourseGoalPatch(courseId: string, goal: CourseGoalUpdate | null, expectedRevision?: number): OpeningAdaptivePrefsPatch { return { courseGoal: { courseId, goal, ...(expectedRevision === undefined ? {} : { expectedRevision }) } }; }
const pendingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create"), courseId: z.string().uuid(), input: learningGoalCreateSchema }),
  z.object({ kind: z.literal("update"), courseId: z.string().uuid(), id: z.string().uuid(), input: learningGoalUpdateSchema }),
  z.object({ kind: z.literal("select"), courseId: z.string().uuid(), input: learningGoalSelectSchema }),
]);
type Pending = z.infer<typeof pendingSchema>;
const memoryPending = new Map<string, Pending>();
function pendingKey(courseId: string) { return `aistudy:goal-command:${courseId}`; }
function remember(courseId: string, command: Pending | null) {
  if (command) memoryPending.set(courseId, command); else memoryPending.delete(courseId);
  try { if (command) sessionStorage.setItem(pendingKey(courseId), JSON.stringify(command)); else sessionStorage.removeItem(pendingKey(courseId)); return true; } catch { return false; }
}
function restore(courseId: string): Pending | null {
  try { const raw = sessionStorage.getItem(pendingKey(courseId)); if (raw) { const parsed = pendingSchema.safeParse(JSON.parse(raw)); if (parsed.success && parsed.data.courseId === courseId) return parsed.data; } } catch { /* The memory copy remains a request, never an authority result. */ }
  return memoryPending.get(courseId) ?? null;
}
function durablePending(courseId: string) { try { const raw = sessionStorage.getItem(pendingKey(courseId)); if (!raw) return false; const value = pendingSchema.safeParse(JSON.parse(raw)); return value.success && value.data.courseId === courseId; } catch { return false; } }
type Definition = Omit<LearningGoalCreate, "clientKey">;
type Editor = Omit<Definition, "weeklyMinutes"> & { weeklyMinutes: string; id: string | null; revision: number };
function editor(courseId: string, goal?: LearningGoal): Editor { return { id: goal?.id ?? null, revision: goal?.revision ?? 0, title: goal?.title ?? "", courseIds: goal?.courseIds ?? [courseId], kind: goal?.kind ?? "custom", targetDate: goal?.targetDate ?? null, examDate: goal?.examDate ?? null, weeklyMinutes: String(goal?.weeklyMinutes ?? 120), priority: goal?.priority ?? 0, learningMode: goal?.learningMode ?? "auto", successCriteria: goal?.successCriteria ?? "" }; }
function definition(value: Editor): Definition { return { title: value.title, courseIds: value.courseIds, kind: value.kind, targetDate: value.targetDate, examDate: value.examDate, weeklyMinutes: Number(value.weeklyMinutes), priority: value.priority, learningMode: value.learningMode, successCriteria: value.successCriteria }; }
const kindLabels = { custom: "自定义", "final-exam": "期末考试", "entrance-exam": "升学考试", interest: "兴趣与理解", maintenance: "长期保持" };
export function CourseGoalForm(props: { courseId: string; api?: OpeningApi; goalClient?: LearningGoalClient }) { return <GoalEditor key={props.courseId} {...props} />; }
function GoalEditor({ courseId, api: suppliedApi, goalClient }: { courseId: string; api?: OpeningApi; goalClient?: LearningGoalClient }) {
  const api = useMemo(() => suppliedApi ?? createOpeningApi(), [suppliedApi]);
  const client = useMemo(() => goalClient ?? createLearningGoalClient(), [goalClient]);
  const [data, setData] = useState<LearningGoalList | null>(null), [edit, setEdit] = useState(() => editor(courseId));
  const [courses, setCourses] = useState<Array<{ id: string; title: string; archivedAt?: string | null }>>([]);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [reload, setReload] = useState(0);
  const [error, setError] = useState(""), [message, setMessage] = useState(""), [catalogError, setCatalogError] = useState("");
  const [pending, setPending] = useState<Pending | null>(() => restore(courseId));
  const pendingRef = useRef(pending); pendingRef.current = pending;
  const [storageWarning, setStorageWarning] = useState(() => Boolean(restore(courseId)) && !durablePending(courseId));
  const active = useRef(true), writing = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { let live = true; setLoading(true); setError("");
    void client.list().then(value => {
      if (!live) return;
      setData(value);
      const command = pendingRef.current;
      const refreshed = command?.kind === "update" ? value.goals.find(goal => goal.id === command.id) : undefined;
      if (command?.kind === "update" && refreshed && refreshed.revision > command.input.expectedRevision) {
        remember(courseId, null); setPending(null); setMessage("目标已更新，刚才的修改不能直接覆盖。下方显示当前目标，请核对；这不表示刚才的保存一定成功。");
      }
      const selected = value.goals.find(goal => goal.id === value.selectedGoalIds[courseId]);
      setEdit(editor(courseId, refreshed ?? selected ?? value.goals.find(goal => goal.courseIds.includes(courseId))));
    }).catch(reason => { if (live) { setData(null); setError(userFacingMessage(reason, "课程目标暂时无法读取。")); } }).finally(() => { if (live) setLoading(false); });
    void client.courses().then(value => { if (live) { setCourses(value); setCatalogError(""); } }).catch(() => { if (live) setCatalogError("课程列表暂不可读取，已有课程关联仍保留。重新读取后可关联其他课程。"); });
    return () => { live = false; };
  }, [client, courseId, reload]);
  const conflict = data?.legacyConflicts.find(value => value.courseId === courseId);
  const current = data?.goals.find(goal => goal.id === edit.id);
  const selectedId = data?.selectedGoalIds[courseId] ?? null;
  const locked = busy || Boolean(pending);
  function change<K extends keyof Editor>(key: K, value: Editor[K]) { setEdit(previous => ({ ...previous, [key]: value })); setMessage(""); }
  async function execute(command: Pending) {
    if (writing.current) return;
    const retryingUnknown = pending !== null; writing.current = true; setBusy(true); setError(""); setMessage(""); setPending(command); setStorageWarning(!remember(courseId, command));
    try {
      if (command.kind === "select") { const result = await client.select(command.input); if (active.current) setData(result); }
      else {
        const result = command.kind === "create" ? await client.create(command.input) : await client.update(command.id, command.input);
        if (active.current) { setData(previous => previous ? { ...previous, goals: [...previous.goals.filter(goal => goal.id !== result.id), result] } : previous); setEdit(editor(courseId, result)); }
      }
      remember(courseId, null);
      if (active.current) { setPending(null); setMessage(command.kind === "select" ? "已选择本课程使用的目标，其他目标和历史保留。" : "目标已保存。需要切换本课程目标时，请明确选择。" ); if (command.kind === "create") setReload(value => value + 1); }
    } catch (reason) {
      if (reason instanceof LearningGoalRequestError && reason.status >= 400 && reason.status < 500 && reason.status !== 408 && !retryingUnknown) { remember(courseId, null); if (active.current) { setPending(null); setData(null); } }
      if (active.current) setError(userFacingMessage(reason, "保存结果待确认，请原样重新确认这次保存。"));
    } finally { writing.current = false; if (active.current) setBusy(false); }
  }
  function save() {
    if (locked || !data) return;
    const minutes = parseWeeklyMinutes(edit.weeklyMinutes);
    if (!minutes.ok) { setError(minutes.error); return; }
    const value = definition(edit), parsed = learningGoalCreateSchema.safeParse({ ...value, clientKey: "validation-only" });
    if (!parsed.success) { setError("请填写目标名称、有效日期与课程关联；考试日期仅用于考试目标。"); return; }
    void execute(edit.id ? { kind: "update", courseId, id: edit.id, input: { ...value, expectedRevision: edit.revision } } : { kind: "create", courseId, input: { ...value, clientKey: `goal:${crypto.randomUUID()}` } });
  }
  function select() { if (!current || !data || locked) return; void execute({ kind: "select", courseId, input: { courseId, goalId: current.id, expectedRevision: current.revision, expectedSelectedGoalId: selectedId, ...(conflict ? { resolveLegacy: true } : {}) } }); }
  function keepLegacy() { if (!conflict) return; setEdit({ ...editor(courseId), title: "保留的旧课程目标", targetDate: conflict.legacyGoal.targetDate, weeklyMinutes: String(conflict.legacyGoal.weeklyMinutes), priority: conflict.legacyGoal.priority ?? 0, learningMode: conflict.legacyGoal.learningMode ?? "auto" }); setMessage("旧值已填入新目标草稿；创建后再明确选择，其他正式目标不会被覆盖。"); }
  const dirty = current && JSON.stringify(definition(edit)) !== JSON.stringify(definition(editor(courseId, current)));
  function milestonesSaved(fresh: CourseGoal) {
    if (!current) return;
    const updated = { ...current, ...fresh, revision: fresh.revision ?? current.revision };
    setData(previous => previous ? { ...previous, goals: previous.goals.map(goal => goal.id === current.id ? updated : goal) } : previous);
    if (!dirty) setEdit(editor(courseId, updated));
  }
  const courseOptions: Array<{ id: string; title: string; archivedAt?: string | null }> = [...courses, ...edit.courseIds.filter(id => !courses.some(course => course.id === id)).map(id => ({ id, title: id === courseId ? "本课程" : `已关联课程 ${id}` }))];
  return <section id="course-goals" className="space-y-3 border-t border-line pt-5" aria-labelledby="course-goal-heading" data-testid="course-goal-form">
    <h2 id="course-goal-heading" className="text-sm font-semibold text-text">课程目标</h2>
    <p className="text-xs leading-6 text-text-3">一门课程可以有多个目标，一个目标也可关联多门课程。日期可留空；目标预算参与工作区共同安排，保存不会自动授权导师。</p>
    {pending ? <div className="space-y-2" role="status"><p className="text-sm text-warn">保存结果待确认。刚才填写的内容已保留，请用下方按钮继续确认。</p><button type="button" className={ui.secondary} disabled={busy} onClick={() => void execute(pending)}>重新确认这次保存</button>{storageWarning ? <p className="text-xs text-warn">此设备暂时无法保存恢复信息，请保留本页；刷新后可能无法恢复这次请求。</p> : null}</div> : null}
    {loading ? <p role="status" className="text-xs text-text-3">正在读取课程目标…</p> : data ? <>
      {conflict ? <div className="space-y-2 border-l-2 border-warn pl-3"><p className="text-sm text-text-2">旧课程目标尚待明确选择：每周 {conflict.legacyGoal.weeklyMinutes} 分钟，目标日期 {conflict.legacyGoal.targetDate ?? "未设置"}。选择正式目标会保留旧值历史。</p><button type="button" className={ui.quiet} disabled={locked} onClick={keepLegacy}>将旧目标保留为另一个目标</button></div> : null}
      <div className="flex flex-wrap items-end gap-2"><label className="min-w-0 flex-1 space-y-1"><span className={ui.label}>查看与编辑目标</span><select className={ui.input} disabled={locked} value={edit.id ?? ""} onChange={event => setEdit(editor(courseId, data.goals.find(goal => goal.id === event.target.value)))}><option value="">新目标</option>{data.goals.map(goal => <option key={goal.id} value={goal.id}>{goal.title}{selectedId === goal.id ? "（本课程当前目标）" : ""}</option>)}</select></label><button type="button" className={ui.quiet} disabled={locked} onClick={() => setEdit(editor(courseId))}>添加另一个目标</button></div>
      <fieldset disabled={locked} className="space-y-3"><legend className="sr-only">目标定义</legend>
        <label className="block space-y-1"><span className={ui.label}>目标名称</span><input className={ui.input} maxLength={160} value={edit.title} onChange={event => change("title", event.target.value)} /></label>
        <div className="flex flex-wrap gap-3"><label className="min-w-0 flex-1 basis-44 space-y-1"><span className={ui.label}>目标类型</span><select className={ui.input} value={edit.kind} onChange={event => { const kind = event.target.value as Editor["kind"]; setEdit(value => ({ ...value, kind, examDate: ["final-exam", "entrance-exam"].includes(kind) ? value.examDate : null })); }}>{Object.entries(kindLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
        <label className="min-w-0 flex-1 basis-44 space-y-1"><span className={ui.label}>目标日期（可选）</span><input className={ui.input} type="date" value={edit.targetDate ?? ""} onChange={event => change("targetDate", event.target.value || null)} /></label>
        {["final-exam", "entrance-exam"].includes(edit.kind) ? <label className="min-w-0 flex-1 basis-44 space-y-1"><span className={ui.label}>考试日期（可选）</span><input className={ui.input} type="date" value={edit.examDate ?? ""} onChange={event => change("examDate", event.target.value || null)} /></label> : null}</div>
        <label className="block space-y-1"><span className={ui.label}>成功标准</span><textarea className={ui.input} rows={3} maxLength={2000} value={edit.successCriteria} onChange={event => change("successCriteria", event.target.value)} /></label>
        <div className="flex flex-wrap gap-3"><label className="min-w-0 flex-1 basis-40 space-y-1"><span className={ui.label}>每周投入分钟</span><input className={ui.input} type="number" min={0} max={3000} step={1} value={edit.weeklyMinutes} onChange={event => change("weeklyMinutes", event.target.value)} /></label><label className="min-w-0 flex-1 basis-32 space-y-1"><span className={ui.label}>优先级（0–5）</span><input className={ui.input} type="number" min={0} max={5} step={1} value={edit.priority} onChange={event => change("priority", Number(event.target.value))} /></label><label className="min-w-0 flex-1 basis-40 space-y-1"><span className={ui.label}>学习安排</span><select className={ui.input} value={edit.learningMode} onChange={event => change("learningMode", event.target.value as Editor["learningMode"])}><option value="auto">随目标调整</option><option value="understand">理解与迁移</option><option value="exam">应试练习</option></select></label></div>
        {edit.targetDate && edit.targetDate < todayLocalDate() ? <p className="text-xs text-warn">目标日期早于今天，请核对；仍可保留历史目标。</p> : null}
        <fieldset className="space-y-2"><legend className={ui.label}>关联课程（共同使用此目标与预算）</legend>{courseOptions.map(course => <label className="flex items-center gap-2 text-sm text-text-2" key={course.id}><input type="checkbox" value={course.id} checked={edit.courseIds.includes(course.id)} disabled={Boolean(course.archivedAt)} onChange={event => change("courseIds", event.target.checked ? [...edit.courseIds, course.id] : edit.courseIds.filter(id => id !== course.id))} />{course.title}{course.archivedAt ? "（已归档）" : ""}</label>)}{catalogError ? <p className="text-xs text-warn">{catalogError}</p> : null}</fieldset>
      </fieldset>
      <div className="flex flex-wrap gap-2"><button type="button" className={ui.secondary} disabled={locked} onClick={save}>{busy ? "保存中…" : edit.id ? "保存目标" : "创建目标"}</button>{current && current.courseIds.includes(courseId) && (selectedId !== current.id || conflict) ? <button type="button" className={ui.secondary} disabled={locked || Boolean(dirty)} onClick={select}>{conflict ? "使用此目标并保留旧值历史" : "本课程使用此目标"}</button> : null}</div>
      {current && current.id === selectedId && !conflict ? <CourseMilestones key={current.id} courseId={courseId} goal={{ ...current, goalId: current.id }} api={api} onSaved={milestonesSaved} disabled={locked} /> : null}
    </> : null}
    {error ? <p className="text-xs leading-6 text-danger" role="alert">{error}</p> : null}{message ? <p className="text-xs leading-6 text-text-2" role="status">{message}</p> : null}
    <button type="button" className={ui.quiet} disabled={busy || loading} onClick={() => setReload(value => value + 1)}>重新读取课程目标</button>
  </section>;
}
