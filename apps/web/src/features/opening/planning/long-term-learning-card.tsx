"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { learningManagementCommandSchema, learningRecoveryCommandSchema, learningMaintenanceStartSchema, type LearningManagementOverview, type CourseRouteActionResult, type PlanDraft, type PlannedBlock } from "@aistudy/contracts";
import { getVerifiedSessionNamespace } from "../../auth/session-identity";
import { createLearningManagementClient, LearningManagementRequestError, type LearningManagementClient } from "./learning-management-client";
import { replanDiff } from "./local-replan-card";
import { ui } from "../design/ui";
import { userFacingMessage } from "../../../lib/user-facing-error";
const pendingSchema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("command"), input: learningManagementCommandSchema }), z.object({ kind: z.literal("recovery"), input: learningRecoveryCommandSchema }), z.object({ kind: z.literal("maintenance"), input: learningMaintenanceStartSchema })]);
type Pending = z.infer<typeof pendingSchema>;
function storageKey(namespace: string, date: string) { return `aistudy:long-term-command:${namespace}:${date}`; }
function restore(namespace: string | null, date: string): Pending | null { if (!namespace) return null; try { const raw = sessionStorage.getItem(storageKey(namespace, date)); const parsed = raw ? pendingSchema.safeParse(JSON.parse(raw)) : null; return parsed?.success ? parsed.data : null; } catch { return null; } }
export function LongTermLearningCard(props: { date: string; client?: LearningManagementClient; onChanged?: () => void }) { return <ManagementCard key={props.date} {...props} />; }
function ManagementCard({ date, client: suppliedClient, onChanged }: { date: string; client?: LearningManagementClient; onChanged?: () => void }) {
  const client = useMemo(() => suppliedClient ?? createLearningManagementClient(), [suppliedClient]);
  const [namespace] = useState(getVerifiedSessionNamespace);
  const [overview, setOverview] = useState<LearningManagementOverview | null>(null), [draft, setDraft] = useState<PlanDraft | null>(null);
  const [routeChoice, setRouteChoice] = useState<CourseRouteActionResult | null>(null);
  const [daily, setDaily] = useState("60"), [buffer, setBuffer] = useState("10"), [shortMinutes, setShortMinutes] = useState("10");
  const [pending, setPending] = useState<Pending | null>(() => restore(namespace, date));
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [reload, setReload] = useState(0), [error, setError] = useState(""), [message, setMessage] = useState(""), [storageWarning, setStorageWarning] = useState(false);
  const writing = useRef(false), active = useRef(true), pendingRef = useRef(pending); pendingRef.current = pending;
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  function owned() { return namespace === getVerifiedSessionNamespace(); }
  function remember(value: Pending | null) { if (!namespace) return false; try { if (value) sessionStorage.setItem(storageKey(namespace, date), JSON.stringify(value)); else sessionStorage.removeItem(storageKey(namespace, date)); return true; } catch { return false; } }
  useEffect(() => { let live = true; setLoading(true); setError("");
    void client.read(date).then(value => {
      if (!live || !owned()) return;
      setOverview(value); setDaily(String(value.budget?.dailyMinutes ?? 60)); setBuffer(String(value.budget?.bufferMinutes ?? 10));
      const command = pendingRef.current;
      if (command?.kind === "command" && command.input.action === "settings" && value.budget && value.budget.revision > command.input.expectedRevision) { remember(null); setPending(null); setMessage("预算设置已经更新，刚才的修改已无法继续保存。请核对下方当前设置；这不代表刚才的保存已成功。"); }
    }).catch(reason => { if (live) { setOverview(null); setError(userFacingMessage(reason, "长期安排暂不可读取。")); } }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  // Pending requests are resolved only by their response or an explicit fresh revision read.
  }, [client, date, reload, namespace]);
  async function execute(command: Pending) {
    if (writing.current || !owned()) return;
    const retryingUnknown = pending !== null; writing.current = true; setBusy(true); setError(""); setMessage(""); setPending(command); setStorageWarning(!remember(command));
    try {
      const result = command.kind === "command" ? await client.command(command.input) : command.kind === "maintenance" ? await client.maintenance(command.input) : await client.recover(command.input);
      if (!owned()) return;
      remember(null); setPending(null);
      if (!active.current) return;
      if ("kind" in result) { setRouteChoice(result); if (result.kind === "ready") window.location.assign(result.href); }
      else if ("href" in result) { window.location.assign(result.href); }
      else { setOverview(result.overview); setDraft(result.draft); if (command.kind === "command" && command.input.action === "settings") { setDaily(String(result.overview.budget?.dailyMinutes ?? daily)); setBuffer(String(result.overview.budget?.bufferMinutes ?? buffer)); setMessage("共同预算已保存。"); } if (command.kind === "command" && command.input.action === "confirm") { setMessage("安排已确认，原学习事实保留。"); onChanged?.(); } }
    } catch (reason) {
      if (reason instanceof LearningManagementRequestError && reason.status >= 400 && reason.status < 500 && reason.status !== 408 && !retryingUnknown) { remember(null); setPending(null); setOverview(null); }
      setError(userFacingMessage(reason, "保存结果待确认，请原样重新确认这次操作。"));
    } finally { writing.current = false; setBusy(false); }
  }
  function saveSettings() {
    if (!overview || busy || pending) return;
    const minutes = Number(daily), spare = Number(buffer);
    if (!daily.trim() || !buffer.trim() || !Number.isInteger(minutes) || minutes < 1 || minutes > 600 || !Number.isInteger(spare) || spare < 0 || spare > 120 || spare >= minutes) { setError("每日预算须为 1–600 分钟，缓冲须为 0–120 分钟且小于每日预算。"); return; }
    void execute({ kind: "command", input: { action: "settings", dailyMinutes: minutes, bufferMinutes: spare, expectedRevision: overview.budget?.revision ?? 0 } });
  }
  function preview() { if (!overview?.budget || pending) return; void execute({ kind: "command", input: { action: "preview", date, expectedAcceptedVersion: overview.acceptedVersion, expectedBudgetRevision: overview.budget.revision, clientKey: `long-term-preview:${crypto.randomUUID()}` } }); }
  function recover(action: "shorten" | "replan") { if (!overview?.budget || pending) return; const minutes = Number(shortMinutes); if (action === "shorten" && (!Number.isInteger(minutes) || minutes < 5 || minutes > 240)) { setError("本次时长须为 5–240 分钟。"); return; } void execute({ kind: "recovery", input: { action, date, activityId: overview.recovery.activityId, taskId: overview.recovery.taskId, ...(action === "shorten" ? { minutes } : {}), expectedAcceptedVersion: overview.acceptedVersion, expectedBudgetRevision: overview.budget.revision, clientKey: `learning-recovery:${crypto.randomUUID()}` } }); }
  const locked = busy || Boolean(pending), diff = overview && draft ? replanDiff(overview.acceptedBlocks, draft.blocks) : null;
  function blockLabel(block: PlannedBlock) { const title = overview?.tasks.find(task => task.id === block.taskId)?.title ?? "学习任务"; return `${title} · ${new Date(block.start).toLocaleTimeString("zh-CN", { timeZone: overview?.timeZone, hour: "2-digit", minute: "2-digit" })}–${new Date(block.end).toLocaleTimeString("zh-CN", { timeZone: overview?.timeZone, hour: "2-digit", minute: "2-digit" })}`; }
  return <details className="space-y-3 border-t border-line py-3" data-testid="long-term-learning-card"><summary className="cursor-pointer text-sm font-medium focus-visible:ring-2 focus-visible:ring-focus-ring">长期学习与共同预算 · {overview?.budget ? `剩余 ${overview.remainingMinutes} 分钟` : loading ? "读取中" : overview ? "未设置共同预算" : "暂不可读取"}</summary>
    <div className="space-y-3 pt-2"><p className="text-xs leading-6 text-text-3">课程、多个目标、练习、复测和卡片共用当天预算，同一活动只计一次。预算保存不会自动扩大导师权限；未设预算也可继续已有活动。</p>
    {overview ? <>
      <p className="text-sm leading-6 text-text-2">{overview.budget ? `每日共同预算 ${overview.budget.dailyMinutes} 分钟 · 缓冲 ${overview.budget.bufferMinutes} 分钟 · 已承诺 ${overview.committedMinutes} 分钟 · 剩余 ${overview.remainingMinutes} 分钟${overview.overcommittedMinutes ? ` · 超出 ${overview.overcommittedMinutes} 分钟` : ""}` : "未设置共同预算，请主动确认后再生成安排。"}</p>
      <fieldset disabled={locked} className="flex flex-wrap items-end gap-3"><legend className="sr-only">共同预算</legend><label className="min-w-0 flex-1 basis-32 space-y-1"><span className={ui.label}>每日共同分钟</span><input className={ui.input} type="number" min={1} max={600} value={daily} onChange={event => setDaily(event.target.value)} /></label><label className="min-w-0 flex-1 basis-32 space-y-1"><span className={ui.label}>缓冲分钟</span><input className={ui.input} type="number" min={0} max={120} value={buffer} onChange={event => setBuffer(event.target.value)} /></label><button className={ui.secondary} type="button" onClick={saveSettings}>保存共同预算</button></fieldset>
      {overview.warnings.map((warning, index) => <p className="text-xs leading-6 text-warn" role="status" key={index}>{warning}</p>)}
      {(overview.maintenanceTasks ?? []).map(task => <div className="space-y-2 border-t border-line pt-3" key={task.taskId}><p className="text-sm text-text-2">{overview.tasks.find(row => row.id === task.taskId)?.title ?? "到期保持抽查"}</p><button type="button" className={ui.secondary} disabled={locked} onClick={() => void execute({ kind: "maintenance", input: { taskId: task.taskId, expectedVersion: task.version, clientKey: `maintenance-start:${crypto.randomUUID()}` } })}>开始这项保持抽查</button></div>)}
      {routeChoice?.kind === "choice" ? <div className="space-y-2"><p role="status" className="text-sm text-text-2">{routeChoice.message}</p><a className={ui.secondary} href={routeChoice.href}>核对抽查选择</a></div> : null}
      {overview.recovery.kind !== "none" ? <section className="space-y-2 border-t border-line pt-3" aria-label="缺席后恢复"><h3 className="text-sm font-medium">从上次继续</h3><p className="text-xs text-text-3">可以继续原活动，或先预览剩余时间的新安排。已有答案、受助记录与已接受任务保留。</p><div className="flex flex-wrap gap-2">{overview.recovery.href ? <a className={ui.secondary} href={overview.recovery.href}>继续原活动</a> : null}<button type="button" className={ui.secondary} disabled={locked || !overview.budget} onClick={() => recover("replan")}>预览缺席后的安排</button></div>{overview.recovery.activityId ? <div className="flex flex-wrap items-end gap-2"><label className="space-y-1"><span className={ui.label}>这次只学几分钟</span><input className={ui.input} type="number" min={5} max={240} value={shortMinutes} disabled={locked} onChange={event => setShortMinutes(event.target.value)} /></label><button type="button" className={ui.secondary} disabled={locked || !overview.budget} onClick={() => recover("shorten")}>选择更短的本次活动</button></div> : null}</section> : null}
      <button type="button" className={ui.secondary} disabled={locked || !overview.budget} onClick={preview}>预览共同安排</button>
      {draft && diff ? <section className="space-y-3 border-l-2 border-accent pl-3" aria-label="安排草案"><h3 className="text-sm font-medium">安排草案 · 尚未接受</h3><p className="text-xs leading-6 text-text-2">保留 {diff.preserved} 项，新增或调整 {diff.added.length} 项，移除或调整 {diff.removed.length} 项。确认前当前安排继续保留。</p>{diff.removed.length ? <div><p className="text-xs font-medium">将移除或调整</p><ul className="space-y-1 text-xs text-text-2">{diff.removed.map((block, index) => <li key={index}>{blockLabel(block)}</li>)}</ul></div> : null}<ul className="space-y-2 text-sm text-text-2">{draft.blocks.map((block, index) => <li key={index}>{blockLabel(block)}<p className="text-xs text-text-3">{block.reason}</p></li>)}</ul>{draft.unscheduledTaskIds.length ? <p className="text-xs text-warn">仍有 {draft.unscheduledTaskIds.length} 项未排入。时间不足时可减少范围、调整日期或维持原安排。</p> : null}<div className="flex flex-wrap gap-2"><button className={ui.secondary} type="button" disabled={locked} onClick={() => void execute({ kind: "command", input: { action: "confirm", draftId: draft.id, expectedBaseVersion: draft.baseVersion, clientKey: `long-term-confirm:${crypto.randomUUID()}` } })}>确认这份安排</button><button className={ui.quiet} type="button" disabled={locked} onClick={() => setDraft(null)}>保留当前安排</button></div></section> : null}
      {overview.acceptedBlocks.length ? <details><summary className="cursor-pointer text-xs text-text-2">当前已接受安排 · {overview.acceptedBlocks.length}</summary><ul className="mt-2 space-y-2 text-xs">{overview.acceptedBlocks.map((block, index) => <li key={index}>{blockLabel(block)}</li>)}</ul></details> : null}
      {overview.cardSessions.filter(session => session.status === "active").map(session => <a className={ui.quiet} href={session.href} key={session.activityId}>恢复卡片本次活动 · {session.budgetMinutes} 分钟</a>)}
    </> : null}
    {pending ? <div role="status" className="space-y-2"><p className="text-sm text-warn">保存结果待确认，这次填写的内容已保留；即使页面仍显示先前设置，也不会当作保存已完成。</p><button type="button" className={ui.secondary} disabled={busy} onClick={() => void execute(pending)}>重新确认这次操作</button>{storageWarning ? <p className="text-xs text-warn">浏览器暂时无法保存待确认的操作，请保留本页；刷新后可能无法继续确认这次操作。</p> : null}</div> : null}
    {error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}{message ? <p role="status" className="text-xs text-text-2">{message}</p> : null}
    <button type="button" className={ui.quiet} disabled={busy || loading} onClick={() => setReload(value => value + 1)}>重新读取长期安排</button>
    </div>
  </details>;
}
