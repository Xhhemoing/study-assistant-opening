"use client";

import { CalendarDays, Plus, RefreshCw, Target } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { StudyGoal } from "@aistudy/contracts";
import { EmptyState } from "@aistudy/ui";
import { useStudyProvider } from "../../lib/data/react";
import { formatExamDate, goalPath, scenarioLabel } from "./goal-model";

function GoalRow({ goal }: { goal: StudyGoal }) {
  return (
    <li>
      <Link className="flex items-start justify-between gap-4 px-4 py-4 transition-colors hover:bg-surface-2/70 focus-visible:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary" href={goalPath(goal.id)}>
        <span className="flex min-w-0 gap-3">
          <Target aria-hidden="true" className="mt-0.5 shrink-0 text-primary" size={18} />
          <span className="min-w-0 space-y-1">
            <span className="block truncate text-sm font-semibold text-text">{goal.title}</span>
            <span className="block text-xs text-text-dim">{scenarioLabel(goal.scenario)} · {goal.dailyMinutes} 分钟 / 天</span>
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-text-dim">
          <CalendarDays aria-hidden="true" size={14} />
          {formatExamDate(goal.examDate)}
        </span>
      </Link>
    </li>
  );
}

export function GoalList() {
  const provider = useStudyProvider();
  const [goals, setGoals] = useState<StudyGoal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);

  const loadGoals = useCallback(async () => {
    if (!provider) {
      setLoading(true);
      return;
    }
    setLoading(true);
    setError("");
    try {
      setGoals(await provider.listGoals());
    } catch {
      setError("目标加载失败，请重试。");
    } finally {
      setLoading(false);
    }
  }, [provider]);

  useEffect(() => {
    void loadGoals();
  }, [loadGoals, reloadToken]);

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-4 border-b border-line pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <p className="text-xs text-text-dim">学习空间</p>
          <h1 className="text-2xl font-semibold tracking-[-0.02em] text-text">学习目标</h1>
          <p className="max-w-prose text-sm leading-6 text-text-dim">把想完成的事情变成一个可以持续调整的学习方向。</p>
        </div>
        <Link className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-ink hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" href="/learn/goals/new">
          <Plus aria-hidden="true" size={16} />创建目标
        </Link>
      </header>

      {loading ? <p className="border-y border-line py-8 text-sm text-text-dim" role="status">正在读取目标…</p> : null}
      {error ? (
        <section className="space-y-3 border-y border-line py-8" role="alert">
          <p className="text-sm text-danger">{error}</p>
          <button className="inline-flex min-h-10 items-center gap-2 rounded-md border border-line px-3 text-sm text-text hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={() => setReloadToken((value) => value + 1)} type="button">
            <RefreshCw aria-hidden="true" size={16} />重试
          </button>
        </section>
      ) : null}
      {!loading && !error && goals.length === 0 ? (
        <EmptyState
          title="还没有学习目标"
          description="先设置一个方向，今天的学习计划才有可以依靠的上下文。"
          action={<Link className="inline-flex min-h-10 items-center gap-2 rounded-md bg-primary px-3 text-sm font-semibold text-ink hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" href="/learn/goals/new"><Plus aria-hidden="true" size={16} />创建第一个目标</Link>}
        />
      ) : null}
      {!loading && !error && goals.length > 0 ? (
        <section aria-labelledby="goal-list-heading" className="space-y-3">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="text-sm font-semibold text-text" id="goal-list-heading">当前目标</h2>
            <span className="text-xs text-text-dim">{goals.length} 个</span>
          </div>
          <ul className="divide-y divide-line border-y border-line">
            {goals.map((goal) => <GoalRow goal={goal} key={goal.id} />)}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
