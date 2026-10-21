"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { z } from "zod";
import { learnerEvidenceDisplayLabels } from "@aistudy/domain";
import { LoadingRows, LoadError, ui } from "../design/ui";
import { useDiagnosticsEnabled } from "../settings/appearance-preferences";
import { LearnerShadowPanel } from "./learner-shadow-panel";
const viewSchema = z.object({ independent: z.number(), retention: z.number(), transfer: z.number(), help: z.number() });
const readSchema = z.object({ stateVersion: z.string(), dataAsOf: z.string().datetime(),
  display: z.object({ scope: z.literal("recorded_requirements"), total: z.number().int().nonnegative(),
    unscopedObservations: z.number().int().nonnegative(),
    counts: z.object({ independent: z.number().int().nonnegative(), hinted: z.number().int().nonnegative(), retest: z.number().int().nonnegative(), insufficient: z.number().int().nonnegative() }) }),
  summary: z.array(z.object({ courseId: z.string().uuid(), requirementKey: z.string().nullable(), skillLabel: z.string(),
    status: z.enum(["unobserved", "observed_independent", "needs_check", "needs_review"]), sampleCount: z.number(), views: viewSchema, gaps: z.array(z.string()) })),
  completeness: z.object({ status: z.enum(["complete", "truncated", "unavailable"]), total: z.number(), returned: z.number(), stale: z.boolean(), gaps: z.array(z.string()) }),
});
type Read = z.infer<typeof readSchema>;
const labels = { unobserved: "未测", observed_independent: "已有独立表现", needs_check: "待核对", needs_review: "需复查" };
export function LearnerStateCard({ courseId, revision = 0, proactive = false }: { courseId?: string; revision?: number; proactive?: boolean }) {
  const diagnostics = useDiagnosticsEnabled();
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<Read | null>(null), [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setError(""); setState(null);
    void fetch(`/api/opening/learner-state${courseId ? `?courseId=${encodeURIComponent(courseId)}` : ""}`, { signal: controller.signal, cache: "no-store" }).then(async response => {
      if (!response.ok) throw new Error("当前学习状态暂时无法读取");
      const result = readSchema.parse(await response.json()); if (!controller.signal.aborted) setState(result);
    }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "状态不可用"); });
    return () => controller.abort();
  }, [courseId, revision, retry]);
  if (error) return <LoadError message={error} onRetry={() => setRetry(value => value + 1)} />;
  if (!state) return <LoadingRows label="正在读取学习证据…" />;
  const relevant = courseId ? state.summary.filter(row => row.courseId === courseId) : state.summary;
  const selected = relevant.find(row => row.status === "needs_review") ?? relevant.find(row => row.status === "needs_check") ?? relevant[0];
  return <section className="space-y-3 rounded-xl border border-line bg-surface p-4" aria-label={proactive ? "开始前的学习建议" : "共同学习证据"}>
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold">{proactive ? "从已有记录开始" : "当前学习证据"}</h2><span className="text-xs text-text-2">{selected ? labels[selected.status] : "未测"}</span></div>
    <div className="space-y-2" aria-label="已记录学习要求的状态">
      <p className="text-sm font-medium">已记录的学习要求 · {state.display.total} 项</p>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">{(Object.keys(learnerEvidenceDisplayLabels) as Array<keyof typeof learnerEvidenceDisplayLabels>).map(key => <div className="rounded-lg bg-surface-2 p-3" key={key}><dt className="text-xs text-text-2">{learnerEvidenceDisplayLabels[key]}</dt><dd className="mt-1 font-serif text-2xl tabular-nums text-text">{state.display.counts[key]}</dd></div>)}</dl>
      <p className="text-xs leading-6 text-text-2">每项按最近作答的有效证据归入一类；数学提示 1–3 级均按使用提示记录。已查看本题解法、核验有误或真实复测到期时显示待复测，不表示已自动新增任务。这不是全课程单元覆盖率或掌握率。</p>
      {state.display.unscopedObservations > 0 ? <p className="text-xs leading-6 text-text-2">另有 {state.display.unscopedObservations} 条记录缺少稳定的学习要求关联，未并入计数。</p> : null}
    </div>
    <p className="text-sm leading-7">{selected ? `${selected.skillLabel}已有 ${selected.sampleCount} 条相关记录。${selected.status === "needs_review" ? "先核对有误的关键步骤，再用新题验证。" : selected.status === "needs_check" ? "先检查原答案与来源，再决定下一步。" : "接下来用不同情境的新题检查，延迟保持仍需后续复测。"}` : "尚无足够记录判断这项能力。可以先完成一道新题，保留原始答案，再核对。"}</p>
    {selected ? <dl className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">{([["independent", "独立表现"], ["retention", "保持"], ["transfer", "迁移"], ["help", "帮助后表现"]] as const).map(([key, label]) => <div key={key}><dt className="text-text-2">{label}</dt><dd className="mt-1 font-medium">{selected.views[key] > 0 ? `${selected.views[key]} 条可查看记录` : "尚无可用证据"}</dd></div>)}</dl> : null}
    {selected?.gaps.includes("retention_intervening_exposure_not_established") ? <p className="text-xs leading-6 text-text-2">这是延迟检查表现的视角；期间复习与站外帮助尚未完整核实，不表示未复习保持。</p> : null}
    <p className="text-xs leading-6 text-text-2">四个视角可以来自同一次作答；未观察不表示能力差。这里没有总掌握百分比。</p>
    {selected && (selected.views.retention > 0 || selected.gaps.some(gap => gap.startsWith("retention_"))) ? <p className="text-xs leading-6 text-text-2">保持视角记录延迟后的表现。期间复习和帮助尚未完整确认时，不能把它解释成“未经复习仍然保持”；系统内的曝光记录不能覆盖站外复习，未确认的范围仍保持未知。</p> : null}
    {proactive && selected ? <Link className={ui.secondary} href={`/opening/courses/${selected.courseId}/study`}>{selected.status === "needs_check" || selected.status === "needs_review" ? "核对原记录后继续" : "继续这一项"}</Link> : null}
    <p className="text-xs leading-6 text-text-2">更新于 {new Date(state.dataAsOf).toLocaleString("zh-CN")}。{state.completeness.stale ? "部分来源已更新，请重新核对相关记录。" : ""}</p>
    {diagnostics ? <section className="space-y-1 border-t border-line pt-3 text-xs leading-6 text-text-2" aria-label="学习证据诊断"><h3 className="font-medium">依据与数据范围</h3><p>{state.completeness.status === "truncated" ? `详情返回 ${state.completeness.returned}/${state.completeness.total} 条；摘要按完整历史生成。` : "本次按可访问的真实学习记录生成。"}</p><p className="break-all">状态版本：{state.stateVersion}</p><p>当前建议按本次数据计算，不代表历史推荐的原因。</p></section> : null}
    {diagnostics ? <LearnerShadowPanel courseId={courseId} revision={revision} /> : null}
  </section>;
}
