"use client";
import { useMemo, useState } from "react";
import { TransitionLink as Link } from "../v3/motion/view-transition";
import type { ConversationPlanInspection, PlanDraft, TaskItem } from "@aistudy/contracts";
import { buttonClass, inputClass, secondaryButtonClass } from "../design/ui";
import { createConversationPlanController, type ConversationPlanApi } from "./conversation-plan-controller";
import { userFacingMessage } from "../../../lib/user-facing-error";

type Props = {
  candidateId: string;
  expectedVersion: number;
  api: ConversationPlanApi;
  disabled?: boolean;
  onModeChange(open: boolean): void;
  onAccepted(task: TaskItem): void;
};
const time = (value: string, timeZone: string) => new Date(value).toLocaleTimeString("zh-CN", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false });

export function ConversationPlanAction({ candidateId, expectedVersion, api, disabled = false, onModeChange, onAccepted }: Props) {
  const controller = useMemo(() => createConversationPlanController(api), [api]);
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [inspection, setInspection] = useState<ConversationPlanInspection | null>(null);
  const [minutes, setMinutes] = useState(""), [course, setCourse] = useState("");
  const [draft, setDraft] = useState<PlanDraft | null>(null);
  const unknownProposal = controller.hasUnknownProposal(), unknownAcceptance = controller.hasUnknownAcceptance();
  async function load() {
    if (busy || disabled) return;
    setOpen(true); onModeChange(true); setBusy(true); setError("");
    try {
      const result = await api.inspectConversationPlan(candidateId);
      setInspection(result); setMinutes(result.candidate.minutes === null ? "" : String(result.candidate.minutes));
      if (result.candidate.minutes !== null && result.candidate.minutes > 240) setError("该建议超过240分钟，请先拆成较短任务后安排。");
    } catch (reason) { setError(userFacingMessage(reason, "暂时无法读取对话建议。")); }
    finally { setBusy(false); }
  }
  function close() { setOpen(false); onModeChange(false); setInspection(null); setDraft(null); setCourse(""); setError(""); }
  async function preview() {
    if (!inspection || busy) return;
    if (!course) { setError("请选择课程或明确选择不关联课程。"); return; }
    const duration = Number(minutes);
    if (!Number.isInteger(duration) || duration < 1 || duration > 240) { setError("请填写1至240之间的预计分钟数。"); return; }
    setBusy(true); setError("");
    try {
      const result = await controller.propose({ candidateId, expectedVersion, date: inspection.date,
        expectedAcceptedVersion: inspection.acceptedVersion, courseId: course === "none" ? null : course, minutes: duration });
      if (result.kind === "draft") setDraft(result.draft);
      else if (result.kind === "clarification") { setInspection(result); setError("请补充课程选择和预计时长。"); }
      else setError("今天没有足够的连续空档，任务尚未创建。可以先调整可用时间，再重新读取。");
    } catch (reason) { setError(userFacingMessage(reason, "还不确定计划草稿是否生成，请再试一次。")); }
    finally { setBusy(false); }
  }
  async function accept() {
    if (!draft || busy || !inspection) return;
    setBusy(true); setError("");
    try {
      const accepted = await controller.accept(draft);
      const task = accepted.suggestedTasks?.find(item => item.key === `conversation:${candidateId}` && accepted.blocks.some(block => block.taskId === item.id));
      if (!task) throw new Error("已读取接受结果，请刷新今日计划核对任务。");
      onModeChange(false);
      onAccepted({ id: task.id, version: 1, title: task.title, minutes: task.minutes, dueAt: null, priority: 0,
        status: "pending", origin: "agent", ...(task.courseId ? { courseId: task.courseId } : {}) });
    } catch (reason) { setError(userFacingMessage(reason, "还不确定是否已接受，请刷新今日计划看看，或再试一次。")); }
    finally { setBusy(false); }
  }
  async function reject() {
    if (!draft || busy || unknownAcceptance) return;
    setBusy(true); setError("");
    try { await api.rejectPlan(draft.id); close(); }
    catch (reason) { setError(userFacingMessage(reason, "暂时无法关闭草案，请重试。")); }
    finally { setBusy(false); }
  }
  if (!open) return <button type="button" className={secondaryButtonClass} disabled={disabled || busy} onClick={() => void load()}>安排到今日计划</button>;
  return <div className="mt-4 space-y-3 rounded-xl border border-line bg-surface-2 p-4" aria-label="对话计划草案">
    <p className="text-sm font-medium text-text">安排已保存的对话建议</p>
    {busy ? <p className="text-xs text-text-2" role="status">正在处理…</p> : null}
    {inspection ? <>
      <p className="break-words text-sm text-text">{inspection.candidate.title}</p>
      <p className="text-xs text-text-2">{inspection.date} · {inspection.timeZone}。已确认的安排将保留。</p>
      {inspection.candidate.dueText ? <p className="text-xs text-text-2">时间备注：{inspection.candidate.dueText}（仅作备注）</p> : null}
      {!inspection.planningReady ? <p className="text-sm text-text-2">请先<Link href="/opening/today" className="underline underline-offset-2">设置学期和可用时间</Link>，再预览安排。</p> : null}
      {!draft ? <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-text-2">关联课程<select className={`${inputClass} mt-1`} disabled={busy || unknownProposal} value={course} onChange={event => setCourse(event.target.value)}><option value="">请选择</option><option value="none">不关联课程</option>{inspection.courses.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label className="text-xs text-text-2">预计分钟数<input type="number" className={`${inputClass} mt-1`} min={1} max={240} required readOnly={inspection.candidate.minutes !== null} disabled={busy || unknownProposal} value={minutes} onChange={event => setMinutes(event.target.value)} /></label>
      </div> : <div className="space-y-2 text-xs text-text-2">
        <p>新增1项任务，保留{draft.blocks.filter(block => block.taskId !== draft.suggestedTasks?.[0]?.id).length}个已确认时间块。确认后创建任务并安排到日历。</p>
        <ul className="space-y-1" aria-label="新增安排">{draft.blocks.filter(block => block.taskId === draft.suggestedTasks?.[0]?.id).map(block => <li key={block.start}>{time(block.start, inspection.timeZone)}–{time(block.end, inspection.timeZone)} · {inspection.candidate.title}</li>)}</ul>
      </div>}
    </> : null}
    {error ? <p className="text-sm text-danger" role="alert">{error}</p> : null}
    {unknownProposal || unknownAcceptance ? <p className="text-xs text-text-2">上次请求结果尚未确认。输入已保留，重试会发送相同请求。</p> : null}
    <div className="flex flex-wrap gap-2">
      {draft ? <><button type="button" disabled={busy} className={buttonClass} onClick={() => void accept()}>{unknownAcceptance ? "重试确认" : "确认安排"}</button><button type="button" disabled={busy || unknownAcceptance} className={secondaryButtonClass} onClick={() => void reject()}>暂不安排</button></>
        : <><button type="button" disabled={busy || !inspection?.planningReady || (inspection.candidate.minutes ?? 0) > 240} className={buttonClass} onClick={() => void preview()}>{unknownProposal ? "重试预览" : "预览安排"}</button><button type="button" disabled={busy || unknownProposal} className={secondaryButtonClass} onClick={() => void load()}>重新读取</button><button type="button" disabled={busy || unknownProposal} className={secondaryButtonClass} onClick={close}>返回建议</button></>}
    </div>
  </div>;
}
