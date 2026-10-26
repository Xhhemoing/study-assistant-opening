"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AiGradingInput, AiGradingStatus, LearningObservation } from "@aistudy/contracts";
import { createOpeningLearningClient } from "../client/learning-client";
import { LearningProse } from "../assistant/learning-prose";
import { sourceViewerHref } from "../inbox/source-viewer";
import type { GradingPhotoSelection } from "./ai-grading-photo";
import { useDiagnosticsEnabled } from "../settings/appearance-preferences";
import { FeedbackPractice } from "./feedback-practice";
import { createAiGradingPoll } from "./ai-grading-poll";
import { canCompleteObservation, observationStage, StageActionBar, type AttemptPrimaryAction } from "./stage-action-bar";
import { userFacingMessage } from "../../../lib/user-facing-error";


export const aiOutcomeLabels = { correct: "正确", incorrect: "需改进", unverified: "暂不能判断" } as const;

export function aiGradingRequest(observationId: string, photo: GradingPhotoSelection): AiGradingInput {
  return { observationId, ...(photo.workSourceId ? photo : {}) };
}

export function canGradeObservation(record: LearningObservation) {
  return Boolean(record.problemId && record.attemptId && record.itemVersionId && record.revisionKind !== "retract" && !record.serverEvaluation);
}

export function AiGradingResult({ record }: { record: LearningObservation }) {
  const diagnostics = useDiagnosticsEnabled();
  const result = record.aiEvaluation;
  if (!result || record.verdictSource !== "ai_graded") return null;
  // The server may abstain even when the model proposed a confident-looking answer.
  const outcome = record.outcome;
  return <section className="space-y-3 rounded-lg bg-surface-2 p-4" aria-label="AI 批改结果">
    <p className="text-sm font-semibold text-text">AI 批改 · {aiOutcomeLabels[outcome]}</p>
    <div className="break-words text-sm leading-7 text-text"><LearningProse text={result.feedback} /></div>
    {!result.questionMatch ? <p className="text-xs leading-6 text-warn">请核对题目与作答是否对应。</p> : null}
    <ol className="space-y-2" aria-label="评分要点">{result.criteria.map((criterion, index) => <li key={index} className="text-sm leading-6">
      <p className="font-medium text-text">{criterion.label} · {aiOutcomeLabels[criterion.verdict]}</p>
      <div className="break-words text-text-2"><LearningProse text={criterion.feedback} /></div>
    </li>)}</ol>
    {result.transcription ? <details><summary className="min-h-10 cursor-pointer py-2 text-xs text-text-2">查看图片识别文字</summary><p className="whitespace-pre-wrap break-words text-sm leading-6 text-text-2">{result.transcription}</p></details> : null}
    {result.followUp && observationStage(record) === "reliable" && result.questionMatch ? <FeedbackPractice key={record.id} question={result.followUp} /> : null}
    {diagnostics ? <details><summary className="min-h-10 cursor-pointer py-2 text-xs text-text-2">批改详情</summary><p className="text-xs leading-6 text-text-3">模型：{result.modelLabel ?? "未提供"} · 自评置信度 {Math.round(result.confidence * 100)}%（不是判分准确率）</p></details> : null}
  </section>;
}

type AiGradingCardProps = {
  record: LearningObservation; autoGrade?: boolean; photo?: GradingPhotoSelection; disabled?: boolean;
  onGraded: (next: LearningObservation) => void; onDispute?: () => void; onPendingChange?: (pending: boolean) => void;
  completionAction?: AttemptPrimaryAction;
  hideDisputeAction?: boolean;
};

export function AiGradingCard(props: AiGradingCardProps) {
  return <GradingCard key={props.record.id} {...props} />;
}

