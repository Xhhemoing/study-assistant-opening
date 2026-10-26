import { describe, expect, it } from "vitest";
import { createDocumentTagsApi, DocumentTagsApiError } from "./document-tags-api";

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

describe("document tags API client", () => {
  it("encodes document IDs and parses persisted tags", async () => {
    const queue = createFetchQueue([jsonResponse({ tags: ["TOPIC"] })]);
    const api = createDocumentTagsApi(queue.fetchImpl);

    await expect(api.get("id/with spaces")).resolves.toEqual(["TOPIC"]);
    expect(queue.calls[0]).toMatchObject({
      input: "/api/documents/id%2Fwith%20spaces/tags",
      init: { method: "GET" },
    });
  });

  it("puts the requested tag collection as JSON", async () => {
    const queue = createFetchQueue([jsonResponse({ tags: ["TOPIC"] })]);
    const api = createDocumentTagsApi(queue.fetchImpl);

    await expect(api.set("document-1", ["TOPIC"])).resolves.toEqual(["TOPIC"]);
    expect(queue.calls[0]?.init).toMatchObject({
      method: "PUT",
      headers: { "content-type": "application/json" },
    });
    expect(JSON.parse(String(queue.calls[0]?.init?.body))).toEqual({ tags: ["TOPIC"] });
  });

  it("preserves structured authorization errors", async () => {
    const queue = createFetchQueue([
      jsonResponse({ error: { code: "WORKSPACE_FORBIDDEN", message: "Forbidden" } }, 403),
    ]);
    const api = createDocumentTagsApi(queue.fetchImpl);

    const error = await api.get("document-1").catch((value: unknown) => value);
    expect(error).toBeInstanceOf(DocumentTagsApiError);
    expect(error).toMatchObject({
      code: "WORKSPACE_FORBIDDEN",
      status: 403,
      message: "Forbidden",
    });
  });

  it("rejects malformed tag responses", async () => {
    const queue = createFetchQueue([jsonResponse({ tags: [1] })]);
    const api = createDocumentTagsApi(queue.fetchImpl);

    await expect(api.get("document-1")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});
