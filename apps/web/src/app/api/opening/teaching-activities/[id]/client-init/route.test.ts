import { beforeEach, describe, expect, it, vi } from "vitest";

const getClientInit = vi.hoisted(() => vi.fn());

vi.mock("../../../../../../features/opening/runtime", () => ({
  getTeachingContentService: vi.fn(() => ({ getClientInit })),
  requireOpeningScope: vi.fn(async () => ({
    scope: { workspaceId: "workspace", ownerUserId: "owner" },
    sql: {},
  })),
}));

import { GET } from "./route";

const AID = "11111111-1111-4111-8111-111111111111";
const SPEC = "88888888-8888-4888-8888-888888888888";
const UNIT = "77777777-7777-4777-8777-777777777777";
const DOC = "66666666-6666-4666-8666-666666666666";
const BID = "44444444-4444-4444-8444-444444444444";
const ISO = "2026-10-11T04:00:00.000Z";

const clientInit = {
  id: SPEC,
  activityId: AID,
  teachingUnitId: UNIT,
  documentId: DOC,
  revisionNumber: 1,
  blockOrder: [{ blockId: BID, position: 0, blockType: "text", role: "teach" }],
  sourceRefs: [],
  goals: [],
  verificationStatus: "unchecked",
  generationConfig: {},
  version: 1,
  createdAt: ISO,
  updatedAt: ISO,
  blocks: [
    {
      blockId: BID,
      position: 0,
      blockType: "text",
      role: "teach",
      content: { text: "hello" },
    },
  ],
  contentVersion: 1,
};

describe("GET /api/opening/teaching-activities/[id]/client-init", () => {
  beforeEach(() => {
    getClientInit.mockReset();
    getClientInit.mockResolvedValue(clientInit);
  });

  it("returns zod-parsed clientInit for the opening scope", async () => {
    const response = await GET(
      new Request(`http://localhost/api/opening/teaching-activities/${AID}/client-init`),
      { params: Promise.resolve({ id: AID }) },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.activityId).toBe(AID);
    expect(body.blocks[0]?.content).toEqual({ text: "hello" });
    expect(getClientInit).toHaveBeenCalledWith(
      { workspaceId: "workspace", ownerUserId: "owner" },
      AID,
    );
  });

  it("maps service errors via jsonError", async () => {
    const { ApiError } = await import("../../../../../../features/auth/service");
    getClientInit.mockRejectedValue(new ApiError("NOT_FOUND", "activity spec not found", 404));
    const response = await GET(
      new Request(`http://localhost/api/opening/teaching-activities/${AID}/client-init`),
      { params: Promise.resolve({ id: AID }) },
    );
    expect(response.status).toBe(404);
  });
});
