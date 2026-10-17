"use client";

import type { ExamErrorCause, ExamSourceItem, ExamSourceRecord, ExamSprintOverview } from "@aistudy/contracts";
import { useState } from "react";
import { textareaClass, ui } from "../design/ui";
import type { ExamSprintIntent } from "./client";
import { WorkReviewPanel, matchingWorkReview, type WorkReviewContext, type WorkDraft } from "./work-review-panel";
import { assistanceLabels, causeLabels, outcomeLabels, phaseLabels } from "./labels";

type Send = (command: ExamSprintIntent) => void;

export function filterSources(items: ExamSourceItem[], topicId: string, search: string): ExamSourceItem[] {
  const query = search.trim().toLocaleLowerCase();
  return items.filter(item => (!topicId || item.topicId === topicId) && (!query || `${item.label} ${item.sourceTitle} ${item.skills.join(" ")} ${item.sourcePage ?? ""}`.toLocaleLowerCase().includes(query)));
}

function SourceRecordForm({ source, records, disabled, send, reviewContext }: { source: ExamSourceItem; records: ExamSourceRecord[]; disabled: boolean; send: Send; reviewContext?: WorkReviewContext }) {
  const [phase, setPhase] = useState<ExamSourceRecord["phase"]>(records.length ? "blind" : "first");
  const [outcome, setOutcome] = useState<ExamSourceRecord["outcome"] | "">("");
  const [assistance, setAssistance] = useState<ExamSourceRecord["assistance"]>("none");
  const [minutes, setMinutes] = useState<number | "">("");
  const [cause, setCause] = useState<ExamErrorCause | "">("");
  const [note, setNote] = useState("");
  const [workDraft, setWorkDraft] = useState<WorkDraft>({ workSourceId: "", answerText: "", referenceChecked: false });
  const workSource = reviewContext?.resources?.sources.find(item => item.id === workDraft.workSourceId);
  const reference = reviewContext?.integration?.binding?.materials.find(item => item.sourceTitle === source.sourceTitle);
  const referenceChecked = workDraft.referenceChecked && !!reference;
  const matchedReview = matchingWorkReview(reviewContext?.review, source.id, workSource, reference, workDraft.answerText);
  const reviewId = referenceChecked && matchedReview?.status === "ready" ? matchedReview.id : undefined;
  return <form className="space-y-3" onSubmit={event => { event.preventDefault(); if (!disabled && outcome && minutes !== "") send({ action: "source", sourceId: source.id, phase, outcome, assistance, durationMinutes: minutes, errorCause: cause || null, note, ...(workDraft.answerText ? { answerText: workDraft.answerText.trim() } : {}), ...(workDraft.workSourceId ? { workSourceId: workDraft.workSourceId, workSourceVersion: workSource?.version } : {}), referenceChecked, ...(reviewId ? { reviewId } : {}) }); }}>
    {reviewContext ? <WorkReviewPanel source={source} context={reviewContext} draft={workDraft} onChange={setWorkDraft} disabled={disabled} /> : null}
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="space-y-1"><span className={ui.label}>本次阶段</span><select className={ui.input} value={phase} disabled={disabled} onChange={event => setPhase(event.target.value as ExamSourceRecord["phase"])}>{Object.entries(phaseLabels).map(([value, label]) => <option key={value} value={value} disabled={value === "first" ? records.length > 0 : records.length === 0}>{label}</option>)}</select></label>
      <label className="space-y-1"><span className={ui.label}>自评结果</span><select className={ui.input} value={outcome} required disabled={disabled} onChange={event => setOutcome(event.target.value as ExamSourceRecord["outcome"])}><option value="">请选择本次结果</option>{Object.entries(outcomeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="space-y-1"><span className={ui.label}>帮助使用</span><select className={ui.input} value={assistance} disabled={disabled} onChange={event => setAssistance(event.target.value as ExamSourceRecord["assistance"])}>{Object.entries(assistanceLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="space-y-1"><span className={ui.label}>实际用时（分钟）</span><input type="number" className={ui.input} min={0} max={720} step="0.5" required value={minutes} disabled={disabled} onChange={event => setMinutes(event.target.value === "" ? "" : Number(event.target.value))} /></label>
      <label className="space-y-1 sm:col-span-2"><span className={ui.label}>错因（可选）</span><select className={ui.input} value={cause} disabled={disabled} onChange={event => setCause(event.target.value as ExamErrorCause | "")}><option value="">未标记</option>{Object.entries(causeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    </div>
    <p className="text-xs leading-6 text-zinc-500">如果重做时需要帮助，请如实登记，本次不会计为独立通过。首次错误或求助后先盲重做，再间隔至少 24 小时复测；首次独立正确可隔日直接复测。变式须先通过隔日独立复测，并写明陌生题来源。</p>
    <label className="block space-y-1"><span className={ui.label}>{phase === "variant" ? "陌生题来源与过程（必填，至少 6 字）" : "过程、卡点与修正（可选）"}</span><textarea className={textareaClass} value={note} maxLength={2000} minLength={phase === "variant" ? 6 : undefined} required={phase === "variant"} disabled={disabled} onChange={event => setNote(event.target.value)} placeholder="例如：分部积分末步漏了负号；求导验算后发现并修正。变式请标出来源和题号。" /></label>
    <button type="submit" disabled={disabled} className={ui.primary}>追加本次自评记录</button>
  </form>;
}

function SourceDetail({ source, records, disabled, send, onClose, reviewContext }: { source: ExamSourceItem; records: ExamSourceRecord[]; disabled: boolean; send: Send; onClose: () => void; reviewContext?: WorkReviewContext }) {
  return <section className="space-y-4 rounded-lg border border-emerald-200 bg-emerald-50/30 p-4" aria-label={`${source.label} 学习登记`}>
    <div className="flex items-start justify-between gap-3"><div><h3 className="font-medium">{source.label}</h3><p className="mt-1 text-xs leading-6 text-zinc-600">{source.sourceTitle} · {source.sourcePage ? `第 ${source.sourcePage} 页` : "页码待核对"} · 建议第 {source.suggestedDay} 天</p></div><button type="button" className={ui.quiet} onClick={onClose}>关闭</button></div>
    <p className="rounded-lg bg-amber-50 p-3 text-xs leading-6 text-amber-900">这是原资料题号索引，原题尚未录入在线题库。请打开你自己的对应 PDF 或练习材料，完成后登记；登记不会自动变成“已掌握”。</p>
    <SourceRecordForm key={`${source.id}-${records.length}`} source={source} records={records} disabled={disabled} send={send} reviewContext={reviewContext} />
    {records.length ? <details className="border-t border-emerald-100 pt-3"><summary className="cursor-pointer text-sm">已保存 {records.length} 条记录 · 查看历史</summary><ol className="mt-3 space-y-3">{[...records].reverse().map(record => <li key={record.id} className="rounded-lg bg-white p-3 text-xs leading-6"><p className="font-medium">{phaseLabels[record.phase]} · {outcomeLabels[record.outcome]}</p><p>{assistanceLabels[record.assistance]} · {record.durationMinutes} 分钟 · {new Date(record.recordedAt).toLocaleString("zh-CN")}</p>{record.errorCause ? <p>错因：{causeLabels[record.errorCause]}</p> : null}{record.workSourceId ? <a className="block text-emerald-800 underline" target="_blank" rel="noreferrer" href={`/api/opening/sources/${encodeURIComponent(record.workSourceId)}/download${record.workSourceVersion === undefined ? "" : `?version=${record.workSourceVersion}`}`}>{record.workSourceVersion === undefined ? "打开照片资料（当前版本）" : `查看本次作答照片 · v${record.workSourceVersion}`}</a> : null}{record.reviewId ? <p>AI 候选点评已挂接 · {record.referenceChecked ? "已手动核对" : "待核对"}</p> : null}{record.answerText ? <p className="whitespace-pre-wrap">{record.answerText}</p> : null}{record.note ? <p className="whitespace-pre-wrap text-zinc-600">{record.note}</p> : null}</li>)}</ol></details> : null}
  </section>;
}

export function SourceTracker({ overview, disabled, send, reviewContext }: { overview: ExamSprintOverview; disabled: boolean; send: Send; reviewContext?: WorkReviewContext }) {
  const [topicId, setTopicId] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const filtered = filterSources(overview.pack.sourceItems, topicId, query);
  const pages = Math.max(1, Math.ceil(filtered.length / 20));
  const currentPage = Math.min(page, pages - 1);
  const selected = overview.pack.sourceItems.find(item => item.id === selectedId);
  const recorded = new Set(overview.state.sourceRecords.map(item => item.sourceId));
  return <section className={`${ui.panel} space-y-4 p-5`} aria-labelledby="source-tracker-title">
    <div><h2 id="source-tracker-title" className="font-semibold">原资料逐题清单 · {overview.summary.sourceTotal} 项</h2><p className="mt-1 text-xs leading-6 text-zinc-500">按主编号登记，部分题目含多个小问。来源覆盖与在线技能状态分别计算。</p></div>
    <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1"><span className={ui.label}>章节</span><select className={ui.input} value={topicId} onChange={event => { setTopicId(event.target.value); setPage(0); }}><option value="">全部章节</option>{overview.pack.topics.map(topic => <option key={topic.id} value={topic.id}>{topic.title}</option>)}</select></label><label className="space-y-1"><span className={ui.label}>搜索题号、来源、页码</span><input type="search" className={ui.input} value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} placeholder="例如：Q9、积分、43" /></label></div>
    {selected ? <SourceDetail source={selected} records={overview.state.sourceRecords.filter(item => item.sourceId === selected.id)} disabled={disabled} send={send} onClose={() => setSelectedId(null)} reviewContext={reviewContext} /> : null}
    <ul className="divide-y divide-zinc-100">{filtered.slice(currentPage * 20, (currentPage + 1) * 20).map(item => <li key={item.id}><button type="button" onClick={() => setSelectedId(item.id)} className="flex min-h-12 w-full items-start justify-between gap-3 rounded-lg px-2 py-3 text-left hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600/50" aria-expanded={selectedId === item.id}><span><span className="block text-sm font-medium text-zinc-800">{item.label}</span><span className="mt-1 block text-xs leading-5 text-zinc-500">{item.sourceTitle}{item.sourcePage ? ` · 第 ${item.sourcePage} 页` : ""}</span></span><span className="shrink-0 text-xs text-zinc-500">{recorded.has(item.id) ? "已有登记" : "未登记"}</span></button></li>)}</ul>
    {!filtered.length ? <p className="text-sm text-zinc-500">没有匹配的来源题目，请试试其他关键词。</p> : null}
    <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs text-zinc-500">共 {filtered.length} 项 · 第 {currentPage + 1}/{pages} 页</span><div className="flex gap-2"><button type="button" className={ui.secondary} disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</button><button type="button" className={ui.secondary} disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>下一页</button></div></div>
  </section>;
}
