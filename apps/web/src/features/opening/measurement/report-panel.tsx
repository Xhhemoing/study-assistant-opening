"use client";

import type { MeasurementAttempt, MeasurementModelScore, MeasurementOverview } from "@aistudy/contracts";
import { useState } from "react";
import { Download } from "lucide-react";
import { ui } from "../design/ui";
import { actualDelay, measurementDate, measurementPhaseLabels } from "./measurement-model";

const number = (value: number | null) => value === null ? "尚无数据" : value.toFixed(4);
const exclusionLabels: Record<string, string> = {
  retracted: "已标记无效", feedback_withheld: "本轮结果尚未公布", skipped: "已跳过", pending: "尚未提交",
  missing_outcome: "缺少结果", assisted: "使用过帮助", repeated: "重复作答", invalid_timing: "时间信息异常",
  missing_prediction: "缺少作答前预测", invalid_prediction: "预测记录异常", prediction_after_presentation: "预测晚于出题",
  invalid_prediction_history: "预测依据异常", missing_prediction_history: "预测依据缺失", invalidated_history: "预测依据已标记无效",
  unpaired_prediction_history: "两种模型的预测依据不一致",
  late_probe: "超出约定复测窗口", insufficient_retest_gap: "与上一轮复测间隔不足",
};

function ModelScores({ models, label }: { models: MeasurementModelScore[]; label: (id: string) => string }) {
  return <div className="overflow-x-auto"><table className="w-full min-w-96 text-left text-xs">
    <caption className="sr-only">同一批有效作答上的预测误差</caption>
    <thead><tr className="border-b border-zinc-200 text-zinc-500"><th className="py-2 font-medium">模型</th><th className="py-2 font-medium">有效题数</th><th className="py-2 font-medium">Brier</th><th className="py-2 font-medium">Log loss</th></tr></thead>
    <tbody>{models.map(model => <tr key={model.modelId} className="border-b border-zinc-100"><th className="py-3 font-medium">{label(model.modelId)}</th><td>{model.count}</td><td>{number(model.brier)}</td><td>{number(model.logLoss)}</td></tr>)}</tbody>
  </table></div>;
}

