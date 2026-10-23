"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { OpeningApi } from "../client/api";
import { createOpeningCardsClient } from "../cards/cards-client";
import { groupReviewTasks } from "../review/review-queue";
import { ui } from "../design/ui";
import { localDateKey } from "./today-view";
import { summarizeTodayPlan } from "./today-overview";

type Progress = { plan: { done: number; total: number } | null; reviews: number | null; failed: boolean };

/** Confirmed task progress, not inferred study time or mastery. These reads never accept a plan. */
export function TodayProgress({ api, timeZone, reloadToken }: {
  api: Pick<OpeningApi, "listTasks" | "getToday">; timeZone: string; reloadToken: number;
}) {
  const cards = useMemo(() => createOpeningCardsClient(), []);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    const now = new Date();
    void Promise.allSettled([api.listTasks(), api.getToday(localDateKey(now, timeZone)), cards.listDue("auto")]).then(([tasks, plan, due]) => {
      if (!active) return;
      setProgress({
        plan: tasks.status === "fulfilled" && plan.status === "fulfilled"
          ? summarizeTodayPlan(tasks.value.tasks, plan.value) : null,
        reviews: tasks.status === "fulfilled" && due.status === "fulfilled"
          ? groupReviewTasks(tasks.value.tasks, now.getTime()).ready.length + due.value.length : null,
        failed: [tasks, plan, due].some(result => result.status === "rejected"),
      });
    });
    const onFocus = () => setRevision(value => value + 1);
    window.addEventListener("focus", onFocus);
    return () => { active = false; window.removeEventListener("focus", onFocus); };
  }, [api, cards, timeZone, reloadToken, revision]);

  return <section aria-label="今天的进度" className="mx-5 rounded-xl border border-line bg-surface px-4 py-4">
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div>
        <h2 className="text-sm font-medium">今天的进度</h2>
        {!progress ? <p role="status" className="mt-2 text-sm text-text-2">正在查看…</p>
          : progress.plan?.total ? <><p className="mt-2 text-sm text-text-2">今日计划已完成 {progress.plan.done}/{progress.plan.total} 项</p><progress aria-label="今日计划完成进度" value={progress.plan.done} max={progress.plan.total} className="mt-2 h-2 w-40 accent-accent" /></>
            : progress.plan ? <p className="mt-2 text-sm text-text-2">从一道练习开始，慢慢积累。</p> : null}
      </div>
      <Link href="/opening/review" className={ui.secondary}>复习{progress?.reviews != null ? ` · ${progress.reviews} 项` : ""}</Link>
    </div>
    {progress?.failed ? <p role="status" className="mt-3 text-xs text-text-2">部分进度还没加载好。<button type="button" className={ui.quiet} onClick={() => setRevision(value => value + 1)}>再试一次</button></p> : null}
  </section>;
}
