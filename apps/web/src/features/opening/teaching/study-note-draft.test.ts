import { afterEach, describe, expect, it, vi } from "vitest";
import { associateStudyNote, readStudyNote, saveStudyNote, studyNoteDocument, writeStudyNote } from "./study-note-draft";
import type { StudyConversationContext } from "../assistant/study-conversation-context";
import { EditorApiError } from "../../editor/editor-api";

const courseId = "11111111-1111-4111-8111-111111111111";
const sourceId = "22222222-2222-4222-8222-222222222222";
const documentId = "33333333-3333-4333-8333-333333333333";
function context(): StudyConversationContext { return { courseId, activityId: crypto.randomUUID(), blockId: crypto.randomUUID(), contentVersion: 3, sourceId, sourceVersion: 2, page: 7, label: "矩阵的两列" }; }
function storage() {
  const values = new Map<string, string>();
  const store = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  vi.stubGlobal("sessionStorage", store);
  return store;
}
const document = { id: documentId, title: "笔记", lifecycle: "scratch", currentRevisionNumber: 1, blocks: [] };
afterEach(() => vi.unstubAllGlobals());

describe("context note creation", () => {
  it("keeps fixed material version and original unit links in the existing editor format", () => {
    const input = studyNoteDocument(context(), { title: " 我的理解 ", text: "  原始理解\n不改写  " });
    expect(input.title).toBe("我的理解");
    expect(input.blocks[0]?.content).toMatchObject({ blockNoteContent: "  原始理解\n不改写  " });
    expect(JSON.stringify(input.blocks)).toContain("version=2&page=7");
    expect(JSON.stringify(input.blocks)).toContain("contentVersion=3");
  });
  it("freezes one explicit create and associates the saved note with the actual course", async () => {
    storage(); const ctx = context(); const draft = { ...readStudyNote(ctx), text: "原始笔记" };
    let resolve!: (value: typeof document) => void;
    const api = { createDocument: vi.fn(() => new Promise<typeof document>(done => { resolve = done; })) };
    const associate = vi.fn().mockResolvedValue(undefined);
    const first = saveStudyNote(ctx, draft, api, associate);
    expect(saveStudyNote(ctx, { ...draft, text: "另一个点击" }, api, associate)).toBe(first);
    expect(readStudyNote(ctx).status).toBe("pending");
    resolve(document); await first;
    expect(api.createDocument).toHaveBeenCalledTimes(1);
    expect(associate).toHaveBeenCalledWith(courseId, documentId);
    expect(readStudyNote(ctx)).toMatchObject({ status: "saved", text: "原始笔记", documentId });
  });
  it("retains an unknown create and never posts it again", async () => {
    const store = storage(); const ctx = context(); const draft = { ...readStudyNote(ctx), text: "保留原文" };
    const api = { createDocument: vi.fn().mockRejectedValue(new Error("reply lost")) };
    expect((await saveStudyNote(ctx, draft, api, vi.fn())).status).toBe("unknown");
    await saveStudyNote(ctx, draft, api, vi.fn());
    expect(api.createDocument).toHaveBeenCalledTimes(1);
    expect(store.getItem(`aistudy.study-note.v1:${JSON.stringify([courseId, ctx.activityId, ctx.blockId, 3, sourceId, 2, 7, null, null])}`)).toContain('"unknown"');
  });
  it("does not create when its pending receipt cannot be persisted, preserving editable text", async () => {
    const store = storage(); const ctx = context(); const draft = { ...readStudyNote(ctx), text: "不能丢失" };
    store.setItem = () => { throw new Error("quota"); };
    const api = { createDocument: vi.fn() };
    expect(await saveStudyNote(ctx, draft, api, vi.fn())).toMatchObject({ status: "editing", text: "不能丢失", storageError: true });
    expect(api.createDocument).not.toHaveBeenCalled();
  });
  it("blocks unreadable or corrupt receipts instead of replacing them with a fresh note", () => {
    vi.stubGlobal("sessionStorage", { getItem: () => { throw new Error("denied"); } });
    expect(readStudyNote(context()).status).toBe("unavailable");
    vi.stubGlobal("sessionStorage", { getItem: () => '{"status":"pending",broken' });
    expect(readStudyNote(context())).toMatchObject({ status: "unavailable", text: '{"status":"pending",broken' });
  });
  it("keeps a successful note when course association fails, and permits retry only after definite rejection", async () => {
    storage(); const ctx = context(); const draft = { ...readStudyNote(ctx), text: "理解" };
    writeStudyNote(ctx, draft);
    const api = { createDocument: vi.fn().mockRejectedValueOnce(new EditorApiError("INVALID", "invalid", 422)).mockResolvedValue(document) };
    expect((await saveStudyNote(ctx, draft, api, vi.fn())).status).toBe("editing");
    expect(await saveStudyNote(ctx, draft, api, vi.fn().mockRejectedValue(new Error("association failed")))).toMatchObject({ status: "saved", documentId, associationFailed: true });
    await saveStudyNote(ctx, draft, api, vi.fn());
    expect(api.createDocument).toHaveBeenCalledTimes(2);
  });
});

