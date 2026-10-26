"use client";

import { useEffect, useState } from "react";
import { z } from "zod";

const metricSchema = z.number().finite().nonnegative().nullable();
export const learnerShadowComparisonSchema = z.object({ mode: z.literal("shadow"), calibrated: z.literal(false),
  count: z.number().int().nonnegative(), families: z.array(z.string()), cutoff: z.string().datetime().nullable(),
  advanceThreshold: z.number().min(0).max(1), thresholdPolicyVersion: z.string(), dataAsOf: z.string().datetime(),
  excluded: z.record(z.string(), z.number().int().nonnegative()),
  models: z.array(z.object({ modelId: z.enum(["classical-bkt", "pfa", "smoothed-frequency"]), count: z.number().int().nonnegative(),
    aboveThresholdCount: z.number().int().nonnegative(), failedAboveThreshold: z.number().int().nonnegative(),
    failureRateAboveThreshold: z.number().min(0).max(1).nullable(), brier: metricSchema, logLoss: metricSchema })).length(3),
});
export type LearnerShadowComparison = z.infer<typeof learnerShadowComparisonSchema>;
const names = { "classical-bkt": "经典 BKT", pfa: "PFA", "smoothed-frequency": "平滑历史正确率" };
const excludedLabels: Record<string, string> = { missing_family_or_target: "缺少正式题族或目标", family_previously_seen: "此题族此前已发放",
  pending_or_retracted: "尚未作答或已撤回", outcome_ineligible: "作答不满足比较条件", prediction_not_before_answer: "预测未早于答案",
  invalidated_history: "预测依据已修订或失效" };
const score = (value: number | null) => value === null ? "样本不足" : value.toFixed(3);

export function LearnerShadowComparisonBody({ report }: { report: LearnerShadowComparison }) {
  return <div className="space-y-3 pt-3 text-xs leading-6 text-text-2">
    <p>仅实验，三个模型均未校准。这里只比较作答前保存的预测，不用于调整学习安排、判断掌握或决定哪些作答可计入学习结果。</p>
    <p>可比较样本：{report.count} 次，覆盖 {report.families.length} 个题族。预先设置的“可独立推进”预测阈值为 {(report.advanceThreshold * 100).toFixed(0)}%；此阈值不是经验证的学习能力界线。</p>
    <div className="overflow-x-auto"><table className="w-full min-w-[36rem] border-collapse text-left">
      <caption className="sr-only">未校准模型在同一组保留作答上的实验比较</caption>
      <thead><tr className="border-b border-line"><th scope="col" className="p-2">模型</th><th scope="col" className="p-2">样本</th><th scope="col" className="p-2">Brier</th><th scope="col" className="p-2">Log loss</th><th scope="col" className="p-2">阈值以上失败 / 样本</th><th scope="col" className="p-2">失败率</th></tr></thead>
      <tbody>{report.models.map(model => <tr key={model.modelId} className="border-b border-line"><th scope="row" className="p-2 font-medium">{names[model.modelId]}</th><td className="p-2 tabular-nums">{model.count}</td><td className="p-2 tabular-nums">{score(model.brier)}</td><td className="p-2 tabular-nums">{score(model.logLoss)}</td><td className="p-2 tabular-nums">{model.failedAboveThreshold} / {model.aboveThresholdCount}</td><td className="p-2 tabular-nums">{model.failureRateAboveThreshold === null ? "样本不足" : `${(model.failureRateAboveThreshold * 100).toFixed(1)}%`}</td></tr>)}</tbody>
    </table></div>
    <p>Brier 和 Log loss 越低，表示这组已发生答案上的预测误差越小；少量数据不能证明哪个模型更好。没有对应分母时，指标保留为空，不按零失败率解释。</p>
    <p>隔离规则：只使用预测截止点之前、同课程与目标的已确认独立记录；训练排除待预测题族。比较使用三个模型共同合格的作答，并排除当前工作区此前已发放的题族、助答、撤回与已失效的依据。</p>
    {Object.keys(report.excluded).length ? <p>未纳入：{Object.entries(report.excluded).map(([reason, count]) => `${excludedLabels[reason] ?? "其他不完整记录"} ${count} 次`).join("；")}。</p> : null}
    <p>数据截止：{report.dataAsOf}。{report.cutoff ? `最新已评分预测的截止点：${report.cutoff}。` : "尚无可评分的预答预测。"}</p>
  </div>;
}

export function LearnerShadowPanel({ courseId, revision = 0 }: { courseId?: string; revision?: number }) {
  const [expanded, setExpanded] = useState(false), [report, setReport] = useState<LearnerShadowComparison | null>(null), [error, setError] = useState("");
  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    setReport(null); setError("");
    void fetch(`/api/opening/learning/shadow-comparison${courseId ? `?courseId=${encodeURIComponent(courseId)}` : ""}`, { cache: "no-store", signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error("预测对照实验暂时无法读取"); return learnerShadowComparisonSchema.parse(await response.json()); })
      .then(value => { if (!controller.signal.aborted) setReport(value); })
      .catch(() => { if (!controller.signal.aborted) setError("预测对照实验暂时无法读取"); });
    return () => controller.abort();
  }, [expanded, courseId, revision]);
  return <details className="border-t border-line pt-3 text-xs text-text-2" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary className="cursor-pointer py-1 font-medium">预测对照 · 仅实验，未校准</summary>
    {error ? <p role="status" className="pt-3 leading-6">{error}；未将读取失败当成没有样本。</p> : report ? <LearnerShadowComparisonBody report={report} /> : expanded ? <p role="status" className="pt-3">正在读取…</p> : null}
  </details>;
}
