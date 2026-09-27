import { beforeEach, describe, expect, it, vi } from "vitest";

const submitTurn = vi.hoisted(() => vi.fn());

vi.mock("../../../../features/opening/runtime", () => ({
  getTutorService: vi.fn(() => ({ submitTurn })),
  requireOpeningScope: vi.fn(async () => ({
    scope: { workspaceId: "workspace", ownerUserId: "owner" },
    sql: {},
  })),
}));

import { POST } from "./route";

const validTurn = {
  conversationId: "11111111-1111-4111-8111-111111111111",
  text: "请解释这个概念",
  sourceIds: [],
  mode: "explain",
  clientKey: "client-key-123",
  privacy: "saved",
};

function post(body: string, contentLength?: string): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (contentLength !== undefined) headers.set("content-length", contentLength);
  return new Request("http://localhost/api/opening/turns", {
    method: "POST",
    headers,
    body,
  });
}

describe("POST /api/opening/turns request boundary", () => {
  beforeEach(() => {
    submitTurn.mockReset();
    submitTurn.mockResolvedValue({ jobId: "job-id", turnId: "turn-id" });
  });

  it("rejects a Content-Length above the Opening JSON limit with the existing error shape", async () => {
    const response = await POST(post(JSON.stringify(validTurn), "131073"));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: { code: "VALIDATION", message: "请求体过大" },
    });
    expect(submitTurn).not.toHaveBeenCalled();
  });

  it("rejects an oversized body when Content-Length is absent", async () => {
    const body = JSON.stringify({ ...validTurn, text: "x".repeat(128 * 1024) });

    const response = await POST(post(body));

    expect(response.status).toBe(413);
    expect(submitTurn).not.toHaveBeenCalled();
  });

  it("rejects an oversized body when Content-Length is misleading", async () => {
    const body = JSON.stringify({ ...validTurn, text: "x".repeat(128 * 1024) });

    const response = await POST(post(body, "1"));

    expect(response.status).toBe(413);
    expect(submitTurn).not.toHaveBeenCalled();
  });

  it("returns a validated request correlation ID", async () => {
    const correlationId = "22222222-2222-4222-8222-222222222222";

    const response = await POST(
      new Request("http://localhost/api/opening/turns", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": correlationId,
        },
        body: JSON.stringify(validTurn),
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      jobId: "job-id",
      turnId: "turn-id",
    });
    expect(response.headers.get("x-request-id")).toBe(correlationId);
  });

  it("rejects an invalid request correlation ID", async () => {
    const response = await POST(
      new Request("http://localhost/api/opening/turns", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": "not-a-uuid",
        },
        body: JSON.stringify(validTurn),
      }),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: { code: "VALIDATION", message: "请求关联 ID 无效" },
    });
    expect(submitTurn).not.toHaveBeenCalled();
  });

  it("allows a legitimate maximum contract text payload", async () => {
    const body = JSON.stringify({
      ...validTurn,
      text: "中".repeat(20_000),
      sourceIds: Array.from(
        { length: 32 },
        (_, index) => `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
      ),
      clientKey: "k".repeat(200),
    });

    const response = await POST(post(body));

    expect(response.status).toBe(201);
    expect(response.headers.get("x-request-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(submitTurn).toHaveBeenCalledOnce();
  });
});
