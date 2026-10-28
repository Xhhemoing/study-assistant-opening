"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { studyContextAnchorSchema, studyNoteCreateSchema } from "@aistudy/contracts";
import { getVerifiedSessionNamespace } from "../../auth/session-identity";
import type { StudyConversationContext } from "../assistant/study-conversation-context";
import { studyConversationIdentity } from "../assistant/study-conversation-context";
import { createLearningAssetLinkClient, LearningAssetLinkRequestError, type LearningAssetLinkClient } from "./learning-asset-link-client";
import { LearningLinkTargetForm, type LearningLinkTarget } from "./learning-link-target-form";
import { AssetLearningLinks } from "./asset-learning-links";
import { ui } from "../design/ui";
import { userFacingMessage } from "../../../lib/user-facing-error";
const targetSchema = z.object({ courseId: studyNoteCreateSchema.shape.courseId, goalId: studyNoteCreateSchema.shape.goalId, requirementId: studyNoteCreateSchema.shape.requirementId, expectedGoalRevision: studyNoteCreateSchema.shape.expectedGoalRevision, expectedRequirementRevision: studyNoteCreateSchema.shape.expectedRequirementRevision });
const draftSchema = z.object({ title: z.string().max(200), text: z.string().max(20000), purpose: z.enum(["reference", "understanding", "error_reason", "exploration"]), target: targetSchema.optional(), request: studyNoteCreateSchema.nullable(), documentId: z.string().uuid().nullable() });
type Draft = z.infer<typeof draftSchema>;
function noteTarget(value: LearningLinkTarget): LearningLinkTarget { const { courseId, goalId, requirementId, expectedGoalRevision, expectedRequirementRevision } = value; return { courseId, goalId, requirementId, expectedGoalRevision, expectedRequirementRevision }; }
export function studyNoteOrigin(context: StudyConversationContext) {
  if (!context.activityId && !context.sourceId && !context.attemptId) return null;
  return studyContextAnchorSchema.parse({ purpose: context.purpose ?? (context.sourceId ? "material_read" : "learning_help"), ...Object.fromEntries(Object.entries(context).filter(([key, value]) => ["courseId", "activityId", "blockId", "contentVersion", "attemptId", "itemVersionId", "sourceId", "sourceVersion", "chunkId", "page", "kcMappingVersion"].includes(key) && value !== undefined && !(key === "contentVersion" && value === 0))) });
}
export function StudyNoteComposer(props: { context: StudyConversationContext; client?: LearningAssetLinkClient; initialTitle?: string; initialText?: string }) { return <NoteComposer key={studyConversationIdentity(props.context)} {...props} />; }
function NoteComposer({ context, client: suppliedClient, initialTitle, initialText }: { context: StudyConversationContext; client?: LearningAssetLinkClient; initialTitle?: string; initialText?: string }) {
  const client = useMemo(() => suppliedClient ?? createLearningAssetLinkClient(), [suppliedClient]);
  const [namespace] = useState(getVerifiedSessionNamespace), key = `aistudy:atomic-study-note:${namespace}:${studyConversationIdentity(context)}`;
  const [restoreProblem] = useState(() => { if (!namespace) return ""; try { const raw = sessionStorage.getItem(key); return raw && !draftSchema.safeParse(JSON.parse(raw)).success ? "原保存信息无法读取，未发送新笔记；请保留内容并核对笔记列表。" : ""; } catch { return "原保存信息无法读取，未发送新笔记；请先恢复浏览器存储。"; } });
  const [error, setError] = useState(""), [storageError, setStorageError] = useState(false), [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => { try { if (namespace) { const raw = sessionStorage.getItem(key); if (raw) return draftSchema.parse(JSON.parse(raw)); } } catch { /* A malformed request is handled as unavailable below, never a fresh save. */ } return { title: initialTitle ?? `${context.label ?? "探索"} · 笔记`.slice(0, 200), text: (initialText ?? context.fragment ?? "").slice(0, 20000), purpose: "understanding", request: null, documentId: null }; });
  const target = draft.request ? noteTarget(draft.request) : draft.target ?? { courseId: context.courseId ?? null, goalId: null, requirementId: null };
  const active = useRef(true), writing = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  function owned() { return namespace !== null && namespace === getVerifiedSessionNamespace(); }
  function persist(next: Draft) { if (!owned()) return false; try { sessionStorage.setItem(key, JSON.stringify(next)); return true; } catch { return false; } }
  function edit(patch: Partial<Draft>) { if (draft.request || draft.documentId) return; const next = { ...draft, ...patch }; setDraft(next); setStorageError(!persist(next)); setError(""); }
  async function save() {
    if (writing.current || draft.documentId || restoreProblem) return;
    const retryingUnknown = draft.request !== null;
    const parsed = studyNoteCreateSchema.safeParse(draft.request ?? { clientKey: `study-note:${crypto.randomUUID()}`, title: draft.title, text: draft.text, purpose: draft.purpose, ...target, origin: studyNoteOrigin(context) });
    if (!parsed.success) { setError("请填写标题和自己的理解，并核对关联目标与原位置。"); return; }
    const captured = { ...draft, target: noteTarget(parsed.data), request: parsed.data };
    if (!persist(captured)) { setStorageError(true); setError("无法保留这次保存的信息，尚未提交。请复制内容并恢复浏览器存储后重试。"); return; }
    writing.current = true; setBusy(true); setDraft(captured); setError("");
    try { const result = await client.note(parsed.data); const saved = { ...captured, request: null, documentId: result.documentId }; persist(saved); if (active.current && owned()) setDraft(saved); }
    catch (reason) { if (active.current && owned()) { if (!retryingUnknown && reason instanceof LearningAssetLinkRequestError && reason.status >= 400 && reason.status < 500 && reason.status !== 408) { const rejected = { ...captured, request: null }; persist(rejected); setDraft(rejected); } setError(userFacingMessage(reason, "保存结果待确认，请原样重新确认这次笔记保存。")); } }
    finally { writing.current = false; if (active.current) setBusy(false); }
  }
  const locked = busy || Boolean(draft.request) || Boolean(draft.documentId) || Boolean(restoreProblem);
  return <section className="space-y-3" aria-label="理解与错因笔记"><p className="text-xs leading-6 text-text-3">写下理解或错因，复用原资产与出处。关联是个人整理，不作为学习成绩，不会新建学习活动。</p>
    <fieldset className="space-y-3" disabled={locked}><label className="block space-y-1"><span className={ui.label}>笔记标题</span><input className={ui.input} maxLength={200} value={draft.title} onChange={event => edit({ title: event.target.value })} /></label><label className="block space-y-1"><span className={ui.label}>记录类型</span><select className={ui.input} value={draft.purpose} onChange={event => edit({ purpose: event.target.value as Draft["purpose"] })}><option value="understanding">自己的理解</option><option value="error_reason">错因与待核对处</option><option value="exploration">自由探索</option><option value="reference">参考记录</option></select></label><label className="block space-y-1"><span className={ui.label}>笔记内容</span><textarea className={`${ui.input} min-h-40`} rows={7} maxLength={20000} value={draft.text} onChange={event => edit({ text: event.target.value })} /></label><LearningLinkTargetForm value={target} onChange={value => edit({ target: value })} disabled={locked} /></fieldset>
    {!draft.documentId ? <button className={ui.primary} type="button" disabled={busy || Boolean(restoreProblem) || !draft.title.trim() || !draft.text.trim()} onClick={() => void save()}>{busy ? "保存中…" : draft.request ? "重新确认这次笔记保存" : "保存理解与关联"}</button> : <div className="space-y-3"><p role="status" className="text-sm text-accent">笔记已保存，出处与关联一并保留。</p><a className={ui.secondary} href={`/opening/library/${draft.documentId}`}>打开笔记</a><AssetLearningLinks assetType="document" assetId={draft.documentId} /><button className={ui.quiet} type="button" onClick={() => { const next = { ...draft, text: "", request: null, documentId: null }; if (persist(next)) setDraft(next); else setStorageError(true); }}>另记一篇</button></div>}
    {restoreProblem ? <p className="text-xs text-warn" role="alert">{restoreProblem}</p> : null}
    {draft.request ? <p role="status" className="text-xs text-warn">保存结果待确认。正文、出处和关联内容已保留，重新确认会找回同一篇笔记。</p> : null}{storageError ? <p className="text-xs text-warn">浏览器暂时无法保留草稿和待确认的保存信息，请先复制文字；恢复存储前不会再次保存。</p> : null}{error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}
  </section>;
}
