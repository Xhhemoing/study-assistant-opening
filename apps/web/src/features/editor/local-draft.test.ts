import { describe, expect, it } from "vitest";
import {
  createEmptyLocalDraft,
  createLocalDraftStorageKey,
  deserializeLocalDraft,
  serializeLocalDraft,
} from "./local-draft";

describe("local note draft", () => {
  it("creates a blank draft with a stable draft id and paragraph block", () => {
    const draft = createEmptyLocalDraft();

    expect(draft.draftId).toMatch(/^[a-z0-9-]+$/);
    expect(draft.title).toBe("未命名笔记");
    expect(draft.blocks).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        type: "paragraph",
      }),
    ]);
  });

  it("round-trips title, block content, and block ids", () => {
    const draft = createEmptyLocalDraft();
    const stored = serializeLocalDraft({
      ...draft,
      title: "线性代数笔记",
      blocks: [
        {
          id: "block-stable-1",
          type: "paragraph",
          content: "Eigenvalues",
        },
      ],
    });

    expect(deserializeLocalDraft(stored)).toMatchObject({
      title: "线性代数笔记",
      blocks: [
        expect.objectContaining({
          id: "block-stable-1",
          type: "paragraph",
          content: "Eigenvalues",
        }),
      ],
    });
  });

  it("rejects malformed or incompatible stored drafts", () => {
    expect(deserializeLocalDraft("not-json")).toBeNull();
    expect(deserializeLocalDraft(JSON.stringify({ version: 2 }))).toBeNull();
    expect(deserializeLocalDraft(JSON.stringify({ version: 1, blocks: "nope" }))).toBeNull();
  });

  it("creates a different storage key for each workspace", () => {
    const workspaceA = createLocalDraftStorageKey("workspace-a");
    const workspaceB = createLocalDraftStorageKey("workspace-b");

    expect(workspaceA).not.toBe(workspaceB);
    expect(workspaceA).toContain("workspace-a");
    expect(workspaceB).toContain("workspace-b");
  });

  it("does not load a draft when no workspace storage key is available", () => {
    expect(deserializeLocalDraft(null)).toBeNull();
  });
});
