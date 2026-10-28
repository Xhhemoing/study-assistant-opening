"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { courseRouteRequirementInputSchema, courseRouteConfirmSchema, courseRouteStartSchema, type CourseRouteRequirementInput, type CourseRouteActionResult, type CourseRouteSnapshot, type LearningGoalList } from "@aistudy/contracts";
import { z } from "zod";
import { ui } from "../design/ui";
import { createCourseRouteClient, CourseRouteRequestError, type CourseRouteClient } from "./course-route-client";
import { createLearningGoalClient, type LearningGoalClient } from "./learning-goal-client";
import { userFacingMessage } from "../../../lib/user-facing-error";
import { CourseSharedSkillControl } from "./course-shared-skill-control";
const statusLabels = { unobserved: "待开始", needs_correction: "需要纠偏", assisted: "受助完成，待独立验证", needs_verification: "待验证", verified: "已有验证记录", blocked: "暂时受阻" };
const delayedLabels = { not_scheduled: "尚未安排", pending: "等待复测", passed: "延迟检查通过", failed: "延迟检查未通过", assisted: "延迟检查受助完成", insufficient_evidence: "延迟检查证据不足", expired: "原复测已过期", cancelled: "原复测已取消" };
const pendingSchema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("confirm"), input: courseRouteConfirmSchema }), z.object({ kind: z.literal("start"), input: courseRouteStartSchema })]);
type Command = z.infer<typeof pendingSchema>;
function pendingKey(courseId: string) { return `aistudy:route-command:${courseId}`; }
function readCommand(courseId: string): Command | null { try { const raw = sessionStorage.getItem(pendingKey(courseId)); const parsed = raw ? pendingSchema.safeParse(JSON.parse(raw)) : null; return parsed?.success ? parsed.data : null; } catch { return null; } }
function requirementInput(row: CourseRouteSnapshot["requirements"][number]): CourseRouteRequirementInput { return courseRouteRequirementInputSchema.parse(Object.fromEntries(Object.entries(row.requirement).filter(([key]) => !["courseId", "revision", "lifecycle", "approvedAt"].includes(key)))); }
export function CourseRoutePanel(props: { courseId: string; archived?: boolean; client?: CourseRouteClient; goalsClient?: Pick<LearningGoalClient, "list">; onNavigate?: (href: string) => void }) { return <RoutePanel key={props.courseId} {...props} />; }
function RoutePanel({ courseId, archived = false, client: suppliedClient, goalsClient, onNavigate = href => window.location.assign(href) }: { courseId: string; archived?: boolean; client?: CourseRouteClient; goalsClient?: Pick<LearningGoalClient, "list">; onNavigate?: (href: string) => void }) {
  const client = useMemo(() => suppliedClient ?? createCourseRouteClient(), [suppliedClient]);
  const goalClient = useMemo(() => goalsClient ?? createLearningGoalClient(), [goalsClient]);
  const [snapshot, setSnapshot] = useState<CourseRouteSnapshot | null>(null), [goals, setGoals] = useState<LearningGoalList | null>(null);
  const [editing, setEditing] = useState<CourseRouteRequirementInput[] | null>(null), [goalId, setGoalId] = useState("");
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [reload, setReload] = useState(0), [error, setError] = useState(""), [goalError, setGoalError] = useState("");
  const [result, setResult] = useState<CourseRouteActionResult | null>(null), [pending, setPending] = useState<Command | null>(() => readCommand(courseId)), [storageWarning, setStorageWarning] = useState(false);
  const writing = useRef(false), active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { let live = true; setLoading(true); setError("");
    void client.read(courseId).then(value => { if (live) { setSnapshot(value); setEditing(null); } }).catch(reason => { if (live) { setSnapshot(null); setError(userFacingMessage(reason, "课程路线暂不可读取。")); } }).finally(() => { if (live) setLoading(false); });
    void goalClient.list(courseId).then(value => { if (live) { setGoals(value); setGoalId(value.selectedGoalIds[courseId] ?? ""); setGoalError(""); } }).catch(() => { if (live) { setGoals(null); setGoalError("目标暂不可读取，请重新读取后开始。"); } });
    return () => { live = false; };
  }, [client, goalClient, courseId, reload]);
  function saveCommand(command: Command | null) { try { if (command) sessionStorage.setItem(pendingKey(courseId), JSON.stringify(command)); else sessionStorage.removeItem(pendingKey(courseId)); return true; } catch { return false; } }
  async function execute(command: Command) {
    if (writing.current || archived) return;
    const retryingUnknown = pending !== null; writing.current = true; setBusy(true); setError(""); setResult(null); setPending(command); setStorageWarning(!saveCommand(command));
    try {
      if (command.kind === "confirm") { const value = await client.confirm(courseId, command.input); if (active.current) { setSnapshot(value); setEditing(null); } }
      else { const value = await client.start(courseId, command.input); if (active.current) { setResult(value); if (value.kind === "ready") onNavigate(value.href); } }
      saveCommand(null); if (active.current) setPending(null);
    } catch (reason) { if (reason instanceof CourseRouteRequestError && reason.status >= 400 && reason.status < 500 && reason.status !== 408 && !retryingUnknown) { saveCommand(null); if (active.current) { setPending(null); setSnapshot(null); } } if (active.current) setError(userFacingMessage(reason, "安排结果尚未确认，请原样重新确认。")); }
    finally { writing.current = false; if (active.current) setBusy(false); }
  }
  function confirm() {
    if (!editing || !snapshot) return;
    const parsed = courseRouteConfirmSchema.safeParse({ expectedRevisions: snapshot.requirements.map(row => ({ id: row.requirement.id, revision: row.requirement.revision })), requirements: editing, confirmScope: true });
    if (!parsed.success) { setError("请检查范围名称、成功标准和前置关联；至少保留一项课程要求。"); return; }
    void execute({ kind: "confirm", input: parsed.data });
  }
  function start(row: CourseRouteSnapshot["requirements"][number]) {
    const goal = goals?.goals.find(value => value.id === goalId);
    if (!goal) { setError("请先明确选择本次学习使用的课程目标。"); return; }
    void execute({ kind: "start", input: { goalId: goal.id, expectedGoalRevision: goal.revision, requirementId: row.requirement.id, expectedRequirementRevision: row.requirement.revision, minutes: 20, clientKey: `route-start:${crypto.randomUUID()}` } });
  }
  function update(id: string, input: Partial<CourseRouteRequirementInput>) { setEditing(rows => rows?.map(row => row.id === id ? { ...row, ...input } : row) ?? null); }
  const locked = busy || Boolean(pending) || archived;
  const availableGoals = goals?.goals.filter(goal => goal.courseIds.includes(courseId)) ?? [];
  return <section id="course-learning-route" aria-labelledby="course-route-heading" className="space-y-3 border-t border-line pt-5">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 id="course-route-heading" className="text-base font-semibold">全课路线与下一步</h2><a className={ui.quiet} href={`?tab=progress#course-goals`}>目标与成功标准</a></div>
    <p className="text-xs leading-6 text-text-3">先核对目标、资料和课程范围，再进入真实学习活动。提取建议与知识图不代表已覆盖全课，学习记录也不会自动宣称掌握。</p>
    {loading ? <p role="status" className="text-sm text-text-3">正在读取课程路线…</p> : snapshot ? <>
      <p className="text-sm text-text-2">{snapshot.scopeState === "confirmed" ? `已确认 ${snapshot.summary.total} 项要求，其中 ${snapshot.summary.mandatory} 项必修；${snapshot.summary.verified} 项已有验证记录，${snapshot.summary.blocked} 项受阻。` : "尚未确认全课范围，请对照大纲和全部资料检查。"}</p>
      {archived ? <p className="text-xs text-warn">课程已归档，路线与记录保留；恢复课程后可开始新的学习。</p> : null}
      {snapshot.currentActivity && ["active", "paused"].includes(snapshot.currentActivity.status) ? <a className={ui.primary} href={`/opening/courses/${courseId}/study?activity=${snapshot.currentActivity.id}`}>继续已有活动：{snapshot.currentActivity.intentSummary}</a> : null}
      <label className="block space-y-1"><span className={ui.label}>本次路线目标</span><select className={ui.input} value={goalId} disabled={locked || !goals} onChange={event => setGoalId(event.target.value)}><option value="">请选择目标</option>{availableGoals.map(goal => <option key={goal.id} value={goal.id}>{goal.title}</option>)}</select></label>{goalError ? <p className="text-xs text-warn">{goalError}</p> : null}{!availableGoals.length && !goalError ? <a className={ui.secondary} href="?tab=progress#course-goals">先确认课程目标</a> : null}
      <ul className="divide-y divide-line border-y border-line">{snapshot.requirements.map(row => <li className="space-y-2 py-3" key={row.requirement.id}><div className="flex flex-wrap justify-between gap-2"><h3 className="text-sm font-medium">{row.requirement.title}{row.requirement.mandatory ? " · 必修" : " · 可选"}</h3><span className="text-xs text-text-3">{statusLabels[row.status]}</span></div>{row.delayedCheck ? <p className="text-xs text-text-3">延迟验证：{delayedLabels[row.delayedCheck.status]}{row.delayedCheck.notBeforeAt ? ` · 最早 ${new Date(row.delayedCheck.notBeforeAt).toLocaleString("zh-CN")}` : ""}</p> : null}{!row.sourcesAvailable ? <p className="text-xs text-warn">资料不可用</p> : null}{row.missingReasons.map((reason, index) => <p className="text-xs text-warn" key={index}>{reason}</p>)}{row.sharedEvidence?.length?<p className="text-xs text-text-3">其中 {row.sharedEvidence.length} 条独立证据来自其他课程原活动；适用本要求关联目标，不新增作答或时间。</p>:null}<button className={ui.secondary} type="button" disabled={locked || !goalId || snapshot.scopeState !== "confirmed"} onClick={() => start(row)}>学习这一项</button></li>)}</ul>
      {!editing ? <button type="button" className={ui.secondary} disabled={locked} onClick={() => setEditing(snapshot.requirements.length ? snapshot.requirements.map(requirementInput) : snapshot.suggestions)}>检查与确认课程范围</button> : <fieldset disabled={locked} className="space-y-3"><legend className="text-sm font-medium">对照大纲检查完整范围</legend><p className="text-xs leading-6 text-text-3">名称调整保留同一项身份；新增要求会创建新的身份。请核对前置、关联目标和资料；删除范围项不会删除已有学习事实。</p>
      {editing.map(row => <details key={row.id} open className="space-y-3 border-b border-line py-3"><summary className="cursor-pointer text-sm font-medium">{row.title || "新课程要求"}</summary><label className="block space-y-1"><span className={ui.label}>要求名称</span><input className={ui.input} value={row.title} maxLength={200} onChange={event => update(row.id, { title: event.target.value })} /></label><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={row.mandatory} onChange={event => update(row.id, { mandatory: event.target.checked })} />必修要求</label>
        <label className="block space-y-1"><span className={ui.label}>成功标准与评分依据</span><textarea className={ui.input} rows={3} value={row.verification.rubric ?? ""} onChange={event => update(row.id, { verification: { ...row.verification, rubric: event.target.value || null, ...(row.verification.kind === "exact" ? {} : { kind: "rubric", status: "needs_check" }) } })} /></label><p className="text-xs text-text-3">当前验证方式：{row.verification.kind === "exact" ? "精确判定" : row.verification.kind === "rubric" ? "按评分标准核对" : row.verification.kind === "manual" ? "人工核对" : "暂不可验证"}；填写标准不会自动获得验证通过。</p>
        <div className="flex flex-wrap gap-3"><label className="min-w-0 flex-1 space-y-1"><span className={ui.label}>跨课证据题型（可选）</span><select className={ui.input} value={row.evidenceConditions?.responseFormat??""} onChange={event=>update(row.id,{evidenceConditions:event.target.value?{responseFormat:event.target.value as "numeric"|"choice"|"text",timeLimitSeconds:row.evidenceConditions?.timeLimitSeconds??null,assistance:"independent"}:undefined})}><option value="">未设，不跨课借分</option><option value="numeric">数值作答</option><option value="choice">选择作答</option><option value="text">文字与步骤</option></select></label>{row.evidenceConditions?<label className="min-w-0 flex-1 space-y-1"><span className={ui.label}>独立作答时限（秒，空为不限时）</span><input className={ui.input} type="number" min={1} max={14400} step={1} value={row.evidenceConditions.timeLimitSeconds??""} onChange={event=>update(row.id,{evidenceConditions:{...row.evidenceConditions!,timeLimitSeconds:event.target.value?Number(event.target.value):null}})}/></label>:null}</div>
        <fieldset className="space-y-2"><legend className={ui.label}>关联目标</legend>{availableGoals.map(goal => <label className="flex gap-2 text-sm" key={goal.id}><input type="checkbox" checked={row.goalIds.includes(goal.id)} onChange={event => update(row.id, { goalIds: event.target.checked ? [...row.goalIds, goal.id] : row.goalIds.filter(id => id !== goal.id) })} />{goal.title}</label>)}</fieldset>
        <fieldset className="space-y-2"><legend className={ui.label}>必要前置</legend>{editing.filter(item => item.id !== row.id).map(item => <label className="flex gap-2 text-sm" key={item.id}><input type="checkbox" checked={row.prerequisiteIds.includes(item.id)} onChange={event => update(row.id, { prerequisiteIds: event.target.checked ? [...row.prerequisiteIds, item.id] : row.prerequisiteIds.filter(id => id !== item.id) })} />{item.title}</label>)}</fieldset>
        <fieldset className="space-y-2"><legend className={ui.label}>对应资料</legend>{snapshot.materials.map(material => <label className="flex gap-2 text-sm" key={`${material.sourceId}:${material.sourceVersion}`}><input type="checkbox" disabled={!material.available} checked={row.sourceRefs.some(ref => ref.sourceId === material.sourceId && ref.sourceVersion === material.sourceVersion)} onChange={event => update(row.id, { sourceRefs: event.target.checked ? [...row.sourceRefs, { sourceId: material.sourceId, sourceVersion: material.sourceVersion }] : row.sourceRefs.filter(ref => ref.sourceId !== material.sourceId || ref.sourceVersion !== material.sourceVersion) })} />{material.title}{!material.available ? "（不可用）" : ""}</label>)}</fieldset>
        <button type="button" className={ui.quiet} onClick={() => setEditing(rows => rows?.filter(item => item.id !== row.id).map(item => ({ ...item, prerequisiteIds: item.prerequisiteIds.filter(id => id !== row.id) })) ?? null)}>从本次范围移除</button>
      </details>)}<div className="flex flex-wrap gap-2"><button type="button" className={ui.quiet} onClick={() => { const id = crypto.randomUUID(); setEditing(rows => [...(rows ?? []), { id, stableSkillId: crypto.randomUUID(), knowledgeNodeId: null, requirementKey: `requirement:${id}`, title: "", position: rows?.length ?? 0, mandatory: true, goalIds: goalId ? [goalId] : [], prerequisiteIds: [], sourceRefs: [], verification: { kind: "unavailable", status: "missing", exerciseKeys: [], rubric: null, missingReasons: ["尚未提供验证题目或评分标准"] }, origin: "confirmed" }]); }}>添加课程要求</button><button type="button" className={ui.secondary} onClick={confirm}>确认这份全课范围</button><button type="button" className={ui.quiet} onClick={() => setEditing(null)}>取消编辑</button></div></fieldset>}
      <details className="border-t border-line pt-3"><summary className="cursor-pointer text-sm text-text-2">全部课程资料 · {snapshot.materials.length}</summary><ul className="mt-3 space-y-2 text-sm">{snapshot.materials.map(material => <li className="flex flex-wrap justify-between gap-2" key={`${material.sourceId}:${material.sourceVersion}`}><span>{material.title}</span><span className="text-xs text-text-3">{material.available ? "可用" : "不可用，请补齐或替换"}</span></li>)}</ul></details>
    </> : null}
    {pending ? <div role="status" className="space-y-2"><p className="text-sm text-warn">安排结果尚未确认，刚才的选择已保留。</p><button className={ui.secondary} type="button" disabled={busy || archived} onClick={() => void execute(pending)}>重新确认这次安排</button>{storageWarning ? <p className="text-xs text-warn">恢复信息无法保存，请保留本页；刷新后无法保证找回这次安排。</p> : null}</div> : null}
    {result?.kind === "choice" ? <div className="space-y-2"><p className="text-sm text-text-2" role="status">{result.message}</p><a className={ui.secondary} href={result.href}>处理这项选择</a></div> : null}{error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}
    <CourseSharedSkillControl courseId={courseId} disabled={locked} onChanged={()=>setReload(value=>value+1)}/>
    <button className={ui.quiet} type="button" disabled={busy || loading || Boolean(pending)} onClick={() => setReload(value => value + 1)}>重新读取课程路线</button>
  </section>;
}
