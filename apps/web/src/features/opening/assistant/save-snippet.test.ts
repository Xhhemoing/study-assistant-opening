import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageList } from "./message-list";
import { SaveSnippetDialog } from "./save-snippet-dialog";
import { describe, expect, it, vi } from "vitest";
import { OpeningApiError } from "../client/api";
import type { ChatMessageView } from "./message-model";
import { createSnippetSaveAttempt, prepareSnippetDraft, snippetSaveAvailability } from "./save-snippet";

const PROVENANCE_ID = "33333333-3333-4333-8333-333333333333";
const DOCUMENT_ID = "44444444-4444-4444-8444-444444444444";
const message: ChatMessageView = { id: "ephemeral", origin: "ephemeral", provenanceId: PROVENANCE_ID,
  role: "assistant", text: "第一句话。\n仅保存这一句。\n最后一句话。", citations: [], citationLabels: [], status: "complete" };
const draft = { title: "片段笔记", text: "仅保存这一句。", provenanceId: PROVENANCE_ID };

describe("explicit snippet save", () => {
  it.each(["user", "assistant"] as const)("allows a sourced ephemeral %s message", (role) => {
    expect(snippetSaveAvailability({ ...message, role })).toBe("available");
  });

  it("does not expose saved messages or unresolved responses for saving", () => {
    expect(snippetSaveAvailability({ ...message, origin: "saved" })).toBe("hidden");
    expect(snippetSaveAvailability({ ...message, origin: undefined })).toBe("hidden");
    expect(snippetSaveAvailability({ ...message, status: "pending" })).toBe("hidden");
    expect(snippetSaveAvailability({ ...message, status: "outcome_unknown" })).toBe("hidden");
  });

  it("blocks unknown provenance instead of inventing an unlinked note", () => {
    expect(snippetSaveAvailability({ ...message, provenanceId: null })).toBe("missing_provenance");
    expect(prepareSnippetDraft({ ...message, provenanceId: undefined }, "选中内容")).toBeNull();
  });

  it("previews the selected excerpt with the original message provenance", () => {
    const result = prepareSnippetDraft(message, "仅保存这一句。");
    expect(result).toEqual({ title: "仅保存这一句。", text: "仅保存这一句。", provenanceId: PROVENANCE_ID });
    expect(prepareSnippetDraft(message)?.text).toBe(message.text);
  });

  it("does not persist a preview and blocks simultaneous or repeated successful confirmation", async () => {
    let finish!: (result: { documentId: string }) => void;
    const create = vi.fn(() => new Promise<{ documentId: string }>((resolve) => { finish = resolve; }));
    const attempt = createSnippetSaveAttempt(create);
    prepareSnippetDraft(message, draft.text);
    expect(create).not.toHaveBeenCalled();
    const first = attempt.confirm(draft);
    await expect(attempt.confirm(draft)).resolves.toBeNull();
    finish({ documentId: DOCUMENT_ID });
    await expect(first).resolves.toEqual({ kind: "saved", documentId: DOCUMENT_ID });
    await expect(attempt.confirm(draft)).resolves.toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(draft);
  });

  it("does not retry an ambiguous network result", async () => {
    const create = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    const attempt = createSnippetSaveAttempt(create);
    await expect(attempt.confirm(draft)).resolves.toMatchObject({ kind: "unknown" });
    await expect(attempt.confirm(draft)).resolves.toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("allows an explicit correction after a definitive rejected request", async () => {
    const create = vi.fn().mockRejectedValueOnce(new OpeningApiError(400, "标题太长"))
      .mockResolvedValueOnce({ documentId: DOCUMENT_ID });
    const attempt = createSnippetSaveAttempt(create);
    await expect(attempt.confirm(draft)).resolves.toEqual({ kind: "failed", message: "标题太长" });
    expect(create).toHaveBeenCalledTimes(1);
    await expect(attempt.confirm({ ...draft, title: "修正标题" })).resolves.toMatchObject({ kind: "saved" });
  });
});

it("renders save actions for every valid temporary message and none for saved history", () => {
  const messages = [
    { ...message, id: "old-user", role: "user" as const },
    { ...message, id: "old-assistant" },
    { ...message, id: "new-user", role: "user" as const },
    { ...message, id: "new-assistant" },
  ];
  const html = renderToStaticMarkup(createElement(MessageList, { messages, onSaveSnippet: () => undefined }));
  expect(html.match(/>保存片段<\/button>/g)).toHaveLength(4);
  const saved = renderToStaticMarkup(createElement(MessageList, {
    messages: [{ ...message, origin: "saved" }], onSaveSnippet: () => undefined,
  }));
  expect(saved).not.toContain("保存片段");
});

it("shows a blocked save entry and explains the missing source context", () => {
  const html = renderToStaticMarkup(createElement(MessageList, {
    messages: [{ ...message, provenanceId: null }], onSaveSnippet: () => undefined,
  }));
  expect(html).toContain('disabled=""');
  expect(html).toContain("来源上下文");
});

it("opening the editable preview does not call the note API", () => {
  const createSnippet = vi.fn();
  const html = renderToStaticMarkup(createElement(SaveSnippetDialog, { draft, api: { createSnippet }, onClose: () => undefined }));
  expect(html).toContain("<textarea");
  expect(html).toContain("仅保存这一句。");
  expect(html).toContain("确认保存为笔记");
  expect(createSnippet).not.toHaveBeenCalled();
});
