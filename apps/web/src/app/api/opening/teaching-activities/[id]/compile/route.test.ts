import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../../../../features/auth/service";

const requestCompile = vi.hoisted(() => vi.fn());

vi.mock("../../../../../../features/opening/runtime", () => ({
  getTeachingActivityService: vi.fn(() => ({ requestCompile })),
  requireOpeningScope: vi.fn(async () => ({
    scope: { workspaceId: "workspace", ownerUserId: "owner" },
    sql: {},
  })),
}));

import { POST } from "./route";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";

function post(body: unknown): Request {
  return new Request(`http://localhost/api/opening/teaching-activities/${id}/compile`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/opening/teaching-activities/[id]/compile", () => {
  beforeEach(() => {
    requestCompile.mockReset();
  });

  it("queues generation and answers 202 with the queued activity", async () => {
    requestCompile.mockResolvedValue({ activity: { id, generateStatus: "queued" }, jobId: "job-1" });
    const response = await POST(post({ clientKey: "compile:abc123" }), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ activity: { id, generateStatus: "queued" }, jobId: "job-1" });
    expect(requestCompile).toHaveBeenCalledWith(
      { workspaceId: "workspace", ownerUserId: "owner" },
      id,
      { clientKey: "compile:abc123" },
    );
  });

  it("surfaces a conflict (already generating / has content) as 409", async () => {
    requestCompile.mockRejectedValue(new ApiError("CONFLICT", "teaching content is already being generated", 409));
    const response = await POST(post({ clientKey: "compile:abc123" }), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(409);
  });

  it("surfaces a disabled compiler as 503 CONFIGURATION", async () => {
    requestCompile.mockRejectedValue(new ApiError("CONFIGURATION", "主讲内容生成未开启", 503));
    const response = await POST(post({ clientKey: "compile:abc123" }), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "CONFIGURATION" } });
  });
});
