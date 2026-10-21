"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import type { LearningObservation, ObservationHistory, ObservationCardDraft } from "@aistudy/contracts";
import { createOpeningLearningClient } from "../client/learning-client";
import { CreateCardDialog } from "../cards/create-card-dialog";
import { createOpeningCardsClient } from "../cards/cards-client";
import { useDiagnosticsEnabled } from "../settings/appearance-preferences";
import { ObservationRevisionFields } from "./observation-revision-fields";
import { currentHistoryRecord, observationRevisionCommand, observationRevisionDraft, observationRevisionFailure, reloadObservationRevisionEditor, type ObservationRevisionEditor } from "./observation-revision-model";
import { AiGradingCard, aiOutcomeLabels } from "./ai-grading-card";
import type { GradingPhotoSelection } from "./ai-grading-photo";

const outcomeLabels = { correct: "自报正确", incorrect: "自报错误", unverified: "未核验" };
function outcomeLabel(record: LearningObservation): string {
  if (record.verdictSource === "ai_graded") return `AI 批改：${aiOutcomeLabels[record.outcome]}`;
  return record.serverEvaluation ? record.serverEvaluation.decision === "correct" ? "自动核算正确"
    : record.serverEvaluation.decision === "incorrect" ? "自动核算有误" : "自动核算拒判" : outcomeLabels[record.outcome];
}
const helpLabels = { independent: "自报独立", hinted: "使用过提示", revealed: "看过讲解", unknown: "帮助情况未知" };
const buttonClass = "border-b border-line px-2 py-2 text-sm text-text disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700";

type HistoryPanel = { history: ObservationHistory | null; open: boolean };
type HistoryPanelAction = { type: "loaded"; history: ObservationHistory } | { type: "close" | "clear" };

export function observationHistoryPanelReducer(state: HistoryPanel, action: HistoryPanelAction): HistoryPanel {
  if (action.type === "loaded") return { history: action.history, open: true };
  if (action.type === "close") return { ...state, open: false };
  return { history: null, open: false };
}

