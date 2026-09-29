"use client";

import { useReducer, useRef, useState } from "react";
import type { LearningObservation, ObservationHistory } from "@aistudy/contracts";
import { createOpeningLearningClient } from "../client/learning-client";
import { ObservationRevisionFields } from "./observation-revision-fields";
import { currentHistoryRecord, observationRevisionCommand, observationRevisionDraft, observationRevisionFailure, reloadObservationRevisionEditor, type ObservationRevisionEditor } from "./observation-revision-model";

const outcomeLabels = { correct: "自报正确", incorrect: "自报错误", unverified: "未核验" };
const helpLabels = { independent: "自报独立", hinted: "使用过提示", revealed: "看过讲解", unknown: "帮助情况未知" };
const buttonClass = "border-b border-zinc-200 px-2 py-2 text-sm text-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700";

type HistoryPanel = { history: ObservationHistory | null; open: boolean };
type HistoryPanelAction = { type: "loaded"; history: ObservationHistory } | { type: "close" | "clear" };

export function observationHistoryPanelReducer(state: HistoryPanel, action: HistoryPanelAction): HistoryPanel {
  if (action.type === "loaded") return { history: action.history, open: true };
  if (action.type === "close") return { ...state, open: false };
  return { history: null, open: false };
}

export function ObservationRevisionCard({ record, onChanged }: { record: LearningObservation; onChanged: () => void }) {
  const [{ history, open: historyOpen }, updateHistory] = useReducer(observationHistoryPanelReducer, { history: null, open: false });
  const [editor, setEditor] = useState<ObservationRevisionEditor | null>(null);
  const [courses, setCourses] = useState<Array<{ id: string; title: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  const retry = useRef<{ intent: string; clientKey: string } | null>(null);
  const client = createOpeningLearningClient();
  const current = history ? currentHistoryRecord(history) : record;

  const fail = (error: unknown) => {
    const failure = observationRevisionFailure(error);
    setMessage(failure.message);
    if (failure.kind === "conflict") setEditor((value) => value ? { ...value, conflict: true } : value);
    if (failure.kind === "unavailable") {
      setUnavailable(true); updateHistory({ type: "clear" }); setEditor(null); onChanged();
    }
  };

  async function load(kind?: "replace" | "retract") {
    setBusy(true); setMessage("");
    try {
      const next = await client.getObservationHistory(record.rootObservationId ?? record.id);
      const head = currentHistoryRecord(next);
      updateHistory({ type: "loaded", history: next });
      if (kind) {
        const options = kind === "replace" ? await client.listRevisionCourses() : [];
        setCourses(options);
        setEditor({ record: head, expectedHead: next.headObservationId, draft: observationRevisionDraft(head), revisionKind: kind, reason: "", conflict: false });
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
      await client.reviseObservation(observationRevisionCommand({ ...editor, clientKey: retry.current.clientKey }));
      setEditor(null); updateHistory({ type: "clear" }); retry.current = null;
      setMessage(editor.revisionKind === "retract" ? "已撤回，历史仍保留。" : "已保存纠正，未新增练习次数。");
      onChanged();
    } catch (error) { fail(error); } finally { setBusy(false); }
  }

  if (unavailable) return <p role="status" className="text-sm text-zinc-500">{message}</p>;
  return <article className="space-y-3 rounded-lg border border-zinc-200 p-4">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h4 className="text-sm font-medium text-zinc-800">{current.skillLabel}</h4>
      <span className="text-xs text-zinc-500">{current.revisionKind === "retract" ? "已撤回 · 不计入当前证据" : `${outcomeLabels[current.outcome]} · ${helpLabels[current.assistance]}`}</span>
    </div>
    <p className="whitespace-pre-wrap break-words text-sm text-zinc-800">{current.answer || "（未填写回答）"}</p>
    <p className="text-xs text-zinc-500">原观察时间：<time dateTime={current.occurredAt}>{new Date(current.occurredAt).toLocaleString("zh-CN")}</time>{current.requirementKey ? ` · 要求：${current.requirementKey}` : ""}</p>
    <div className="flex flex-wrap gap-2">
      <button type="button" className={buttonClass} disabled={busy || !!editor} onClick={() => historyOpen ? updateHistory({ type: "close" }) : void load()}>{historyOpen ? "收起历史" : "查看历史"}</button>
      <button type="button" className={buttonClass} disabled={busy || !!editor} onClick={() => void load("replace")}>{current.revisionKind === "retract" ? "纠正并重新纳入" : "纠正记录"}</button>
      {current.revisionKind !== "retract" ? <button type="button" className={buttonClass} disabled={busy || !!editor} onClick={() => void load("retract")}>撤回记录</button> : null}
    </div>
    {historyOpen && history ? <ol className="space-y-3 border-l border-zinc-200 pl-4" aria-label="观察修订历史">{history.revisions.map((item, index) => <li key={item.id} className="space-y-1 text-xs text-zinc-500">
      <p className="font-medium text-zinc-800">版本 {index + 1} · {item.revisionKind === "retract" ? "撤回" : item.revisionKind === "replace" ? "纠正" : "原记录"}{item.id === history.headObservationId ? " · 当前版本" : " · 历史版本（不重复计数）"}</p>
      <p>{item.skillLabel} · {outcomeLabels[item.outcome]} · {helpLabels[item.assistance]}{item.requirementKey ? ` · 要求：${item.requirementKey}` : ""}</p>
      <p className="whitespace-pre-wrap break-words">{item.answer || "（未填写回答）"}</p>
      {item.revisionReason ? <p className="whitespace-pre-wrap break-words">原因：{item.revisionReason}</p> : null}
      <p>记录时间：{new Date(item.recordedAt ?? item.occurredAt).toLocaleString("zh-CN")}</p>
    </li>)}</ol> : null}
    {editor ? <form className="space-y-3 border-t border-zinc-200 pt-3" onSubmit={(event) => void submit(event)}>
      <h5 className="text-sm font-medium text-zinc-800">{editor.revisionKind === "retract" ? "撤回当前记录" : "纠正当前记录"}</h5>
      {editor.revisionKind === "replace" ? <ObservationRevisionFields draft={editor.draft} courses={courses} onChange={(draft) => setEditor({ ...editor, draft })} /> : <p className="text-sm text-zinc-500">撤回后不再用于当前总结和新复测候选。原记录和纠正历史仍保留。</p>}
      <label className="block text-sm text-zinc-800">{editor.revisionKind === "retract" ? "撤回原因" : "纠正原因"}<textarea required maxLength={2000} value={editor.reason} onChange={(event) => setEditor({ ...editor, reason: event.target.value })} rows={2} className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-800" /></label>
      {editor.conflict ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void reload()}>重新载入最新版本并保留输入</button> : null}
      <div className="flex gap-2"><button type="submit" className={buttonClass} disabled={busy || editor.conflict || !editor.reason.trim()}>{busy ? "正在保存…" : editor.revisionKind === "retract" ? "确认撤回" : "保存纠正"}</button><button type="button" className={buttonClass} disabled={busy} onClick={() => setEditor(null)}>取消</button></div>
    </form> : null}
    {message ? <p role="status" className="text-sm leading-6 text-zinc-500">{message}</p> : null}
    {busy && !editor ? <p role="status" className="text-sm text-zinc-500">正在读取记录…</p> : null}
  </article>;
}
