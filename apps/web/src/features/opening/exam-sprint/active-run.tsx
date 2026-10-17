"use client";

import type { ExamAttemptView, ExamSprintOverview } from "@aistudy/contracts";
import { useEffect, useState } from "react";
import { ui, tone } from "../design/ui";
import type { ExamSprintIntent } from "./client";
import { causeLabels, formatDuration, modeLabels } from "./labels";

type Send = (command: ExamSprintIntent) => void;

function RunClock({ startedAt, deadlineAt, now }: { startedAt: string; deadlineAt: string | null; now: number }) {
  const seconds = (now - Date.parse(startedAt)) / 1000;
  const remaining = deadlineAt ? (Date.parse(deadlineAt) - now) / 1000 : null;
  return <p className="text-xs tabular-nums text-zinc-500">已用 {formatDuration(seconds)}{remaining !== null ? ` · 剩余 ${formatDuration(remaining)}` : ""}{remaining !== null && remaining <= 0 ? " · 已到时，请交卷查看结果" : ""}</p>;
}

export function AttemptFeedback({ attempt, disabled, send }: { attempt: ExamAttemptView; disabled: boolean; send: Send }) {
  if (!attempt.feedback) return null;
  return <div className="space-y-3 rounded-lg bg-zinc-50 p-4">
    <p className="text-sm font-semibold text-zinc-900">{attempt.answer === null ? "未作答" : attempt.correct ? "回答正确" : "需要再练"} · {attempt.help.length ? "含帮助，不计独立正确" : !attempt.answeredAt ? "尚未形成作答证据" : attempt.independent ? "未见题族独立作答" : "当前不计新增独立证据（重复、帮助或资格变化）"}</p>
    <p className="text-sm">参考答案：{attempt.feedback.answer}</p>
    <p className="whitespace-pre-wrap text-sm leading-7 text-zinc-700">{attempt.feedback.explanation}</p>
    {attempt.answeredAt ? <label className="block max-w-xs space-y-1"><span className={ui.label}>这次卡在哪里？（可修正）</span><select className={ui.input} disabled={disabled} value={attempt.errorCause ?? ""} onChange={event => send({ action: "error", attemptId: attempt.id, errorCause: (event.target.value || null) as ExamAttemptView["errorCause"] })}><option value="">未标记</option>{Object.entries(causeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label> : null}
  </div>;
}

function QuestionForm({ attempt, mock, disabled, send }: { attempt: ExamAttemptView; mock: boolean; disabled: boolean; send: Send }) {
  const [answer, setAnswer] = useState(attempt.answer ?? "");
  const [confidence, setConfidence] = useState(attempt.confidence ?? 3);
  const answered = attempt.answeredAt !== null;
  return <div className="space-y-5">
    <p className="whitespace-pre-wrap text-base leading-8 text-zinc-900">{attempt.question.prompt}</p>
    <form onSubmit={event => { event.preventDefault(); if (answer && !answered && !disabled) send({ action: "answer", attemptId: attempt.id, answer, confidence }); }} className="space-y-4">
      <fieldset disabled={disabled || answered} className="space-y-2"><legend className="sr-only">选择你的答案</legend>{attempt.question.options.map(option => <label key={option.id} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm ${answer === option.id ? "border-emerald-500 bg-emerald-50" : "border-zinc-200 hover:bg-zinc-50"}`}><input type="radio" name={`answer-${attempt.id}`} value={option.id} checked={answer === option.id} onChange={() => setAnswer(option.id)} className="mt-1 accent-emerald-700" /><span className="whitespace-pre-wrap leading-6">{option.id}. {option.label}</span></label>)}</fieldset>
      {!answered ? <div className="flex flex-wrap items-end gap-3"><label className="block space-y-1"><span className={ui.label}>提交前，你有多确定？</span><select className={ui.input} value={confidence} onChange={event => setConfidence(Number(event.target.value))} disabled={disabled}><option value={1}>1 · 主要靠猜</option><option value={2}>2 · 不太确定</option><option value={3}>3 · 大致确定</option><option value={4}>4 · 比较确定</option><option value={5}>5 · 能解释方法</option></select></label><button type="submit" className={ui.primary} disabled={disabled || !answer}>提交本题</button></div> : <p role="status" className="text-sm text-emerald-800">本题已保存{mock ? "，交卷后统一查看解析。" : "。"}</p>}
    </form>
    {!answered ? <div className="space-y-2"><p className="text-xs leading-6 text-zinc-500">{mock ? "若使用过外部帮助，请先如实登记；本题不计独立正确，交卷前仍不显示解析。" : "先尝试，再按需求助。使用提示、答案或外部帮助会被记录，本题不计独立正确。"}</p><div className="flex flex-wrap gap-2">{([ ["hint", "给我提示"], ["solution", "直接看答案"], ["external", "已用外部帮助"] ] as const).filter(([kind]) => !mock || kind === "external").map(([kind, label]) => <button type="button" key={kind} className={ui.secondary} disabled={disabled || attempt.help.some(help => help.kind === kind)} onClick={() => send({ action: "help", attemptId: attempt.id, kind })}>{label}{attempt.help.some(help => help.kind === kind) ? " · 已记录" : ""}</button>)}</div></div> : null}
    {attempt.hint && !mock ? <div className={`rounded-lg p-3 text-sm leading-7 ${tone.warning}`}><span className="font-medium">提示：</span>{attempt.hint}</div> : null}
    {!mock ? <AttemptFeedback attempt={attempt} disabled={disabled} send={send} /> : <p className="text-xs leading-6 text-zinc-500">短模拟中不提供提示和解析；请如实记录帮助使用，作答后交卷。</p>}
  </div>;
}

export function ActiveRun({ overview, disabled, send }: { overview: ExamSprintOverview; disabled: boolean; send: Send }) {
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
    <div className="flex flex-wrap items-start justify-between gap-2"><div><h2 id="current-sprint-title" className="font-semibold">{modeLabels[run.mode]} · {answered} / {run.questionIds.length} 题已答</h2><p className="mt-1 text-xs text-zinc-500">{mock ? "20–30 分钟短模拟 · 不是完整考试卷" : "作答 → 看解析 → 归因 → 独立复测"}</p></div><RunClock startedAt={run.startedAt} deadlineAt={run.deadlineAt} now={now} /></div>
    {attempt ? <QuestionForm key={`${attempt.id}-${attempt.answer ?? "pending"}`} attempt={attempt} mock={mock} disabled={disabled || expired} send={send} /> : <p className="text-sm text-zinc-600">本轮题目已完成，请结束本轮查看结果。</p>}
    <div className="flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-4">
      {attempt?.answeredAt && !isLast && !expired ? <button type="button" className={ui.primary} disabled={disabled} onClick={() => send({ action: "next", runId: run.id })}>下一题</button> : null}
      {!attempt || (isLast && attempt.answeredAt) || expired ? <button type="button" className={ui.primary} disabled={disabled} onClick={() => send({ action: "finish", runId: run.id })}>{mock ? "交卷并查看解析" : "结束本轮"}</button> : <button type="button" className={ui.quiet} disabled={disabled} onClick={() => setConfirmFinish(value => !value)}>提前结束</button>}
      {confirmFinish ? <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-600"><span>未作答题保留为未测，确定结束？</span><button type="button" className={ui.secondary} disabled={disabled} onClick={() => send({ action: "finish", runId: run.id })}>确认结束</button><button type="button" className={ui.quiet} onClick={() => setConfirmFinish(false)}>继续作答</button></div> : null}
    </div>
  </section>;
}

export function CompletedRun({ overview, disabled, send }: { overview: ExamSprintOverview; disabled: boolean; send: Send }) {
  const runs = [...overview.state.runs].reverse().filter(item => item.completedAt);
  if (!runs.length) return null;
  return <section className="space-y-3" aria-label="历史训练结果">{runs.map((run, index) => {
    const attempts = overview.attempts.filter(item => item.runId === run.id);
    const answered = attempts.filter(item => item.answeredAt);
    return <details key={run.id} className={`${ui.panel} p-4`} open={!overview.activeRun && index === 0 && run.mode.startsWith("mock")}><summary className="cursor-pointer text-sm font-medium">{index === 0 ? "最近一轮" : "历史训练"} · {modeLabels[run.mode]} · 已答 {answered.length}/{run.questionIds.length}</summary><div className="mt-4 space-y-3"><p className="text-sm font-medium text-zinc-800">客观题正确 {answered.filter(item => item.correct).length} / {run.questionIds.length} · 未答 {run.questionIds.length - answered.length} · 独立新题族正确 {answered.filter(item => item.independent && item.correct).length}</p><p className="text-xs leading-6 text-zinc-500">结果只反映这些已做题目，不代表正式考试分数。本轮正确数保留历史评分；当前独立证据和技能状态还会考虑帮助、重复题族、撤回及版本资格。</p>{attempts.map(attempt => <details key={attempt.id} className="rounded-lg border border-zinc-200 p-3"><summary className="cursor-pointer whitespace-pre-wrap text-sm leading-6">{attempt.question.prompt}</summary><div className="mt-3"><ul className="mb-3 space-y-2">{attempt.question.options.map(option => <li key={option.id} className="rounded-lg bg-zinc-50 p-2 text-sm leading-6"><span className="whitespace-pre-wrap">{option.id}. {option.label}</span>{option.id === attempt.answer ? <span className="ml-2 text-xs font-medium text-zinc-700">你的选择</span> : null}{option.id === attempt.feedback?.answer ? <span className="ml-2 text-xs font-medium text-emerald-800">参考答案</span> : null}</li>)}</ul><p className="mb-2 text-xs text-zinc-600">你的答案：{attempt.answer ?? "未作答"} · 用时 {formatDuration(attempt.durationSeconds ?? 0)}</p><AttemptFeedback attempt={attempt} disabled={disabled} send={send} /></div></details>)}</div></details>;
  })}</section>;
}
