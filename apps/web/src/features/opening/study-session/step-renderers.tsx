"use client";
import type { ComponentType, ReactNode } from "react";
import type { StudySessionView, StudyStep } from "./model";
import { ui } from "../design/ui";
import { SpanTargetedFocus } from "../teaching/span/targeted-focus";
export type StepRendererProps = { step: StudyStep; answer: StudySessionView["answer"]; locked: boolean; photo?: StudySessionView["photo"]; content?: ReactNode; onEdit: (key: string, value: string) => void; onChoosePhoto?: (file: File) => void; onRemovePhoto?: () => void };
function LearnRenderer({ step }: StepRendererProps) {
  return step.kind === "learn" ? <><SpanTargetedFocus text={step.targetedFocus} /><div className="whitespace-pre-wrap text-sm leading-8">{step.body}</div></> : null;
}
function QuestionRenderer({ step, answer, locked, photo, onEdit, onChoosePhoto, onRemovePhoto }: StepRendererProps) {
  return step.kind === "question" ? <div className="space-y-5"><p className="whitespace-pre-wrap text-sm leading-8">{step.prompt}</p><fieldset disabled={locked} className="grid gap-3 sm:grid-cols-2"><legend className="mb-3 text-sm font-medium">写下自己的等式和推理</legend>{step.fields.map(field => <label className="block text-sm" key={field.key}>{field.label}{field.options ? <select className={`${ui.input} mt-1`} value={answer[field.key] ?? ""} onChange={event => onEdit(field.key, event.target.value)}><option value="">请选择</option>{field.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : <input className={`${ui.input} mt-1`} maxLength={field.key === "explanation" ? 6000 : 1200} value={answer[field.key] ?? ""} onChange={event => onEdit(field.key, event.target.value)} />}</label>)}</fieldset>{photo?.enabled ? <section className="space-y-2 rounded-lg border border-line p-3" aria-label="照片作答附件"><p className="text-sm font-medium">照片作答（附件，不会识别成文字）</p><input type="file" accept="image/*" capture="environment" disabled={locked || ["uploading", "preparing"].includes(photo.status)} onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) onChoosePhoto?.(file); }} />{photo.name ? <p className="text-xs text-text-2">{photo.name}</p> : null}{photo.status === "ready" ? <p role="status" className="text-xs text-text-2">照片已准备，可在提交时作为附件发送。</p> : photo.status === "pending" ? <p role="status" className="text-xs text-warn">照片已保存，解析仍在进行；不会显示已识别文字。</p> : photo.status === "unavailable" ? <p role="status" className="text-xs text-warn">照片暂不可用于本题，文字作答仍可继续。</p> : photo.message ? <p role="alert" className="text-xs text-danger">{photo.message}</p> : null}{photo.status !== "none" ? <button type="button" className={ui.quiet} disabled={locked} onClick={() => onRemovePhoto?.()}>移除照片附件，继续文字作答</button> : null}</section> : null}</div> : null;
}
/** New kinds register here; controlled practice reuses its existing editor/result owner. */
function PracticeRenderer({ step, content }: StepRendererProps) {
  return step.kind === "practice" ? <div className="space-y-5"><section aria-label="已确认的题干"><h2 className="text-sm font-medium">题干</h2><p className="whitespace-pre-wrap text-sm leading-8">{step.prompt}</p></section>{content}</div> : null;
}
export const stepRenderers: Record<StudyStep["kind"], ComponentType<StepRendererProps>> = { learn: LearnRenderer, question: QuestionRenderer, practice: PracticeRenderer };
