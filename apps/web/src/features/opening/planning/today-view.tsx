"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { OpeningApi } from "../client/api";
import { createOpeningApi, OpeningApiError } from "../client/api";
import { canAcceptPlan } from "./plan-action";
import { canProposePlan } from "./plan-input";

type Props = { api?: OpeningApi; date?: string };

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function TodayPlanView({ api: supplied, date = today() }: Props) {
  const api = useMemo(() => supplied ?? createOpeningApi(), [supplied]);
  const [tasks, setTasks] = useState<Awaited<ReturnType<OpeningApi["listTasks"]>>["tasks"]>([]);
  const [plan, setPlan] = useState<Awaited<ReturnType<OpeningApi["getToday"]>> | null>(null);
  const [reminders, setReminders] = useState<Awaited<ReturnType<OpeningApi["listReminders"]>> | null>(null);
  const [draft, setDraft] = useState<Awaited<ReturnType<OpeningApi["proposePlan"]>> | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [freeStart, setFreeStart] = useState("");
  const [freeEnd, setFreeEnd] = useState("");

  const refresh = useCallback(async () => {
    const [nextTasks, nextPlan, nextReminders] = await Promise.all([
      api.listTasks(), api.getToday(date), api.listReminders(),
    ]);
    setTasks(nextTasks.tasks.filter((task) => task.status === "pending"));
    setPlan(nextPlan);
    setReminders(nextReminders);
  }, [api, date]);

  useEffect(() => {
    void refresh().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "计划暂时无法读取"));
  }, [refresh]);

  async function propose() {
    setPending(true); setError("");
    try {
      const newFree = canProposePlan({ start: freeStart, end: freeEnd })
        ? [{ start: new Date(freeStart).toISOString(), end: new Date(freeEnd).toISOString(), kind: "free" as const }]
        : [];
      const free = [...(plan?.hardBlocks ?? []), ...newFree];
      if (newFree.length === 0) {
        setError("请先填写一个有效的可用时间段。");
        return;
      }
      const next = await api.proposePlan({ date, free, clientKey: `today-plan-${date}` });
      setDraft(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "计划生成失败");
    } finally { setPending(false); }
  }

  async function accept() {
    if (!draft || !canAcceptPlan({ pending, stale: draft.baseVersion !== plan?.acceptedVersion })) return;
    setPending(true); setError("");
    try {
      await api.acceptPlan({ draftId: draft.id, expectedBaseVersion: draft.baseVersion, clientKey: `accept-plan-${draft.id}` });
      setDraft(null);
      await refresh();
    } catch (reason) {
      if (reason instanceof OpeningApiError && reason.status === 409) setError("计划已变化，请重新读取后再确认；没有重复提交。");
      else setError(reason instanceof Error ? reason.message : "计划确认失败");
    } finally { setPending(false); }
  }

  return (
    <section className="space-y-4 border-t border-zinc-200 pt-6" aria-label="今日计划">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div><h2 className="text-base font-semibold text-zinc-900">今日计划</h2><p className="text-sm text-zinc-500">只显示真实任务和计划状态；提醒列表不等于外部推送。</p></div>
        <div className="flex flex-wrap items-center gap-2"><label className="text-xs text-zinc-500">可用时间 <input aria-label="可用时间开始" type="datetime-local" value={freeStart} onChange={(event) => setFreeStart(event.target.value)} className="ml-1 rounded border border-zinc-300 px-1 py-1 text-xs" /></label><span className="text-xs text-zinc-400">至</span><input aria-label="可用时间结束" type="datetime-local" value={freeEnd} onChange={(event) => setFreeEnd(event.target.value)} className="rounded border border-zinc-300 px-1 py-1 text-xs" /><button type="button" onClick={() => void propose()} disabled={pending || !canProposePlan({ start: freeStart, end: freeEnd })} className="min-h-9 rounded-md border border-zinc-300 px-3 text-sm text-zinc-700 disabled:opacity-50">生成计划</button></div>
      </div>
      {error ? <div className="space-y-2"><p className="text-sm text-red-700" role="alert">{error}</p><button type="button" onClick={() => void refresh().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "计划暂时无法读取"))} className="min-h-9 rounded-md border border-zinc-300 px-3 text-sm text-zinc-700">重试</button></div> : null}
      {tasks.length === 0 ? <p className="text-sm text-zinc-500">暂无待完成任务。</p> : <ul className="space-y-2">{tasks.slice(0, 3).map((task) => <li key={task.id} className="rounded-md border border-zinc-200 px-3 py-2 text-sm">{task.title}<span className="ml-2 text-xs text-zinc-500">{task.minutes} 分钟</span></li>)}</ul>}
      {draft ? <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-3"><p className="text-sm font-medium text-zinc-900">计划变更预览</p><p className="mt-1 text-xs text-zinc-600">当前 {plan?.blocks.length ?? 0} 个时间块 → 草案 {draft.blocks.length} 个时间块；未安排 {draft.unscheduledTaskIds.length} 项。</p><div className="mt-2 flex gap-2"><button type="button" onClick={() => void accept()} disabled={pending || !canAcceptPlan({ pending, stale: draft.baseVersion !== plan?.acceptedVersion })} className="min-h-9 rounded-md bg-zinc-900 px-3 text-sm text-white disabled:opacity-50">确认变更</button><button type="button" onClick={() => setDraft(null)} disabled={pending} className="min-h-9 rounded-md border border-zinc-300 px-3 text-sm">取消</button></div></div> : null}
      {reminders ? <div className="rounded-md border border-zinc-200 p-3"><p className="text-sm font-medium text-zinc-800">提醒</p><p className="mt-1 text-xs text-zinc-500">外部渠道：{reminders.externalDelivery === "configured" ? "已配置" : "未配置"}</p><ul className="mt-2 space-y-1 text-sm">{reminders.reminders.slice(0, 3).map((reminder) => <li key={reminder.id}>{reminder.status === "sent" && reminder.receiptId ? "已收到提供方回执" : reminder.outcome === "unknown" ? "发送结果未知，请勿自动重试" : reminder.outcome === "quiet" ? "静默时段，暂不发送" : reminder.outcome === "rate_limited" ? "提供方限流" : reminder.channel === "in_app" ? "应用内提醒" : "外部提醒未送达"}</li>)}</ul></div> : null}
    </section>
  );
}
