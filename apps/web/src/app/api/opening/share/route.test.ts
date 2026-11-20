import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ scope: vi.fn() }));
vi.mock("../../../../features/opening/runtime", () => ({
  requireOpeningScope: mocks.scope,
}));

import { ApiError } from "../../../../features/auth/service";
import { verifyPitfallShareToken } from "../../../../features/opening/share/token-codec";
import { POST } from "./route";

const TEST_SECRET = "route-share-test-secret-0123456789abcdef";

const VALID_PAYLOAD = {
  subjectLabel: "线性代数",
  pitfallTitle: "特征值相同不代表矩阵一定可对角化",
  trapSummary: "只看到有重根就默认能对角化，忘了检查几何重数是否等于代数重数。",
  takeawayRule: "重特征值先算 n - rank(A - λI)，相等才可对角化。",
  cohortSampleSize: 42,
  cohortTrapRate: 67.4,
};

function jsonRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/opening/share", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function streamRequest(body: ReadableStream<Uint8Array>, contentLength?: string) {
  return new Request("http://localhost/api/opening/share", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(contentLength !== undefined ? { "content-length": contentLength } : {}),
    },
    body,
    duplex: "half",
  } as RequestInit);
}

describe("POST /api/opening/share", () => {
  const originalSecret = process.env.AUTH_SECRET;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env.AUTH_SECRET = TEST_SECRET;
    mocks.scope.mockResolvedValue({
      principal: { userId: "u-1", workspaceId: "w-1", sessionId: "s-1" },
      scope: { workspaceId: "w-1", ownerUserId: "u-1" },
      sql: {},
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalSecret === undefined) {
      delete process.env.AUTH_SECRET;
    } else {
      process.env.AUTH_SECRET = originalSecret;
    }
  });

  it("requires authentication before consuming the request stream", async () => {
    mocks.scope.mockRejectedValueOnce(
      new ApiError("UNAUTHENTICATED", "Authentication required", 401),
    );
    let cancelled = false;
    const pull = vi.fn();
    const body = new ReadableStream<Uint8Array>(
      {
        pull,
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );

    const response = await POST(streamRequest(body));
    expect(response.status).toBe(401);
    expect(cancelled).toBe(true);
    expect(pull).not.toHaveBeenCalled();
  });

  it("rejects declared bodies exceeding 16 KiB without reading", async () => {
    let cancelled = false;
    const pull = vi.fn();
    const body = new ReadableStream<Uint8Array>(
      {
        pull,
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );

    const response = await POST(streamRequest(body, String(16 * 1024 + 1)));
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(pull).not.toHaveBeenCalled();
  });

  it.each([undefined, "1"])(
    "rejects streamed bodies exceeding 16 KiB with Content-Length %s",
    async (length) => {
      let cancelled = false;
      const chunk = new Uint8Array(8 * 1024);
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      });

      const response = await POST(streamRequest(body, length));
      expect(response.status).toBe(413);
      expect(cancelled).toBe(true);
    },
  );

  it("mints a verifiable stateless share token with 201 and no-store cache header", async () => {
    const response = await POST(jsonRequest(VALID_PAYLOAD));
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const data = (await response.json()) as {
      token: string;
      sharePath: string;
      expiresAt: string;
    };
    expect(data.sharePath).toBe(`/s/${data.token}`);
    expect(Date.parse(data.expiresAt)).toBeGreaterThan(Date.now());

    const verified = verifyPitfallShareToken(data.token, { authSecret: TEST_SECRET });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.payload.subjectLabel).toBe("线性代数");
      expect(verified.payload.cohortSampleSize).toBe(42);
      expect(verified.payload.cohortTrapRate).toBe(67);
    }
  });

  it("forces cohortTrapRate to null when cohortSampleSize < 30", async () => {
    const response = await POST(
      jsonRequest({ ...VALID_PAYLOAD, cohortSampleSize: 15, cohortTrapRate: 70 }),
    );
    expect(response.status).toBe(201);
    const data = (await response.json()) as { token: string };
    const verified = verifyPitfallShareToken(data.token, { authSecret: TEST_SECRET });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.payload.cohortSampleSize).toBe(15);
      expect(verified.payload.cohortTrapRate).toBeNull();
    }
  });

  it("rejects privacy violations, UUIDs in text, and malformed JSON with 400", async () => {
    const withUserId = await POST(jsonRequest({ ...VALID_PAYLOAD, userId: "u-1" }));
    expect(withUserId.status).toBe(400);

    const withUuid = await POST(
      jsonRequest({
        ...VALID_PAYLOAD,
        trapSummary: "错题 550e8400-e29b-41d4-a716-446655440000 别再错",
      }),
    );
    expect(withUuid.status).toBe(400);

    const invalidJson = await POST(jsonRequest("{bad-json"));
    expect(invalidJson.status).toBe(400);

    const emptyBody = await POST(
      new Request("http://localhost/api/opening/share", { method: "POST" }),
    );
    expect(emptyBody.status).toBe(400);
  });

  it("returns 503 CONFIGURATION when AUTH_SECRET is missing", async () => {
    delete process.env.AUTH_SECRET;
    const response = await POST(jsonRequest(VALID_PAYLOAD));
    expect(response.status).toBe(503);
  });
});