function AnswerRecord({ attempt, overview, busy, onRetract }: {
  attempt: MeasurementAttempt; overview: MeasurementOverview; busy: boolean; onRetract: (id: string, reason: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState("");
  const delay = actualDelay(attempt, overview);
  const result = attempt.retractedAt ? "已标记无效" : attempt.outcome === "correct" ? "答对" : attempt.outcome === "incorrect" ? "答错" : attempt.outcome === "skipped" ? "已跳过" : "本轮结果待公布";
  return <details className="border-t border-zinc-100 py-3">
    <summary className="cursor-pointer rounded text-xs leading-6 text-zinc-700 focus-visible:ring-2 focus-visible:ring-emerald-600">第 {attempt.ordinal} 题 · {measurementPhaseLabels[attempt.item.phase]} · {attempt.item.skillLabel} · {result}</summary>
    <div className="mt-3 space-y-3 text-xs leading-6 text-zinc-600">
      <p className="whitespace-pre-wrap">{attempt.item.prompt}</p>
      <p>我的选择：{attempt.item.options.find(option => option.id === attempt.answer)?.label ?? "未选择"}</p>
      {attempt.feedback ? <p className="whitespace-pre-wrap">{attempt.feedback}</p> : null}
      <p>提交于 {measurementDate(attempt.answeredAt!)}{delay ? `；距初次练习结束 ${delay}` : ""}。</p>
      {attempt.predictions.length ? <p>作答前已保存的答对概率：{attempt.predictions.map(prediction => `${overview.trial?.models.find(model => model.id === prediction.modelId)?.label ?? prediction.modelId} ${(prediction.probability * 100).toFixed(1)}%`).join("；")}。这是模型预测，不是掌握度。</p> : null}
      {attempt.retractedAt ? <p>标记原因：{attempt.retractionReason}。原始记录保留，已从有效比较中排除。</p> : editing ? <form className="space-y-2" onSubmit={event => { event.preventDefault(); if (reason.trim() && !busy) onRetract(attempt.id, reason.trim()); }}>
        <label className="block" htmlFor={`retract-${attempt.id}`}>说明误操作、已见过答案或其他影响独立性的情况</label>
        <textarea id={`retract-${attempt.id}`} className={ui.input} value={reason} maxLength={500} rows={2} disabled={busy} onChange={event => setReason(event.target.value)} />
        <div className="flex gap-2"><button type="submit" className={ui.secondary} disabled={busy || !reason.trim()}>保留原始记录并标记无效</button><button type="button" className={ui.quiet} disabled={busy} onClick={() => setEditing(false)}>取消</button></div>
      </form> : <button type="button" className={ui.quiet} disabled={busy} onClick={() => setEditing(true)}>这条记录有问题</button>}
    </div>
  </details>;
}

export function MeasurementReportPanel({ overview, busy, onRetract }: {
  overview: MeasurementOverview; busy: boolean; onRetract: (id: string, reason: string) => void;
}) {
  const label = (id: string) => overview.trial?.models.find(model => model.id === id)?.label ?? id;
  return <details className={`${ui.panel} p-5`}>
    <summary className="cursor-pointer rounded text-sm font-medium text-zinc-800 focus-visible:ring-2 focus-visible:ring-emerald-600">测试数据与作答记录</summary>
    <div className="mt-5 space-y-6">
      <p className="text-xs leading-6 text-zinc-600">固定题目让两种模型预测同一次作答。以下指标越低，代表这批数据的预测误差越小；小样本差异不能证明教学效果提升。参数尚未用你的数据校准。</p>
      <ModelScores models={overview.report.models} label={label} />
      <p className="text-xs leading-6 text-zinc-600">配对差值（BKT − 频率基线）：Brier {number(overview.report.pairedBrierDifference)}，Log loss {number(overview.report.pairedLogLossDifference)}。正值表示 BKT 在本批作答中误差更大。</p>
      <div className="grid gap-3 sm:grid-cols-3">{overview.report.byPhase.map(phase => <div key={phase.phase} className="rounded-lg bg-zinc-50 p-3 text-xs leading-6"><p className="font-medium text-zinc-800">{measurementPhaseLabels[phase.phase]}</p><p>{phase.eligible} 条有效独立作答</p>{phase.models.map(model => <p key={model.modelId}>{label(model.modelId)} Brier {number(model.brier)}</p>)}</div>)}</div>
      <details className="text-xs leading-6 text-zinc-600"><summary className="cursor-pointer">校准与排除原因</summary><div className="mt-3 space-y-4">
        <p>跳过 {overview.report.skipped} 题；尚未提交 {overview.report.pending} 题。每条记录列出一个优先排除原因；不把缺测算作答错。</p>
        <ul>{Object.entries(overview.report.excluded).map(([reason, count]) => <li key={reason}>{exclusionLabels[reason] ?? reason}：{count}</li>)}</ul>
        {overview.report.models.map(model => <div key={model.modelId}><p className="font-medium">{label(model.modelId)} · 预测区间 / 样本数 / 平均预测 / 实际正确率</p>{model.calibration.filter(bin => bin.count > 0).map(bin => <p key={bin.lower}>{Math.round(bin.lower * 100)}–{Math.round(bin.upper * 100)}% / {bin.count} / {number(bin.meanPrediction)} / {number(bin.observedAccuracy)}</p>)}</div>)}
      </div></details>
      <div><h3 className="text-sm font-medium text-zinc-800">已提交的记录</h3>{overview.attempts.filter(attempt => attempt.answeredAt !== null).map(attempt => <AnswerRecord key={attempt.id} attempt={attempt} overview={overview} busy={busy} onRetract={onRetract} />)}</div>
      {overview.trial ? <a className={ui.secondary} href={`/api/opening/measurement/export?courseId=${encodeURIComponent(overview.trial.courseId)}`} download><Download size={14} aria-hidden="true" />导出个人测试数据 JSON</a> : null}
      <p className="text-xs leading-6 text-zinc-500">导出包含个人作答、时间、帮助与更正记录、模型版本及预测。暂停会保留记录；同一题组不重复启动，以免已见题影响复测。</p>
    </div>
  </details>;
}
