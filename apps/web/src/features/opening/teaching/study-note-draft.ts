import { z } from "zod";
import { createBlockId } from "../../editor/local-draft";
import { EditorApiError, type CreateDocumentInput, type EditorApi } from "../../editor/editor-api";
import { sourceViewerHref } from "../inbox/source-viewer";
import { studyContextReturnHref, studyConversationIdentity, type StudyConversationContext } from "../assistant/study-conversation-context";

const noteSchema = z.object({
  title: z.string().max(200), text: z.string().max(20_000),
  status: z.enum(["editing", "pending", "saved", "unknown", "unavailable"]),
  documentId: z.string().uuid().nullable(), associationFailed: z.boolean(),
  storageError: z.boolean().default(false),
}).strict();
export type StudyNoteDraft = z.infer<typeof noteSchema>;
const memory = new Map<string, StudyNoteDraft>();
const flights = new Map<string, Promise<StudyNoteDraft>>();
const storageKey = (context: StudyConversationContext) => `aistudy.study-note.v1:${studyConversationIdentity(context)}`;

export function readStudyNote(context: StudyConversationContext): StudyNoteDraft {
  const key = storageKey(context);
  const cached = memory.get(key);
  if (cached) return cached;
  try {
    const raw = sessionStorage.getItem(key);
    if (raw) {
      let saved: StudyNoteDraft;
      try { saved = noteSchema.parse(JSON.parse(raw)); }
      catch {
        // An unreadable write receipt must not become permission to create again.
        const unavailable: StudyNoteDraft = { title: "待核实的笔记草稿", text: raw.slice(0, 20_000), status: "unavailable", documentId: null, associationFailed: false, storageError: true };
        memory.set(key, unavailable);
        return unavailable;
      }
      if (saved.status === "pending" && !flights.has(key)) saved.status = "unknown";
      memory.set(key, saved);
      return saved;
    }
  } catch {
    const unavailable: StudyNoteDraft = { title: "待核实的笔记草稿", text: "", status: "unavailable", documentId: null, associationFailed: false, storageError: true };
    memory.set(key, unavailable);
    return unavailable;
  }
  const draft: StudyNoteDraft = { title: `${context.label || "学习"} · 笔记`.slice(0, 200), text: context.fragment || "", status: "editing", documentId: null, associationFailed: false, storageError: false };
  memory.set(key, draft);
  return draft;
}

/** Memory stays newest after a storage failure; a stale disk value cannot replace it. */
export function writeStudyNote(context: StudyConversationContext, draft: StudyNoteDraft): boolean {
  const key = storageKey(context);
  memory.set(key, draft);
  try { sessionStorage.setItem(key, JSON.stringify(draft)); return true; }
  catch { return false; }
}

export function studyNoteDocument(context: StudyConversationContext, draft: Pick<StudyNoteDraft, "title" | "text">): CreateDocumentInput {
  const paragraph = (content: unknown) => ({ id: createBlockId(), type: "paragraph", content: { blockNoteContent: content, props: null, children: [] } });
  const links: Array<{ text: string; href: string }> = [];
  if (context.sourceId && context.sourceVersion !== undefined) links.push({
    text: `${context.label || "原材料"} · v${context.sourceVersion}${context.page ? ` · 指定第 ${context.page} 页` : ""}`,
    href: sourceViewerHref(context.sourceId, context.sourceVersion, { page: context.page }),
  });
  const returnHref = studyContextReturnHref({ ...context, sourceId: undefined, sourceVersion: undefined, page: undefined });
  if (returnHref) links.push({ text: "返回学习内容", href: returnHref });
  return { title: draft.title.trim(), blocks: [paragraph(draft.text), ...links.map(link => paragraph([
    { type: "link", href: link.href, content: [{ type: "text", text: link.text, styles: {} }] },
  ]))] };
}

/** One explicit create. An unknown response locks this draft across remounts. */
export function saveStudyNote(context: StudyConversationContext, draft: StudyNoteDraft, api: Pick<EditorApi, "createDocument">, associate: (courseId: string, documentId: string) => Promise<void>): Promise<StudyNoteDraft> {
  const key = storageKey(context);
  const pending = flights.get(key);
  if (pending) return pending;
  const current = readStudyNote(context);
  if (current.status !== "editing") return Promise.resolve(current);
  const captured: StudyNoteDraft = { ...draft, status: "pending", storageError: false };
  if (!writeStudyNote(context, captured)) {
    const unsent: StudyNoteDraft = { ...draft, status: "editing", storageError: true };
    memory.set(key, unsent);
    return Promise.resolve(unsent);
  }
  const flight = (async () => {
    let result: StudyNoteDraft;
    try {
      const document = await api.createDocument(studyNoteDocument(context, captured));
      const documentId = z.string().uuid().parse(document.id);
      result = { ...captured, status: "saved", documentId };
      writeStudyNote(context, result);
      if (context.courseId) {
        try { await associate(context.courseId, documentId); }
        catch { result = { ...result, associationFailed: true }; }
      }
    } catch (error) {
      result = { ...captured, status: error instanceof EditorApiError && error.status >= 400 && error.status < 500 && error.status !== 408 ? "editing" : "unknown" };
    }
    writeStudyNote(context, result);
    return result;
  })().finally(() => flights.delete(key));
  flights.set(key, flight);
  return flight;
}

export async function associateStudyNote(courseId: string, documentId: string): Promise<void> {
  const response = await fetch(`/api/courses/${encodeURIComponent(courseId)}/memberships`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ assetType: "document", assetId: documentId, role: "reference", visibility: "private" }),
  });
  if (!response.ok) throw new Error("笔记已保存，课程关联未确认。");
}
