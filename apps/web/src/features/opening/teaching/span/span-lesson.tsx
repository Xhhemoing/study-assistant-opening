"use client";

import { TransitionLink as Link } from "../../v3/motion/view-transition";
import { conversationObjectHref } from "../../assistant/conversation-links";
import { useCallback, useMemo, useRef, useState } from "react";
import type { LearningAttempt, LearningObservation, SpanHintLevel, SpanTeachingMode, StudySessionIntent, SpanLessonSnapshot } from "@aistudy/contracts";
import { createSpanTeachingSequence, spanModeForIntent } from "@aistudy/domain";
import { ContentBlock, ContentGrid, ui } from "../../design/ui";
import { studentCopy } from "../student-copy";
import { LearnerStateCard } from "../learner-state-card";
import { SpanDelayedRetestControl } from "./delayed-retest-control";
import { SpanWorkedExample, SpanOverviewLinks } from "./worked-example";
import { SpanExplorer } from "./span-explorer";
import { StudyIntentControls } from "../study-intent-controls";
import { SpanPractice } from "./span-practice";
import { useStudyAssistantContext } from "../../assistant/current-study-context";
import { spanAssistantContext, spanPracticeEntryKey } from "../lesson-assistant-context";
import { SelectionAsk } from "../selection-ask";
import { LessonCompanionWorkspace } from "../lesson-companion-workspace";
import { useLessonArrowKeys } from "../lesson-shortcuts";
import { useDiagnosticsEnabled } from "../../settings/appearance-preferences";
import { SpanTutorControl } from "./span-tutor-control";
import { SpanNextActionControl, currentSpanObservationId } from "./span-next-action-control";
import { isSpanReservedProblemId } from "./span-answer";
import type { SpanExecutionPhase } from "./span-session-client";

const modeLabels = { self_study: "自学 · 例题到独立新题", overview: "串讲 · 连接方程与几何", challenge: "拔高 · 预设迁移" };
const modeProcess: Record<SpanTeachingMode, string> = {
  self_study: "自学：看例题 → 补全步骤 → 独立新题。目标是自己列出并检查线性组合。",
  overview: "串讲：连接方程与几何 → 对比关系 → 迁移练习。目标是知道不同表示怎样互相转换。",
  challenge: "挑战：先预测 → 探索变化 → 独立迁移。目标是在新结构下解释并检验自己的判断。",
};
const defaultIntent: StudySessionIntent = { purpose: "self_study", timeBudgetMinutes: 20, language: "zh", pace: "normal", continuous: true, selfReportedFatigue: "unknown" };
/** Identity only: never import the server generator into the lesson runtime. */
export function isSpanReservedAttempt(attempt: LearningAttempt): boolean {
  return isSpanReservedProblemId(attempt.spanExercise?.id);
}
type SpanLessonProps = { originalConversationId?: string | null; courseId: string; sourceIds: string[]; sourceLoadError: boolean; delayedRetestId?: string; initialIntent?: StudySessionIntent; initialMoveId?: string; initialNewEvidenceEventId?: string;
  session?: SpanLessonSnapshot; executionPhase?: SpanExecutionPhase; restoredAttempts?: LearningAttempt[]; restoredObservations?: LearningObservation[]; restoredHintLevels?: Record<string, SpanHintLevel[]>; savingProgress?: boolean;
  onProgress?: (intent: StudySessionIntent, moveId: string, status: "active" | "paused" | "completed") => Promise<boolean>; onSummary?: () => void; onReload?: () => void };
/** 步骤短标签；同名步骤（如两道独立新题）第二个起改为「迁移新题」以便区分。 */
export function stepLabels(moves: readonly { presentation: { kind: string } }[]): string[] {
  const base = moves.map(move => move.presentation.kind === "worked_example" ? "逐步看例题" : move.presentation.kind === "faded_example" ? "补全步骤" : move.presentation.kind === "contrast" ? "结构对比" : move.presentation.kind === "predict_then_explore" ? "预测与探索" : "独立新题");
  return base.map((label, index) => label === "独立新题" && base.indexOf(label) < index ? "迁移新题" : label);
}

