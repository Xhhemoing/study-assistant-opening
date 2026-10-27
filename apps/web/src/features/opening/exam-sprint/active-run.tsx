"use client";

import type { ExamAttemptView, ExamSprintOverview } from "@aistudy/contracts";
import { useEffect, useState } from "react";
import { ui, tone } from "../design/ui";
import { useDiagnosticsEnabled } from "../settings/appearance-preferences";
import type { ExamSprintIntent } from "./client";
import { causeLabels, formatDuration, hasSprintAttemptHelp, modeLabels } from "./labels";

import { LessonButton } from "./lesson-button";
import { attemptElementId, type OpenSprintLesson } from "./lesson-navigation";

type Send = (command: ExamSprintIntent) => void;

function RunClock({ startedAt, deadlineAt, now }: { startedAt: string; deadlineAt: string | null; now: number }) {
  const seconds = (now - Date.parse(startedAt)) / 1000;
  const remaining = deadlineAt ? (Date.parse(deadlineAt) - now) / 1000 : null;
  return <p className="text-xs tabular-nums text-text-3">已用 {formatDuration(seconds)}{remaining !== null ? ` · 剩余 ${formatDuration(remaining)}` : ""}{remaining !== null && remaining <= 0 ? " · 已到时，请交卷查看结果" : ""}</p>;
}

