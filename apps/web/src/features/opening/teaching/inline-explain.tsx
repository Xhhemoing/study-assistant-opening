"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createEditorApi } from "../../editor/editor-api";
import { studyConversationIdentity, type StudyConversationContext } from "../assistant/study-conversation-context";
import { CreateCardDialog, type StudyCardDraft } from "../cards/create-card-dialog";
import { ui } from "../design/ui";
import { associateStudyNote, readStudyNote, saveStudyNote, subscribeStudyNote, type StudyNoteDraft } from "./study-note-draft";

const scope = "inline-explanation";
export type InlineExplainProps = {
  context: StudyConversationContext;
  content: string;
  heading?: string;
  initiallyCollapsed?: boolean;
  onContinueInChat: () => void;
};

/** Saves the displayed, already delivered explanation through the real note service. */
export function InlineExplain({ context, content, heading = "补充解释", initiallyCollapsed = false, onContinueInChat }: InlineExplainProps) {
  const api = useMemo(() => createEditorApi(), []);
  const binding = useMemo(() => ({ ...context, fragment: content }), [context, content]);
  const identity = studyConversationIdentity(binding);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const [failed, setFailed] = useState(false);
  const [note, setNote] = useState<StudyNoteDraft | null>(null);
  const [card, setCard] = useState<StudyCardDraft | null>(null);
  useEffect(() => {
    const update = () => setNote(readStudyNote(binding, scope));
    const unsubscribe = subscribeStudyNote(binding, update, scope);
    update(); setFailed(false); setCard(null);
    return unsubscribe;
  }, [identity]);
  async function save() {
    setFailed(false);
    const capturedIdentity = identity;
    const current = readStudyNote(binding, scope);
    const draft = current.status === "editing" ? { ...current, text: content } : current;
    const request = saveStudyNote(binding, draft, api, associateStudyNote, scope);
    setNote(readStudyNote(binding, scope));
    const result = await request;
    if (currentIdentity.current === capturedIdentity) { setNote(result); setFailed(result.status === "editing"); }
    return result;
  }
  function makeCard() {
    setCard({ identity, courseId: context.courseId, front: `如何理解${context.label || "这段讲解"}？`, back: content,
      sourceLabel: `${context.label || "当前讲解"}${typeof context.sourceVersion === "number" ? ` · v${context.sourceVersion}` : ""}${context.page ? ` · 第 ${context.page} 页` : ""}`,
      createSource: async () => {
        const result = await save();
        if (result.status !== "saved" || !result.documentId) throw new Error(result.status === "editing" ? "来源笔记保存失败，内容已保留，请重试。" : "来源笔记的保存结果尚未确认，请检查笔记列表后继续。草稿内容已保留。");
        return result.documentId;
      },
    });
  }
  const locked = note?.status === "pending" || note?.status === "saved" || note?.status === "unknown" || note?.status === "unavailable";
  if (!content.trim()) return null;
  return <details open={!initiallyCollapsed} className="rounded-md bg-surface-2 px-4 py-3" data-anchor={context.blockId}>
    <summary className="min-h-8 cursor-pointer text-sm font-medium text-text-2">{heading}</summary>
    <p className="prose-reading mt-2 whitespace-pre-wrap break-words text-text">{content}</p>
    <div className="mt-2 flex flex-wrap gap-1">
      <button type="button" className={ui.quiet} disabled={locked} onClick={() => void save()}>{note?.status === "pending" ? "保存中…" : note?.status === "saved" ? "已存为笔记" : failed ? "保存失败，重试" : "保存"}</button>
      <button type="button" className={ui.quiet} onClick={makeCard}>制成卡片</button>
      <button type="button" className={ui.quiet} onClick={onContinueInChat}>继续问</button>
    </div>
    {failed ? <p role="alert" className="text-xs text-danger">保存失败，内容仍保留。{note?.storageError ? "请释放浏览器存储空间后重试。" : "请重试。"}</p> : null}
    {note?.status === "unknown" || note?.status === "unavailable" ? <p role="alert" className="text-xs text-warn">笔记保存结果尚未确认，内容仍保留。请先核对笔记列表，避免重复保存。</p> : null}
    {note?.status === "saved" ? <p role="status" className="sr-only">已存为笔记{note.associationFailed ? "，课程关联未确认" : ""}</p> : null}
    {card ? <CreateCardDialog studyDraft={card} onClose={() => setCard(null)} /> : null}
  </details>;
}
