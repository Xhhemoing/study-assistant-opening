import { beforeEach, describe, expect, it, vi } from "vitest";

const createConversation = vi.hoisted(() => vi.fn());

vi.mock("../../../../features/opening/runtime", () => ({
  getTutorService: vi.fn(() => ({ createConversation })),
  requireOpeningScope: vi.fn(async () => ({
    scope: { workspaceId: "workspace", ownerUserId: "owner" },
    sql: {},
  })),
}));

import { POST } from "./route";

function post(body: string, contentLength?: string): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (contentLength !== undefined) headers.set("content-length", contentLength);
  return new Request("http://localhost/api/opening/conversations", {
    method: "POST",
    headers,
    body,
  });
}

describe("POST /api/opening/conversations request boundary", () => {
  beforeEach(() => {
    createConversation.mockReset();
    createConversation.mockResolvedValue({ id: "conversation-id" });
  });

  it("rejects a Content-Length above the Opening JSON limit", async () => {
    const response = await POST(post("{}", "131073"));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: { code: "VALIDATION", message: "请求体过大" },
    });
    expect(createConversation).not.toHaveBeenCalled();
  });

  it("accepts a legitimate JSON body", async () => {
    const body = { title: "New conversation" };

    const response = await POST(post(JSON.stringify(body)));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ id: "conversation-id" });
    expect(createConversation).toHaveBeenCalledWith(
      { workspaceId: "workspace", ownerUserId: "owner" },
      body,
    );
  });
});