export function ObservationRevisionCard({ record, onChanged, onUpdated, autoGrade = false, gradingPhoto }: {
  record: LearningObservation; onChanged: () => void; onUpdated?: (record: LearningObservation) => void;
  autoGrade?: boolean; gradingPhoto?: GradingPhotoSelection;
}) {
  const diagnostics = useDiagnosticsEnabled();
  const [{ history, open: historyOpen }, updateHistory] = useReducer(observationHistoryPanelReducer, { history: null, open: false });
  const [editor, setEditor] = useState<ObservationRevisionEditor | null>(null);
  const [courses, setCourses] = useState<Array<{ id: string; title: string }>>([]);
  const [cardDraft, setCardDraft] = useState<ObservationCardDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  const [latest, setLatest] = useState<LearningObservation | null>(null);
  const [disputing, setDisputing] = useState(false);
  const retry = useRef<{ intent: string; clientKey: string } | null>(null);
  const client = createOpeningLearningClient();
  const current = history ? currentHistoryRecord(history) : latest ?? record;
  useEffect(() => { setLatest(null); }, [record]);

  function updated(next: LearningObservation) {
    setLatest(next); updateHistory({ type: "clear" }); onUpdated?.(next); onChanged();
  }

  const fail = (error: unknown) => {
    const failure = observationRevisionFailure(error);
    setMessage(failure.message);
    if (failure.kind === "conflict") setEditor((value) => value ? { ...value, conflict: true } : value);
    if (failure.kind === "unavailable") {
      setUnavailable(true); updateHistory({ type: "clear" }); setEditor(null); onChanged();
    }
  };

  async function makeCard() {
    setBusy(true); setMessage("");
    try {
      setCardDraft(await createOpeningCardsClient().observationDraft(current.id));
    } catch (error) { fail(error); } finally { setBusy(false); }
  }

  async function load(kind?: "replace" | "retract", dispute = false) {
    setBusy(true); setMessage("");
    try {
      const next = await client.getObservationHistory(record.rootObservationId ?? record.id);
      const head = currentHistoryRecord(next);
      updateHistory({ type: "loaded", history: next });
      if (kind) {
        const options = kind === "replace" && !dispute ? await client.listRevisionCourses() : [];
        setCourses(options);
        setDisputing(dispute);
        if (dispute) updateHistory({ type: "close" });
        setEditor({ record: head, expectedHead: next.headObservationId, draft: { ...observationRevisionDraft(head), ...(dispute ? { outcome: "unverified" as const } : {}) }, revisionKind: kind, reason: dispute ? "AI 批改结果不准确" : "", conflict: false });
      }
    } catch (error) { fail(error); } finally { setBusy(false); }
  }

  async function reload() {
    if (!editor) return;
    setBusy(true);
    try {
      const next = await client.getObservationHistory(record.rootObservationId ?? record.id);
      setEditor(reloadObservationRevisionEditor(editor, next)); updateHistory({ type: "loaded", history: next });
      setMessage("已载入最新版本，输入已保留。请对照历史后确认提交。");
    } catch (error) { fail(error); } finally { setBusy(false); }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!editor || editor.conflict || busy) return;
    setBusy(true); setMessage("");
    try {
      const intent = JSON.stringify([editor.expectedHead, editor.revisionKind, editor.draft, editor.reason]);
      if (retry.current?.intent !== intent) retry.current = { intent, clientKey: crypto.randomUUID() };
      const result = await client.reviseObservation(observationRevisionCommand({ ...editor, clientKey: retry.current.clientKey }));
      setEditor(null); updateHistory({ type: "clear" }); retry.current = null;
      setMessage(editor.revisionKind === "retract" ? "已撤回，历史仍保留。" : "已保存纠正，未新增练习次数。");
      if (result.observation) updated(result.observation); else onChanged();
    } catch (error) { fail(error); } finally { setBusy(false); }
  }

  if (unavailable) return <p role="status" className="text-sm text-text-3">{message}</p>;
  return <article className="space-y-3 rounded-lg border border-line p-4">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h4 className="text-sm font-medium text-text">{current.skillLabel}</h4>
      <span className="text-xs text-text-3">{current.revisionKind === "retract" ? "已撤回 · 不计入当前证据" : `${outcomeLabel(current)} · ${helpLabels[current.assistance]}`}</span>
    </div>
    <p className="whitespace-pre-wrap break-words text-sm text-text">{current.answer || "（未填写回答）"}</p>
    {current.revisionKind !== "retract" ? <AiGradingCard record={current} autoGrade={autoGrade} photo={gradingPhoto} disabled={busy || Boolean(editor)} onGraded={updated} onDispute={() => void load("replace", true)} /> : null}
    <p className="text-xs text-text-3">原观察时间：<time dateTime={current.occurredAt}>{new Date(current.occurredAt).toLocaleString("zh-CN")}</time>{diagnostics && current.requirementKey ? ` · 要求：${current.requirementKey}` : ""}</p>
    <div className="flex flex-wrap gap-2">
      {current.outcome === "incorrect" && current.revisionKind !== "retract" ? <button type="button" className={buttonClass} disabled={busy || !!editor} onClick={() => void makeCard()}>做成记忆卡片</button> : null}
      <button type="button" className={buttonClass} disabled={busy || !!editor} onClick={() => historyOpen ? updateHistory({ type: "close" }) : void load()}>{historyOpen ? "收起历史" : "查看历史"}</button>
      <button type="button" className={buttonClass} disabled={busy || !!editor} onClick={() => void load("replace")}>{current.revisionKind === "retract" ? "纠正并重新纳入" : "纠正记录"}</button>
      {current.revisionKind !== "retract" ? <button type="button" className={buttonClass} disabled={busy || !!editor} onClick={() => void load("retract")}>撤回记录</button> : null}
    </div>
    {historyOpen && history ? <ol className="space-y-3 border-l border-line pl-4" aria-label="观察修订历史">{history.revisions.map((item, index) => <li key={item.id} className="space-y-1 text-xs text-text-3">
      <p className="font-medium text-text">第 {index + 1} 次记录 · {item.revisionKind === "retract" ? "撤回" : item.revisionKind === "replace" ? "纠正" : "原记录"}{item.id === history.headObservationId ? " · 当前记录" : " · 历史记录（不重复计数）"}</p>
      <p>{item.skillLabel} · {outcomeLabel(item)} · {helpLabels[item.assistance]}{diagnostics && item.requirementKey ? ` · 要求：${item.requirementKey}` : ""}</p>
      <p className="whitespace-pre-wrap break-words">{item.answer || "（未填写回答）"}</p>
      {item.revisionReason ? <p className="whitespace-pre-wrap break-words">原因：{item.revisionReason}</p> : null}
      <p>记录时间：{new Date(item.recordedAt ?? item.occurredAt).toLocaleString("zh-CN")}</p>
    </li>)}</ol> : null}
    {editor ? <form className="space-y-3 border-t border-line pt-3" onSubmit={(event) => void submit(event)}>
      <h5 className="text-sm font-medium text-text">{disputing ? "更正批改结果" : editor.revisionKind === "retract" ? "撤回当前记录" : "纠正当前记录"}</h5>
      {disputing ? <label className="block text-sm text-text">你的判断<select className="ml-2 min-h-11 rounded border border-line bg-surface px-3 py-2" value={editor.draft.outcome} onChange={event => setEditor({ ...editor, draft: { ...editor.draft, outcome: event.target.value as LearningObservation["outcome"] } })}><option value="unverified">暂不能判断</option><option value="correct">答案正确</option><option value="incorrect">答案有误</option></select></label> : editor.revisionKind === "replace" ? <ObservationRevisionFields draft={editor.draft} courses={courses} onChange={(draft) => setEditor({ ...editor, draft })} /> : <p className="text-sm text-text-3">撤回后不再用于当前总结和新复测候选。原记录和纠正历史仍保留。</p>}
      <label className="block text-sm text-text">{editor.revisionKind === "retract" ? "撤回原因" : "纠正原因"}<textarea required maxLength={2000} value={editor.reason} onChange={(event) => setEditor({ ...editor, reason: event.target.value })} rows={2} className="mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-text" /></label>
      {editor.conflict ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void reload()}>重新载入最新版本并保留输入</button> : null}
      <div className="flex gap-2"><button type="submit" className={buttonClass} disabled={busy || editor.conflict || !editor.reason.trim()}>{busy ? "正在保存…" : editor.revisionKind === "retract" ? "确认撤回" : "保存纠正"}</button><button type="button" className={buttonClass} disabled={busy} onClick={() => setEditor(null)}>取消</button></div>
    </form> : null}
    {cardDraft ? <CreateCardDialog initial={cardDraft} onClose={() => setCardDraft(null)} /> : null}
    {message ? <p role="status" className="text-sm leading-6 text-text-3">{message}</p> : null}
    {busy && !editor ? <p role="status" className="text-sm text-text-3">正在读取记录…</p> : null}
  </article>;
}