it("carries unknown legacy note-create receipts into an enriched attempt anchor without a duplicate post", async () => {
  storage(); const ctx = context(), api = { createDocument: vi.fn().mockRejectedValue(new Error("reply lost")) };
  const draft = { ...readStudyNote(ctx), text: "原稿" };
  await saveStudyNote(ctx, draft, api, vi.fn());
  const enriched = { ...ctx, attemptId: crypto.randomUUID(), itemVersionId: crypto.randomUUID(), purpose: "learning_help" as const };
  expect(readStudyNote(enriched)).toMatchObject({ status: "unknown", text: "原稿" });
  await saveStudyNote(enriched, draft, api, vi.fn());
  expect(api.createDocument).toHaveBeenCalledTimes(1);
});

it("does not create an empty course note and keeps drafts isolated between two courses", async () => {
  storage();
  const a = { courseId, label: "数学甲" }, b = { courseId: crypto.randomUUID(), label: "物理乙" };
  const api = { createDocument: vi.fn().mockResolvedValue(document) }, associate = vi.fn();
  await saveStudyNote(a, readStudyNote(a), api, associate);
  expect(api.createDocument).not.toHaveBeenCalled();
  writeStudyNote(a, { ...readStudyNote(a), text: "甲课理解" });
  expect(readStudyNote(b).text).toBe("");
  expect(JSON.stringify(studyNoteDocument(a, readStudyNote(a)))).toContain(`/opening/courses/${courseId}`);
});

it("saves an inline explanation without replacing the student's editable note or its receipt", async () => {
  storage(); const ctx = context();
  const studentDraft = { ...readStudyNote(ctx), text: "我自己还没保存的推导" };
  writeStudyNote(ctx, studentDraft);
  const scope = "inline-explanation";
  const api = { createDocument: vi.fn().mockResolvedValue(document) };
  const explanation = { ...readStudyNote(ctx, scope), text: "当前显示的讲解" };
  expect(await saveStudyNote(ctx, explanation, api, vi.fn(), scope)).toMatchObject({ status: "saved", text: "当前显示的讲解" });
  expect(readStudyNote(ctx)).toEqual(studentDraft);
  await saveStudyNote(ctx, explanation, api, vi.fn(), scope);
  expect(api.createDocument).toHaveBeenCalledOnce();
});

it("notifies a newly mounted subscriber when a shared save completes", async () => {
  storage(); const ctx = context();
  let finish!: (value: typeof document) => void;
  const api = { createDocument: vi.fn(() => new Promise<typeof document>(resolve => { finish = resolve; })) };
  const { subscribeStudyNote } = await import("./study-note-draft");
  const previous = vi.fn(), unsubscribe = subscribeStudyNote(ctx, previous);
  const pending = saveStudyNote(ctx, { ...readStudyNote(ctx), text: "保存中原稿" }, api, vi.fn());
  unsubscribe(); const states: string[] = [];
  const stop = subscribeStudyNote(ctx, () => states.push(readStudyNote(ctx).status));
  expect(readStudyNote(ctx).status).toBe("pending");
  finish(document); await pending;
  expect(states.at(-1)).toBe("saved"); expect(previous).toHaveBeenCalledOnce();
  expect(api.createDocument).toHaveBeenCalledOnce(); stop();
});

it("does not overwrite a new note with a late course-association response for the saved previous note", async () => {
  storage(); const ctx = context();
  let finish!: () => void;
  const associate = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const pending = saveStudyNote(ctx, { ...readStudyNote(ctx), text: "第一篇" }, { createDocument: vi.fn().mockResolvedValue(document) }, associate);
  await Promise.resolve();
  expect(readStudyNote(ctx)).toMatchObject({ status: "saved", documentId });
  writeStudyNote(ctx, { ...readStudyNote(ctx), status: "editing", text: "正在写第二篇", documentId: null, associationFailed: false });
  finish(); await pending;
  expect(readStudyNote(ctx)).toMatchObject({ status: "editing", text: "正在写第二篇", documentId: null });
});

describe("associateStudyNote", () => {
  afterEach(() => vi.unstubAllGlobals());
  const respond = (status: number, body: unknown) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })));
  it("treats an existing association (409 duplicate) as linked", async () => {
    respond(409, { error: { code: "CONFLICT", message: "exists", businessCode: "DUPLICATE_MEMBERSHIP" } });
    await expect(associateStudyNote("c", "d")).resolves.toBeUndefined();
  });
  it("still reports other conflicts and failures", async () => {
    respond(409, { error: { code: "CONFLICT", message: "archived" } });
    await expect(associateStudyNote("c", "d")).rejects.toThrow("课程关联未确认");
    respond(500, {});
    await expect(associateStudyNote("c", "d")).rejects.toThrow("课程关联未确认");
  });
});
