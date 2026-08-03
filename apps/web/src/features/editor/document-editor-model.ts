import type { EditorDocument } from "./editor-api";
import type { EditorRevision } from "./version-history";
import type { LocalDraftBlock, LocalNoteDraft } from "./local-draft";

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
      return { id: block.id, type: block.type, content: packed };
    }),
    updatedAt: document.updatedAt ?? new Date().toISOString(),
  };
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