export function AttemptFeedback({ attempt, disabled, send }: { attempt: ExamAttemptView; disabled: boolean; send: Send }) {
  const diagnostics = useDiagnosticsEnabled();
  if (!attempt.feedback) return null;
  const assisted = hasSprintAttemptHelp(attempt);
  return <div className="space-y-3 rounded-lg bg-surface-2 p-4">
    <p className="text-sm font-semibold text-text">{attempt.answer === null ? "未作答" : attempt.correct ? "回答正确" : "需要再练"}{diagnostics ? <> · {assisted ? "含帮助，不计独立正确" : !attempt.answeredAt ? "尚未形成作答证据" : attempt.exposureCoverage ? "这道题之前可能见过材料，这次不单独计分" : attempt.independent ? "未见题族独立作答" : "本次暂不计入新的独立作答依据（重复练习、使用过帮助或记录的使用条件变化）"}</> : null}</p>
    <p className="text-sm">参考答案：{attempt.feedback.answer}</p>
    <p className="whitespace-pre-wrap font-reading text-[17px] leading-[30px] text-text">{attempt.feedback.explanation}</p>
    {attempt.answeredAt ? <label className="block max-w-xs space-y-1"><span className={ui.label}>这次卡在哪里？（可修正）</span><select className={ui.input} disabled={disabled} value={attempt.errorCause ?? ""} onChange={event => send({ action: "error", attemptId: attempt.id, errorCause: (event.target.value || null) as ExamAttemptView["errorCause"] })}><option value="">未标记</option>{Object.entries(causeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label> : null}
  </div>;
}

function QuestionForm({ attempt, mock, disabled, send }: { attempt: ExamAttemptView; mock: boolean; disabled: boolean; send: Send }) {
  const [answer, setAnswer] = useState(attempt.answer ?? "");
  const [confidence, setConfidence] = useState(attempt.confidence ?? 3);
  const answered = attempt.answeredAt !== null;
  return <div id={attemptElementId(attempt.id)} tabIndex={-1} className="scroll-mt-24 space-y-5">
    <p className="whitespace-pre-wrap font-reading text-[17px] leading-[30px] text-text">{attempt.question.prompt}</p>
    <form onSubmit={event => { event.preventDefault(); if (answer && !answered && !disabled) send({ action: "answer", attemptId: attempt.id, answer, confidence }); }} className="space-y-4">
      <fieldset disabled={disabled || answered} className="space-y-2"><legend className="sr-only">选择你的答案</legend>{attempt.question.options.map(option => <label key={option.id} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm ${answer === option.id ? "border-accent bg-accent-soft" : "border-text-3 hover:bg-surface-2"}`}><input type="radio" name={`answer-${attempt.id}`} value={option.id} checked={answer === option.id} onChange={() => setAnswer(option.id)} className="mt-1 accent-accent" /><span className="whitespace-pre-wrap leading-6">{option.id}. {option.label}</span></label>)}</fieldset>
      {!answered ? <div className="flex flex-wrap items-end gap-3"><label className="block space-y-1"><span className={ui.label}>提交前，你有多确定？</span><select className={ui.input} value={confidence} onChange={event => setConfidence(Number(event.target.value))} disabled={disabled}><option value={1}>1 · 主要靠猜</option><option value={2}>2 · 不太确定</option><option value={3}>3 · 大致确定</option><option value={4}>4 · 比较确定</option><option value={5}>5 · 能解释方法</option></select></label><button type="submit" className={ui.primary} disabled={disabled || !answer}>提交本题</button></div> : <p role="status" className="text-sm text-accent">本题已保存{mock ? "，交卷后统一查看解析。" : "。"}</p>}
    </form>
    {!answered ? <div className="space-y-2"><p className="text-xs leading-6 text-text-3">{mock ? "模拟练习会在交卷后显示解析。需要帮助时，可以先结束模拟。" : "先试试，卡住了就看提示。看完再试着完成下一步。"}</p><div className="flex flex-wrap gap-2">{([ ["hint", "给我提示"], ["solution", "直接看答案"], ["external", "已用外部帮助"] ] as const).filter(([kind]) => !mock || kind === "external").map(([kind, label]) => <button type="button" key={kind} className={ui.secondary} disabled={disabled || attempt.help.some(help => help.kind === kind)} onClick={() => send({ action: "help", attemptId: attempt.id, kind })}>{label}{attempt.help.some(help => help.kind === kind) ? " · 已记录" : ""}</button>)}</div></div> : null}
    {attempt.hint && !mock ? <div className={`rounded-lg p-3 text-sm leading-7 ${tone.warning}`}><span className="font-medium">提示：</span>{attempt.hint}</div> : null}
    {!mock ? <AttemptFeedback attempt={attempt} disabled={disabled} send={send} /> : <p className="text-xs leading-6 text-text-3">短模拟中不提供提示和解析；请如实记录帮助使用，作答后交卷。</p>}
  </div>;
}

export function ActiveRun({ overview, disabled, send, onOpenLesson }: { overview: ExamSprintOverview; disabled: boolean; send: Send; onOpenLesson?: OpenSprintLesson }) {
  const run = overview.activeRun;
  const attempt = overview.currentAttempt;
  const [confirmFinish, setConfirmFinish] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  if (!run) return null;
  const answered = overview.attempts.filter(item => item.runId === run.id && item.answeredAt).length;
  const mock = run.mode.startsWith("mock");
  const isLast = attempt ? run.questionIds.indexOf(attempt.questionId) === run.questionIds.length - 1 : true;
  const expired = run.deadlineAt !== null && now >= Date.parse(run.deadlineAt);
  return <section className={`${ui.panel} space-y-5 p-5`} aria-labelledby="current-sprint-title">
    <div className="flex flex-wrap items-start justify-between gap-2"><div><h2 id="current-sprint-title" className="font-semibold">{modeLabels[run.mode]} · {answered} / {run.questionIds.length} 题已答</h2><p className="mt-1 text-xs text-text-3">{mock ? "20–30 分钟短模拟 · 不是完整考试卷" : "作答 → 看解析 → 归因 → 独立复测"}</p></div><RunClock startedAt={run.startedAt} deadlineAt={run.deadlineAt} now={now} /></div>
    {attempt ? <QuestionForm key={`${attempt.id}-${attempt.answer ?? "pending"}`} attempt={attempt} mock={mock} disabled={disabled || expired} send={send} /> : <p className="text-sm text-text-2">本轮题目已完成，请结束本轮查看结果。</p>}
    {attempt && onOpenLesson ? <LessonButton overview={overview} lessonId={attempt.question.lessonId} onOpenLesson={onOpenLesson} disabled={disabled} returnTarget={{ id: attemptElementId(attempt.id), label: "返回原题", runId: run.id, attemptId: attempt.id }} /> : null}
    <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
      {attempt?.answeredAt && !isLast && !expired ? <button type="button" className={ui.primary} disabled={disabled} onClick={() => send({ action: "next", runId: run.id })}>下一题</button> : null}
      {!attempt || (isLast && attempt.answeredAt) || expired ? <button type="button" className={ui.primary} disabled={disabled} onClick={() => send({ action: "finish", runId: run.id })}>{mock ? "交卷并查看解析" : "结束本轮"}</button> : <button type="button" className={ui.quiet} disabled={disabled} onClick={() => setConfirmFinish(value => !value)}>提前结束</button>}
      {confirmFinish ? <div className="flex flex-wrap items-center gap-2 text-xs text-text-2"><span>未作答题保留为未测，确定结束？</span><button type="button" className={ui.secondary} disabled={disabled} onClick={() => send({ action: "finish", runId: run.id })}>确认结束</button><button type="button" className={ui.quiet} onClick={() => setConfirmFinish(false)}>继续作答</button></div> : null}
    </div>
  </section>;
}

export function CompletedRun({ overview, disabled, send, onOpenLesson }: { overview: ExamSprintOverview; disabled: boolean; send: Send; onOpenLesson?: OpenSprintLesson }) {
  const diagnostics = useDiagnosticsEnabled();
  const runs = [...overview.state.runs].reverse().filter(item => item.completedAt);
  if (!runs.length) return null;
  return <section className="space-y-3" aria-label="历史训练结果">{runs.map((run, index) => {
    const attempts = overview.attempts.filter(item => item.runId === run.id);
    const answered = attempts.filter(item => item.answeredAt);
    return <details key={run.id} className={`${ui.panel} p-4`} open={!overview.activeRun && index === 0 && run.mode.startsWith("mock")}><summary className="min-h-11 cursor-pointer text-sm font-medium py-2">{index === 0 ? "最近一轮" : "历史训练"} · {modeLabels[run.mode]} · 已答 {answered.length}/{run.questionIds.length}</summary><div className="mt-4 space-y-3"><p className="text-sm font-medium text-text">客观题正确 {answered.filter(item => item.correct).length} / {run.questionIds.length} · 未答 {run.questionIds.length - answered.length}{diagnostics ? <> · 独立新题族正确 {answered.filter(item => item.independent && item.correct).length}</> : null}</p><p className="text-xs leading-6 text-text-3">这些结果不代表正式考试分数。回看出错的题目，找出需要调整的一步，再做一道变式。</p>{attempts.map(attempt => <details key={attempt.id} className="rounded-lg border border-line p-3"><summary id={attemptElementId(attempt.id)} className="scroll-mt-24 min-h-11 cursor-pointer whitespace-pre-wrap text-sm leading-6 py-2">{attempt.question.prompt}</summary><div className="mt-3"><ul className="mb-3 space-y-2">{attempt.question.options.map(option => <li key={option.id} className="rounded-lg bg-surface-2 p-2 text-sm leading-6"><span className="whitespace-pre-wrap">{option.id}. {option.label}</span>{option.id === attempt.answer ? <span className="ml-2 text-xs font-medium text-text-2">你的选择</span> : null}{option.id === attempt.feedback?.answer ? <span className="ml-2 text-xs font-medium text-accent">参考答案</span> : null}</li>)}</ul><p className="mb-2 text-xs text-text-2">你的答案：{attempt.answer ?? "未作答"} · 用时 {formatDuration(attempt.durationSeconds ?? 0)}</p><AttemptFeedback attempt={attempt} disabled={disabled} send={send} />{onOpenLesson ? <div className="mt-3"><LessonButton overview={overview} disabled={disabled} lessonId={attempt.question.lessonId} onOpenLesson={onOpenLesson} returnTarget={{ id: attemptElementId(attempt.id), label: "返回原题", runId: run.id, attemptId: attempt.id }} /></div> : null}</div></details>)}</div></details>;
  })}</section>;
}
