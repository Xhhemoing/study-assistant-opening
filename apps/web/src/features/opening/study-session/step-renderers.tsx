"use client";
import type { ComponentType } from "react";
import type { StudySessionView, StudyStep } from "./model";
import { ui } from "../design/ui";
export type StepRendererProps = { step: StudyStep; answer: StudySessionView["answer"]; locked: boolean; onEdit: (key: string, value: string) => void };
function LearnRenderer({ step }: StepRendererProps) {
  return step.kind === "learn" ? <div className="whitespace-pre-wrap text-sm leading-8">{step.body}</div> : null;
}
function QuestionRenderer({ step, answer, locked, onEdit }: StepRendererProps) {
  return step.kind === "question" ? <div className="space-y-5"><p className="whitespace-pre-wrap text-sm leading-8">{step.prompt}</p><fieldset disabled={locked} className="grid gap-3 sm:grid-cols-2"><legend className="mb-3 text-sm font-medium">写下自己的等式和推理</legend>{step.fields.map(field => <label className="block text-sm" key={field.key}>{field.label}{field.options ? <select className={`${ui.input} mt-1`} value={answer[field.key] ?? ""} onChange={event => onEdit(field.key, event.target.value)}><option value="">请选择</option>{field.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : <input className={`${ui.input} mt-1`} maxLength={field.key === "explanation" ? 6000 : 1200} value={answer[field.key] ?? ""} onChange={event => onEdit(field.key, event.target.value)} />}</label>)}</fieldset></div> : null;
}
/** New kinds register here; shell/action/help/result composition stays shared. */
export const stepRenderers: Record<StudyStep["kind"], ComponentType<StepRendererProps>> = { learn: LearnRenderer, question: QuestionRenderer };
