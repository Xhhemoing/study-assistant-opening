import { z } from "zod";
import { createBlockId } from "../editor/local-draft";
import { EditorApiError, type CreateDocumentInput, type EditorApi } from "../editor/editor-api";
import { sourceViewerHref } from "../inbox/source-viewer";
import { legacyStudyConversationIdentity, studyContextReturnHref, studyConversationIdentity, type StudyConversationContext } from "../assistant/study-conversation-context";

const noteSchema = z.object({
  title: z.string().max(200), text: z.string().max(20_000),
  status: z.enum(["editing", "pending", "saved", "unknown", "unavailable"]),
  documentId: z.string().uuid().nullable(), associationFailed: z.boolean(),
  storageError: z.boolean().default(false),
}).strict();
export type StudyNoteDraft = z.infer<typeof noteSchema>;
const memory = new Map<string, StudyNoteDraft>();
const flights = new Map<string, Promise<StudyNoteDraft>>();
const listeners = new Map<string, Set<() => void>>();
const publish = (key: string) => listeners.get(key)?.forEach(listener => listener());
const storageKey = (context: StudyConversationContext, scope?: string) => `aistudy.study-note.v1:${scope ? `${scope}:` : ""}${studyConversationIdentity(context)}`;

/** The new atomic saver must not replay or overwrite a pre-existing legacy create. */
export function hasExistingStudyNote(context: StudyConversationContext): boolean {
  const key = storageKey(context);
  if (memory.has(key)) return true;
  try { return sessionStorage.getItem(key) !== null; } catch { return false; }
}

export function subscribeStudyNote(context: StudyConversationContext, listener: () => void, scope?: string) {
  const key = storageKey(context, scope);
  const entries = listeners.get(key) ?? new Set<() => void>();
  entries.add(listener); listeners.set(key, entries);
  return () => { entries.delete(listener); if (!entries.size) listeners.delete(key); };
}

export function readStudyNote(context: StudyConversationContext, scope?: string): StudyNoteDraft {
  const key = storageKey(context, scope);
  const cached = memory.get(key);
  if (cached) return cached;
  try {
    let raw = sessionStorage.getItem(key);
    if (!scope && !raw && context.activityId && context.blockId && (context.attemptId || context.itemVersionId || context.kcMappingVersion !== undefined)) {
      const legacyKey = `aistudy.study-note.v1:${legacyStudyConversationIdentity(context)}`;
      const previous = memory.get(legacyKey);
      if (previous) {
        const flight = flights.get(legacyKey);
        const migrated = previous.status === "pending" && !flight ? { ...previous, status: "unknown" as const } : previous;
        memory.set(key, migrated);
        if (flight) {
          flights.set(key, flight);
          void flight.then(result => { writeStudyNote(context, result, scope); }).finally(() => flights.delete(key));
        }
        return migrated;
      }
      raw = sessionStorage.getItem(legacyKey);
      if (raw) sessionStorage.setItem(key, raw);
    }
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
export function writeStudyNote(context: StudyConversationContext, draft: StudyNoteDraft, scope?: string): boolean {
  const key = storageKey(context, scope);
  memory.set(key, draft); publish(key);
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
export function saveStudyNote(context: StudyConversationContext, draft: StudyNoteDraft, api: Pick<EditorApi, "createDocument">, associate: (courseId: string, documentId: string) => Promise<void>, scope?: string): Promise<StudyNoteDraft> {
  const key = storageKey(context, scope);
  const pending = flights.get(key);
  if (pending) return pending;
  const current = readStudyNote(context, scope);
  if (current.status !== "editing" || !draft.title.trim() || !draft.text.trim()) return Promise.resolve(current);
  const captured: StudyNoteDraft = { ...draft, status: "pending", storageError: false };
  if (!writeStudyNote(context, captured, scope)) {
    const unsent: StudyNoteDraft = { ...draft, status: "editing", storageError: true };
    memory.set(key, unsent); publish(key);
    return Promise.resolve(unsent);
  }
  const flight = (async () => {
    let result: StudyNoteDraft;
    try {
      const document = await api.createDocument(studyNoteDocument(context, captured));
      const documentId = z.string().uuid().parse(document.id);
      result = { ...captured, status: "saved", documentId, associationFailed: Boolean(context.courseId) };
      writeStudyNote(context, result, scope);
      if (context.courseId) {
        try { await associate(context.courseId, documentId); result = { ...result, associationFailed: false }; }
        catch { /* Keep the saved document and report its unconfirmed association. */ }
      }
    } catch (error) {
      result = { ...captured, status: error instanceof EditorApiError && error.status >= 400 && error.status < 500 && error.status !== 408 ? "editing" : "unknown" };
    }
    // An explicit “another note” after document creation is a new intent. A late
    // membership response must not replace that newer editable draft.
    if (result.status !== "saved" || readStudyNote(context, scope).documentId === result.documentId) writeStudyNote(context, result, scope);
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
  if (response.ok || await isDuplicateMembership(response)) return;
  throw new Error("笔记已保存，课程关联未确认。");
}

/** A 409 for an association that already exists means the note is already linked (已关联). */
async function isDuplicateMembership(response: Response): Promise<boolean> {
  if (response.status !== 409) return false;
  try {
    const body: unknown = await response.json();
    const error = body && typeof body === "object" ? (body as { error?: { businessCode?: unknown } }).error : undefined;
    return error?.businessCode === "DUPLICATE_MEMBERSHIP";
  } catch { return false; }
}
