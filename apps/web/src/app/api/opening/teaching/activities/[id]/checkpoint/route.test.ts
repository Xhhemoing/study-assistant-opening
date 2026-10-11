import { beforeEach, describe, expect, it, vi } from "vitest";

const saveCheckpoint = vi.fn();
const requireOpeningScope = vi.fn();
const readOpeningJsonBody = vi.fn();
const jsonError = vi.fn((err: unknown) => Response.json(err, { status: 400 }));
const mapDomainError = vi.fn((err: unknown) => err);

vi.mock("../../../../../../../features/opening/runtime", () => ({
  requireOpeningScope: (...args: unknown[]) => requireOpeningScope(...args),
  getTeachingResumeService: () => ({ saveCheckpoint }),
}));

vi.mock("../../../../../../../features/opening/request-body", () => ({
  readOpeningJsonBody: (...args: unknown[]) => readOpeningJsonBody(...args),
}));

vi.mock("../../../../../../../features/auth/service", () => ({
  jsonError: (...args: unknown[]) => jsonError(...args),
  mapDomainError: (...args: unknown[]) => mapDomainError(...args),
}));

import { POST } from "./route";

const activityId = "11111111-1111-4111-8111-111111111111";

describe("POST /api/opening/teaching/activities/[id]/checkpoint (T17)", () => {
  beforeEach(() => {
    saveCheckpoint.mockReset();
    requireOpeningScope.mockReset();
    readOpeningJsonBody.mockReset();
  });

  it("returns 200 on ok checkpoint save", async () => {
    requireOpeningScope.mockResolvedValue({
      scope: { workspaceId: "w", ownerUserId: "u" },
      sql: {},
    });
    readOpeningJsonBody.mockResolvedValue({ expectedVersion: 1 });
    saveCheckpoint.mockResolvedValue({
      ok: true,
      contentVersion: 1,
      checkpointJson: { drafts: [] },
    });
    const res = await POST(new Request("http://localhost/checkpoint"), {
      params: Promise.resolve({ id: activityId }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("returns 409 on draft_anchor_lost", async () => {
    requireOpeningScope.mockResolvedValue({
      scope: { workspaceId: "w", ownerUserId: "u" },
      sql: {},
    });
    readOpeningJsonBody.mockResolvedValue({ expectedVersion: 1, drafts: [] });
    saveCheckpoint.mockResolvedValue({
      ok: false,
      mismatch: "draft_anchor_lost",
      lostBlockIds: ["22222222-2222-4222-8222-222222222222"],
    });
    const res = await POST(new Request("http://localhost/checkpoint"), {
      params: Promise.resolve({ id: activityId }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.mismatch).toBe("draft_anchor_lost");
  });
});
