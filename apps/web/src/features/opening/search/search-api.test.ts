import { describe, expect, it } from "vitest";
import { SearchApiError, createSearchApi } from "./search-api";

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

const hit = {
  id: "11111111-1111-4111-8111-111111111111",
  type: "document",
  title: "线性代数笔记",
  snippet: "矩阵的行列式…",
  score: 5,
};

describe("search API client", () => {
  it("encodes the query and parses hits", async () => {
    const queue = createFetchQueue([jsonResponse({ hits: [hit] })]);
    const api = createSearchApi(queue.fetchImpl);

    await expect(api.search("线性代数", 12)).resolves.toEqual([hit]);
    expect(queue.calls[0]).toMatchObject({
      input: "/api/search?q=%E7%BA%BF%E6%80%A7%E4%BB%A3%E6%95%B0&limit=12",
      init: { method: "GET" },
    });
  });

  it("omits the limit parameter when not provided", async () => {
    const queue = createFetchQueue([jsonResponse({ hits: [] })]);
    const api = createSearchApi(queue.fetchImpl);

    await expect(api.search("导数")).resolves.toEqual([]);
    expect(String(queue.calls[0]?.input)).toBe("/api/search?q=%E5%AF%BC%E6%95%B0");
  });

  it("preserves structured error code, status, and message", async () => {
    const queue = createFetchQueue([
      jsonResponse({ error: { code: "UNAUTHENTICATED", message: "请先登录" } }, 401),
    ]);
    const api = createSearchApi(queue.fetchImpl);

    const error = await api.search("x").catch((value: unknown) => value);
    expect(error).toBeInstanceOf(SearchApiError);
    expect(error).toMatchObject({
      code: "UNAUTHENTICATED",
      message: "请先登录",
      status: 401,
    });
  });

  it("rejects malformed search responses", async () => {
    const queue = createFetchQueue([jsonResponse({ hits: [{ id: 1 }] })]);
    const api = createSearchApi(queue.fetchImpl);

    const error = await api.search("x").catch((value: unknown) => value);
    expect(error).toBeInstanceOf(SearchApiError);
    expect(error).toMatchObject({ code: "INVALID_RESPONSE", status: 500 });
  });
});
