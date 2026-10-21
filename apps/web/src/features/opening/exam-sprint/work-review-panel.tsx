"use client";

import type { ExamIntegrationOverview, ExamSourceItem, ExamWorkReview } from "@aistudy/contracts";
import Link from "next/link";
import { textareaClass, ui } from "../design/ui";
import type { ExamIntegrationIntent } from "./client";
import type { ExamResources } from "./use-exam-resources";

export type WorkReviewContext = { integration: ExamIntegrationOverview | null; resources: ExamResources | null; review: ExamWorkReview | null; send: (intent: ExamIntegrationIntent) => void; refresh: (id: string) => void };
export type WorkDraft = { workSourceId: string; answerText: string; referenceChecked: boolean };

export function matchingWorkReview(review: ExamWorkReview | null | undefined, sourceItemId: string, work: { id: string; version: number } | undefined, reference: { sourceId: string; sourceVersion: number } | undefined, answerText: string): ExamWorkReview | null {
  return review && work && reference && review.sourceItemId === sourceItemId && review.workSourceId === work.id && review.workSourceVersion === work.version && review.referenceSourceId === reference.sourceId && review.referenceSourceVersion === reference.sourceVersion && review.answerText === answerText.trim() ? review : null;
}

export function WorkReviewPanel({ source, context, draft, onChange, disabled }: { source: ExamSourceItem; context: WorkReviewContext; draft: WorkDraft; onChange: (draft: WorkDraft) => void; disabled: boolean }) {
  const images = context.resources?.sources.filter(item => item.mime.startsWith("image/")) ?? [];
  const work = images.find(item => item.id === draft.workSourceId);
  const reference = context.integration?.binding?.materials.find(item => item.sourceTitle === source.sourceTitle);
  const review = matchingWorkReview(context.review, source.id, work, reference, draft.answerText);
  return <details className="rounded-lg border border-line bg-surface p-3"><summary className="min-h-11 cursor-pointer text-sm font-medium py-2">拍照答案与 AI 过程点评（可选）</summary><div className="mt-3 space-y-3"><p className="text-xs leading-6 text-text-3">先上传你的手写图片，再选择用于本次作答的文件。AI 只提供候选点评；最终结果、帮助使用和是否完成仍由你核对登记。</p><Link href="/opening/library?tab=materials#upload" className={ui.secondary}>前往资料库上传作答照片</Link><label className="block space-y-1"><span className={ui.label}>本次作答照片</span><select className={ui.input} value={draft.workSourceId} disabled={disabled} onChange={event => onChange({ ...draft, workSourceId: event.target.value, referenceChecked: false })}><option value="">暂不挂接图片</option>{images.map(item => <option key={item.id} value={item.id}>{item.name} · v{item.version}</option>)}</select></label><label className="block space-y-1"><span className={ui.label}>补充解答过程（可留空）</span><textarea className={textareaClass} maxLength={20000} value={draft.answerText} disabled={disabled} onChange={event => onChange({ ...draft, answerText: event.target.value, referenceChecked: false })} placeholder="可补充图片中不清楚的公式或解题步骤。" /></label>
    {reference ? <a className="inline-flex min-h-11 items-center text-xs text-accent underline" target="_blank" rel="noreferrer" href={`/api/opening/sources/${encodeURIComponent(reference.sourceId)}/download?version=${reference.sourceVersion}${source.sourcePage ? `#page=${source.sourcePage}` : ""}`}>核对题目原资料 · v{reference.sourceVersion}{source.sourcePage ? ` · 第 ${source.sourcePage} 页` : ""}</a> : <p className="text-xs leading-6 text-warn">先在“课程与证据”中把这组原题关联到真实资料版本，才能请求 AI 点评。</p>}
    <div className="flex flex-wrap gap-2"><button type="button" className={ui.secondary} disabled={disabled || !work || !reference || review?.status === "pending" || review?.status === "unknown" || review?.status === "ready"} onClick={() => { if (work && reference) { onChange({ ...draft, referenceChecked: false }); context.send({ action: "review", input: { sourceItemId: source.id, workSourceId: work.id, workSourceVersion: work.version, referenceSourceId: reference.sourceId, referenceSourceVersion: reference.sourceVersion, answerText: draft.answerText } }); } }}>请求 AI 过程点评</button>{review ? <button type="button" disabled={disabled} className={ui.quiet} onClick={() => context.refresh(review.id)}>刷新本次点评</button> : null}</div>
    {review ? <WorkReviewResult review={review} /> : context.review?.sourceItemId === source.id ? <p className="text-xs leading-6 text-warn">旧点评与当前答案或资料版本不一致，不会挂接到这次自评。可重新请求点评，或独立进行人工核对。</p> : null}
    {reference ? <label className="flex min-h-11 cursor-pointer items-start gap-2 py-2 text-xs leading-6"><input type="checkbox" className="mt-1 accent-accent" disabled={disabled} checked={draft.referenceChecked} onChange={event => onChange({ ...draft, referenceChecked: event.target.checked })} /><span>我已对照真实参考解答逐步核对整题，不仅确认题目一致；原资料无完整解答时保持未勾选。AI 候选不自动构成参考依据；若根据点评修改答案，会如实登记帮助使用。</span></label> : null}
  </div></details>;
}

export function WorkReviewResult({ review }: { review: ExamWorkReview }) {
  if (!review.proposal) return <p className="rounded-lg bg-warn-soft p-3 text-xs leading-6 text-warn" role="status">{review.status === "pending" ? "点评处理中，请稍后手动刷新。" : review.status === "unknown" ? "模型结果尚未确认。请刷新这次点评，不要重复请求。" : "本次点评未能完成，可以继续人工核对与登记。"}</p>;
  const labels = { correct: "候选：完整正确", partial: "候选：部分正确", incorrect: "候选：需要修正", unverified: "尚不能核实" };
  return <section className="space-y-3 rounded-lg bg-surface-2 p-3" aria-label="AI 候选点评"><p className="text-sm font-medium">{labels[review.proposal.outcome]} · 待你核对</p>{!review.proposal.questionMatch ? <p className="text-xs text-warn">题目匹配尚未确认，请先核对原题。</p> : null}<p className="whitespace-pre-wrap font-reading text-[17px] leading-[30px]">{review.proposal.summary}</p><ol className="space-y-2">{review.proposal.steps.map((step, index) => <li key={index} className="text-xs leading-6"><p className="font-medium">{step.label} · {step.verdict === "correct" ? "候选正确" : step.verdict === "incorrect" ? "候选需修正" : "待核实"}</p><p className="whitespace-pre-wrap">{step.feedback}</p></li>)}</ol><details><summary className="min-h-11 cursor-pointer text-xs py-2">查看识别出的过程</summary><p className="mt-2 whitespace-pre-wrap text-xs leading-6">{review.proposal.transcription}</p></details><p className="text-xs text-text-3">模型：{review.modelLabel ?? "未提供"}。这些候选不会自动改写你的自评或掌握状态。</p></section>;
}
