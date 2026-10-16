"use client";
import { useEffect, useRef, useState } from "react";
import type { PlanDraft, PlannedBlock, TaskItem } from "@aistudy/contracts";
import type { OpeningApi } from "../client/api";
import { buttonClass, secondaryButtonClass } from "../design/ui";
import { planAcceptFailure } from "./plan-accept-errors";

export function replanDiff(before: readonly PlannedBlock[], after: readonly PlannedBlock[]) {
  const key = (block: PlannedBlock) => JSON.stringify([block.taskId, block.start, block.end, block.reason]);
  const old = new Set(before.map(key)), next = new Set(after.map(key));
  return { added: after.filter(block => !old.has(key(block))), removed: before.filter(block => !next.has(key(block))),
    preserved: before.filter(block => next.has(key(block))).length };
}

/** A dismissed offer stays quiet for this accepted version; a new version gets a fresh choice. */
export function LocalReplanCard({ api, date, acceptedVersion, blocks, tasks, reason, timeZone, dismissalKey, onChanged }: {
  api: Pick<OpeningApi, "proposeLocalReplan" | "acceptPlan" | "rejectPlan">;
  date: string; acceptedVersion: number; blocks: PlannedBlock[]; tasks: TaskItem[];
  reason: "missed_block" | "freed_time" | null; timeZone: string; dismissalKey?: string; onChanged(): void | Promise<void>;
}) {
  const [draft, setDraft] = useState<PlanDraft | null>(null);
  const [hidden, setHidden] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const action = useRef(false);
  const key = `${dismissalKey ?? ""}:${date}:${acceptedVersion}:${reason}`;
  const storageKey = dismissalKey ? `opening-replan-dismissed:${dismissalKey}` : null;
  const epoch = useRef(key); epoch.current = key;
  const proposalKey = useRef<string | null>(null), acceptKey = useRef<string | null>(null);
  useEffect(() => {
    epoch.current = key;
    setDraft(null);
    try { setHidden(storageKey !== null && localStorage.getItem(storageKey) === "1"); } catch { setHidden(false); } setError(""); setNotice(""); setPending(false);
    proposalKey.current = null; acceptKey.current = null; action.current = false;
    return () => { epoch.current = "unmounted"; };
  }, [key, storageKey]);
  function hide() {
    setHidden(true);
    if (storageKey) { try { localStorage.setItem(storageKey, "1"); } catch { /* A blocked storage still permits a dismissal in this view. */ } }
  }
  async function preview() {
    if (action.current) return;
    action.current = true; setPending(true); setError("");
    const token = key;
    proposalKey.current ??= `replan-${crypto.randomUUID()}`;
    try {
      const result = await api.proposeLocalReplan({ date, expectedAcceptedVersion: acceptedVersion, clientKey: proposalKey.current });
      if (epoch.current !== token) return;
      if (result.kind === "draft") setDraft(result.draft);
      else setNotice("剩余空档暂时没有可安排的变化，当前安排已保留。");
    } catch (failure) { if (epoch.current === token) setError(planAcceptFailure(failure).message); }
    finally { if (epoch.current === token) { action.current = false; setPending(false); } }
  }
  async function confirm() {
    if (!draft || action.current) return;
    action.current = true; setPending(true); setError(""); const token = key;
    acceptKey.current ??= `replan-accept-${crypto.randomUUID()}`;
    try {
      await api.acceptPlan({ draftId: draft.id, expectedBaseVersion: draft.baseVersion, clientKey: acceptKey.current });
      if (epoch.current === token) { setDraft(null); setHidden(true); await onChanged(); }
    } catch (failure) { if (epoch.current === token) setError(planAcceptFailure(failure).message); }
    finally { if (epoch.current === token) { action.current = false; setPending(false); } }
  }
  async function dismiss() {
    if (action.current) return;
    if (!draft) { hide(); return; }
    action.current = true; setPending(true); const token = key;
    try { await api.rejectPlan(draft.id); if (epoch.current === token) { setDraft(null); hide(); } }
    catch (failure) { if (epoch.current === token) setError(failure instanceof Error ? failure.message : "取消失败，请重试。"); }
    finally { if (epoch.current === token) { action.current = false; setPending(false); } }
  }
  async function reread() {
    if (action.current) return;
    action.current = true; setPending(true); const token = key;
    try {
      await onChanged();
      if (epoch.current !== token) return;
      setDraft(null); setError(""); setNotice("");
      proposalKey.current = null; acceptKey.current = null;
    } catch (failure) {
      if (epoch.current === token) setError(failure instanceof Error ? failure.message : "读取失败，请稍后重试。");
    } finally { if (epoch.current === token) { action.current = false; setPending(false); } }
  }
  if (!reason || hidden) return null;
  const diff = draft ? replanDiff(blocks, draft.blocks) : null;
  const time = (value: string) => new Intl.DateTimeFormat("zh-CN", { timeZone, hour: "2-digit", minute: "2-digit" }).format(new Date(value));
  return <section className="mx-4 my-3 space-y-3 rounded-xl border border-emerald-200 bg-emerald-50/40 p-3" aria-label="局部重排">
    <h3 className="text-sm font-medium text-zinc-900">{reason === "missed_block" ? "有任务错过了原定时间" : "今天腾出了一些时间"}</h3>
    <p className="text-xs leading-5 text-zinc-600">可以预览剩余空档的安排，确认后才生效。</p>
    {diff ? <><p className="text-xs text-zinc-700">保留 {diff.preserved} 段 · 释放 {diff.removed.length} 段 · 新增 {diff.added.length} 段</p>
      <ul className="space-y-2 text-xs text-zinc-700">{diff.removed.map(block => <li key={`remove-${block.taskId}-${block.start}`}>释放：{tasks.find(task => task.id === block.taskId)?.title ?? "学习任务"} · {time(block.start)}–{time(block.end)}</li>)}{diff.added.map(block => <li key={`add-${block.taskId}-${block.start}`}>新增：{tasks.find(task => task.id === block.taskId)?.title ?? "学习任务"} · {time(block.start)}–{time(block.end)}</li>)}</ul>
      {draft!.unscheduledTaskIds.length ? <p className="text-xs text-zinc-600">另有 {draft!.unscheduledTaskIds.length} 项仍未排入。</p> : null}</> : null}
    {notice ? <p role="status" className="text-xs text-zinc-600">{notice}</p> : null}
    {error ? <div><p role="alert" className="text-xs text-red-700">{error} 请先重新读取，核对当前安排后再继续。</p><button type="button" disabled={pending} className={`${secondaryButtonClass} mt-2`} onClick={() => void reread()}>重新读取当前安排</button></div> : null}
    <div className="flex flex-wrap gap-2"><button type="button" disabled={pending || Boolean(notice) || Boolean(error)} className={buttonClass} onClick={() => void (draft ? confirm() : preview())}>{pending ? "正在处理…" : draft ? "确认局部重排" : "预览局部重排"}</button><button type="button" disabled={pending || Boolean(error)} className={secondaryButtonClass} onClick={() => void dismiss()}>{draft ? "取消草案" : "暂不调整"}</button></div>
  </section>;
}
