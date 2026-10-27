"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { learningLifecycleCommandSchema, type LearningGoal, type LearningGoalList } from "@aistudy/contracts";
import { z } from "zod";
import { createLearningGoalClient, type LearningGoalClient } from "./learning-goal-client";
import { createLearningManagementClient, LearningManagementRequestError, type LearningManagementClient } from "../planning/learning-management-client";
import { ui } from "../design/ui";
import { userFacingMessage } from "../../../lib/user-facing-error";
type Command = z.infer<typeof learningLifecycleCommandSchema>;
const labels = { active: "继续推进", maintenance: "定期维护", reduced: "减负", paused: "暂停", archived: "归档目标", stopped: "停止目标" };
function key(courseId: string) { return `aistudy:lifecycle-command:${courseId}`; }
function restore(courseId: string): Command | null { try { const raw = sessionStorage.getItem(key(courseId)); const value = raw ? learningLifecycleCommandSchema.safeParse(JSON.parse(raw)) : null; return value?.success ? value.data : null; } catch { return null; } }
export function CourseLifecycleControl(props: { courseId: string; goalsClient?: Pick<LearningGoalClient, "list">; client?: Pick<LearningManagementClient, "lifecycle"> }) { return <LifecycleControl key={props.courseId} {...props} />; }
function LifecycleControl({ courseId, goalsClient, client: suppliedClient }: { courseId: string; goalsClient?: Pick<LearningGoalClient, "list">; client?: Pick<LearningManagementClient, "lifecycle"> }) {
  const client = useMemo(() => suppliedClient ?? createLearningManagementClient(), [suppliedClient]);
  const goalClient = useMemo(() => goalsClient ?? createLearningGoalClient(), [goalsClient]);
  const [data, setData] = useState<LearningGoalList | null>(null), [goalId, setGoalId] = useState(""), [lifecycle, setLifecycle] = useState<LearningGoal["lifecycle"]>("active"), [interval, setInterval] = useState("7");
  const [pending, setPending] = useState<Command | null>(() => restore(courseId)), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [reload, setReload] = useState(0), [error, setError] = useState(""), [message, setMessage] = useState(""), [storageWarning, setStorageWarning] = useState(false);
  const writing = useRef(false), pendingRef = useRef(pending); pendingRef.current = pending;
  function remember(command: Command | null) { try { if (command) sessionStorage.setItem(key(courseId), JSON.stringify(command)); else sessionStorage.removeItem(key(courseId)); return true; } catch { return false; } }
  function choose(goal: LearningGoal | undefined) { setGoalId(goal?.id ?? ""); setLifecycle(goal?.lifecycle ?? "active"); setInterval(String(goal?.maintenanceIntervalDays ?? 7)); }
  useEffect(() => { let live = true; setLoading(true); setError(""); void goalClient.list(courseId).then(value => {
    if (!live) return;
    setData(value); const command = pendingRef.current, selected = value.goals.find(goal => goal.id === (command?.goalId ?? value.selectedGoalIds[courseId])) ?? value.goals[0]; choose(selected);
    const fresh = command && value.goals.find(goal => goal.id === command.goalId);
    if (fresh && fresh.revision > command.expectedRevision) { remember(null); setPending(null); setMessage("目标版本已前进，旧状态请求已不能应用。请核对当前状态。"); }
  }).catch(reason => { if (live) { setData(null); setError(userFacingMessage(reason, "目标状态暂不可读取。")); } }).finally(() => { if (live) setLoading(false); }); return () => { live = false; };
  // A fresh read cannot clear a pending CAS that still has the same revision.
  }, [goalClient, courseId, reload]);
  const goal = data?.goals.find(value => value.id === goalId), locked = busy || Boolean(pending);
  async function execute(command: Command) {
    if (writing.current) return;
    const retryingUnknown = pending !== null; writing.current = true; setBusy(true); setError(""); setMessage(""); setPending(command); setStorageWarning(!remember(command));
    try { const result = await client.lifecycle(command); remember(null); setPending(null); setData(previous => previous ? { ...previous, goals: previous.goals.map(goal => goal.id === result.goal.id ? result.goal : goal) } : previous); choose(result.goal); setMessage(result.message); }
    catch (reason) { if (reason instanceof LearningManagementRequestError && reason.status >= 400 && reason.status < 500 && !retryingUnknown) { remember(null); setPending(null); setData(null); } setError(userFacingMessage(reason, "状态保存待确认，请原样重新确认。")); }
    finally { writing.current = false; setBusy(false); }
  }
  function save() { if (!goal || locked) return; const days = Number(interval); if (["maintenance", "reduced"].includes(lifecycle) && (!Number.isInteger(days) || days < 1 || days > 365)) { setError("维护间隔须为 1–365 天。"); return; } void execute({ goalId: goal.id, expectedRevision: goal.revision, lifecycle, acceptedPolicy: "keep", ...(["maintenance", "reduced"].includes(lifecycle) ? { maintenanceIntervalDays: days } : {}) }); }
  return <details className="space-y-3 border-t border-line pt-3"><summary className="cursor-pointer text-sm font-medium">长期目标状态与维护</summary><div className="space-y-3 pt-2">
    <p className="text-xs leading-6 text-text-3">维护、减负、暂停或停止只改变后续推进；已接受任务保留，取消请到今日任务逐项操作。材料、历史作答和证据保留；课程归档与账号开关仍单独生效。</p>
    {loading ? <p role="status" className="text-xs text-text-3">正在读取目标状态…</p> : data ? data.goals.length ? <>
      <label className="block space-y-1"><span className={ui.label}>要管理的目标</span><select className={ui.input} disabled={locked} value={goalId} onChange={event => choose(data.goals.find(goal => goal.id === event.target.value))}>{data.goals.map(goal => <option value={goal.id} key={goal.id}>{goal.title}</option>)}</select></label>
      {goal ? <p className="text-xs text-text-2">当前：{labels[goal.lifecycle]}。这次修改会影响该目标关联的 {goal.courseIds.length} 门课程；不会修改其他目标。</p> : null}
      <label className="block space-y-1"><span className={ui.label}>目标状态</span><select className={ui.input} aria-label="目标状态" disabled={locked} value={lifecycle} onChange={event => setLifecycle(event.target.value as LearningGoal["lifecycle"])}>{Object.entries(labels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
      {["maintenance", "reduced"].includes(lifecycle) ? <label className="block space-y-1"><span className={ui.label}>维护间隔（天）</span><input className={ui.input} disabled={locked} type="number" min={1} max={365} value={interval} onChange={event => setInterval(event.target.value)} /></label> : null}
      <button type="button" className={ui.secondary} disabled={locked || !goal} onClick={save}>确认目标状态</button>
    </> : <a className={ui.secondary} href="?tab=progress#course-goals">先确认课程目标</a> : null}
    {pending ? <div className="space-y-2" role="status"><p className="text-xs text-warn">状态保存待确认，原目标、版本和请求保留。读取相同旧版本不能确认请求结束。</p><button className={ui.secondary} type="button" disabled={busy} onClick={() => void execute(pending)}>重新确认这次状态变更</button>{storageWarning ? <p className="text-xs text-warn">请求恢复信息无法保存，请保留本页；刷新后无法保证恢复。</p> : null}</div> : null}
    {error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}{message ? <p role="status" className="text-xs text-text-2">{message}</p> : null}
    <button className={ui.quiet} type="button" disabled={busy || loading} onClick={() => setReload(value => value + 1)}>重新读取目标状态</button>
  </div></details>;
}
