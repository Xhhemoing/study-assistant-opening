"use client";

import Link from "next/link";
import { useEffect, useId, useMemo, useState } from "react";
import { createEditorApi } from "../../editor/editor-api";
import { libraryNotePath } from "../../editor/library-paths";
import type { StudyConversationContext } from "../assistant/study-conversation-context";
import { textareaClass, ui } from "../design/ui";
import { associateStudyNote, subscribeStudyNote } from "./study-note-draft";
import { editSelfExplanation, freezeSelfExplanation, readSelfExplanation, saveSelfExplanation, selfExplanationQuestion, selfExplanationScope, selfExplanationFits, startSelfExplanation, type SelfExplanation, type SelfExplanationDraft } from "./self-explanation-draft";

export function SelfExplanationPanel({ context, canAsk, blockedReason, onCheck }: {
  context: StudyConversationContext; canAsk: boolean; blockedReason?: string; onCheck: (text: string) => void;
}) {
  const scope = selfExplanationScope();
  const [overflow, setOverflow] = useState<{ scope: string | null; context: StudyConversationContext; record: SelfExplanation } | null>(null);
  const [draft, setDraft] = useState<SelfExplanationDraft | null>(null);
  const [warning, setWarning] = useState(false);
  const [confirmNew, setConfirmNew] = useState(false);
  const api = useMemo(() => createEditorApi(), []);
  const id = useId();
  useEffect(() => {
    setOverflow(null); setWarning(false); setConfirmNew(false);
    const update = () => setDraft(readSelfExplanation(context, scope));
    const unsubscribe = scope ? subscribeStudyNote({ ...context, fragment: undefined }, update, scope) : () => {};
    update(); return unsubscribe;
  }, [context, scope]);
  const local = overflow?.scope === scope && overflow.context === context ? overflow.record : null;
  const record = scope ? local ?? draft?.record : null;
  const tooLarge = Boolean(local && !selfExplanationFits(local));
  const editing = draft?.note.status === "editing" && Boolean(record);
  const refresh = (stored: boolean) => { setWarning(!stored); setDraft(readSelfExplanation(context, scope)); };
  const edit = (update: Partial<Pick<SelfExplanation, "original" | "revision">>) => {
    if (!record || !scope || scope !== selfExplanationScope()) return;
    const next = { ...record, ...update, original: record.frozen ? record.original : update.original ?? record.original };
    if (!selfExplanationFits(next)) { setOverflow({ scope, context, record: next }); return; }
    setOverflow(null); refresh(editSelfExplanation(context, update, scope));
  };
  return <div className="space-y-3">
    {!scope ? <p role="alert">尚未验证登录身份，不能读取、编辑或保存理解草稿。请重新登录后继续。</p> : null}
    {tooLarge ? <p role="alert">内容转义后超过草稿容量上限，尚未保存本次输入；当前输入完整保留，可复制后缩短。不会截断或保存旧版本。</p> : null}
    <p className="text-xs leading-6 text-text-2">先用自己的话解释，再按需修订。这是非评分记录，不判断掌握程度。AI 反馈只在原对话展示，不会自动写入这里。</p>
    <label htmlFor={`${id}-original`} className="block space-y-1 text-xs text-text-2"><span>我的原话{record?.frozen ? "（已冻结）" : ""}</span><textarea id={`${id}-original`} className={`${textareaClass} min-h-32`} value={record?.original ?? ""} maxLength={9000} readOnly={!editing || record?.frozen} onChange={event => edit({ original: event.target.value })} /></label>
    {editing && !record?.frozen ? <button type="button" className={ui.secondary} disabled={tooLarge || !record?.original.trim()} onClick={() => refresh(freezeSelfExplanation(context, scope))}>确认原话并冻结</button> : null}
    <label htmlFor={`${id}-revision`} className="block space-y-1 text-xs text-text-2"><span>我的修订（可选；可能参考对话，不作为独立作答）</span><textarea id={`${id}-revision`} className={`${textareaClass} min-h-32`} value={record?.revision ?? ""} maxLength={9000} readOnly={!editing || !record?.frozen} onChange={event => edit({ revision: event.target.value })} /></label>
    <div className="flex flex-wrap gap-2">
      <button type="button" className={ui.secondary} disabled={!scope || !record?.frozen || !canAsk} onClick={() => { if (scope && scope === selfExplanationScope() && record?.frozen && canAsk) onCheck(selfExplanationQuestion(record)); }}>请帮我检查这段理解</button>
      <button type="button" className={ui.primary} disabled={tooLarge || !editing || !record?.frozen} onClick={() => void saveSelfExplanation(context, api, associateStudyNote, scope)}>保存为用户笔记</button>
    </div>
    <p className="text-xs leading-6 text-text-3">检查只会预填当前对话输入框，需要你核对后手动发送。保存只包含用户原话、修订及当前学习/原文链接，不包含 AI 反馈。</p>
    {!canAsk ? <p className="text-xs leading-6 text-warn">{blockedReason || "先保存题目的原答案，再请求检查；仍可先记录自己的理解。"}</p> : null}
    {draft?.note.status === "pending" ? <p role="status">正在保存，请保留原稿…</p> : null}
    {draft?.note.status === "unknown" ? <p role="alert">保存结果未知，可能已经保存。原稿已保留，请先检查笔记列表；不会自动重试，也不能开始新记录。</p> : null}
    {draft?.note.status === "unavailable" || (draft && !record) ? <div role="alert"><p>原稿或保存回执无法读取，已暂停编辑与新建，请检查笔记列表。可复制下方保留的内容。</p><textarea aria-label="保留的原稿" className={textareaClass} readOnly value={draft.note.text} /></div> : null}
    {draft?.note.storageError || warning ? <p role="alert">浏览器未能保留草稿或请求回执，或内容已达到记录容量上限；请先复制原稿。请求回执保存失败时不会发送保存请求。</p> : null}
    {draft?.note.status === "saved" && draft.note.documentId ? <div role="status"><p>{draft.note.associationFailed ? "用户笔记已保存，课程关联未确认；原文链接仍保留。" : "用户笔记已保存。"}</p><Link className={ui.secondary} href={libraryNotePath("/opening/library", draft.note.documentId)}>打开笔记</Link></div> : null}
    {record && (editing || draft?.note.status === "saved") ? <div className="space-y-2"><button type="button" className={ui.quiet} onClick={() => setConfirmNew(true)}>开始新记录</button>{confirmNew ? <div><p className="text-xs text-warn">开始新记录会清空此处原话与修订，未保存内容请先复制或保存。</p><button type="button" className={ui.secondary} onClick={() => { if (startSelfExplanation(context, scope)) setOverflow(null); refresh(true); setConfirmNew(false); }}>确认开始新记录</button><button type="button" className={ui.quiet} onClick={() => setConfirmNew(false)}>取消</button></div> : null}</div> : null}
    <Link className={ui.quiet} href="/opening/library?tab=notes">查看笔记列表</Link>
  </div>;
}
