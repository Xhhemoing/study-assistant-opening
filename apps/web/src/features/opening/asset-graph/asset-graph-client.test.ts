import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assetGraphPageSchema, type AssetGraphQuery } from "@aistudy/contracts";
import { clearSessionExpiry } from "../../auth/session-expiry";
import {
  AssetGraphRequestError,
  DEFAULT_ASSET_GRAPH_QUERY_ENDPOINT,
  createAssetGraphClient,
  createHttpAssetGraphTransport,
  createSyntheticAssetGraphTransport,
  type SyntheticAssetGraphFixtures,
} from "./asset-graph-client";

const fixturesPath = resolve(
  __dirname,
  "../../../../../../docs/brainstorm/2026-11-18-knowledge-assets-examples.json",
);
const fixtures = JSON.parse(readFileSync(fixturesPath, "utf8")) as SyntheticAssetGraphFixtures;

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => reverseObjectKeys(item));
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const reversed: Record<string, unknown> = {};
    for (const key of Object.keys(record).reverse()) {
      reversed[key] = reverseObjectKeys(record[key]);
    }
    return reversed;
  }
  return value;
}

afterEach(() => {
  clearSessionExpiry();
  vi.restoreAllMocks();
});

describe("createSyntheticAssetGraphTransport", () => {
  it("loads all 20 design fixture cases and matches each regardless of key ordering", async () => {
    expect(fixtures.cases).toHaveLength(20);
    const transport = createSyntheticAssetGraphTransport(fixtures);

    for (const item of fixtures.cases) {
      const shuffledQuery = reverseObjectKeys(item.request.body) as AssetGraphQuery;
      if (item.http === 200) {
        const result = await transport(shuffledQuery);
        expect(result).toEqual(assetGraphPageSchema.parse(item.response));
      } else {
        await expect(transport(shuffledQuery)).rejects.toMatchObject({
          name: "AssetGraphRequestError",
          status: item.http,
          code: (item.response as { error: { code: string } }).error.code,
          message: (item.response as { error: { message: string } }).error.message,
        });
      }
    }
  });

  it("throws SYNTHETIC_UNCOVERED for queries not present in fixtures instead of returning fake empty results", async () => {
    const transport = createSyntheticAssetGraphTransport(fixtures);
    await expect(
      transport({
        op: "roots",
        context: { kind: "workspace" },
        lens: "evidence",
        q: "未在样例中的查询",
      }),
    ).rejects.toMatchObject({
      name: "AssetGraphRequestError",
      code: "SYNTHETIC_UNCOVERED",
      message: "设计样例未覆盖此请求",
    });
  });

  it("rejects immediately when signal is already aborted", async () => {
    const transport = createSyntheticAssetGraphTransport(fixtures);
    const controller = new AbortController();
    controller.abort();
    await expect(
      transport({ op: "roots", context: { kind: "workspace" }, lens: "all" }, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("createHttpAssetGraphTransport and createAssetGraphClient", () => {
  const endpoint = "/api/opening/asset-graph/query";

  it("defaults to DEFAULT_ASSET_GRAPH_QUERY_ENDPOINT (/api/opening/asset-graph/query) and keeps empty endpoint rejected", async () => {
    expect(DEFAULT_ASSET_GRAPH_QUERY_ENDPOINT).toBe("/api/opening/asset-graph/query");
    expect(() => createHttpAssetGraphTransport("")).toThrow("Asset graph endpoint must be a non-empty string.");
    expect(() => createHttpAssetGraphTransport("   ")).toThrow("Asset graph endpoint must be a non-empty string.");

    const firstCase = fixtures.cases[0]!;
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify(firstCase.response), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const transport = createHttpAssetGraphTransport(undefined, fetchMock);
    const page = await transport({ op: "roots", context: { kind: "workspace" }, lens: "all" });
    expect(page).toEqual(assetGraphPageSchema.parse(firstCase.response));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/opening/asset-graph/query");
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("same-origin");
    expect(init?.cache).toBe("no-store");

    const err404 = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "请求的资源不可用。" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(
      createHttpAssetGraphTransport(undefined, err404)({ op: "roots", context: { kind: "workspace" }, lens: "all" }),
    ).rejects.toEqual(new AssetGraphRequestError("NOT_FOUND", "请求的资源不可用。", 404));

    const err409 = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ error: { code: "CURSOR_STALE", message: "游标已失效" } }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(
      createHttpAssetGraphTransport(undefined, err409)({ op: "roots", context: { kind: "workspace" }, lens: "all" }),
    ).rejects.toEqual(new AssetGraphRequestError("CURSOR_STALE", "游标已失效", 409));

    const err500 = vi.fn<typeof fetch>(async () => new Response("Internal Server Error", { status: 500 }));
    await expect(
      createHttpAssetGraphTransport(undefined, err500)({ op: "roots", context: { kind: "workspace" }, lens: "all" }),
    ).rejects.toMatchObject({ name: "AssetGraphRequestError", code: "NETWORK", status: 500 });

    const errNet = vi.fn<typeof fetch>(async () => {
      throw new TypeError("network down");
    });
    await expect(
      createHttpAssetGraphTransport(undefined, errNet)({ op: "roots", context: { kind: "workspace" }, lens: "all" }),
    ).rejects.toMatchObject({ name: "AssetGraphRequestError", code: "NETWORK" });
  });

  it("sends same-origin POST with no-store cache, signal, and canonical JSON body", async () => {
    const firstCase = fixtures.cases[0]!;
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify(firstCase.response), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const transport = createHttpAssetGraphTransport(endpoint, fetchMock);
    const client = createAssetGraphClient(transport);
    const controller = new AbortController();

    const page = await client.roots(
      { lens: "all", context: { kind: "workspace" } },
      controller.signal,
    );

    expect(page).toEqual(assetGraphPageSchema.parse(firstCase.response));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(endpoint);
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("same-origin");
    expect(init?.cache).toBe("no-store");
    expect(init?.signal).toBe(controller.signal);
    expect(init?.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({
      context: { kind: "workspace" },
      lens: "all",
      op: "roots",
    });
  });

  it.each([
    [400, "VALIDATION", "参数错误"],
    [401, "UNAUTHENTICATED", "请先登录"],
    [403, "FORBIDDEN", "无权查看"],
    [404, "NOT_FOUND", "请求的资源不可用。"],
    [409, "CURSOR_STALE", "游标已失效"],
    [409, "CONFLICT", "版本冲突"],
  ] as const)("maps HTTP %s (%s) structured error without falling back to mock", async (status, code, message) => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ error: { code, message } }), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
    const transport = createHttpAssetGraphTransport(endpoint, fetchMock);

    await expect(
      transport({ op: "roots", context: { kind: "workspace" }, lens: "all" }),
    ).rejects.toEqual(new AssetGraphRequestError(code, message, status));
  });

  it("maps 5xx and network failures to NETWORK error without falling back to mock", async () => {
    const serverFail = vi.fn<typeof fetch>(async () =>
      new Response("Internal Server Error", { status: 500 }),
    );
    await expect(
      createHttpAssetGraphTransport(endpoint, serverFail)({
        op: "roots",
        context: { kind: "workspace" },
        lens: "all",
      }),
    ).rejects.toMatchObject({
      name: "AssetGraphRequestError",
      code: "NETWORK",
      status: 500,
    });

    const networkFail = vi.fn<typeof fetch>(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(
      createHttpAssetGraphTransport(endpoint, networkFail)({
        op: "roots",
        context: { kind: "workspace" },
        lens: "all",
      }),
    ).rejects.toMatchObject({
      name: "AssetGraphRequestError",
      code: "NETWORK",
    });
  });

  it("rejects malformed 200 JSON or schema-invalid pages with INVALID_RESPONSE", async () => {
    const badJsonFetch = vi.fn<typeof fetch>(async () => new Response("not-json", { status: 200 }));
    await expect(
      createHttpAssetGraphTransport(endpoint, badJsonFetch)({
        op: "roots",
        context: { kind: "workspace" },
        lens: "all",
      }),
    ).rejects.toMatchObject({
      name: "AssetGraphRequestError",
      code: "INVALID_RESPONSE",
      status: 200,
    });

    const badShapeFetch = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ nodes: [] }), { status: 200 }),
    );
    await expect(
      createHttpAssetGraphTransport(endpoint, badShapeFetch)({
        op: "roots",
        context: { kind: "workspace" },
        lens: "all",
      }),
    ).rejects.toMatchObject({
      name: "AssetGraphRequestError",
      code: "INVALID_RESPONSE",
      status: 200,
    });
  });

  it("supports neighbors and detail convenience methods on createAssetGraphClient", async () => {
    const neighborsCase = fixtures.cases.find(
      c => c.name === "synthetic-course-03-requirement-source-and-observation-neighbors",
    )!;
    const detailCase = fixtures.cases.find(
      c => c.name === "synthetic-course-04-requirement-detail-with-versioned-start-action",
    )!;
    const client = createAssetGraphClient(createSyntheticAssetGraphTransport(fixtures));

    const neighbors = await client.neighbors(
      neighborsCase.request.body as Parameters<typeof client.neighbors>[0],
    );
    expect(neighbors.edges).toHaveLength(2);

    const detail = await client.detail(
      detailCase.request.body as Parameters<typeof client.detail>[0],
    );
    expect(detail.detail?.actions[0]).toMatchObject({ kind: "startCourseRequirement" });
  });
});
