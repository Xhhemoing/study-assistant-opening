"use client";

import type { ExamIntegrationOverview, ExamSprintOverview } from "@aistudy/contracts";
import { ui } from "../design/ui";
import { useDiagnosticsEnabled } from "../settings/appearance-preferences";

export function BktPanel({ integration, overview }: { integration: ExamIntegrationOverview; overview: ExamSprintOverview }) {
  const diagnostics = useDiagnosticsEnabled();
  if (!diagnostics) return null;
  const report = integration.bkt;
  return <section className={`${ui.panel} space-y-4 p-5`} aria-labelledby="exam-bkt-title"><h2 id="exam-bkt-title" className="font-semibold">下一题表现估计 · 未校准</h2><p className="text-sm leading-7 text-text-2">以下是下一题独立答对的模型估计，不是掌握百分比，也不是考试分数。模型尚未用你的长期记录完成校准，先观察实际预测与结果的差距。</p><p className="rounded-lg bg-warn-soft p-3 text-xs leading-6 text-warn">{report.message}</p><ul className="divide-y divide-line">{report.skills.map(skill => <li key={skill.skillId} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm"><span>{overview.skills.find(item => item.skillId === skill.skillId)?.title ?? skill.skillId}</span><span className="text-text-2">{skill.nextCorrectProbability === null ? "暂无可用估计" : `下题独立答对估计 ${Math.round(skill.nextCorrectProbability * 100)}%`}<span className="ml-2 text-xs text-text-3">有效样本 {skill.eligible}</span></span></li>)}</ul><details className="border-t border-line pt-3"><summary className="min-h-11 cursor-pointer text-xs font-medium text-text-2 py-2">查看估计质量与样本范围</summary><div className="mt-3 space-y-2 text-xs leading-6 text-text-2"><p>有效预测结果 {report.eligible} 次；排除 {report.excluded} 次。求助、重复题族等暂不计入的记录，不会被当作独立作答依据。</p><p>BKT Brier 误差：{report.bktBrier === null ? "样本不足" : report.bktBrier.toFixed(3)}；简单基线：{report.baselineBrier === null ? "样本不足" : report.baselineBrier.toFixed(3)}。</p><p>Brier 比较事先预测与实际结果，越小越好。小样本下的差异不能证明模型更准；仍需继续收集独立作答。</p></div></details></section>;
}
