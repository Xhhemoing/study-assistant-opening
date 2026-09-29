"use client";

import { CalendarCheck, Check, Circle, LoaderCircle, Pin, RefreshCw, SkipForward } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { PlannedTask, TodayPlan } from "@aistudy/contracts";
import { EmptyState, PageHeading, ui } from "../opening/design/ui";
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
  const [showAll, setShowAll] = useState(false);

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

  if (loading) return <p className="border-y border-zinc-200 py-8 text-sm text-zinc-500" role="status">正在读取今日计划...</p>;
  if (error && !plan) {
    return (
      <section className="space-y-4 border-y border-zinc-200 py-8" role="alert">
        <p className="text-sm text-red-700">{error}</p>
        <div className="flex flex-wrap gap-3">
          <button className={ui.secondary} onClick={() => setReloadToken((value) => value + 1)} type="button">
            <RefreshCw aria-hidden="true" size={16} />重试
          </button>
          <Link className={ui.primary} href="/learn/goals/new">创建目标</Link>
        </div>
      </section>
    );
  }
  if (!plan) return null;

  const completion = getPlanCompletion(plan);
  const choosing = needsOptionChoice(plan);
  const optionId = selectedOptionId || plan.options[0]?.id || "";
  return (
    <main className="min-w-0 bg-white"><PageHeading title="今日计划" description="根据目标和有效学习证据安排今天的任务。" action={<Link className={ui.secondary} href="/learn/goals">管理目标</Link>} /><div className="mx-auto max-w-5xl space-y-5 px-5 py-5">

      {error ? <p className="text-sm text-red-700" role="alert">{error}</p> : null}
      <section className="space-y-4" aria-labelledby="today-plan-heading">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2"><CalendarCheck aria-hidden="true" className="text-emerald-700" size={19} /><h2 className="text-base font-semibold text-zinc-900" id="today-plan-heading">今日任务</h2></div>
          <span className="text-xs text-zinc-500">{completion.done}/{completion.total} 完成 · {plan.totalMinutes}/{plan.budgetMinutes} 分钟</span>
        </div>
        <progress aria-label={`今日计划完成度 ${completion.percent}%`} className="h-2 w-full accent-emerald-600" max={100} value={completion.percent} />
        {choosing ? <PlanOptionsPicker confirming={busyTaskId !== null} onConfirm={() => void chooseOption()} onSelect={setSelectedOptionId} plan={plan} selectedId={optionId} /> : plan.tasks.length === 0 ? <EmptyState title="今天还没有可执行任务" description="先完成一次练习或从自由探索开始，系统会逐步形成计划。" action={<Link className={ui.primary} href="/explore">开始探索</Link>} /> : (
          <ul className="divide-y divide-zinc-200 border-y border-zinc-200">
            {plan.tasks.slice(0, showAll ? undefined : 3).map((task) => {
              const busy = busyTaskId === task.id;
              return (
                <li className="flex flex-col gap-4 py-4 sm:flex-row sm:items-center sm:justify-between" key={task.id}>
                  <div className="flex min-w-0 items-start gap-3">
                    <span className={`mt-0.5 inline-grid size-8 shrink-0 place-items-center rounded-full ${task.status === "done" ? "bg-emerald-50 text-emerald-700" : "bg-zinc-100 text-zinc-500"}`} aria-hidden="true">{task.status === "done" ? <Check size={16} /> : <Circle size={14} />}</span>
                    <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className={`text-sm font-semibold ${task.status === "done" ? "text-zinc-500 line-through" : "text-zinc-900"}`}>{task.title}</h3><span className="text-[11px] text-zinc-500">{kindLabels[task.kind]} · 约 {task.estimatedMinutes} 分钟</span></div><details className="mt-1 text-xs text-zinc-500"><summary className="w-fit cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700">安排依据</summary><p className="mt-2 text-sm leading-7 text-zinc-600">{task.reason}</p></details></div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                    <button aria-label={task.locked ? "取消固定任务" : "固定任务"} className={`inline-grid size-10 md:size-8 place-items-center rounded-md border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 ${task.locked ? "border-emerald-600 text-emerald-700" : "border-zinc-200 text-zinc-500 hover:bg-zinc-100"}`} disabled={busyTaskId !== null} onClick={() => void toggleLock(task)} title={task.locked ? "取消固定任务" : "固定任务"} type="button"><Pin aria-hidden="true" size={15} /></button>
                    {task.status === "pending" ? <><Link className={ui.primary} href={taskHref(task, plan.date)}>开始</Link><button className={ui.secondary} disabled={busyTaskId !== null} onClick={() => void updateTask(task, "skipped")} type="button"><SkipForward aria-hidden="true" size={14} />跳过</button></> : null}
                    {task.status !== "done" ? <button className={ui.secondary} disabled={busyTaskId !== null} onClick={() => void updateTask(task, "done")} type="button">{busy ? <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" size={14} /> : <Check aria-hidden="true" size={14} />}完成</button> : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {!choosing && plan.tasks.length > 3 ? <button className={ui.quiet} aria-expanded={showAll} onClick={() => setShowAll((current) => !current)} type="button">{showAll ? "收起任务" : `展开全部 ${plan.tasks.length} 项任务`}</button> : null}
      </section>
    </div></main>
  );
}
