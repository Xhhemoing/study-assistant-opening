import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    // PR-H: the teaching-loop API is server-gated; these cases run with it enabled.
    vi.stubEnv("OPENING_TEACHING_LOOP", "1");
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
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ["off", {}],
    ["rollout 0", { OPENING_TEACHING_LOOP: "1", OPENING_TEACHING_LOOP_ROLLOUT_PERCENT: "0" }],
  ])("PR-H: 404 and no service call when the loop API is %s (hidden UI is not the gate)", async (_label, env: Record<string, string>) => {
    vi.stubEnv("OPENING_TEACHING_LOOP", env.OPENING_TEACHING_LOOP ?? "0");
    if (env.OPENING_TEACHING_LOOP_ROLLOUT_PERCENT) vi.stubEnv("OPENING_TEACHING_LOOP_ROLLOUT_PERCENT", env.OPENING_TEACHING_LOOP_ROLLOUT_PERCENT);
    requireOpeningScope.mockResolvedValue({ scope: { workspaceId: "w", ownerUserId: "u" }, sql: {} });
    const res = await POST(new Request("http://x", { method: "POST", body: "{}" }), { params: Promise.resolve({ id: activityId }) });
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: { code: "NOT_FOUND", message: "Not found" } });
    expect(saveCheckpoint).not.toHaveBeenCalled();
  });
});
