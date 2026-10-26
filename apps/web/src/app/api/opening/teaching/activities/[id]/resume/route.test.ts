import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getResume = vi.fn();
const requireOpeningScope = vi.fn();
const jsonError = vi.fn((err: unknown) => Response.json(err, { status: 400 }));
const mapDomainError = vi.fn((err: unknown) => err);

vi.mock("../../../../../../../features/opening/runtime", () => ({
  requireOpeningScope: (...args: unknown[]) => requireOpeningScope(...args),
  getTeachingResumeService: () => ({ getResume }),
}));

vi.mock("../../../../../../../features/auth/service", () => ({
  jsonError: (...args: unknown[]) => jsonError(...args),
  mapDomainError: (...args: unknown[]) => mapDomainError(...args),
}));

import { GET } from "./route";

const activityId = "11111111-1111-4111-8111-111111111111";
const blockId = "22222222-2222-4222-8222-222222222222";

function sampleResume() {
  return {
    activityId,
    status: "paused",
    generateStatus: "ready",
    contentVersion: 1,
    pathVersion: 1,
    clientInit: null,
    thoughtTrain: {
      currentBlockId: blockId,
      skippedBlockIds: [],
      branchStack: [],
      commandLog: [],
    },
    drafts: [],
    interactionParams: {},
    actualAttempts: [],
    helpDelivered: [],
    openProblems: [],
    gates: {
      permission: "owned",
      materials: "available",
      unavailableSourceIds: [],
      job: "ready",
    },
    continuableActions: ["continue_block"],
    summary: { status: "skipped" },
  };
}

describe("GET /api/opening/teaching/activities/[id]/resume (T17)", () => {
  beforeEach(() => {
    // PR-H: the teaching-loop API is server-gated; these cases run with it enabled.
    vi.stubEnv("OPENING_TEACHING_LOOP", "1");
    getResume.mockReset();
    requireOpeningScope.mockReset();
    jsonError.mockClear();
    mapDomainError.mockClear();
  });

  it("returns zod-validated LearningResume with no-store", async () => {
    vi.stubEnv("OPENING_TEACHING_LOOP_ROLLOUT_PERCENT", "0");
    requireOpeningScope.mockResolvedValue({
      scope: { workspaceId: "w", ownerUserId: "u" },
      sql: {},
    });
    getResume.mockResolvedValue(sampleResume());
    const res = await GET(new Request("http://localhost/resume"), {
      params: Promise.resolve({ id: activityId }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body.activityId).toBe(activityId);
    expect(body.gates.permission).toBe("owned");
    expect(body).not.toHaveProperty("conversationId");
  });

  it("maps auth/domain errors", async () => {
    requireOpeningScope.mockRejectedValue({ code: "UNAUTHORIZED" });
    mapDomainError.mockReturnValue({ code: "UNAUTHORIZED", status: 401 });
    jsonError.mockReturnValue(Response.json({ code: "UNAUTHORIZED" }, { status: 401 }));
    const res = await GET(new Request("http://localhost/resume"), {
      params: Promise.resolve({ id: activityId }),
    });
    expect(res.status).toBe(401);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ["off", {}],
    ["off with retired rollout value", { OPENING_TEACHING_LOOP: "0", OPENING_TEACHING_LOOP_ROLLOUT_PERCENT: "0" }],
  ])("PR-H: 404 and no service call when the loop API is %s (hidden UI is not the gate)", async (_label, env: Record<string, string>) => {
    vi.stubEnv("OPENING_TEACHING_LOOP", env.OPENING_TEACHING_LOOP ?? "0");
    if (env.OPENING_TEACHING_LOOP_ROLLOUT_PERCENT) vi.stubEnv("OPENING_TEACHING_LOOP_ROLLOUT_PERCENT", env.OPENING_TEACHING_LOOP_ROLLOUT_PERCENT);
    requireOpeningScope.mockResolvedValue({ scope: { workspaceId: "w", ownerUserId: "u" }, sql: {} });
    const res = await GET(new Request("http://x"), { params: Promise.resolve({ id: activityId }) });
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: { code: "NOT_FOUND", message: "Not found" } });
    expect(getResume).not.toHaveBeenCalled();
  });
});
