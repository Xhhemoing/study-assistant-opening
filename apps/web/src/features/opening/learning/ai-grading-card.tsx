"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AiGradingInput, AiGradingStatus, LearningObservation } from "@aistudy/contracts";
import { createOpeningLearningClient } from "../client/learning-client";
import { LearningProse } from "../assistant/learning-prose";
import { sourceViewerHref } from "../inbox/source-viewer";
import type { GradingPhotoSelection } from "./ai-grading-photo";
import { useDiagnosticsEnabled } from "../settings/appearance-preferences";
import { FeedbackPractice } from "./feedback-practice";
import { canCompleteObservation, observationStage, StageActionBar, type AttemptPrimaryAction } from "./stage-action-bar";


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
};

export function AiGradingCard(props: AiGradingCardProps) {
  return <GradingCard key={props.record.id} {...props} />;
}

function GradingCard({ record, disabled = false, onGraded, onDispute, onPendingChange, completionAction }: AiGradingCardProps) {
  const client = useMemo(() => createOpeningLearningClient(), []);
  const [status, setStatus] = useState<AiGradingStatus | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const onGradedRef = useRef(onGraded);
  onGradedRef.current = onGraded;
  const canGrade = canGradeObservation(record);
  const pending = sending || status?.status === "queued" || status?.status === "grading";
  useEffect(() => { onPendingChange?.(pending); }, [pending, onPendingChange]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; onPendingChange?.(false); }; }, [onPendingChange]);

  // Even autoGrade callers only READ. Saving the answer already enqueued its
  // durable job. Closing this card only stops polling, never the job itself.
  useEffect(() => {
    if (!canGrade && !record.aiEvaluation) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const next = await client.getGradingStatus(record.id);
        if (stopped) return;
        setStatus(next); setError("");
        if (next.headObservationId !== record.id) {
          const history = await client.getObservationHistory(record.id);
          if (stopped) return;
          const head = history.revisions.find(row => row.id === history.headObservationId);
          if (head && head.id !== record.id) { onGradedRef.current(head); return; }
        }
        if (["queued", "grading", "unknown_cost"].includes(next.status)) timer = setTimeout(() => void poll(), next.status === "unknown_cost" ? 10000 : 2000);
      } catch (reason) {
        if (stopped) return;
        setError(`原答案已保存。${reason instanceof Error ? reason.message : "暂时无法读取批改状态。"}`);
        timer = setTimeout(() => void poll(), 5000);
      }
    }
    void poll();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [canGrade, client, record.aiEvaluation, record.id, refresh]);

  async function enqueue() {
    if (inFlight.current || disabled || !status?.retryable) return;
    inFlight.current = true; setSending(true); setError("");
    try {
      const next = await client.gradeObservation({ observationId: record.id });
      if (mounted.current) { setStatus(next); setRefresh(value => value + 1); }
    } catch (reason) {
      if (mounted.current) setError(`原答案已保存。${reason instanceof Error ? reason.message : "未能加入批改队列。"}`);
    } finally { inFlight.current = false; if (mounted.current) setSending(false); }
  }

  if (!canGrade && !record.aiEvaluation) return null;
  const photo = status?.workSource ?? record.aiEvaluation?.workSource;
  const photoHref = photo ? sourceViewerHref(photo.id, photo.version, { page: photo.physicalPage }) : null;
  const unknown = status?.status === "unknown_cost";
  const completion = !pending && !error && completionAction && canCompleteObservation(record)
    ? { ...completionAction, disabled: disabled || completionAction.disabled } : undefined;
  const message = error || (unknown ? "批改费用或发送结果尚未确认，不会重复发送。原答案已保存，可以手动改评。"
    : pending ? "答案已保存，正在后台批改；离开页面不会取消。"
      : status?.status === "needs_manual" ? "原答案已保存，请核对结果或手动改评。" : !status ? "正在读取后台批改状态。" : undefined);
  return <div className="space-y-3" aria-busy={pending}>
    {photoHref ? <a className="inline-flex min-h-10 items-center text-xs text-accent underline underline-offset-4" target="_blank" rel="noreferrer" href={photoHref}>查看作答照片</a> : null}
    <AiGradingResult record={record} />
    <StageActionBar stage={error ? "failed" : pending ? "processing" : unknown ? "evaluation-pending" : observationStage(record)} message={message}
      primary={completion ?? (status?.retryable ? { label: "重试批改", disabled: disabled || sending, onClick: () => void enqueue() }
        : !pending && onDispute && (unknown || status?.status === "needs_manual") ? { label: "修改这一步", disabled, onClick: onDispute } : undefined)}>
      {record.aiEvaluation && onDispute ? <button type="button" className="min-h-11 rounded px-2 py-2 text-sm text-accent underline underline-offset-4 disabled:opacity-50" disabled={pending || disabled} onClick={onDispute}>判错了</button> : null}
    </StageActionBar>
  </div>;
}
