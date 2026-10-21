"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AiGradingInput, LearningObservation, SourceRecord } from "@aistudy/contracts";
import { createOpeningApi } from "../client/api";
import { createOpeningLearningClient } from "../client/learning-client";
import { LearningProse } from "../assistant/learning-prose";
import { sourceViewerHref } from "../inbox/source-viewer";
import { AiGradingPhotoFields, emptyGradingPhoto, type GradingPhotoSelection } from "./ai-grading-photo";
import { runPracticeRequest } from "./practice-draft";
import { useDiagnosticsEnabled } from "../settings/appearance-preferences";
import { FeedbackPractice } from "./feedback-practice";

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
  if (!result) return null;
  // The server may abstain even when the model proposed a confident-looking answer.
  const outcome = record.verdictSource === "ai_graded" ? record.outcome : result.outcome;
  return <section className="space-y-3 rounded-lg bg-surface-2 p-4" aria-label="AI 批改结果">
    <p className="text-sm font-semibold text-text">AI 批改 · {aiOutcomeLabels[outcome]}</p>
    <div className="break-words text-sm leading-7 text-text"><LearningProse text={result.feedback} /></div>
    {!result.questionMatch ? <p className="text-xs leading-6 text-warn">请核对题目与作答是否对应。</p> : null}
    <ol className="space-y-2" aria-label="评分要点">{result.criteria.map((criterion, index) => <li key={index} className="text-sm leading-6">
      <p className="font-medium text-text">{criterion.label} · {aiOutcomeLabels[criterion.verdict]}</p>
      <div className="break-words text-text-2"><LearningProse text={criterion.feedback} /></div>
    </li>)}</ol>
    {result.transcription ? <details><summary className="min-h-10 cursor-pointer py-2 text-xs text-text-2">查看图片识别文字</summary><p className="whitespace-pre-wrap break-words text-sm leading-6 text-text-2">{result.transcription}</p></details> : null}
    {result.followUp && outcome !== "unverified" && result.questionMatch ? <FeedbackPractice key={record.id} question={result.followUp} /> : null}
    {diagnostics ? <details><summary className="min-h-10 cursor-pointer py-2 text-xs text-text-2">批改详情</summary><p className="text-xs leading-6 text-text-3">模型：{result.modelLabel ?? "未提供"} · 自评置信度 {Math.round(result.confidence * 100)}%（不是判分准确率）</p></details> : null}
  </section>;
}

export function AiGradingCard({ record, autoGrade = false, photo: suppliedPhoto, disabled = false, onGraded, onDispute }: {
  record: LearningObservation; autoGrade?: boolean; photo?: GradingPhotoSelection; disabled?: boolean;
  onGraded: (next: LearningObservation) => void; onDispute?: () => void;
}) {
  const client = useMemo(() => createOpeningLearningClient(), []);
  const [photo, setPhoto] = useState(suppliedPhoto ?? emptyGradingPhoto);
  const [sources, setSources] = useState<SourceRecord[]>([]);
  const [photoOpen, setPhotoOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
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

  const grade = useCallback(async () => {
    if (inFlight.current || disabled || !canGrade || record.aiEvaluation) return;
    inFlight.current = true; setPending(true); setError("");
    try {
      const input = aiGradingRequest(record.id, selectedPhoto);
      const next = await runPracticeRequest(`ai-grade:${JSON.stringify(input)}`, () => client.gradeObservation(input));
      if (mounted.current && currentRecordId.current === record.id) onGraded(next);
    } catch (reason) {
      if (mounted.current && currentRecordId.current === record.id) setError(`原答案已保存。${reason instanceof Error ? reason.message : "本次批改未完成，请重试。"}`);
    } finally {
      inFlight.current = false;
      if (mounted.current) setPending(false);
    }
  }, [canGrade, client, disabled, onGraded, record.aiEvaluation, record.id, selectedPhoto]);

  useEffect(() => {
    if (!autoGrade || !canGrade || record.aiEvaluation || disabled || autoRequested.current === record.id) return;
    autoRequested.current = record.id;
    void grade();
  }, [autoGrade, canGrade, disabled, grade, record.aiEvaluation, record.id]);

  async function loadPhotos() {
    setPhotoOpen(true);
    try { setSources(await createOpeningApi().listSources()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "文件暂时无法读取，请重试。"); }
  }

  if (!canGrade && !record.aiEvaluation) return null;
  return <div className="space-y-3" aria-busy={pending}>
    {photoHref ? <a className="inline-flex min-h-10 items-center text-xs text-accent underline underline-offset-4" target="_blank" rel="noreferrer" href={photoHref}>查看作答照片</a> : null}
    <AiGradingResult record={record} />
    {pending ? <p role="status" className="text-sm text-text-2">原答案已保存，正在批改…</p> : null}
    {error ? <p role="alert" className="text-sm leading-6 text-warn">{error}</p> : null}
    {!record.aiEvaluation && photoOpen && !suppliedPhoto ? <AiGradingPhotoFields sources={sources} value={photo} onChange={setPhoto} disabled={pending || disabled} onRefresh={() => void loadPhotos()} /> : null}
    <div className="flex flex-wrap items-center gap-3">
      {!record.aiEvaluation ? <button type="button" className="min-h-11 rounded-lg bg-ink px-4 py-2 text-sm text-on-ink disabled:opacity-50" disabled={pending || disabled} onClick={() => void grade()}>{pending ? "正在批改…" : error ? "重试批改" : "AI 批改"}</button> : onDispute ? <button type="button" className="min-h-10 rounded px-2 py-2 text-sm text-accent underline underline-offset-4 disabled:opacity-50" disabled={pending || disabled} onClick={onDispute}>判错了</button> : null}
      {!record.aiEvaluation && !photoOpen && !suppliedPhoto ? <button type="button" className="min-h-10 px-2 py-2 text-xs text-text-2 underline underline-offset-4 disabled:opacity-50" disabled={pending || disabled} onClick={() => void loadPhotos()}>添加作答照片</button> : null}
    </div>
  </div>;
}
