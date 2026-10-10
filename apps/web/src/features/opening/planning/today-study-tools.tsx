"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { OpeningApi } from "../client/api";
import { secondaryButtonClass } from "../design/ui";
import { SuggestPlanCard } from "./suggest-plan-card";

type Props = {
  api: OpeningApi;
  disabled?: boolean;
  date: string;
  plan: Awaited<ReturnType<OpeningApi["getToday"]>> | null;
  tasks: Awaited<ReturnType<OpeningApi["listTasks"]>>["tasks"];
  onChanged: () => void;
  children?: ReactNode;
};

/** Closed by default; after first use keep children mounted so drafts survive folding. */
export function TodayStudyTools({ api, date, plan, tasks, onChanged, children, disabled = false }: Props) {
  const [visited, setVisited] = useState(false);
  return <details className="mx-4 mt-4 rounded-xl border border-zinc-200 bg-zinc-50" onToggle={event => { if (event.currentTarget.open) setVisited(true); }}>
    <summary className="min-h-11 cursor-pointer rounded-xl px-3 py-3 text-xs font-medium text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600/50">
      更多排程与提醒
    </summary>
    {visited ? <div className="border-t border-zinc-200">
      <p className="px-4 py-3 text-xs leading-5 text-zinc-500">额外排程与提醒诊断按需使用。收起不会丢弃当前草案，确认后才改变正式计划。</p>
      <fieldset disabled={disabled} className="min-w-0 disabled:opacity-60">
      {children}
      {plan ? <SuggestPlanCard api={api} date={date} acceptedVersion={plan.acceptedVersion} confirmedBlocks={plan.blocks} tasks={tasks} onChanged={onChanged} /> : null}
      </fieldset>
      <ReminderStatus api={api} />
    </div> : null}
  </details>;
}

function ReminderStatus({ api }: { api: Pick<OpeningApi, "listReminders"> }) {
  const [reminders, setReminders] = useState<Awaited<ReturnType<OpeningApi["listReminders"]>> | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    setError(false); setReminders(null);
    api.listReminders().then(
      result => { if (current) setReminders(result); },
      () => { if (current) setError(true); },
    );
    return () => { current = false; };
  }, [api, retry]);
  if (error) return <div className="px-4 py-3 text-xs leading-5 text-amber-900"><p role="status">提醒状态暂时无法读取，学习任务不受影响。</p><button type="button" className={`${secondaryButtonClass} mt-2`} onClick={() => setRetry(value => value + 1)}>重试读取提醒</button></div>;
  if (!reminders) return <p className="px-4 py-3 text-xs text-zinc-500" role="status">正在读取提醒状态…</p>;
  if (!reminders.reminders.length && reminders.externalDelivery !== "configured") return null;
  return <details className="px-4 py-3 text-xs text-zinc-500">
    <summary className="min-h-10 cursor-pointer py-2 focus-visible:ring-2 focus-visible:ring-emerald-600/50">提醒状态 · {reminders.reminders.length} 项</summary>
    <p className="py-1 leading-5">外部渠道：{reminders.externalDelivery === "configured" ? "已配置" : "未配置"}；应用内列表不代表已送达。</p>
    <ul className="space-y-1">{reminders.reminders.map(reminder => <li key={reminder.id}>{reminder.status === "sent" && reminder.receiptId ? "已收到提供方回执" : reminder.outcome === "unknown" ? "发送结果未知，请勿自动重试" : reminder.outcome === "quiet" ? "静默时段，暂不发送" : reminder.outcome === "rate_limited" ? "提供方限流" : reminder.channel === "in_app" ? "应用内提醒" : "外部提醒未送达"}</li>)}</ul>
  </details>;
}
