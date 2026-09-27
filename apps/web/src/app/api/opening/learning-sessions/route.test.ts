import { beforeEach, describe, expect, it, vi } from "vitest";

const createLearningSession = vi.hoisted(() => vi.fn());

vi.mock("../../../../features/opening/runtime", () => ({
  getObservationService: vi.fn(() => ({ createLearningSession })),
  requireOpeningScope: vi.fn(async () => ({
    scope: { workspaceId: "workspace", ownerUserId: "owner" },
    sql: {},
  })),
}));

import { POST } from "./route";

const validBody = {
  courseId: "11111111-1111-4111-8111-111111111111",
  skillLabel: "链式法则",
  sourceIds: [],
};

function post(body: string, contentLength?: string): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (contentLength !== undefined) headers.set("content-length", contentLength);
  return new Request("http://localhost/api/opening/learning-sessions", {
    method: "POST",
    headers,
    body,
  });
}

describe("POST /api/opening/learning-sessions request boundary", () => {
  beforeEach(() => {
    createLearningSession.mockReset();
    createLearningSession.mockResolvedValue({ id: "session-id" });
  });

  it("rejects an oversized body before schema validation or service work", async () => {
    const response = await POST(post("{}", "131073"));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: { code: "VALIDATION", message: "请求体过大" },
    });
    expect(createLearningSession).not.toHaveBeenCalled();
  });

  it("accepts a legitimate schema-valid body", async () => {
    const response = await POST(post(JSON.stringify(validBody)));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ id: "session-id" });
    expect(createLearningSession).toHaveBeenCalledWith(
      { workspaceId: "workspace", ownerUserId: "owner" },
      validBody,
    );
  });
});