export function SpanLesson({ courseId, sourceIds, sourceLoadError, delayedRetestId, initialIntent, initialMoveId, initialNewEvidenceEventId, session, executionPhase, restoredAttempts = [], restoredObservations = [], restoredHintLevels = {}, onProgress, savingProgress, onSummary, onReload, originalConversationId }: SpanLessonProps) {
  const diagnostics = useDiagnosticsEnabled();
  const lessonRoot = useRef<HTMLElement>(null);
  const [intent, setIntent] = useState(initialIntent ?? defaultIntent);
  const [mode, setMode] = useState<SpanTeachingMode>(spanModeForIntent(initialIntent ?? defaultIntent));
  const [step, setStep] = useState(delayedRetestId || (!initialMoveId && initialNewEvidenceEventId) || initialMoveId?.endsWith("-reserved") ? createSpanTeachingSequence(spanModeForIntent(initialIntent ?? defaultIntent)).length : Math.max(0, createSpanTeachingSequence(spanModeForIntent(initialIntent ?? defaultIntent)).findIndex(move => move.id === initialMoveId)));
  const [attempts, setAttempts] = useState<Record<string, LearningAttempt | null>>({});
  const [newEvidenceEventId, setNewEvidenceEventId] = useState(initialNewEvidenceEventId);
  const [intentRevision, setIntentRevision] = useState(0);
  const [records, setRecords] = useState<Record<string, LearningObservation>>(() => Object.fromEntries(restoredObservations.flatMap(record => {
    const problem = restoredAttempts.find(attempt => attempt.id === record.attemptId)?.spanExercise?.id;
    return problem ? [[isSpanReservedAttempt(restoredAttempts.find(attempt => attempt.id === record.attemptId)!) ? "reserved:auto" : problem, record]] : [];
  })));
  const sequence = createSpanTeachingSequence(mode);
  const moves = [...sequence, { ...sequence[sequence.length - 1]!, id: `${mode}-reserved`, presentation: { kind: "independent_item" as const, instructions: "离开示范，用服务器发放的保留题检查" } }];
  const current = moves[step]!;
  const isPresentation = !delayedRetestId && step === 0;
  const problemId = delayedRetestId ? "reserved:auto" : step === moves.length - 1 ? "reserved:auto" : mode === "self_study" ? step === 1 ? "span-faded-3d" : "span-independent-3d"
    : mode === "overview" ? step === 1 ? "span-contrast-dependent" : "span-geometry-transfer"
      : "span-geometry-transfer";
  const currentRecord = records[problemId];
  const unavailableRestoredQuestion = restoredAttempts.some(attempt => !attempt.spanExercise);
  const restoredAttempt = problemId === "reserved:auto" && newEvidenceEventId !== initialNewEvidenceEventId ? undefined
    : [...restoredAttempts].sort((left, right) => right.startedAt.localeCompare(left.startedAt)).find(attempt => problemId === "reserved:auto" ? isSpanReservedAttempt(attempt) : attempt.spanExercise?.id === problemId);
  const entryKey = spanPracticeEntryKey(courseId, mode, problemId, delayedRetestId, newEvidenceEventId);
  const activeAttempt = !isPresentation ? attempts[entryKey] ?? null : null;
  const onAttempt = useCallback((attempt: LearningAttempt | null) => setAttempts(previous => previous[entryKey] === attempt ? previous : { ...previous, [entryKey]: attempt }), [entryKey]);
  const assistantContext = useMemo(() => spanAssistantContext(courseId, isPresentation, activeAttempt, sourceLoadError || !sourceIds.length), [courseId, isPresentation, activeAttempt, sourceLoadError, sourceIds.length]);
  useStudyAssistantContext(assistantContext);
  async function goToStep(next: number, nextIntent = intent) {
    const nextMode = spanModeForIntent(nextIntent), nextSequence = createSpanTeachingSequence(nextMode);
    const moveId = nextSequence[next]?.id ?? `${nextMode}-reserved`;
    if (onProgress && !await onProgress(nextIntent, moveId, "active")) return;
    setIntent(nextIntent); setMode(nextMode); setStep(next);
  }
  const complete = !isPresentation && Boolean(currentRecord);
  const successful = currentRecord?.serverEvaluation?.decision === "correct";
  useLessonArrowKeys(lessonRoot, {
    previous: step > 0 && !delayedRetestId ? () => void goToStep(step - 1) : undefined,
    next: step < moves.length - 1 && (isPresentation || complete) ? () => void goToStep(step + 1) : undefined,
  });
  return <section ref={lessonRoot} data-lesson-shortcuts="true" className="flex h-full min-h-0 flex-col overflow-hidden bg-surface text-text">
    <LessonCompanionWorkspace title="线性组合与 span" returnHref={conversationObjectHref(`/opening/courses/${courseId}`, originalConversationId)} progress={{ current: step + 1, total: moves.length }} originalConversationId={originalConversationId} binding={assistantContext} outline={<nav aria-label="span 学习目录" className="space-y-1">{moves.map((move, index) => <button key={move.id} type="button" className={`${ui.quiet} w-full justify-start whitespace-normal text-left`} aria-current={step === index ? "step" : undefined} disabled={Boolean(delayedRetestId)} onClick={() => void goToStep(index)}>{index + 1}. {stepLabels(moves)[index]}</button>)}</nav>}>
    <ContentGrid className="space-y-6 px-5 py-6 sm:px-8"><p className="sr-only">{delayedRetestId ? "复习：试试你还记得怎样解这道题。" : modeProcess[mode]}</p>
      <h2 className="text-title font-semibold">如何知道一个向量能不能由另外两个向量组成？</h2>
      <SpanTutorControl key={courseId} courseId={courseId} />
      <LearnerStateCard courseId={courseId} revision={Object.keys(records).length + intentRevision} proactive />
      {delayedRetestId ? <p role="status" className="rounded-lg bg-accent-soft text-text p-3 text-sm leading-7">隔了几天，再用一道新题试试。卡住了也可以看提示。</p> : null}
      {!delayedRetestId ? <fieldset aria-label="本次学习意图" className="flex flex-wrap items-center gap-2 text-ui text-text-2">
        <label className="min-w-0"><span className="sr-only">我想怎样学</span><select className={`${ui.input} h-9 w-auto py-0`} value={intent.purpose} onChange={event => { const purpose = event.target.value as StudySessionIntent["purpose"]; void goToStep(0, { ...intent, purpose }); }}>{Object.entries(modeLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}<option value="confused">看不懂 · 先补最小关系</option><option value="review">复习 · 再用新题检查</option><option value="exam_sprint">冲刺 · 聚焦关键步骤</option></select></label>
        <span className="inline-flex items-center gap-1.5"><label><span className="sr-only">时间预算（分钟）</span><input className={`${ui.input} h-9 w-16 py-0 text-center tabular-nums`} type="number" min={1} max={240} value={intent.timeBudgetMinutes} onChange={event => { const value = Number(event.target.value); if (value >= 1 && value <= 240) setIntent(current => ({ ...current, timeBudgetMinutes: value })); }} /></label><span aria-hidden="true">分钟</span></span>
        <details className="group relative"><summary className="flex h-9 cursor-pointer list-none items-center rounded-lg px-2.5 text-ui text-text-2 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">更多偏好</summary>
          <div className="absolute left-0 z-20 mt-1 grid w-72 gap-3 rounded-xl border border-line bg-surface p-3 shadow-lg">
            <label className="block text-xs">讲解语言<select className={`${ui.input} mt-1`} value={intent.language} onChange={event => setIntent(current => ({ ...current, language: event.target.value as StudySessionIntent["language"] }))}><option value="zh">中文</option><option value="en">English（题意术语）</option><option value="bilingual">中英对照</option></select></label>
            <label className="block text-xs">节奏<select className={`${ui.input} mt-1`} value={intent.pace} onChange={event => setIntent(current => ({ ...current, pace: event.target.value as StudySessionIntent["pace"] }))}><option value="slow">慢一点</option><option value="normal">正常</option><option value="fast">直接给关键步骤</option></select></label>
            <label className="block text-xs">当前精力<select className={`${ui.input} mt-1`} value={intent.selfReportedFatigue} onChange={event => setIntent(current => ({ ...current, selfReportedFatigue: event.target.value as StudySessionIntent["selfReportedFatigue"] }))}><option value="unknown">未说明</option><option value="low">精力尚可</option><option value="high">有些疲劳</option></select></label>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={intent.continuous} onChange={event => setIntent(current => ({ ...current, continuous: event.target.checked }))} className="accent-accent" />连续推进（仍由我决定何时下一步）</label>
          </div>
        </details>
      </fieldset> : null}
      {activeAttempt || session ? <StudyIntentControls key={activeAttempt?.id ?? session!.sessionId} attempt={activeAttempt ?? { sessionId: session!.sessionId, courseId }} currentIntent={session?.intent ?? intent} desiredIntent={activeAttempt ? intent : undefined} onApplied={(next, action, evidenceEventId) => {
        setIntent({ ...next }); setIntentRevision(value => value + 1);
        const nextMode = spanModeForIntent(next);
        if (evidenceEventId) { setRecords(currentRecords => { const remaining = { ...currentRecords }; delete remaining["reserved:auto"]; return remaining; }); setNewEvidenceEventId(evidenceEventId); void goToStep(createSpanTeachingSequence(nextMode).length, next); }
        else if (!delayedRetestId && (action === "diagnose" || action === "increase_challenge" || nextMode !== mode)) void goToStep(0, next);
        else void goToStep(step, next);
      }} /> : null}
      {intent.selfReportedFatigue === "high" || intent.timeBudgetMinutes < 10 ? <p role="status" className="text-xs leading-6 text-text-2">这次先完成一个短步骤即可，你已写下的答案会保留。</p> : null}
      {intent.language !== "zh" ? <p className="text-sm leading-7">Span = all linear combinations（所有线性组合）; coefficient = 系数; consistent system = 相容方程组。Language support translates the question; it does not solve it. 深入英文解释可在本题提问中选择语言支持。</p> : null}
      <ContentBlock width={isPresentation ? "wide" : "prose"}><section className="space-y-4"><h2 className="text-lg font-semibold">{current.presentation.instructions}</h2><p className="text-sm leading-7">{current.studentAction}</p><SelectionAsk binding={assistantContext}>
        {isPresentation ? <>
          {mode === "challenge" ? <SpanExplorer courseId={courseId} sourceId={sourceIds[0]} sessionId={session?.sessionId} /> : <SpanWorkedExample courseId={courseId} sourceId={sourceIds[0]} sessionId={session?.sessionId} fast={intent.pace === "fast"} />}
          {mode === "overview" ? <SpanOverviewLinks courseId={courseId} sourceId={sourceIds[0]} sessionId={session?.sessionId} /> : null}
          {mode !== "challenge" ? <SpanExplorer courseId={courseId} sourceId={sourceIds[0]} sessionId={session?.sessionId} /> : null}
        </> : unavailableRestoredQuestion ? <p role="alert" className="text-sm leading-7 text-warn">刚才的题目还未恢复。请到<Link className={ui.quiet} href={conversationObjectHref(`/opening/courses/${courseId}#course-learning-records`, originalConversationId)}>课程学习记录</Link>查看原题和答案，再继续学习。</p> : sourceLoadError || !sourceIds.length ? <p role="alert" className="text-sm leading-7 text-warn">课程材料暂时无法读取。请返回课程添加或恢复一份可用材料；你已写下的答案仍保留。</p> : <SpanPractice key={entryKey} executionPhase={executionPhase} session={session} restoredAttempt={restoredAttempt} restoredHintLevels={restoredAttempt ? restoredHintLevels[restoredAttempt.id] : undefined} courseId={courseId} sourceIds={sourceIds} problemId={problemId} intent={intent} intentRevision={intentRevision} newEvidenceEventId={newEvidenceEventId} retestId={delayedRetestId} onAttempt={onAttempt} onIntentApplied={(next, action) => { setIntent(next); const nextMode = spanModeForIntent(next); if (!delayedRetestId && (action === "diagnose" || action === "increase_challenge" || nextMode !== mode)) { setMode(nextMode); setStep(0); } }} onRecorded={record => setRecords(current => ({ ...current, [problemId]: record }))} />}
        </SelectionAsk>
      </section></ContentBlock>
      {complete || sourceLoadError || !sourceIds.length || !isPresentation && unavailableRestoredQuestion ? <div className="space-y-3 rounded-xl bg-surface-2 p-4"><h3 className="text-sm font-medium">下一步</h3>{complete ? <p className="prose-reading">{currentRecord?.serverEvaluation?.decision === "correct" ? studentCopy.nextCorrect : studentCopy.nextIncorrect}</p> : <p className="text-sm leading-7 text-text-2">原题和记录保留，先核对现在可以继续的学习。</p>}{complete && !delayedRetestId && currentRecord?.serverEvaluation?.decision !== "correct" ? <button type="button" className={ui.secondary} onClick={() => void goToStep(0)}>回看关系与示范</button> : null}{session ? <SpanNextActionControl session={session} observationId={currentSpanObservationId([...restoredObservations, ...Object.values(records)], session)} onReload={onReload} disabled={savingProgress} /> : null}{currentRecord && !delayedRetestId ? <SpanDelayedRetestControl key={currentRecord.id} record={currentRecord} /> : null}</div> : null}
      {diagnostics ? <details className="text-xs leading-6 text-text-3"><summary className="cursor-pointer">本步骤期待观察什么</summary><p>{current.expectedObservation}</p><p>继续或停止：{current.continuation.stopWhen}</p><p>覆盖知识点：{current.targetKnowledgeComponents.join("、")}</p></details> : null}
      <div className="flex flex-wrap gap-3 border-t border-line pt-4">{step > 0 && !delayedRetestId ? <button type="button" className={ui.quiet} onClick={() => void goToStep(step - 1)}>回看上一步</button> : null}{step < moves.length - 1 ? <button type="button" className={ui.primary} disabled={!isPresentation && !complete} onClick={() => void goToStep(step + 1)}>{isPresentation ? "开始补全新题" : successful ? "本步骤通过，进入下一道新题" : complete ? "继续下一道新题" : "提交本题后继续"}</button> : <Link className={ui.secondary} href={conversationObjectHref(`/opening/courses/${courseId}#course-learning-records`, originalConversationId)}>回到课程记录，安排后续复测</Link>}</div>
      {session ? <div className="flex flex-wrap gap-3 border-t border-line pt-4">{onReload ? <button type="button" className={ui.quiet} disabled={savingProgress} onClick={onReload}>重新读取本节</button> : null}<button type="button" className={ui.secondary} disabled={savingProgress} onClick={() => void onProgress?.(intent, current.id, "paused")}>暂停并保存</button><button type="button" className={ui.secondary} disabled={savingProgress} onClick={() => void onProgress?.(intent, current.id, "completed")}>结束并看小结</button><button type="button" className={ui.quiet} disabled={savingProgress} onClick={onSummary}>查看本次小结</button><p role="status" className="w-full text-xs text-text-3">{savingProgress ? "正在保存本次步骤…" : "暂停或结束时会保存学习进度；未提交的答案保留在当前浏览器标签页。"}</p></div> : null}
    </ContentGrid></LessonCompanionWorkspace>
  </section>;
}
