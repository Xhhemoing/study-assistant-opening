import { z } from "zod";
import { getVerifiedSessionNamespace } from "../../auth/session-identity";
import type { EditorApi } from "../../editor/editor-api";
import type { StudyConversationContext } from "../assistant/study-conversation-context";
import { readStudyNote, saveStudyNote, studyNoteDocument, writeStudyNote, type StudyNoteDraft } from "./study-note-draft";

export function selfExplanationScope(): string | null {
  const namespace = getVerifiedSessionNamespace();
  return namespace ? `self-explanation:${namespace}` : null;
}
const ownsScope = (scope: string | null) => Boolean(scope && scope === selfExplanationScope());
const unavailable = (): SelfExplanationDraft => ({ note: { title: "我的理解", text: "", status: "unavailable", documentId: null, associationFailed: false, storageError: false }, record: null });
export const selfExplanationFits = (record: SelfExplanation) => schema.safeParse(record).success && JSON.stringify(record).length <= 20_000;
const schema = z.object({ original: z.string().max(9000), revision: z.string().max(9000), frozen: z.boolean() }).strict();
export type SelfExplanation = z.infer<typeof schema>;
export type SelfExplanationDraft = { note: StudyNoteDraft; record: SelfExplanation | null };
const empty = (): SelfExplanation => ({ original: "", revision: "", frozen: false });
// A material fragment is context, never the user's own explanation.
const ownContext = (context: StudyConversationContext) => ({ ...context, fragment: undefined });

export function readSelfExplanation(context: StudyConversationContext, scope = selfExplanationScope()): SelfExplanationDraft {
  if (!ownsScope(scope)) return unavailable();
  const note = readStudyNote(ownContext(context), scope!);
  if (!note.text && note.status === "editing") return { note, record: empty() };
  const parsed = schema.safeParse((() => { try { return JSON.parse(note.text); } catch { return null; } })());
  return { note, record: parsed.success ? parsed.data : null };
}

export function editSelfExplanation(context: StudyConversationContext, update: Partial<Pick<SelfExplanation, "original" | "revision">>, scope = selfExplanationScope()): boolean {
  const { note, record } = readSelfExplanation(context, scope);
  if (!record || note.status !== "editing") return false;
  const next = { ...record, ...update, original: record.frozen ? record.original : update.original ?? record.original };
  if (!selfExplanationFits(next)) return false;
  const encoded = JSON.stringify(next);
  return writeStudyNote(ownContext(context), { ...note, text: encoded }, scope!);
}

export function freezeSelfExplanation(context: StudyConversationContext, scope = selfExplanationScope()): boolean {
  const { note, record } = readSelfExplanation(context, scope);
  if (!record || note.status !== "editing" || !record.original.trim()) return false;
  return writeStudyNote(ownContext(context), { ...note, text: JSON.stringify({ ...record, frozen: true }) }, scope!);
}

/** Explicit new intent only; an unconfirmed create may never be discarded/retried. */
export function startSelfExplanation(context: StudyConversationContext, scope = selfExplanationScope()): boolean {
  const { note, record } = readSelfExplanation(context, scope);
  if (!record || !["editing", "saved"].includes(note.status)) return false;
  return writeStudyNote(ownContext(context), { title: `${context.label || "学习"} · 我的理解`.slice(0, 200), text: JSON.stringify(empty()), status: "editing", documentId: null, associationFailed: false, storageError: false }, scope!);
}

export function selfExplanationQuestion(record: SelfExplanation): string {
  return `请帮我检查这段理解。请指出需要澄清的概念、条件和推理，不评分，也不判断掌握程度。\n\n我的原话：\n${record.original}${record.revision.trim() ? `\n\n我的修订（可能参考了对话，不是独立作答）：\n${record.revision}` : ""}`;
}

export function saveSelfExplanation(context: StudyConversationContext, api: Pick<EditorApi, "createDocument">, associate: (courseId: string, documentId: string) => Promise<void>, scope = selfExplanationScope()) {
  const { note, record } = readSelfExplanation(context, scope);
  if (!record?.frozen || !record.original.trim() || !selfExplanationFits(record)) return Promise.resolve(note);
  // Reuse the existing create receipt and real source/return links, but keep user
  // original/revision in separate labelled blocks. No assistant snippet/provenance.
  const adapter = { createDocument: () => {
    const document = studyNoteDocument(context, { title: `${context.label || "学习"} · 我的理解`.slice(0, 200), text: "用户理解记录（非评分；AI 反馈仅在原对话中）" });
    const block = (text: string) => studyNoteDocument(context, { title: "", text }).blocks[0]!;
    document.blocks.splice(1, 0, block("用户原话"), block(record.original));
    if (record.revision.trim()) document.blocks.splice(3, 0, block("用户修订（可能参考对话，不作为独立作答）"), block(record.revision));
    return api.createDocument(document);
  } };
  return saveStudyNote(ownContext(context), note, adapter, async (courseId, documentId) => {
    if (!ownsScope(scope)) throw new Error("账号已切换，课程关联未确认");
    await associate(courseId, documentId);
  }, scope!);
}
