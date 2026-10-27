/**
 * J1 / G1+G2: a local draft is tied to the server revision it was based on.
 * Repro of the silent overwrite: draft edited on v3, server meanwhile at v5,
 * draft timestamp newer than the server's. Before J1 the editor adopted the
 * draft by timestamp and saved with the *server's* current revision (5), so
 * the optimistic lock passed and v4/v5 were overwritten without a conflict.
 */
import { describe, expect, it } from "vitest";
import type { EditorBlockInput, EditorDocument } from "./editor-api";
import * as model from "./document-editor-model";
import { deserializeLocalDraft, serializeLocalDraft, type LocalNoteDraft } from "./local-draft";

const DOC = "11111111-1111-4111-8111-111111111111";
const BLOCK = "22222222-2222-4222-8222-222222222222";

function serverDoc(rev: number, text: string, updatedAt = "2026-10-12T08:00:00.000Z"): EditorDocument {
  return {
    id: DOC, title: `标题 v${rev}`, lifecycle: "scratch", currentRevisionNumber: rev, updatedAt,
    blocks: [{ id: BLOCK, type: "paragraph", position: 0, content: { blockNoteContent: text } }],
  } as EditorDocument;
}

/** Same rule as packages/database library.updateDocument (library.ts:775). */
function fakeServer(initial: EditorDocument) {
  let current = initial;
  return {
    get current() { return current; },
    save(input: { expectedRevisionNumber: number; title?: string; blocks: EditorBlockInput[] }) {
      if (input.expectedRevisionNumber !== current.currentRevisionNumber) return { status: 409 as const };
      current = { ...current, title: input.title ?? current.title, currentRevisionNumber: current.currentRevisionNumber + 1,
        blocks: input.blocks.map((b, position) => ({ ...b, position })) } as EditorDocument;
      return { status: 200 as const, document: current };
    },
  };
}

function staleDraftOnV3(): LocalNoteDraft {
  const base = model.documentToDraft(serverDoc(3, "v3 内容", "2026-10-12T07:00:00.000Z"));
  return { ...base, title: "离线修改", blocks: [{ ...base.blocks[0]!, content: "基于 v3 的离线修改" }],
    // Later than the server's updatedAt: the old timestamp rule would adopt it.
    updatedAt: "2026-10-12T09:00:00.000Z" };
}

describe("G1: draft is bound to its base revision", () => {
  it("documentToDraft records the server revision as baseRevisionNumber", () => {
    expect(model.documentToDraft(serverDoc(5, "x")).baseRevisionNumber).toBe(5);
  });

  it("baseRevisionNumber (and optional clientKey) survive localStorage round-trip", () => {
    const draft = { ...model.documentToDraft(serverDoc(3, "x")), clientKey: "k-1" };
    const back = deserializeLocalDraft(serializeLocalDraft(draft));
    expect(back?.baseRevisionNumber).toBe(3);
    expect(back?.clientKey).toBe("k-1");
  });

  it("a v3 draft opened against v5 is a conflict, not silently adopted (even if its timestamp is newer)", () => {
    const plan = model.planDraftRestore(serverDoc(5, "v5 内容"), staleDraftOnV3());
    expect(plan.state).toBe("conflict");
    expect(plan.conflict?.reason).toBe("stale-base");
    expect(plan.conflict?.local.title).toBe("离线修改");
  });

  it("saving the stale draft cannot overwrite v5 (expected = draft base, server returns 409)", () => {
    const server = fakeServer(serverDoc(5, "v5 内容"));
    const draft = staleDraftOnV3();
    const payload = model.buildSavePayload(draft);
    expect(payload.expectedRevisionNumber).toBe(3);
    expect(server.save(payload).status).toBe(409);
    expect(server.current.currentRevisionNumber).toBe(5);
  });

  it("a draft based on the current revision restores as unsaved and saves cleanly", () => {
    const base = model.documentToDraft(serverDoc(5, "v5 内容"));
    const draft = { ...base, title: "继续编辑" };
    const plan = model.planDraftRestore(serverDoc(5, "v5 内容"), draft);
    expect(plan.state).toBe("unsaved");
    expect(plan.draft.title).toBe("继续编辑");
    const server = fakeServer(serverDoc(5, "v5 内容"));
    const result = server.save(model.buildSavePayload(plan.draft));
    expect(result.status).toBe(200);
  });

  it("a draft that equals the server content restores as saved", () => {
    const plan = model.planDraftRestore(serverDoc(5, "v5 内容"), model.documentToDraft(serverDoc(5, "v5 内容")));
    expect(plan.state).toBe("saved");
  });

  it("no local draft → server document, saved", () => {
    const plan = model.planDraftRestore(serverDoc(5, "v5 内容"), null);
    expect(plan.state).toBe("saved");
    expect(plan.draft.baseRevisionNumber).toBe(5);
  });

  it("legacy draft without baseRevisionNumber goes to conflict when it differs from the server", () => {
    const legacy = deserializeLocalDraft(JSON.stringify({
      version: 1, draftId: DOC, title: "旧格式草稿", updatedAt: "2026-10-12T09:00:00.000Z",
      blocks: [{ id: BLOCK, type: "paragraph", content: "旧草稿" }],
    }));
    expect(legacy).not.toBeNull();
    const plan = model.planDraftRestore(serverDoc(5, "v5 内容"), legacy);
    expect(plan.state).toBe("conflict");
    expect(plan.conflict?.reason).toBe("legacy-draft");
    expect(() => model.buildSavePayload(legacy!)).toThrow();
  });
});

describe("G2: conflict resolution never silently drops the local draft", () => {
  it("diff summary shows both sides", () => {
    const diff = model.summarizeDraftDiff(staleDraftOnV3(), model.documentToDraft(serverDoc(5, "v5 内容")));
    expect(diff.titleChanged).toBe(true);
    expect(diff.local.text).toContain("基于 v3 的离线修改");
    expect(diff.server.text).toContain("v5 内容");
    expect(diff.server.revisionNumber).toBe(5);
    expect(diff.local.baseRevisionNumber).toBe(3);
  });

  it("save-as-new copies local content with fresh block ids (no id collision with the original)", () => {
    const local = staleDraftOnV3();
    const input = model.planSaveAsNewNote(local);
    expect(input.title).toBe("离线修改（冲突副本）");
    expect(input.blocks[0]?.content).toEqual({ blockNoteContent: "基于 v3 的离线修改", props: null, children: [] });
    expect(input.blocks[0]?.id).not.toBe(BLOCK);
    expect(input.blocks[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
