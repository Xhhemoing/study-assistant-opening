import { getShareablePitfallById } from "@aistudy/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ scope: vi.fn() }));
vi.mock("../../../../features/opening/runtime", () => ({
  requireOpeningScope: mocks.scope,
}));

import { ApiError } from "../../../../features/auth/service";
import { verifyPitfallShareToken } from "../../../../features/opening/share/token-codec";
import { POST } from "./route";

const TEST_SECRET = "route-share-test-secret-0123456789abcdef";
const VALID_PITFALL_ID = "math-linalg-diagonalizable-multiplicity";

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

  it("mints a verifiable stateless share token solely from the server-authoritative catalog", async () => {
    const expectedEntry = getShareablePitfallById(VALID_PITFALL_ID);
    expect(expectedEntry).not.toBeNull();

    const response = await POST(
      jsonRequest({ pitfallId: VALID_PITFALL_ID, expiresInSeconds: 3600 }),
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const data = (await response.json()) as {
      pitfallId: string;
      token: string;
      sharePath: string;
      expiresAt: string;
    };
    expect(data.pitfallId).toBe(VALID_PITFALL_ID);
    expect(data.sharePath).toBe(`/s/${data.token}`);
    expect(Date.parse(data.expiresAt)).toBeGreaterThan(Date.now());

    const verified = verifyPitfallShareToken(data.token, { authSecret: TEST_SECRET });
    expect(verified.ok).toBe(true);
    if (verified.ok && expectedEntry) {
      expect(verified.payload.subjectLabel).toBe(expectedEntry.subjectLabel);
      expect(verified.payload.pitfallTitle).toBe(expectedEntry.pitfallTitle);
      expect(verified.payload.trapSummary).toBe(expectedEntry.trapSummary);
      expect(verified.payload.takeawayRule).toBe(expectedEntry.takeawayRule);
      expect(verified.payload.cohortSampleSize).toBe(0);
      expect(verified.payload.cohortTrapRate).toBeNull();
      expect(verified.payload.exp - verified.payload.iat).toBe(3600);
    }
  });

  it("returns 404 NOT_FOUND for unknown pitfallId", async () => {
    const response = await POST(jsonRequest({ pitfallId: "unknown-pitfall-id" }));
    expect(response.status).toBe(404);
  });

  it("rejects client-forged copy, cohort stats, PII fields, and malformed JSON with 400", async () => {
    const forgedBodies = [
      { pitfallId: VALID_PITFALL_ID, title: "官方认证：点击领券" },
      { pitfallId: VALID_PITFALL_ID, misconception: "伪造错因" },
      { pitfallId: VALID_PITFALL_ID, reframe: "伪造口诀" },
      { pitfallId: VALID_PITFALL_ID, ctaHref: "https://phishing.example" },
      { pitfallId: VALID_PITFALL_ID, pitfallTitle: "伪造标题" },
      { pitfallId: VALID_PITFALL_ID, trapSummary: "伪造摘要" },
      { pitfallId: VALID_PITFALL_ID, takeawayRule: "伪造规则" },
      { pitfallId: VALID_PITFALL_ID, cohortSampleSize: 5000, cohortTrapRate: 99 },
      { pitfallId: VALID_PITFALL_ID, userId: "u-1" },
      { pitfallId: "INVALID_ID_FORMAT" },
      { pitfallId: VALID_PITFALL_ID, expiresInSeconds: 10 },
    ];

    for (const body of forgedBodies) {
      const response = await POST(jsonRequest(body));
      expect(response.status).toBe(400);
    }

    const invalidJson = await POST(jsonRequest("{bad-json"));
    expect(invalidJson.status).toBe(400);

    const emptyBody = await POST(
      new Request("http://localhost/api/opening/share", { method: "POST" }),
    );
    expect(emptyBody.status).toBe(400);
  });

  it("returns 503 CONFIGURATION when AUTH_SECRET is missing, low-entropy, or a placeholder", async () => {
    delete process.env.AUTH_SECRET;
    expect((await POST(jsonRequest({ pitfallId: VALID_PITFALL_ID }))).status).toBe(503);

    process.env.AUTH_SECRET = "a".repeat(32);
    expect((await POST(jsonRequest({ pitfallId: VALID_PITFALL_ID }))).status).toBe(503);

    process.env.AUTH_SECRET = "change-me-0123456789abcdefghijkl";
    expect((await POST(jsonRequest({ pitfallId: VALID_PITFALL_ID }))).status).toBe(503);
  });
});