function GradingCard({ record, disabled = false, onGraded, onDispute, onPendingChange, completionAction, hideDisputeAction = false }: AiGradingCardProps) {
  const client = useMemo(() => createOpeningLearningClient(), []);
  const [status, setStatus] = useState<AiGradingStatus | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const onGradedRef = useRef(onGraded);
  onGradedRef.current = onGraded;
  const canGrade = canGradeObservation(record);
  const pending = sending || status?.status === "queued" || status?.status === "grading";
  useEffect(() => { onPendingChange?.(pending); }, [pending, onPendingChange]);
  useEffect(() => () => { onPendingChange?.(false); }, [onPendingChange]);
  const poller = useMemo(() => createAiGradingPoll(async isCurrent => {
    const next = await client.getGradingStatus(record.id);
    if (!isCurrent()) return null;
    setStatus(next); setSending(false); setError("");
    if (next.headObservationId !== record.id) {
      const history = await client.getObservationHistory(record.id);
      if (!isCurrent()) return null;
      const head = history.revisions.find(row => row.id === history.headObservationId);
      if (head && head.id !== record.id) { onGradedRef.current(head); return null; }
    }
    return next.status;
  }, reason => {
    setSending(false);
    setError(`原答案已保存。${userFacingMessage(reason, "暂时无法读取批改状态。")}`);
  }), [client, record.id]);

  // Even autoGrade callers only READ. Closing/hidden only stops local polling,
  // never the durable job. Retain the lock across effect restarts/StrictMode.
  useEffect(() => {
    if (!canGrade && !record.aiEvaluation) return;
    poller.start();
    return () => poller.stop();
  }, [canGrade, poller, record.aiEvaluation]);

  async function enqueue() {
    if (inFlight.current || disabled || !status?.retryable || status.status === "unknown_cost") return;
    inFlight.current = true;
    try {
      await poller.retry(async isCurrent => {
        setSending(true); setError("");
        try {
          const next = await client.gradeObservation({ observationId: record.id });
          if (isCurrent()) setStatus(next);
          return true;
        } catch (reason) {
          if (isCurrent()) setError(`原答案已保存。${userFacingMessage(reason, "未能加入批改队列。")}`);
          return false;
        } finally { if (isCurrent()) setSending(false); }
      });
    } finally { inFlight.current = false; }
  }

  if (!canGrade && !record.aiEvaluation) return null;
  const photo = status?.workSource ?? record.aiEvaluation?.workSource;
  const photoHref = photo ? sourceViewerHref(photo.id, photo.version, { page: photo.physicalPage }) : null;
  const unknown = status?.status === "unknown_cost";
  const skippedMessages = {
    disabled: "答案已保存，工作区已关闭首次提交自动批改。可手动批改。",
    no_model: "答案已保存，尚无可用的批改模型。请先在设置中配置模型，再手动批改。",
    daily_cap: "答案已保存，今日自动批改额度已用完。仍可手动批改，费用受每日 AI 预算约束。",
    budget: "答案已保存，当前 AI 预算不足以覆盖本次预估。调整预算或模型后可手动批改。",
    budget_unavailable: "答案已保存，暂时无法可靠估算本次批改费用（例如图片上限未配置）。请调整模型后手动批改。",
    answer_changed: "答案已修改并保存，不会自动重批。请手动重新批改。",
  };
  const skipped = status?.autoGradeSkipped ? skippedMessages[status.autoGradeSkipped] : undefined;
  const retryLabel = status?.answerRevision && status.answerRevision > 1 ? "重新批改"
    : status && !status.jobId ? "手动批改" : "重试批改";
  const completion = !pending && !error && status?.autoGradeSkipped !== "answer_changed" && completionAction && canCompleteObservation(record)
    ? { ...completionAction, disabled: disabled || completionAction.disabled } : undefined;
  const message = error || (unknown ? "批改费用或发送结果尚未确认，不会重复发送。原答案已保存，可以手动改评。"
    : pending ? "答案已保存，正在后台批改；离开页面不会取消。"
      : skipped ?? (status?.status === "needs_manual" ? "原答案已保存，请核对结果或手动改评。" : !status ? "正在读取后台批改状态。" : undefined));
  return <div className="space-y-3" aria-busy={pending}>
    {photoHref ? <a className="inline-flex min-h-10 items-center text-xs text-accent underline underline-offset-4" target="_blank" rel="noreferrer" href={photoHref}>查看作答照片</a> : null}
    <AiGradingResult record={record} />
    <StageActionBar stage={error ? "failed" : pending ? "processing" : unknown ? "evaluation-pending" : observationStage(record)} message={message}
      primary={completion ?? (status?.retryable && !unknown ? { label: retryLabel, disabled: disabled || sending, onClick: () => void enqueue() }
        : !pending && onDispute && (unknown || status?.status === "needs_manual") ? { label: "修改这一步", disabled, onClick: onDispute } : undefined)}>
      {record.aiEvaluation && onDispute && !hideDisputeAction ? <button type="button" className="min-h-11 rounded px-2 py-2 text-sm text-accent underline underline-offset-4 disabled:opacity-50" disabled={pending || disabled} onClick={onDispute}>判错了</button> : null}
    </StageActionBar>
  </div>;
}
