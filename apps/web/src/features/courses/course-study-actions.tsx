"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ArrowRight, CalendarPlus, ClipboardList } from "lucide-react";
import { createOpeningApi, type OpeningApi } from "../opening/client/api";
import { ui } from "../opening/design/ui";
import { runSeedTodayPlan } from "../opening/planning/seed-today-plan";

/** Primary learning CTA only; materials / records stay secondary (CT-01 / CT-02). */
export function CourseStudyActions({
  assetCount,
  goalCount,
  opening = false,
  courseId,
  courseTitle,
  api: suppliedApi,
}: {
  assetCount: number;
  goalCount?: number;
  opening?: boolean;
  courseId?: string;
  courseTitle?: string;
  api?: OpeningApi;
}) {
  const router = useRouter();
  const api = useMemo(() => suppliedApi ?? createOpeningApi(), [suppliedApi]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const countText =
    typeof goalCount === "number"
      ? `${assetCount} 份课程材料 · ${goalCount} 个学习目标`
      : `${assetCount} 份课程材料`;
  const canSeed = Boolean(opening && courseId && courseTitle);

  async function seedTodayPlan() {
    if (!canSeed || !courseId || !courseTitle || busy) return;
    setBusy(true);
    setError("");
    try {
      await runSeedTodayPlan(api, {
        target: { kind: "course", courseId, courseTitle },
        navigate: (href) => router.push(href),
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "设为今日计划失败，请重试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="border-b border-zinc-200 pb-5" aria-labelledby="course-study-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="course-study-heading" className="text-sm font-semibold text-zinc-800">开始这次学习</h2>
        <p className="text-xs text-zinc-500">{countText}</p>
      </div>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-600">
        {opening
          ? "一次主路径：设为今日计划 → 确认草案 → 开始学习。独立练习与材料在次要入口，不与主行动抢注意力。"
          : "一次主路径：选主题 → 作答 → 保存。材料与设置在下方折叠区，不与主行动抢注意力。"}
      </p>
      <nav aria-label="课程学习方式" className="mt-3 flex flex-wrap items-center gap-2">
        {canSeed ? (
          <button
            type="button"
            className={ui.primary}
            disabled={busy}
            onClick={() => void seedTodayPlan()}
          >
            <CalendarPlus size={14} aria-hidden="true" />
            {busy ? "正在设置…" : "设为今日计划"}
          </button>
        ) : null}
        <a
          className={canSeed ? ui.quiet : ui.primary}
          href="#course-practice"
        >
          开始独立练习
          <ArrowRight size={14} aria-hidden="true" />
        </a>
        <a className={ui.quiet} href="#course-learning-records">
          <ClipboardList size={14} aria-hidden="true" />
          学习记录
        </a>
        <Link className={ui.quiet} href={opening ? "/opening/library?tab=notes" : "/library/new"}>
          写笔记
        </Link>
      </nav>
      {error ? (
        <p className="mt-2 text-xs leading-5 text-red-700" role="alert">{error}</p>
      ) : null}
      <p className="mt-2 text-xs leading-5 text-zinc-500">
        {opening
          ? "「设为今日计划」会写入默认作息（若尚未设置）并添加一条今日任务，然后打开今日推荐草案。"
          : "没有材料也能开始；独立练习与自报记录不需要 AI。课程材料见下方折叠区。"}
      </p>
    </section>
  );
}
