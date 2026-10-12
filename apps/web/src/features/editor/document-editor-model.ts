import type { CreateDocumentInput, EditorDocument, UpdateDocumentInput } from "./editor-api";
import type { EditorRevision } from "./version-history";
import { createBlockId, type LocalDraftBlock, type LocalNoteDraft } from "./local-draft";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function documentToDraft(document: EditorDocument): LocalNoteDraft {
  return {
    version: 1,
    draftId: document.id,
    title: document.title,
    blocks: document.blocks.map((block) => {
      const packed = block.content;
      if (isRecord(packed) && "blockNoteContent" in packed) {
        return {
          id: block.id,
          type: block.type,
          content: packed.blockNoteContent,
          props: isRecord(packed.props) ? packed.props : undefined,
          children: Array.isArray(packed.children)
            ? packed.children as LocalDraftBlock[]
            : undefined,
        };
      }
      // Server-created blocks (e.g. exploration promotion) store plain { text }.
      if (isRecord(packed) && typeof packed.text === "string") {
        return { id: block.id, type: block.type, content: packed.text };
      }
      return { id: block.id, type: block.type, content: packed };
    }),
    updatedAt: document.updatedAt ?? new Date().toISOString(),
    baseRevisionNumber: document.currentRevisionNumber,
  };
}

export type DraftConflict = {
  reason: "stale-base" | "legacy-draft" | "server-conflict";
  /** The user's local work; kept in storage until an explicit resolution. */
  local: LocalNoteDraft;
};

export type DraftRestorePlan = {
  draft: LocalNoteDraft;
  state: "saved" | "unsaved" | "conflict";
  conflict?: DraftConflict;
};

function contentKey(draft: Pick<LocalNoteDraft, "title" | "blocks">): string {
  return JSON.stringify([draft.title, draftToApiBlocks(draft.blocks)]);
}

/**
 * Decide what the editor opens with. Chosen by revision, never by clock:
 * - no draft → server copy (saved)
 * - draft content equals server → server copy (saved)
 * - draft.base === server revision → local draft (unsaved)
 * - draft.base differs, or legacy draft without base → conflict; the local
 *   draft stays the editable copy so nothing is lost, but saving is refused
 *   until the user resolves (diff / save as new / confirmed discard).
 */
export function planDraftRestore(server: EditorDocument, local: LocalNoteDraft | null): DraftRestorePlan {
  const serverDraft = documentToDraft(server);
  if (!local) return { draft: serverDraft, state: "saved" };
  if (contentKey(local) === contentKey(serverDraft)) return { draft: serverDraft, state: "saved" };
  if (local.baseRevisionNumber === undefined) {
    return { draft: local, state: "conflict", conflict: { reason: "legacy-draft", local } };
  }
  if (local.baseRevisionNumber !== server.currentRevisionNumber) {
    return { draft: local, state: "conflict", conflict: { reason: "stale-base", local } };
  }
  return { draft: local, state: "unsaved" };
}

export class DraftWithoutBaseError extends Error {
  constructor() {
    super("草稿缺少基线版本，不能直接保存");
    this.name = "DraftWithoutBaseError";
  }
}

/** Save payload; the optimistic lock uses the draft's base, not the latest server revision. */
export function buildSavePayload(draft: LocalNoteDraft, reason = "manual-save"): UpdateDocumentInput {
  if (draft.baseRevisionNumber === undefined) throw new DraftWithoutBaseError();
  return {
    expectedRevisionNumber: draft.baseRevisionNumber,
    title: draft.title,
    blocks: draftToApiBlocks(draft.blocks),
    reason,
  };
}

function blockText(blocks: LocalDraftBlock[]): string {
  const text = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map(text).join("");
    if (isRecord(value)) return typeof value.text === "string" ? value.text : text(value.content);
    return "";
  };
  return blocks.map((block) => [text(block.content), block.children ? blockText(block.children) : ""].filter(Boolean).join("\n")).join("\n");
}

export function summarizeDraftDiff(local: LocalNoteDraft, server: LocalNoteDraft) {
  return {
    titleChanged: local.title !== server.title,
    local: { title: local.title, text: blockText(local.blocks), baseRevisionNumber: local.baseRevisionNumber ?? null, updatedAt: local.updatedAt },
    server: { title: server.title, text: blockText(server.blocks), revisionNumber: server.baseRevisionNumber ?? null, updatedAt: server.updatedAt },
  };
}

/** Copy of the local work as a new document (existing POST /api/documents). Fresh block ids avoid collisions. */
export function planSaveAsNewNote(local: LocalNoteDraft): CreateDocumentInput {
  const remap = (blocks: LocalDraftBlock[]): LocalDraftBlock[] =>
    blocks.map((block) => ({ ...block, id: createBlockId(), children: block.children ? remap(block.children) : undefined }));
  return {
    title: `${local.title.trim() || "未命名笔记"}（冲突副本）`,
    blocks: draftToApiBlocks(remap(local.blocks)),
  };
}

export function resolveEditorSaveResult(
  savedDocument: EditorDocument,
  currentDraft: LocalNoteDraft,
  requestVersion: number,
  currentVersion: number,
): { draft: LocalNoteDraft; hasUnsavedChanges: boolean } {
  if (requestVersion !== currentVersion) {
    // Edits made during the save now sit on top of the revision we just wrote.
    return { draft: { ...currentDraft, baseRevisionNumber: savedDocument.currentRevisionNumber }, hasUnsavedChanges: true };
  }
  return { draft: documentToDraft(savedDocument), hasUnsavedChanges: false };
}

export function draftToApiBlocks(blocks: LocalDraftBlock[]) {
  return blocks.map((block) => ({
    id: block.id,
    type: block.type,
    content: {
      blockNoteContent: block.content,
      props: block.props ?? null,
      children: block.children ?? [],
    },
  }));
}

export function revisionToApiBlocks(revision: EditorRevision) {
  return revision.blocks.flatMap((block) => {
    if (!isRecord(block) || typeof block.id !== "string" || typeof block.type !== "string") {
      return [];
    }
    return [{ id: block.id, type: block.type, content: isRecord(block.content) ? block.content : {} }];
  });
}
