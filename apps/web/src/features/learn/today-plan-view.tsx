"use client";

import { CalendarCheck, Check, Circle, LoaderCircle, Pin, RefreshCw, SkipForward } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { PlannedTask, TodayPlan } from "@aistudy/contracts";
import { EmptyState } from "@aistudy/ui";
import { useStudyProvider } from "../../lib/data/react";
import { getPlanCompletion, taskHref } from "./today-plan-model";
import { needsOptionChoice } from "../today-plan/plan-options-model";
import { PlanOptionsPicker } from "../today-plan/plan-options";

const kindLabels: Record<PlannedTask["kind"], string> = {
  practice: "练习",
  review: "复习",
  explore: "探索",
  output: "输出",
};

export function TodayPlanView() {
  const provider = useStudyProvider();
  const [plan, setPlan] = useState<TodayPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [selectedOptionId, setSelectedOptionId] = useState("");

  const loadPlan = useCallback(async () => {
    if (!provider) {
      setLoading(true);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const next = await provider.getTodayPlan();
      setPlan(next);
      setSelectedOptionId(next.options[0]?.id ?? "");
    } catch {
      setPlan(null);
      setError("今日计划暂时无法读取，请先创建目标或稍后重试。");
    } finally {
      setLoading(false);
    }
  }, [provider]);

  useEffect(() => {
    void loadPlan();
  }, [loadPlan, reloadToken]);

  async function chooseOption() {
    const optionId = selectedOptionId || plan?.options[0]?.id || "";
    if (!provider || !plan || !optionId || busyTaskId) return;
    setBusyTaskId(optionId);
    setError("");
    try {
      setPlan(await provider.selectPlanOption(plan.date, optionId));
    } catch {
      setError("方案应用失败，请重试。");
    } finally {
      setBusyTaskId(null);
    }
  }

  async function updateTask(task: PlannedTask, status: PlannedTask["status"]) {
    if (!provider || !plan || busyTaskId) return;
    setBusyTaskId(task.id);
    setError("");
    try {
      setPlan(await provider.setTaskStatus(plan.date, task.id, status));
    } catch {
      setError("任务状态更新失败，请重试。");
    } finally {
      setBusyTaskId(null);
    }
  }

  async function toggleLock(task: PlannedTask) {
    if (!provider || !plan || busyTaskId) return;
    setBusyTaskId(task.id);
    setError("");
    try {
      setPlan(await provider.toggleTaskLock(plan.date, task.id));
    } catch {
      setError("任务固定状态更新失败，请重试。");
    } finally {
      setBusyTaskId(null);
    }
  }

  if (loading) return <p className="border-y border-line py-8 text-sm text-text-dim" role="status">正在读取今日计划...</p>;
  if (error && !plan) {
    return (
      <section className="space-y-4 border-y border-line py-8" role="alert">
        <p className="text-sm text-danger">{error}</p>
        <div className="flex flex-wrap gap-3">
          <button className="inline-flex min-h-10 items-center gap-2 rounded-md border border-line px-3 text-sm text-text hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={() => setReloadToken((value) => value + 1)} type="button">
            <RefreshCw aria-hidden="true" size={16} />重试
          </button>
          <Link className="inline-flex min-h-10 items-center rounded-md bg-primary px-3 text-sm font-semibold text-ink hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" href="/learn/goals/new">创建目标</Link>
        </div>
      </section>
    );
  }
  if (!plan) return null;

  const completion = getPlanCompletion(plan);
  const choosing = needsOptionChoice(plan);
  const optionId = selectedOptionId || plan.options[0]?.id || "";
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-4 border-b border-line pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <p className="text-xs text-text-dim">目标学习</p>
          <h1 className="text-2xl font-semibold tracking-[-0.02em] text-text">今天，从一个清晰的任务开始</h1>
          <p className="max-w-prose text-sm leading-6 text-text-dim">计划会根据目标和有效学习证据逐步调整。</p>
        </div>
        <Link className="inline-flex min-h-10 items-center justify-center rounded-md border border-line px-3 text-sm text-text-dim hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" href="/learn/goals">管理目标</Link>
      </header>

      {error ? <p className="text-sm text-danger" role="alert">{error}</p> : null}
      <section className="space-y-4" aria-labelledby="today-plan-heading">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2"><CalendarCheck aria-hidden="true" className="text-primary" size={19} /><h2 className="text-base font-semibold text-text" id="today-plan-heading">今日任务</h2></div>
          <span className="text-xs text-text-dim">{completion.done}/{completion.total} 完成 · {plan.totalMinutes}/{plan.budgetMinutes} 分钟</span>
        </div>
        <progress aria-label={`今日计划完成度 ${completion.percent}%`} className="h-2 w-full accent-primary" max={100} value={completion.percent} />
        {choosing ? <PlanOptionsPicker confirming={busyTaskId !== null} onConfirm={() => void chooseOption()} onSelect={setSelectedOptionId} plan={plan} selectedId={optionId} /> : plan.tasks.length === 0 ? <EmptyState title="今天还没有可执行任务" description="先完成一次练习或从自由探索开始，系统会逐步形成计划。" action={<Link className="inline-flex min-h-10 items-center gap-2 rounded-md bg-primary px-3 text-sm font-semibold text-ink hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" href="/explore">开始探索</Link>} /> : (
          <ul className="divide-y divide-line border-y border-line">
            {plan.tasks.map((task) => {
              const busy = busyTaskId === task.id;
              return (
                <li className="flex flex-col gap-4 py-4 sm:flex-row sm:items-center sm:justify-between" key={task.id}>
                  <div className="flex min-w-0 items-start gap-3">
                    <span className={`mt-0.5 inline-grid size-8 shrink-0 place-items-center rounded-full ${task.status === "done" ? "bg-success/15 text-success" : "bg-surface-2 text-text-dim"}`} aria-hidden="true">{task.status === "done" ? <Check size={16} /> : <Circle size={14} />}</span>
                    <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className={`text-sm font-semibold ${task.status === "done" ? "text-text-dim line-through" : "text-text"}`}>{task.title}</h3><span className="text-[11px] text-text-dim">{kindLabels[task.kind]} · 约 {task.estimatedMinutes} 分钟</span></div><p className="mt-1 text-xs text-text-dim">{task.reason}</p></div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                    <button aria-label={task.locked ? "取消固定任务" : "固定任务"} className={`inline-grid size-9 place-items-center rounded-md border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${task.locked ? "border-primary text-primary" : "border-line text-text-dim hover:bg-surface-2"}`} disabled={busyTaskId !== null} onClick={() => void toggleLock(task)} title={task.locked ? "取消固定任务" : "固定任务"} type="button"><Pin aria-hidden="true" size={15} /></button>
                    {task.status === "pending" ? <><Link className="inline-flex min-h-9 items-center rounded-md bg-primary px-3 text-xs font-semibold text-ink hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" href={taskHref(task, plan.date)}>开始</Link><button className="inline-flex min-h-9 items-center gap-1 rounded-md border border-line px-3 text-xs text-text-dim hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" disabled={busyTaskId !== null} onClick={() => void updateTask(task, "skipped")} type="button"><SkipForward aria-hidden="true" size={14} />跳过</button></> : null}
                    {task.status !== "done" ? <button className="inline-flex min-h-9 items-center gap-1 rounded-md border border-line px-3 text-xs text-text-dim hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" disabled={busyTaskId !== null} onClick={() => void updateTask(task, "done")} type="button">{busy ? <LoaderCircle aria-hidden="true" className="animate-spin" size={14} /> : <Check aria-hidden="true" size={14} />}完成</button> : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
