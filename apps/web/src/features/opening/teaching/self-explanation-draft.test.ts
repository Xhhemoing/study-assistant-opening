import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishVerifiedSessionIdentity } from "../../auth/session-identity";
import { readStudyNote, writeStudyNote } from "./study-note-draft";
import { editSelfExplanation, freezeSelfExplanation, readSelfExplanation, saveSelfExplanation, selfExplanationQuestion, startSelfExplanation } from "./self-explanation-draft";

const ctx = () => ({ courseId: crypto.randomUUID(), sourceId: crypto.randomUUID(), sourceVersion: 2, page: 7, label: "矩阵", fragment: "不是用户的原话" });
const documentId = "33333333-3333-4333-8333-333333333333";
beforeEach(() => { vi.stubGlobal("window", {}); publishVerifiedSessionIdentity({ id: "A", workspaceId: "workspace" }); const values = new Map<string, string>(); vi.stubGlobal("sessionStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) }); });
afterEach(() => vi.unstubAllGlobals());

describe("user-owned non-scoring explanation", () => {
  it("starts empty, isolates ordinary notes, freezes original and only explicitly starts a new record", () => {
    const context = ctx();
    writeStudyNote(context, { ...readStudyNote(context), text: "普通笔记" });
    expect(readSelfExplanation(context).record?.original).toBe("");
    editSelfExplanation(context, { original: " 原话\n保留 " });
    freezeSelfExplanation(context);
    editSelfExplanation(context, { original: "不能覆盖", revision: "修订" });
    expect(readSelfExplanation(context).record).toEqual({ original: " 原话\n保留 ", revision: "修订", frozen: true });
    expect(readStudyNote(context).text).toBe("普通笔记");
    expect(startSelfExplanation(context)).toBe(true);
    expect(readSelfExplanation(context).record).toEqual({ original: "", revision: "", frozen: false });
  });
  it("saves separately labelled user blocks through existing links and course association", async () => {
    const context = ctx(); editSelfExplanation(context, { original: "我的原话" }); freezeSelfExplanation(context); editSelfExplanation(context, { revision: "我的修订" });
    const api = { createDocument: vi.fn().mockResolvedValue({ id: documentId }) }, associate = vi.fn().mockResolvedValue(undefined);
    await saveSelfExplanation(context, api, associate);
    const input = api.createDocument.mock.calls[0]![0];
    expect(input.blocks.map((block: { content: { blockNoteContent: unknown } }) => block.content.blockNoteContent).slice(1, 5)).toEqual(["用户原话", "我的原话", "用户修订（可能参考对话，不作为独立作答）", "我的修订"]);
    expect(JSON.stringify(input)).toContain("version=2&page=7");
    expect(JSON.stringify(input)).not.toContain("不是用户的原话");
    expect(associate).toHaveBeenCalledWith(context.courseId, documentId);
    expect(readSelfExplanation(context)).toMatchObject({ note: { status: "saved" }, record: { original: "我的原话", revision: "我的修订" } });
    await saveSelfExplanation(context, api, associate); expect(api.createDocument).toHaveBeenCalledOnce();
  });
  it("retains unknown original and revision, prevents automatic retry and new-record reset", async () => {
    const context = ctx(); editSelfExplanation(context, { original: "原稿", revision: "修订" }); freezeSelfExplanation(context);
    const api = { createDocument: vi.fn().mockRejectedValue(new Error("lost reply")) };
    await saveSelfExplanation(context, api, vi.fn()); await saveSelfExplanation(context, api, vi.fn());
    expect(api.createDocument).toHaveBeenCalledOnce();
    expect(startSelfExplanation(context)).toBe(false);
    expect(readSelfExplanation(context)).toMatchObject({ note: { status: "unknown" }, record: { original: "原稿", revision: "修订", frozen: true } });
  });
  it("refuses unfrozen creates and preserves text if the receipt cannot be stored", async () => {
    const context = ctx(), api = { createDocument: vi.fn() };
    editSelfExplanation(context, { original: "原稿" }); await saveSelfExplanation(context, api, vi.fn()); expect(api.createDocument).not.toHaveBeenCalled();
    freezeSelfExplanation(context);
    vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: () => { throw new Error("quota"); } });
    await saveSelfExplanation(context, api, vi.fn());
    expect(api.createDocument).not.toHaveBeenCalled(); expect(readSelfExplanation(context)).toMatchObject({ note: { status: "editing", storageError: true }, record: { original: "原稿", frozen: true } });
  });
  it("isolates A/B on the same context and captures pending save ownership", async () => {
    const context = ctx();
    editSelfExplanation(context, { original: "A的原稿" }); freezeSelfExplanation(context);
    let resolve!: (value: { id: string }) => void;
    const api = { createDocument: vi.fn(() => new Promise<{ id: string }>(done => { resolve = done; })) };
    const associate = vi.fn();
    const pending = saveSelfExplanation(context, api, associate);
    publishVerifiedSessionIdentity({ id: "B", workspaceId: "workspace" });
    expect(readSelfExplanation(context).record?.original).toBe("");
    expect(editSelfExplanation(context, { original: "B的原稿" })).toBe(true);
    resolve({ id: documentId }); await pending;
    expect(associate).not.toHaveBeenCalled();
    expect(readSelfExplanation(context)).toMatchObject({ note: { status: "editing" }, record: { original: "B的原稿" } });
    publishVerifiedSessionIdentity({ id: "A", workspaceId: "workspace" });
    expect(readSelfExplanation(context)).toMatchObject({ note: { status: "saved", associationFailed: true }, record: { original: "A的原稿" } });
  });
  it("refuses all access without a verified identity", async () => {
    const context = ctx(); editSelfExplanation(context, { original: "私密原稿" });
    const cleanup = publishVerifiedSessionIdentity({ id: "A", workspaceId: "workspace" }); cleanup();
    expect(readSelfExplanation(context)).toMatchObject({ record: null, note: { text: "", status: "unavailable" } });
    expect(editSelfExplanation(context, { original: "覆盖" })).toBe(false);
    expect(freezeSelfExplanation(context)).toBe(false); expect(startSelfExplanation(context)).toBe(false);
    const api = { createDocument: vi.fn() }; await saveSelfExplanation(context, api, vi.fn());
    expect(api.createDocument).not.toHaveBeenCalled();
    publishVerifiedSessionIdentity({ id: "A", workspaceId: "workspace" });
    expect(readSelfExplanation(context).record?.original).toBe("私密原稿");
  });
  it.each(['"', '\n', '\\', '\u0000'])("rejects escaped overflow without corrupting the stored receipt: %j", char => {
    const context = ctx();
    expect(editSelfExplanation(context, { original: char.repeat(9000) })).toBe(char !== '\u0000');
    if (char === '\u0000') { expect(readSelfExplanation(context).record?.original).toBe(""); return; }
    const before = readSelfExplanation(context);
    expect(editSelfExplanation(context, { revision: char.repeat(9000) })).toBe(false);
    expect(readSelfExplanation(context)).toEqual(before);
    expect(readSelfExplanation(context).note.text.length).toBeLessThanOrEqual(20_000);
    expect(JSON.parse(readSelfExplanation(context).note.text)).toEqual(before.record);
  });
  it("prepares an explicit non-scoring request without inventing feedback", () => {
    expect(selfExplanationQuestion({ original: "甲", revision: "乙", frozen: true })).toContain("可能参考了对话，不是独立作答");
  });
  it("restores frozen original/revision from storage and treats an interrupted save as unknown", () => {
    const context = ctx();
    vi.stubGlobal("sessionStorage", { getItem: () => JSON.stringify({ title: "我的理解", text: JSON.stringify({ original: "恢复的原话", revision: "恢复的修订", frozen: true }), status: "pending", documentId: null, associationFailed: false, storageError: false }) });
    expect(readSelfExplanation(context)).toMatchObject({ note: { status: "unknown" }, record: { original: "恢复的原话", revision: "恢复的修订", frozen: true } });
    expect(startSelfExplanation(context)).toBe(false);
  });
  it("does not exceed the underlying receipt capacity with heavily escaped text", () => {
    const context = ctx();
    editSelfExplanation(context, { original: "原话" });
    expect(editSelfExplanation(context, { original: "\\".repeat(9000), revision: "\\".repeat(9000) })).toBe(false);
    expect(readSelfExplanation(context).record?.original).toBe("原话");
  });
});
