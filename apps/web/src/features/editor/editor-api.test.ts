import { describe, expect, it } from "vitest";
import { createEditorApi } from "./editor-api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createFetchQueue(responses: Response[]) {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    const response = responses.shift();
    if (!response) throw new Error("Unexpected fetch call");
    return response;
  };
  return { calls, fetchImpl };
}

const documentPayload = {
  id: "document-1",
  title: "线性代数",
  lifecycle: "scratch",
  currentRevisionNumber: 1,
  blocks: [{ id: "block-1", type: "paragraph", position: 0, content: { text: "A" } }],
};

describe("editor API client", () => {
  it("gets a document by id", async () => {
    const queue = createFetchQueue([jsonResponse({ document: documentPayload })]);
    const api = createEditorApi(queue.fetchImpl);

    await expect(api.fetchDocument("document-1")).resolves.toEqual(documentPayload);
    expect(queue.calls[0]).toMatchObject({
      input: "/api/documents/document-1",
      init: { method: "GET" },
    });
  });

  it("creates a document with its initial blocks", async () => {
    const queue = createFetchQueue([jsonResponse({ document: documentPayload }, 201)]);
    const api = createEditorApi(queue.fetchImpl);
    const blocks = [{ id: "block-1", type: "paragraph", content: { text: "A" } }];

    await expect(api.createDocument({ title: "线性代数", blocks })).resolves.toEqual(documentPayload);
    expect(queue.calls[0]?.init).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(queue.calls[0]?.init?.body))).toEqual({
      title: "线性代数",
      blocks,
    });
  });

  it("updates a document and sends the revision reason", async () => {
    const queue = createFetchQueue([jsonResponse({ document: documentPayload })]);
    const api = createEditorApi(queue.fetchImpl);
    const blocks = [{ id: "block-1", type: "paragraph", content: { text: "B" } }];

    await expect(api.saveDocument("document-1", {
      title: "线性代数笔记",
      blocks,
      reason: "manual-save",
      expectedRevisionNumber: 1,
    })).resolves.toEqual(documentPayload);
    expect(queue.calls[0]).toMatchObject({
      input: "/api/documents/document-1",
      init: { method: "PATCH" },
    });
    expect(JSON.parse(String(queue.calls[0]?.init?.body))).toEqual({
      title: "线性代数笔记",
      blocks,
      reason: "manual-save",
      expectedRevisionNumber: 1,
    });
  });

  it("lists document revisions", async () => {
    const revisions = [{ revisionNumber: 1, title: "线性代数", blocks: [] }];
    const queue = createFetchQueue([jsonResponse({ revisions })]);
    const api = createEditorApi(queue.fetchImpl);

    await expect(api.fetchRevisions("document-1")).resolves.toEqual(revisions);
    expect(queue.calls[0]).toMatchObject({
      input: "/api/documents/document-1/revisions",
      init: { method: "GET" },
    });
  });

  it("preserves structured API errors", async () => {
    const queue = createFetchQueue([
      jsonResponse({ error: { code: "NOT_FOUND", message: "Document missing" } }, 404),
    ]);
    const api = createEditorApi(queue.fetchImpl);

    await expect(api.fetchDocument("missing")).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
      message: "Document missing",
    });
  });

  it("preserves a structured conflict API error", async () => {
    const queue = createFetchQueue([
      jsonResponse({ error: { code: "CONFLICT", message: "Document changed elsewhere" } }, 409),
    ]);
    const api = createEditorApi(queue.fetchImpl);

    await expect(api.fetchDocument("document-1")).rejects.toMatchObject({
      code: "CONFLICT",
      status: 409,
      message: "Document changed elsewhere",
    });
  });
});
