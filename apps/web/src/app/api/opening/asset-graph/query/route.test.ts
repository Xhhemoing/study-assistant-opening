import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetGraphPage } from "@aistudy/contracts";
import { ApiError } from "../../../../../features/auth/service";

const mocks = vi.hoisted(() => ({
  requireOpeningScope: vi.fn(),
  query: vi.fn(),
  createService: vi.fn(),
}));

vi.mock("../../../../../features/opening/runtime", () => ({
  requireOpeningScope: mocks.requireOpeningScope,
}));

vi.mock("../../../../../features/opening/server/asset-graph-service", async importOriginal => {
  const actual = await importOriginal<
    typeof import("../../../../../features/opening/server/asset-graph-service")
  >();
  return {
    ...actual,
    createAssetGraphService: mocks.createService,
  };
});

import { OpeningAssetGraphError } from "../../../../../features/opening/server/asset-graph-service";
import * as routeModule from "./route";

const { POST } = routeModule;

const SCOPE = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  ownerUserId: "22222222-2222-4222-8222-222222222222",
};

const VALID_PAGE: AssetGraphPage = {
  asOf: "2026-11-18T10:00:00.000Z",
  nodes: [
    {
      id: "course/33333333-3333-4333-8333-333333333333",
      kind: "course",
      label: "高等数学",
    },
  ],
  edges: [],
  page: { nextCursor: null },
  completeness: "complete",
  warnings: [],
  detail: null,
};

function makeRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/opening/asset-graph/query", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

describe("POST /api/opening/asset-graph/query", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireOpeningScope.mockResolvedValue({ sql: {}, scope: SCOPE });
    mocks.query.mockResolvedValue(VALID_PAGE);
    mocks.createService.mockReturnValue({ query: mocks.query });
  });

  it("exports only POST and does not expose GET, PUT, PATCH, or DELETE", () => {
    expect(typeof POST).toBe("function");
    const exported = routeModule as Record<string, unknown>;
    expect(exported.GET).toBeUndefined();
    expect(exported.PUT).toBeUndefined();
    expect(exported.PATCH).toBeUndefined();
    expect(exported.DELETE).toBeUndefined();
  });

  it("returns 401 with private, no-store when unauthenticated", async () => {
    mocks.requireOpeningScope.mockRejectedValue(
      new ApiError("UNAUTHENTICATED", "Authentication required", 401),
    );

    const response = await POST(
      makeRequest(JSON.stringify({ op: "roots", context: { kind: "workspace" }, lens: "all" })),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHENTICATED", message: "Authentication required" },
    });
    expect(mocks.createService).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("returns 400 with private, no-store for malformed JSON or empty body", async () => {
    for (const badBody of ["{not-json", ""]) {
      const response = await POST(makeRequest(badBody));
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      await expect(response.json()).resolves.toEqual({
        error: { code: "VALIDATION", message: "请求体不是有效的 JSON。" },
      });
    }
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("returns 413 with private, no-store when body exceeds 16KB", async () => {
    const byHeader = await POST(makeRequest("{}", { "content-length": "16385" }));
    expect(byHeader.status).toBe(413);
    expect(byHeader.headers.get("cache-control")).toBe("private, no-store");
    await expect(byHeader.json()).resolves.toEqual({
      error: { code: "VALIDATION", message: "请求体过大" },
    });

    const oversizedPayload = JSON.stringify({
      op: "roots",
      context: { kind: "workspace" },
      lens: "all",
      q: "a".repeat(16_500),
    });
    const byStream = await POST(makeRequest(oversizedPayload));
    expect(byStream.status).toBe(413);
    expect(byStream.headers.get("cache-control")).toBe("private, no-store");
    await expect(byStream.json()).resolves.toEqual({
      error: { code: "VALIDATION", message: "请求体过大" },
    });

    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("returns 400 with private, no-store on schema violations and identity field injection", async () => {
    const invalidBodies = [
      { op: "roots", context: { kind: "workspace" }, lens: "all", kinds: ["observation"] },
      { op: "roots", context: { kind: "workspace" }, lens: "all", workspaceId: SCOPE.workspaceId },
      { op: "roots", context: { kind: "workspace" }, lens: "all", ownerUserId: SCOPE.ownerUserId },
      { op: "detail", context: { kind: "workspace" }, lens: "all", focus: "bad-id" },
    ];

    for (const invalidBody of invalidBodies) {
      const response = await POST(makeRequest(JSON.stringify(invalidBody)));
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      await expect(response.json()).resolves.toEqual({
        error: { code: "VALIDATION", message: "查询参数格式不正确，请调整筛选条件后再试。" },
      });
    }
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it.each([
    ["NOT_FOUND", "hidden internal message", 404, "请求的资源不可用。"],
    ["CURSOR_STALE", "分页上下文已失效，请从本次查询的第一页重新读取。", 409, "分页上下文已失效，请从本次查询的第一页重新读取。"],
    ["VALIDATION", "工作区作用域参数无效。", 400, "工作区作用域参数无效。"],
    ["CONFLICT", "存在并发状态冲突。", 409, "存在并发状态冲突。"],
  ] as const)(
    "maps OpeningAssetGraphError(%s) to HTTP %s with private, no-store",
    async (code, thrownMessage, expectedStatus, expectedMessage) => {
      mocks.query.mockRejectedValueOnce(new OpeningAssetGraphError(code, thrownMessage));

      const response = await POST(
        makeRequest(JSON.stringify({ op: "roots", context: { kind: "workspace" }, lens: "all" })),
      );

      expect(response.status).toBe(expectedStatus);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      await expect(response.json()).resolves.toEqual({
        error: { code, message: expectedMessage },
      });
    },
  );

  it("maps unexpected errors to 500 with private, no-store without leaking internal details", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      mocks.query.mockRejectedValueOnce(new Error("postgres internal secret error"));

      const response = await POST(
        makeRequest(JSON.stringify({ op: "roots", context: { kind: "workspace" }, lens: "all" })),
      );

      expect(response.status).toBe(500);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const body = await response.json();
      expect(body).toEqual({
        error: { code: "INTERNAL_ERROR", message: "服务暂时无法处理请求，请稍后重试。" },
      });
      expect(JSON.stringify(body)).not.toContain("postgres internal secret error");
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("returns 200 with private, no-store and passes authenticated server scope to service", async () => {
    const query = {
      op: "roots",
      context: { kind: "workspace" },
      lens: "all",
      limit: 10,
      include: ["summary"],
    };

    const response = await POST(makeRequest(JSON.stringify(query)));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual(VALID_PAGE);
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.query).toHaveBeenCalledWith(SCOPE, query);
  });
});
