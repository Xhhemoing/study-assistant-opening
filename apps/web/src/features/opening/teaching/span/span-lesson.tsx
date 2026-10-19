"use client";

import Link from "next/link";
import { useState } from "react";
import type { LearningAttempt, LearningObservation, SpanTeachingMode, StudySessionIntent } from "@aistudy/contracts";
import { createSpanTeachingSequence, spanModeForIntent } from "@aistudy/domain";
import { ui } from "../../design/ui";
import { LearnerStateCard } from "../learner-state-card";
import { SpanDelayedRetestControl } from "./delayed-retest-control";
import { SpanWorkedExample, SpanOverviewLinks } from "./worked-example";
import { SpanExplorer } from "./span-explorer";
import { StudyIntentControls } from "../study-intent-controls";
import { SpanPractice } from "./span-practice";

const modeLabels = { self_study: "自学 · 例题到独立新题", overview: "串讲 · 连接方程与几何", challenge: "拔高 · 预设迁移" };
const modeProcess: Record<SpanTeachingMode, string> = {
  self_study: "自学：看例题 → 补全步骤 → 独立新题。目标是自己列出并检查线性组合。",
  overview: "串讲：连接方程与几何 → 对比关系 → 迁移练习。目标是知道不同表示怎样互相转换。",
  challenge: "挑战：先预测 → 探索变化 → 独立迁移。目标是在新结构下解释并检验自己的判断。",
};
const defaultIntent: StudySessionIntent = { purpose: "self_study", timeBudgetMinutes: 20, language: "zh", pace: "normal", continuous: true, selfReportedFatigue: "unknown" };
export function SpanLesson({ courseId, sourceIds, sourceLoadError, delayedRetestId, initialIntent, initialMoveId, initialNewEvidenceEventId }: { courseId: string; sourceIds: string[]; sourceLoadError: boolean; delayedRetestId?: string; initialIntent?: StudySessionIntent; initialMoveId?: string; initialNewEvidenceEventId?: string }) {
  const [intent, setIntent] = useState(initialIntent ?? defaultIntent);
  const [mode, setMode] = useState<SpanTeachingMode>(spanModeForIntent(initialIntent ?? defaultIntent));
  const [step, setStep] = useState(delayedRetestId || initialNewEvidenceEventId ? createSpanTeachingSequence(spanModeForIntent(initialIntent ?? defaultIntent)).length : Math.max(0, createSpanTeachingSequence(spanModeForIntent(initialIntent ?? defaultIntent)).findIndex(move => move.id === initialMoveId)));
  const [activeAttempt, setActiveAttempt] = useState<LearningAttempt | null>(null);
  const [newEvidenceEventId, setNewEvidenceEventId] = useState(initialNewEvidenceEventId);
  const [intentRevision, setIntentRevision] = useState(0);
  const [records, setRecords] = useState<Record<string, LearningObservation>>({});
  const sequence = createSpanTeachingSequence(mode);
  const moves = [...sequence, { ...sequence[sequence.length - 1]!, id: `${mode}-reserved`, presentation: { kind: "independent_item" as const, instructions: "离开示范，用服务器发放的保留题检查" } }];
  const current = moves[step]!;
  const isPresentation = !delayedRetestId && step === 0;
  const problemId = delayedRetestId ? "reserved:auto" : step === moves.length - 1 ? "reserved:auto" : mode === "self_study" ? step === 1 ? "span-faded-3d" : "span-independent-3d"
    : mode === "overview" ? step === 1 ? "span-contrast-dependent" : "span-geometry-transfer"
      : "span-geometry-transfer";
  const currentRecord = records[problemId];
  const complete = !isPresentation && Boolean(currentRecord);
  const successful = currentRecord?.serverEvaluation?.decision === "correct";
  return <main className="h-full overflow-y-auto bg-white text-zinc-800"><header className="flex flex-wrap items-center gap-3 border-b border-zinc-200 px-5 py-3"><Link className={ui.quiet} href={`/opening/courses/${courseId}/study`}>返回课程学习</Link><h1 className="text-sm font-semibold">线性组合与 span</h1><span className="text-xs text-zinc-500">按你的目的推进</span></header>
    <div className="mx-auto max-w-4xl space-y-6 px-5 py-6 sm:px-8"><div className="mb-4 space-y-1"><p className="text-sm font-medium leading-7">{delayedRetestId ? "延迟复测：离开示范，独立完成服务器发放的保留题。" : modeProcess[mode]}</p><p className="text-xs leading-6 text-zinc-500">本次时间预算 {intent.timeBudgetMinutes} 分钟，由你调整；保存新题作答后核对。本示例只覆盖线性组合与 span。</p></div>
      <div className="space-y-2"><h2 className="text-xl font-semibold">如何知道一个向量能不能由另外两个向量组成？</h2><p className="text-sm leading-7 text-zinc-600">建立向量等式，求系数，再检查每一个坐标。例题、带提示练习与独立首答分别保留含义。</p></div>
      <LearnerStateCard courseId={courseId} revision={Object.keys(records).length + intentRevision} proactive />
      {delayedRetestId ? <p role="status" className="rounded-lg bg-emerald-50 p-3 text-sm leading-7">正式延迟复测：本轮直接进入未发放的保留题。时间与课程归属会在发题和提交前重验；本轮帮助仍如实记录。</p> : null}
      {!delayedRetestId ? <fieldset className="grid gap-3 rounded-xl border border-zinc-200 p-4 sm:grid-cols-2"><legend className="px-1 text-xs text-zinc-500">本次学习意图 · 随时可改</legend>
        <label className="block text-xs sm:col-span-2">我想怎样学<select className={`${ui.input} mt-1`} value={intent.purpose} onChange={event => { const purpose = event.target.value as StudySessionIntent["purpose"]; setMode(spanModeForIntent({ ...intent, purpose })); setIntent(current => ({ ...current, purpose })); setStep(0); }}>{Object.entries(modeLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}<option value="confused">看不懂 · 先补最小关系</option><option value="review">复习 · 再用新题检查</option><option value="exam_sprint">冲刺 · 聚焦关键步骤</option></select></label>
        <label className="block text-xs">时间预算（分钟）<input className={`${ui.input} mt-1`} type="number" min={1} max={240} value={intent.timeBudgetMinutes} onChange={event => { const value = Number(event.target.value); if (value >= 1 && value <= 240) setIntent(current => ({ ...current, timeBudgetMinutes: value })); }} /></label>
        <label className="block text-xs">讲解语言<select className={`${ui.input} mt-1`} value={intent.language} onChange={event => setIntent(current => ({ ...current, language: event.target.value as StudySessionIntent["language"] }))}><option value="zh">中文</option><option value="en">English（题意术语）</option><option value="bilingual">中英对照</option></select></label>
        <label className="block text-xs">节奏<select className={`${ui.input} mt-1`} value={intent.pace} onChange={event => setIntent(current => ({ ...current, pace: event.target.value as StudySessionIntent["pace"] }))}><option value="slow">慢一点</option><option value="normal">正常</option><option value="fast">直接给关键步骤</option></select></label>
        <label className="block text-xs">当前精力<select className={`${ui.input} mt-1`} value={intent.selfReportedFatigue} onChange={event => setIntent(current => ({ ...current, selfReportedFatigue: event.target.value as StudySessionIntent["selfReportedFatigue"] }))}><option value="unknown">未说明</option><option value="low">精力尚可</option><option value="high">有些疲劳</option></select></label>
        <label className="flex items-center gap-2 text-xs sm:col-span-2"><input type="checkbox" checked={intent.continuous} onChange={event => setIntent(current => ({ ...current, continuous: event.target.checked }))} className="accent-emerald-700" />愿意连续推进；仍由我决定何时进入下一步</label>
      </fieldset> : null}
      {activeAttempt ? <StudyIntentControls key={activeAttempt.id} attempt={activeAttempt} desiredIntent={intent} onApplied={(next, action, evidenceEventId) => {
        setIntent({ ...next }); setIntentRevision(value => value + 1);
        const nextMode = spanModeForIntent(next);
        if (evidenceEventId) { setRecords(currentRecords => { const remaining = { ...currentRecords }; delete remaining["reserved:auto"]; return remaining; }); setNewEvidenceEventId(evidenceEventId); setMode(nextMode); setStep(createSpanTeachingSequence(nextMode).length); }
        else if (action === "diagnose" || action === "increase_challenge" || nextMode !== mode) { setMode(nextMode); setStep(0); }
      }} /> : null}
      {intent.selfReportedFatigue === "high" || intent.timeBudgetMinutes < 10 ? <p role="status" className="text-xs leading-6 text-zinc-600">这次先完成一个短步骤即可，首答草稿会保留。疲劳只改变节奏，不改变你的正确性记录。</p> : null}
      {intent.language !== "zh" ? <p className="text-sm leading-7">Span = all linear combinations（所有线性组合）; coefficient = 系数; consistent system = 相容方程组。Language support translates the question; it does not solve it. 深入英文解释可在本题提问中选择语言支持。</p> : null}
      {!delayedRetestId ? <p className="text-xs leading-6 text-zinc-500">可自行选择步骤；跳到新题不表示前面的观察目标已通过，原有待核对表现继续保留。</p> : null}
      <nav hidden={Boolean(delayedRetestId)} aria-label="span 教学步骤" className="flex flex-wrap gap-3">{moves.map((move, index) => <button key={move.id} type="button" className={step === index ? ui.secondary : ui.quiet} aria-current={step === index ? "step" : undefined} onClick={() => setStep(index)}>{index + 1}. {move.presentation.kind === "worked_example" ? "逐步看例题" : move.presentation.kind === "faded_example" ? "补全步骤" : move.presentation.kind === "contrast" ? "结构对比" : move.presentation.kind === "predict_then_explore" ? "预测与探索" : "独立新题"}</button>)}</nav>
      <section className="space-y-4"><h2 className="text-lg font-semibold">{current.presentation.instructions}</h2><p className="text-sm leading-7">{current.studentAction}</p>
        {isPresentation ? <>
          {mode === "challenge" ? <SpanExplorer courseId={courseId} sourceId={sourceIds[0]} /> : <SpanWorkedExample courseId={courseId} sourceId={sourceIds[0]} fast={intent.pace === "fast"} />}
          {mode === "overview" ? <SpanOverviewLinks courseId={courseId} sourceId={sourceIds[0]} /> : null}
          {mode !== "challenge" ? <SpanExplorer courseId={courseId} sourceId={sourceIds[0]} /> : null}
        </> : sourceLoadError || !sourceIds.length ? <p role="alert" className="text-sm leading-7 text-amber-900">课程材料暂不可核实，不能固定正式题目版本。请返回课程添加或恢复一份可用材料；已写草稿仍保留。</p> : <SpanPractice key={`${mode}:${problemId}:${newEvidenceEventId ?? ""}`} courseId={courseId} sourceIds={sourceIds} problemId={problemId} intent={intent} intentRevision={intentRevision} newEvidenceEventId={newEvidenceEventId} retestId={delayedRetestId} onAttempt={setActiveAttempt} onIntentApplied={(next, action) => { setIntent(next); const nextMode = spanModeForIntent(next); if (action === "diagnose" || action === "increase_challenge" || nextMode !== mode) { setMode(nextMode); setStep(0); } }} onRecorded={record => setRecords(current => ({ ...current, [problemId]: record }))} />}
      </section>
      {complete ? <div className="space-y-3 rounded-xl bg-zinc-50 p-4"><h3 className="text-sm font-medium">下一步</h3><p className="text-sm leading-7">{currentRecord?.serverEvaluation?.decision === "correct" ? "这道题已核对。继续用新的结构检查，稍后再做延迟复测；本次正确尚不说明保持或稳固掌握。" : "先核对未一致的步骤或输入格式。原始首答保留，修正不会覆盖它；需要时回看例题，再用新题检查。"}</p>{currentRecord?.serverEvaluation?.decision !== "correct" ? <button type="button" className={ui.secondary} onClick={() => setStep(0)}>回看关系与示范</button> : null}<p className="text-xs leading-6 text-zinc-500">文字理由与解释质量另行核对；自动核算只对结构化数学步骤负责。</p>{currentRecord && !delayedRetestId ? <SpanDelayedRetestControl key={currentRecord.id} record={currentRecord} /> : null}</div> : null}
      <details className="text-xs leading-6 text-zinc-500"><summary className="cursor-pointer">本步骤期待观察什么</summary><p>{current.expectedObservation}</p><p>继续或停止：{current.continuation.stopWhen}</p><p>覆盖知识点：{current.targetKnowledgeComponents.join("、")}</p></details>
      <div className="flex flex-wrap gap-3 border-t border-zinc-200 pt-4">{step > 0 && !delayedRetestId ? <button type="button" className={ui.quiet} onClick={() => setStep(value => value - 1)}>回看上一步</button> : null}{step < moves.length - 1 ? <button type="button" className={ui.primary} disabled={!isPresentation && !successful} onClick={() => setStep(value => value + 1)}>{isPresentation ? "开始补全新题" : "本步骤通过，进入下一道新题"}</button> : <Link className={ui.secondary} href={`/opening/courses/${courseId}#course-learning-records`}>回到课程记录，安排后续复测</Link>}</div>
    </div>
  </main>;
}
