"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AiGradingInput, LearningObservation, SourceRecord } from "@aistudy/contracts";
import { createOpeningApi } from "../client/api";
import { createOpeningLearningClient } from "../client/learning-client";
import { LearningProse } from "../assistant/learning-prose";
import { sourceViewerHref } from "../inbox/source-viewer";
import { AiGradingPhotoFields, emptyGradingPhoto, type GradingPhotoSelection } from "./ai-grading-photo";
import { pendingPracticeRequest, runPracticeRequest } from "./practice-draft";
import { useDiagnosticsEnabled } from "../settings/appearance-preferences";
import { FeedbackPractice } from "./feedback-practice";
import { canCompleteObservation, observationStage, StageActionBar, type AttemptPrimaryAction } from "./stage-action-bar";
import { readGradingPhotoDraft, saveGradingPhotoDraft } from "./ai-grading-photo-draft";

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

function GradingCard({ record, autoGrade = false, photo: suppliedPhoto, disabled = false, onGraded, onDispute, onPendingChange, completionAction }: AiGradingCardProps) {
  const client = useMemo(() => createOpeningLearningClient(), []);
  const [photo, setPhoto] = useState(suppliedPhoto ?? emptyGradingPhoto);
  const [photoReady, setPhotoReady] = useState(Boolean(suppliedPhoto));
  const [photoWarning, setPhotoWarning] = useState(false);
  useEffect(() => {
    if (!suppliedPhoto) setPhoto(readGradingPhotoDraft(record.id));
    setPhotoReady(true);
  }, [record.id, suppliedPhoto]);
  const [sources, setSources] = useState<SourceRecord[]>([]);
  const [photoOpen, setPhotoOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { onPendingChange?.(pending); }, [pending, onPendingChange]);
  useEffect(() => () => { onPendingChange?.(false); }, [onPendingChange]);
  const inFlight = useRef(false);
  const autoRequested = useRef<string | null>(null);
  const mounted = useRef(true);
  const currentRecordId = useRef(record.id);
  currentRecordId.current = record.id;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const selectedPhoto = suppliedPhoto ?? photo;
  const assessedPhoto = record.aiEvaluation?.workSource;
  const photoHref = assessedPhoto ? sourceViewerHref(assessedPhoto.id, assessedPhoto.version, { page: assessedPhoto.physicalPage })
    : selectedPhoto.workSourceId ? sourceViewerHref(selectedPhoto.workSourceId, selectedPhoto.workSourceVersion, { page: selectedPhoto.physicalPage }) : null;
  const canGrade = canGradeObservation(record);
  const completion = !pending && !error && completionAction && canCompleteObservation(record)
    ? { ...completionAction, disabled: disabled || completionAction.disabled } : undefined;

  const requestKey = `ai-grade:${JSON.stringify(aiGradingRequest(record.id, selectedPhoto))}`;
  const grade = useCallback(async (resumeOnly = false) => {
    const existing = pendingPracticeRequest<LearningObservation>(requestKey);
    if (inFlight.current || !photoReady || disabled || !canGrade || record.aiEvaluation || resumeOnly && !existing) return;
    inFlight.current = true; setPending(true); setError("");
    try {
      const input = aiGradingRequest(record.id, selectedPhoto);
      const next = await (existing ?? runPracticeRequest(requestKey, () => client.gradeObservation(input)));
      if (mounted.current && currentRecordId.current === record.id) onGraded(next);
    } catch (reason) {
      if (mounted.current && currentRecordId.current === record.id) setError(`原答案已保存。${reason instanceof Error ? reason.message : "本次批改未完成，请重试。"}`);
    } finally {
      inFlight.current = false;
      if (mounted.current) setPending(false);
    }
  }, [canGrade, client, disabled, onGraded, photoReady, record.aiEvaluation, record.id, requestKey, selectedPhoto]);

  useEffect(() => { void grade(true); }, [grade]);

  useEffect(() => {
    if (!photoReady || !autoGrade || !canGrade || record.aiEvaluation || disabled || autoRequested.current === record.id) return;
    autoRequested.current = record.id;
    void grade();
  }, [autoGrade, canGrade, disabled, grade, photoReady, record.aiEvaluation, record.id]);

  async function loadPhotos() {
    setPhotoOpen(true);
    try {
      const next = await createOpeningApi().listSources();
      if (mounted.current) setSources(next);
    }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "文件暂时无法读取，请重试。"); }
  }

  if (!canGrade && !record.aiEvaluation) return null;
  return <div className="space-y-3" aria-busy={pending}>
    {photoHref ? <a className="inline-flex min-h-10 items-center text-xs text-accent underline underline-offset-4" target="_blank" rel="noreferrer" href={photoHref}>查看作答照片</a> : null}
    <AiGradingResult record={record} />
    {!record.aiEvaluation && photoOpen && !suppliedPhoto ? <AiGradingPhotoFields sources={sources} value={photo} onChange={value => { setPhoto(value); setPhotoWarning(!saveGradingPhotoDraft(record.id, value)); }} disabled={pending || disabled} onRefresh={() => void loadPhotos()} /> : null}
    {photoWarning ? <p role="status" className="text-xs text-warn">照片选择仅在本页保留，刷新后请重新选择；原答案不受影响。</p> : null}
    <StageActionBar stage={pending ? "processing" : error ? "failed" : observationStage(record) === "corrected" ? "corrected" : record.aiEvaluation ? observationStage(record) : "draft"}
      message={pending ? "正在批改，你的答案已保存。" : error || (record.aiEvaluation && observationStage(record) === "evaluation-pending" ? "这次结果不确定，请说明需要修改的判断。" : undefined)}
      primary={completion ?? (!record.aiEvaluation ? { label: error ? "重试批改" : "AI 批改", disabled: !photoReady || disabled, onClick: () => void grade() }
        : observationStage(record) === "evaluation-pending" && onDispute ? { label: "修改这一步", disabled, onClick: onDispute } : undefined)}>
      {completion && !record.aiEvaluation && canGrade ? <button type="button" className="min-h-11 px-2 py-2 text-xs text-text-2 underline underline-offset-4 disabled:opacity-50" disabled={!photoReady || disabled} onClick={() => void grade()}>重新批改</button> : null}
      {record.aiEvaluation && observationStage(record) !== "evaluation-pending" && onDispute ? <button type="button" className="min-h-11 rounded px-2 py-2 text-sm text-accent underline underline-offset-4 disabled:opacity-50" disabled={pending || disabled} onClick={onDispute}>判错了</button> : null}
      {!record.aiEvaluation && !photoOpen && !suppliedPhoto ? <button type="button" className="min-h-11 px-2 py-2 text-xs text-text-2 underline underline-offset-4 disabled:opacity-50" disabled={pending || disabled || !photoReady} onClick={() => void loadPhotos()}>添加作答照片</button> : null}
    </StageActionBar>
  </div>;
}
