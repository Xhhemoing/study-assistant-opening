import { describe, expect, it } from "vitest";
import { createKnowledgeLinksApi, KnowledgeLinksApiError } from "./knowledge-links-api";

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

const link = {
  id: "33333333-3333-4333-8333-333333333333",
  relationType: "references",
  isIncoming: true,
  from: {
    type: "document",
    id: "11111111-1111-4111-8111-111111111111",
    documentId: "11111111-1111-4111-8111-111111111111",
    title: "Source",
    text: null,
    status: "available",
  },
  to: {
    type: "document",
    id: "22222222-2222-4222-8222-222222222222",
    documentId: "22222222-2222-4222-8222-222222222222",
    title: "Target",
    text: null,
    status: "available",
  },
  createdAt: "2026-08-03T12:00:00.000Z",
};

describe("knowledge links API client", () => {
  it("encodes document IDs and parses enriched links", async () => {
    const documentId = "id/with spaces";
    const queue = createFetchQueue([jsonResponse({ links: [link] })]);
    const api = createKnowledgeLinksApi(queue.fetchImpl);

    await expect(api.list(documentId)).resolves.toEqual([link]);
    expect(queue.calls[0]).toMatchObject({
      input: "/api/documents/id%2Fwith%20spaces/links",
      init: { method: "GET" },
    });
  });

  it("posts extracted titles with JSON content type", async () => {
    const queue = createFetchQueue([new Response(null, { status: 204 })]);
    const api = createKnowledgeLinksApi(queue.fetchImpl);

    await expect(api.index("document-1", ["Target", "Target"])).resolves.toBeUndefined();
    expect(queue.calls[0]?.init).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(JSON.parse(String(queue.calls[0]?.init?.body))).toEqual({
      targetTitles: ["Target", "Target"],
    });
  });

  it("preserves structured error code, status, and message", async () => {
    const queue = createFetchQueue([
      jsonResponse({ error: { code: "WORKSPACE_FORBIDDEN", message: "Forbidden" } }, 403),
    ]);
    const api = createKnowledgeLinksApi(queue.fetchImpl);

    const error = await api.list("document-1").catch((value: unknown) => value);
    expect(error).toBeInstanceOf(KnowledgeLinksApiError);
    expect(error).toMatchObject({
      code: "WORKSPACE_FORBIDDEN",
      status: 403,
      message: "Forbidden",
    });
  });

  it("rejects malformed success responses", async () => {
    const queue = createFetchQueue([jsonResponse({ links: [{ ...link, relationType: "mentions" }] })]);
    const api = createKnowledgeLinksApi(queue.fetchImpl);

    const error = await api.list("document-1").catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "INVALID_RESPONSE" });
  });
});
