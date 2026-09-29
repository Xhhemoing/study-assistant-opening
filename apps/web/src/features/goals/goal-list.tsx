"use client";

import { CalendarDays, Plus, RefreshCw, Target } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { StudyGoal } from "@aistudy/contracts";
import { EmptyState, PageHeading, ui } from "../opening/design/ui";
import { useStudyProvider } from "../../lib/data/react";
import { formatExamDate, goalPath, scenarioLabel } from "./goal-model";

function GoalRow({ goal }: { goal: StudyGoal }) {
  return (
    <li>
      <Link className="flex items-start justify-between gap-4 px-3 py-3 transition-colors duration-150 motion-reduce:transition-none hover:bg-zinc-50 focus-visible:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-600" href={goalPath(goal.id)}>
        <span className="flex min-w-0 gap-3">
          <Target aria-hidden="true" className="mt-0.5 shrink-0 text-emerald-700" size={18} />
          <span className="min-w-0 space-y-1">
            <span className="block truncate text-sm font-semibold text-zinc-900">{goal.title}</span>
            <span className="block text-xs text-zinc-500">{scenarioLabel(goal.scenario)} · {goal.dailyMinutes} 分钟 / 天</span>
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-zinc-500">
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
    <main className="min-w-0 bg-white"><PageHeading title="学习目标" description="调整你的学习方向、时间和目标场景。" action={<Link className={ui.primary} href="/learn/goals/new"><Plus aria-hidden="true" size={14} />创建目标</Link>} /><div className="mx-auto max-w-5xl space-y-5 px-5 py-5">

      {loading ? <p className="border-y border-zinc-200 py-8 text-sm text-zinc-500" role="status">正在读取目标…</p> : null}
      {error ? (
        <section className="space-y-3 border-y border-zinc-200 py-8" role="alert">
          <p className="text-sm text-red-700">{error}</p>
          <button className={ui.secondary} onClick={() => setReloadToken((value) => value + 1)} type="button">
            <RefreshCw aria-hidden="true" size={16} />重试
          </button>
        </section>
      ) : null}
      {!loading && !error && goals.length === 0 ? (
        <EmptyState
          title="还没有学习目标"
          description="先设置一个方向，今天的学习计划才有可以依靠的上下文。"
          action={<Link className={ui.primary} href="/learn/goals/new"><Plus aria-hidden="true" size={16} />创建第一个目标</Link>}
        />
      ) : null}
      {!loading && !error && goals.length > 0 ? (
        <section aria-labelledby="goal-list-heading" className="space-y-3">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="text-sm font-semibold text-zinc-900" id="goal-list-heading">当前目标</h2>
            <span className="text-xs text-zinc-500">{goals.length} 个</span>
          </div>
          <ul className="divide-y divide-zinc-200 border-y border-zinc-200">
            {goals.map((goal) => <GoalRow goal={goal} key={goal.id} />)}
          </ul>
        </section>
      ) : null}
    </div></main>
  );
}
