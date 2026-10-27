"use client";
import type { LearningObservation, SpanLessonSnapshot } from "@aistudy/contracts";
import { learnerEvidenceState, learnerEvidenceLabels } from "../learner-evidence-state";
import { SpanDelayedRetestControl } from "./delayed-retest-control";
import { useDiagnosticsEnabled } from "../../settings/appearance-preferences";
import { SpanNextActionControl, currentSpanObservationId } from "./span-next-action-control";
import { SpanTutorControl } from "./span-tutor-control";

export function summarizeSpanSession(observations: readonly LearningObservation[]) {
  const current = observations.filter(row => row.revisionKind !== "retract" && (!row.effectiveHeadId || row.effectiveHeadId === row.id));
  return { recorded: current.length,
    independent: current.filter(row => learnerEvidenceState(row) === "independent").length,
    helped: current.filter(row => row.assistance === "hinted" || row.assistance === "revealed").length,
    needsCheck: current.filter(row => row.serverEvaluation?.decision !== "correct").length,
    observations: current,
  };
}
export function SpanSessionSummary({ observations, delayed = false, session, onReload }: { observations: LearningObservation[]; delayed?: boolean; session?: SpanLessonSnapshot; onReload?: () => void }) {
  const diagnostics = useDiagnosticsEnabled();
  const summary = summarizeSpanSession(observations);
  const latest = [...summary.observations].reverse().find(row => row.serverEvaluation?.evaluatorVersion === "span-exact-v1" && row.serverEvaluation.decision !== "abstain");
  return <section className="space-y-4 rounded-xl border border-line bg-surface p-5" aria-label="本次 span 学习小结">
    <h2 className="text-lg font-semibold">本次学习小结</h2>
    {session && session.status !== "active" ? <SpanTutorControl key={session.courseId} courseId={session.courseId} /> : null}
    <dl className="grid grid-cols-2 gap-3">{[["完成练习", summary.recorded], ["再练一步", summary.needsCheck]].map(([label, count]) => <div key={label} className="rounded-lg bg-surface-2 p-3"><dt className="text-xs text-text-2">{label}</dt><dd className="mt-1 text-lg font-semibold">{count}</dd></div>)}</dl>
    <p className="text-sm leading-7 text-text-2">回想一下：你能写出向量等式，并检查每一个坐标了吗？过几天再用一道新题试试。</p>
    {diagnostics ? <p className="text-xs text-text-3">诊断：独立核对正确 {summary.independent}；使用帮助作答 {summary.helped}。这些记录不等同于长期掌握。</p> : null}
    {summary.observations.length ? <ul className="space-y-2">{summary.observations.map((row, index) => <li key={row.id} className="rounded-lg border border-line p-3 text-sm"><p>练习 {index + 1} · {diagnostics ? learnerEvidenceLabels[learnerEvidenceState(row)] : row.serverEvaluation?.decision === "correct" ? "这道题做对了" : "回顾一下解法"}</p><details className="mt-2"><summary className="cursor-pointer text-xs text-text-2">回看我的答案</summary><pre className="mt-2 whitespace-pre-wrap break-words text-xs leading-6">{row.answer}</pre><p className="mt-2 text-xs text-text-3">{new Date(row.occurredAt).toLocaleString("zh-CN")}</p></details></li>)}</ul> : <p className="text-sm text-text-2">还没有完成练习，可以接着刚才的题目试试。</p>}
    {!delayed && latest ? <SpanDelayedRetestControl key={latest.id} record={latest} /> : null}
    {session ? <SpanNextActionControl session={session} observationId={currentSpanObservationId(observations, session)} onReload={onReload} /> : null}
  </section>;
}
