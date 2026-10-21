import type { LearningObservation } from "@aistudy/contracts";
import { learnerEvidenceState, learnerEvidenceLabels } from "../learner-evidence-state";
import { SpanDelayedRetestControl } from "./delayed-retest-control";

export function summarizeSpanSession(observations: readonly LearningObservation[]) {
  const current = observations.filter(row => row.revisionKind !== "retract" && (!row.effectiveHeadId || row.effectiveHeadId === row.id));
  return { recorded: current.length,
    independent: current.filter(row => learnerEvidenceState(row) === "independent").length,
    helped: current.filter(row => row.assistance === "hinted" || row.assistance === "revealed").length,
    needsCheck: current.filter(row => row.serverEvaluation?.decision !== "correct").length,
    observations: current,
  };
}
export function SpanSessionSummary({ observations, delayed = false }: { observations: LearningObservation[]; delayed?: boolean }) {
  const summary = summarizeSpanSession(observations);
  const latest = [...summary.observations].reverse().find(row => row.serverEvaluation?.evaluatorVersion === "span-exact-v1" && row.serverEvaluation.decision !== "abstain");
  return <section className="space-y-4 rounded-xl border border-line bg-surface p-5" aria-label="本次 span 学习小结">
    <h2 className="text-lg font-semibold">本次学习小结</h2>
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">{[["已封存作答", summary.recorded], ["独立核对正确", summary.independent], ["使用帮助作答", summary.helped], ["仍需核对", summary.needsCheck]].map(([label, count]) => <div key={label} className="rounded-lg bg-surface-2 p-3"><dt className="text-xs text-text-2">{label}</dt><dd className="mt-1 text-lg font-semibold">{count}</dd></div>)}</dl>
    <p className="text-sm leading-7 text-text-2">这里读取本次活动的实际作答与当前有效评价；看过示范、含提示完成、同题重做和独立新题不会混为掌握证据。长期保持还需要真实间隔后的复测。</p>
    {summary.observations.length ? <ul className="space-y-2">{summary.observations.map((row, index) => <li key={row.id} className="rounded-lg border border-line p-3 text-sm"><p>作答 {index + 1} · {learnerEvidenceLabels[learnerEvidenceState(row)]}</p><details className="mt-2"><summary className="cursor-pointer text-xs text-text-2">查看当前有效作答与评价时间</summary><pre className="mt-2 whitespace-pre-wrap break-words text-xs leading-6">{row.answer}</pre><p className="mt-2 text-xs text-text-3">{new Date(row.occurredAt).toLocaleString("zh-CN")}</p></details></li>)}</ul> : <p className="text-sm text-text-2">本次还没有封存作答。已打开的题目与帮助记录保留，可继续原题。</p>}
    {!delayed && latest ? <SpanDelayedRetestControl key={latest.id} record={latest} /> : null}
  </section>;
}
