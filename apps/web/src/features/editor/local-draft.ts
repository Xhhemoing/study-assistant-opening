export const LOCAL_DRAFT_STORAGE_KEY = "aistudy.editor.local-draft.v1";

export function createLocalDraftStorageKey(workspaceId: string): string {
  return `${LOCAL_DRAFT_STORAGE_KEY}:${encodeURIComponent(workspaceId)}`;
}

export type LocalDraftBlock = {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  content: unknown;
  children?: LocalDraftBlock[];
};

export type LocalNoteDraft = {
  version: 1;
  draftId: string;
  title: string;
  blocks: LocalDraftBlock[];
  updatedAt: string;
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isDraftBlock(value: unknown): value is LocalDraftBlock {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || typeof value.type !== "string") return false;
  if (!("content" in value)) return false;
  if (value.props !== undefined && !isRecord(value.props)) return false;
  if (value.children !== undefined) {
    if (!Array.isArray(value.children) || !value.children.every(isDraftBlock)) return false;
  }
  return true;
}

export function createEmptyLocalDraft(): LocalNoteDraft {
  return {
    version: 1,
    draftId: createId("draft"),
    title: "未命名笔记",
    blocks: [
      {
        id: createId("block"),
        type: "paragraph",
        content: "",
      },
    ],
    updatedAt: new Date().toISOString(),
  };
}

export function serializeLocalDraft(draft: LocalNoteDraft): string {
  return JSON.stringify(draft);
}

export function deserializeLocalDraft(value: string | null): LocalNoteDraft | null {
  if (!value) return null;

  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || parsed.version !== 1) return null;
    if (typeof parsed.draftId !== "string" || typeof parsed.title !== "string") return null;
    if (!Array.isArray(parsed.blocks) || !parsed.blocks.every(isDraftBlock)) return null;
    if (typeof parsed.updatedAt !== "string") return null;
    return parsed as unknown as LocalNoteDraft;
  } catch {
    return null;
  }
}

export function loadLocalDraft(workspaceId: string): LocalNoteDraft | null {
  if (typeof window === "undefined" || !workspaceId) return null;
  try {
    return deserializeLocalDraft(
      window.localStorage.getItem(createLocalDraftStorageKey(workspaceId)),
    );
  } catch {
    return null;
  }
}

export function saveLocalDraft(workspaceId: string, draft: LocalNoteDraft): boolean {
  if (typeof window === "undefined" || !workspaceId) return false;
  try {
    window.localStorage.setItem(
      createLocalDraftStorageKey(workspaceId),
      serializeLocalDraft(draft),
    );
    return true;
  } catch {
    return false;
  }
}

export function editorBlocksToDraftBlocks(blocks: unknown[]): LocalDraftBlock[] {
  return blocks.flatMap((value) => {
    if (!isRecord(value) || typeof value.id !== "string" || typeof value.type !== "string") {
      return [];
    }
    const children = Array.isArray(value.children)
      ? editorBlocksToDraftBlocks(value.children)
      : undefined;
    return [{
      id: value.id,
      type: value.type,
      props: isRecord(value.props) ? value.props : undefined,
      content: value.content,
      children,
    }];
  });
}

export function draftBlocksToEditorBlocks(blocks: LocalDraftBlock[]): Array<Record<string, unknown>> {
  return blocks.map((block) => ({
    id: block.id,
    type: block.type,
    props: block.props,
    content: block.content,
    children: block.children ? draftBlocksToEditorBlocks(block.children) : [],
  }));
}
