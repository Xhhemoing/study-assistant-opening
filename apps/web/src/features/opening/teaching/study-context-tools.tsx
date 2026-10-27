"use client";

import { TransitionLink as Link } from "../v3/motion/view-transition";
import { useEffect, useId, useMemo, useState } from "react";
import type { LearningAttempt } from "@aistudy/contracts";
import { createEditorApi } from "../editor/editor-api";
import { libraryNotePath } from "../editor/library-paths";
import { AssistantView } from "../assistant/assistant-view";
import { studyConversationIdentity, type StudyConversationContext } from "../assistant/study-conversation-context";
import { textareaClass, ui } from "../design/ui";
import { useDiagnosticsEnabled } from "../settings/appearance-preferences";
import { associateStudyNote, hasExistingStudyNote, readStudyNote, saveStudyNote, subscribeStudyNote, writeStudyNote, type StudyNoteDraft } from "./study-note-draft";
import { StudyNoteComposer } from "../learning-links/study-note-composer";
import { AssetLearningLinks } from "../learning-links/asset-learning-links";

/** The prompt's tutor must use its real attempt, so delivered help stays in the evidence chain. */
export function StudyContextTools({ context, isQuestion = false, learningAttempt = null, initialQuestion = "", questionBlockedReason, section, askRequest }: {
  context: StudyConversationContext;
  isQuestion?: boolean;
  learningAttempt?: LearningAttempt | null;
  initialQuestion?: string;
  questionBlockedReason?: string;
  section?: "chat" | "notes";
  askRequest?: { id: string; text: string };
}) {
  const diagnostics = useDiagnosticsEnabled();
  const [tab, setTab] = useState<"question" | "note">("question");
  const [questionVisited, setQuestionVisited] = useState(Boolean(initialQuestion));
  const visibleTab = section ? section === "notes" ? "note" : "question" : tab;
  const identity = studyConversationIdentity(context);
  const canAsk = !questionBlockedReason && (!isQuestion || Boolean(learningAttempt));
  useEffect(() => { if (askRequest && canAsk) setQuestionVisited(true); }, [askRequest?.id, canAsk]);
  return <div className="flex h-full min-h-0 min-w-0 flex-col gap-3">
    <p title={context.label} className="line-clamp-2 shrink-0 break-words text-xs leading-5 text-text-2">围绕：{context.label || "当前内容"}{diagnostics && context.sourceVersion !== undefined ? ` · v${context.sourceVersion}` : ""}{context.page ? ` · 指定第 ${context.page} 页` : ""}</p>
    <div hidden={Boolean(section)} className={section ? "hidden" : "flex flex-wrap gap-2"} aria-label="选择上下文工具">
      <button type="button" className={tab === "question" ? ui.secondary : ui.quiet} aria-pressed={tab === "question"} onClick={() => setTab("question")}>提问</button>
      <button type="button" className={tab === "note" ? ui.secondary : ui.quiet} aria-pressed={tab === "note"} onClick={() => setTab("note")}>记笔记</button>
    </div>
    <div hidden={visibleTab !== "question"} className={visibleTab === "question" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
      {!canAsk ? <p className="text-sm leading-7 text-text-2">{questionBlockedReason || "先在题目下保存自己的原答案，再继续提问。之后的辅导会关联本次作答，并记录实际获得的帮助。"}</p> : <>
        {!questionVisited ? <button type="button" className={ui.secondary} onClick={() => setQuestionVisited(true)}>打开此处提问</button> : null}
        {questionVisited ? <div className="min-h-0 min-w-0 flex-1" key={identity}><AssistantView embedded startFresh studyContext={context}
          initialCourseId={context.courseId} initialSourceIds={learningAttempt?.sourceIds ?? (context.sourceId ? [context.sourceId] : [])}
          initialPage={context.page ?? null} initialDraft={initialQuestion} promptRequest={askRequest} learningAttempt={learningAttempt ?? undefined} /></div> : null}
      </>}
    </div>
    <div hidden={visibleTab !== "note"} className={visibleTab === "note" ? "min-h-0 flex-1 overflow-y-auto" : "hidden"}><StudyNotePanel key={identity} context={context} /></div>
  </div>;
}

export function StudyNotePanel({ context }: { context: StudyConversationContext }) {
  const [legacy, setLegacy] = useState(false), [legacyAvailable, setLegacyAvailable] = useState(false);
  useEffect(() => { setLegacyAvailable(hasExistingStudyNote(context)); }, [context]);
  return <div className="space-y-3">{legacyAvailable ? <div className="space-y-2"><p className="text-xs text-text-3">此前的笔记草稿与未知保存请求仍保留，新入口不会重新发送它。</p><button className={ui.quiet} type="button" onClick={() => setLegacy(value => !value)}>{legacy ? "返回新的理解与关联笔记" : "查看此前笔记草稿或保存结果"}</button></div> : null}{legacy ? <LegacyStudyNotePanel context={context} /> : <StudyNoteComposer context={context} />}</div>;
}

function LegacyStudyNotePanel({ context }: { context: StudyConversationContext }) {
  const [draft, setDraft] = useState<StudyNoteDraft | null>(null);
  const [storageWarning, setStorageWarning] = useState(false);
  const [message, setMessage] = useState("");
  const api = useMemo(() => createEditorApi(), []);
  const id = useId();
  useEffect(() => {
    const update = () => setDraft(readStudyNote(context));
    const unsubscribe = subscribeStudyNote(context, update);
    update(); return unsubscribe;
  }, [context]);
  function edit(update: Partial<Pick<StudyNoteDraft, "title" | "text">>) {
    if (!draft || draft.status !== "editing") return;
    const next = { ...draft, ...update };
    setDraft(next);
    setStorageWarning(!writeStudyNote(context, next));
    setMessage("");
  }
  async function save() {
    if (!draft || !draft.title.trim() || !draft.text.trim() || draft.status !== "editing") return;
    const request = saveStudyNote(context, draft, api, associateStudyNote);
    setDraft(readStudyNote(context));
    const result = await request;
    if (result.status === "editing") setMessage("保存未完成，请核对内容后重试。");
  }
  const locked = !draft || draft.status !== "editing";
  return <div className="space-y-3">
    <p className="text-xs leading-6 text-text-3">写下自己的理解，保存后可从笔记回到本次学习和原文。</p>
    <label htmlFor={`${id}-title`} className="block space-y-1 text-xs text-text-2"><span>标题</span><input id={`${id}-title`} className={ui.input} value={draft?.title ?? ""} maxLength={200} disabled={locked} onChange={event => edit({ title: event.target.value })} /></label>
    <label htmlFor={`${id}-text`} className="block space-y-1 text-xs text-text-2"><span>笔记内容</span><textarea id={`${id}-text`} className={`${textareaClass} min-h-48`} value={draft?.text ?? ""} maxLength={20_000} readOnly={locked} onChange={event => edit({ text: event.target.value })} /></label>
    {draft?.status === "editing" ? <button type="button" className={ui.primary} disabled={!draft.title.trim() || !draft.text.trim()} onClick={() => void save()}>保存为笔记</button> : null}
    {draft?.status === "pending" ? <p role="status" className="text-xs text-text-2">正在保存笔记，请保留此处内容…</p> : null}
    {draft?.status === "unknown" ? <p role="alert" className="text-xs leading-6 text-warn">保存结果尚未确认，可能已经保存。原内容已保留，请先检查笔记列表，避免重复创建。</p> : null}
    {draft?.status === "unavailable" ? <p role="alert" className="text-xs leading-6 text-warn">原笔记或保存结果暂时无法读取，已暂停新建。请允许浏览器存储，或检查笔记列表后重新进入。</p> : null}
    {draft?.storageError && draft.status === "editing" ? <p role="alert" className="text-xs leading-6 text-warn">无法保留本次保存请求，尚未发送。原内容仍可编辑和复制；请释放浏览器存储空间后重试。</p> : null}
    {draft?.status === "saved" && draft.documentId ? <div role="status" className="space-y-2 text-xs leading-6 text-accent"><p>{draft.associationFailed ? "笔记已保存，课程关联未确认；文中的学习与原文链接仍保留。" : "笔记已保存。"}</p><Link className={ui.secondary} href={libraryNotePath("/opening/library", draft.documentId)}>打开笔记继续编辑</Link><button type="button" className={ui.quiet} onClick={() => { const next: StudyNoteDraft = { title: `${context.label || "学习"} · 笔记`.slice(0, 200), text: "", status: "editing", documentId: null, associationFailed: false, storageError: false }; setStorageWarning(!writeStudyNote(context, next)); setDraft(next); }}>另记一篇</button></div> : null}
    {message ? <p role="alert" className="text-xs text-danger">{message}</p> : null}
    {storageWarning ? <p role="status" className="text-xs leading-6 text-warn">此浏览器无法保留未保存的笔记。工具切换期间仍保留内容，刷新前请先复制或保存。</p> : null}
    <Link className={ui.quiet} href={`/opening/library?tab=notes${context.courseId ? `&courseId=${encodeURIComponent(context.courseId)}` : ""}`}>查看笔记列表</Link>
    {draft?.status === "saved" && draft.documentId ? <AssetLearningLinks assetType="document" assetId={draft.documentId} /> : null}
  </div>;
}
