"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { StudyConversationContext } from "../assistant/study-conversation-context";
import { createEditorApi } from "../editor/editor-api";
import { ui } from "../design/ui";
import { associateStudyNote, readStudyNote, saveStudyNote, subscribeStudyNote, type StudyNoteDraft } from "./study-note-draft";

const scope = "selected-lesson-text";

/** Mounted by selection identity: a late receipt can only update its original selection. */
export function SelectionNoteSave({ context }: { context: StudyConversationContext }) {
  const captured = useRef({ ...context }).current;
  const api = useMemo(() => createEditorApi(), []);
  const [note, setNote] = useState<StudyNoteDraft | null>(null);
  const [attempted, setAttempted] = useState(false);
  useEffect(() => {
    const update = () => setNote(readStudyNote(captured, scope));
    const unsubscribe = subscribeStudyNote(captured, update, scope);
    update();
    return unsubscribe;
  }, [captured]);
  function save() {
    const current = readStudyNote(captured, scope);
    if (current.status !== "editing") return;
    setAttempted(true);
    void saveStudyNote(captured, { ...current, text: captured.fragment ?? "" }, api, associateStudyNote, scope);
  }
  return <div className="space-y-1">
    <button type="button" aria-label="保存选中文字" className={ui.quiet} disabled={note?.status !== "editing"}
      onPointerDown={event => event.preventDefault()} onClick={save}>{note?.status === "pending" ? "保存中…" : note?.status === "saved" ? "已存为笔记" : "保存"}</button>
    {note?.status === "unknown" || note?.status === "unavailable" ? <p role="alert" className="px-2 text-xs leading-5 text-warn">保存结果尚未确认，选中文字仍保留。请先核对笔记列表，避免重复保存。</p> : null}
    {note?.status === "saved" && note.associationFailed ? <p role="status" className="px-2 text-xs leading-5 text-warn">笔记已保存，课程关联未确认；文中的学习链接仍保留。</p> : null}
    {attempted && note?.status === "editing" ? <p role="alert" className="px-2 text-xs leading-5 text-danger">笔记尚未保存，选中文字仍保留。{note.storageError ? "请释放浏览器存储空间后重试。" : "请重试。"}</p> : null}
  </div>;
}
