import { beforeEach, describe, expect, it, vi } from "vitest";

const list = vi.hoisted(() => vi.fn());
const create = vi.hoisted(() => vi.fn());

vi.mock("../../../../features/opening/runtime", () => ({
  getTeachingActivityService: vi.fn(() => ({ list, create })),
  requireOpeningScope: vi.fn(async () => ({
    scope: { workspaceId: "workspace", ownerUserId: "owner" },
    sql: {},
  })),
}));

import { GET, POST } from "./route";

function post(body: string, contentLength?: string): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (contentLength !== undefined) headers.set("content-length", contentLength);
  return new Request("http://localhost/api/opening/teaching-activities", {
    method: "POST",
    headers,
    body,
  });
}

describe("GET/POST /api/opening/teaching-activities", () => {
  beforeEach(() => {
    list.mockReset();
    create.mockReset();
    list.mockResolvedValue([{ id: "activity-1" }]);
    create.mockResolvedValue({ id: "activity-1", intentSummary: "今日主题学习" });
  });

  it("lists activities for the opening scope", async () => {
    const response = await GET(new Request("http://localhost/api/opening/teaching-activities"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([{ id: "activity-1" }]);
    expect(list).toHaveBeenCalledWith({ workspaceId: "workspace", ownerUserId: "owner" });
  });

  it("rejects a Content-Length above the Opening JSON limit", async () => {
    const response = await POST(post("{}", "131073"));
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: { code: "VALIDATION", message: "请求体过大" },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("creates an activity from a legitimate JSON body", async () => {
    const body = {
      clientKey: "today-start-2026-10-11",
      intentKind: "topic",
      intentSummary: "今日主题学习",
      createIntent: { intentKind: "topic", source: "today" },
    };
    const response = await POST(post(JSON.stringify(body)));
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      id: "activity-1",
      intentSummary: "今日主题学习",
    });
    expect(create).toHaveBeenCalledWith(
      { workspaceId: "workspace", ownerUserId: "owner" },
      body,
    );
  });
});
