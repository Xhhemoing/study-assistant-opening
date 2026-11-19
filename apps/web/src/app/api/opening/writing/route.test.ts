import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CourselessActivityOutcome, WritingWorkspaceView } from "@aistudy/contracts";
import { ApiError } from "../../../../features/auth/service";

const mocks = vi.hoisted(() => ({
  requireOpeningScope: vi.fn(),
  start: vi.fn(),
  getView: vi.fn(),
  command: vi.fn(),
  createService: vi.fn(),
}));

vi.mock("../../../../features/opening/runtime", () => ({
  requireOpeningScope: mocks.requireOpeningScope,
}));

vi.mock("../../../../features/opening/server/writing-workspace-service", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../../features/opening/server/writing-workspace-service")
  >();
  return {
    ...actual,
    createWritingWorkspaceService: mocks.createService,
  };
});

import { OpeningWritingError } from "../../../../features/opening/server/writing-workspace-service";
import * as rootRoute from "./route";
import * as docRoute from "./[documentId]/route";

const SCOPE = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  ownerUserId: "22222222-2222-4222-8222-222222222222",
};
const DOC_ID = "33333333-3333-4333-8333-333333333333";
const BLOCK_ID = "44444444-4444-4444-8444-444444444444";
const ACTIVITY_ID = "55555555-5555-4555-8555-555555555555";

const VIEW: WritingWorkspaceView = {
  workGroupId: DOC_ID,
  activityId: ACTIVITY_ID,
  courseId: null,
  currentDocumentId: DOC_ID,
  currentVariant: {
    workGroupId: DOC_ID,
    variantLabel: "初稿",
    parentDocumentId: null,
    parentRevisionNumber: null,
    keptAsPreferred: false,
    focusBlockId: BLOCK_ID,
    assistanceRecords: [],
  },
  variants: [
    {
      documentId: DOC_ID,
      title: "独立写作练习",
      variantLabel: "初稿",
      currentRevisionNumber: 1,
      parentDocumentId: null,
      parentRevisionNumber: null,
      keptAsPreferred: false,
      focusBlockId: BLOCK_ID,
      assistanceCount: 0,
      adoptedPolishCount: 0,
      updatedAt: "2026-11-18T10:00:00.000Z",
    },
  ],
  focusRestore: { status: "exact", blockId: BLOCK_ID },
};

function req(url: string, method: string, body?: string, headers: Record<string, string> = {}) {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body }),
  });
}

const ctx = (documentId = DOC_ID) => ({ params: Promise.resolve({ documentId }) });

describe("/api/opening/writing routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireOpeningScope.mockResolvedValue({ sql: {}, scope: SCOPE });
    mocks.start.mockResolvedValue(VIEW);
    mocks.getView.mockResolvedValue(VIEW);
    mocks.command.mockResolvedValue({ workspace: VIEW });
    mocks.createService.mockReturnValue({
      start: mocks.start,
      getView: mocks.getView,
      command: mocks.command,
    });
  });

  it("POST /api/opening/writing returns 201 WritingWorkspaceView and enforces auth/validation", async () => {
    mocks.requireOpeningScope.mockRejectedValueOnce(
      new ApiError("UNAUTHENTICATED", "Authentication required", 401),
    );
    const unauth = await rootRoute.POST(
      req("http://localhost/api/opening/writing", "POST", JSON.stringify({ clientKey: "writing-key-1", title: "写作" })),
    );
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get("cache-control")).toBe("private, no-store");

    const badJson = await rootRoute.POST(
      req("http://localhost/api/opening/writing", "POST", "{bad"),
    );
    expect(badJson.status).toBe(400);

    const badSchema = await rootRoute.POST(
      req("http://localhost/api/opening/writing", "POST", JSON.stringify({ clientKey: "short", title: "" })),
    );
    expect(badSchema.status).toBe(400);
    expect(mocks.start).not.toHaveBeenCalled();

    const payload = { clientKey: "writing-key-1", title: "独立写作练习", initialText: "首段" };
    const created = await rootRoute.POST(
      req("http://localhost/api/opening/writing", "POST", JSON.stringify(payload)),
    );
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("private, no-store");
    await expect(created.json()).resolves.toEqual(VIEW);
    expect(mocks.start).toHaveBeenCalledWith(SCOPE, payload);
  });

  it("GET /api/opening/writing/[documentId] handles initialized false/true and forwards query params", async () => {
    const invalidDoc = await docRoute.GET(
      req("http://localhost/api/opening/writing/not-uuid", "GET"),
      ctx("not-uuid"),
    );
    expect(invalidDoc.status).toBe(400);

    const invalidActivity = await docRoute.GET(
      req(`http://localhost/api/opening/writing/${DOC_ID}?activity=bad`, "GET"),
      ctx(),
    );
    expect(invalidActivity.status).toBe(400);

    mocks.getView.mockResolvedValueOnce(null);
    const uninitialized = await docRoute.GET(
      req(`http://localhost/api/opening/writing/${DOC_ID}`, "GET"),
      ctx(),
    );
    expect(uninitialized.status).toBe(200);
    await expect(uninitialized.json()).resolves.toEqual({ initialized: false, documentId: DOC_ID });

    const initialized = await docRoute.GET(
      req(`http://localhost/api/opening/writing/${DOC_ID}?focusBlock=${BLOCK_ID}&activity=${ACTIVITY_ID}`, "GET"),
      ctx(),
    );
    expect(initialized.status).toBe(200);
    expect(initialized.headers.get("cache-control")).toBe("private, no-store");
    await expect(initialized.json()).resolves.toEqual({ initialized: true, workspace: VIEW });
    expect(mocks.getView).toHaveBeenCalledWith(SCOPE, DOC_ID, {
      requestedFocusBlockId: BLOCK_ID,
      activityId: ACTIVITY_ID,
    });
  });

  it("POST /api/opening/writing/[documentId] executes commands and maps domain errors cleanly", async () => {
    const outcome: CourselessActivityOutcome = {
      activityId: ACTIVITY_ID,
      courseId: null,
      documentId: DOC_ID,
      revisionNumber: 2,
      assistance: "revealed",
      adoptedPolishCount: 1,
      keptAsPreferred: false,
      evidenceVerdict: "MASTERY_NOT_ESTABLISHED",
    };
    mocks.command.mockResolvedValueOnce({ workspace: VIEW, outcome });

    const cmdBody = {
      action: "adopt_suggestion",
      expectedRevisionNumber: 1,
      assistanceId: "66666666-6666-4666-8666-666666666666",
      targetBlockId: BLOCK_ID,
      replacementText: "润色后的表达",
    };
    const res = await docRoute.POST(
      req(`http://localhost/api/opening/writing/${DOC_ID}`, "POST", JSON.stringify(cmdBody)),
      ctx(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    await expect(res.json()).resolves.toEqual({ workspace: VIEW, outcome });
    expect(mocks.command).toHaveBeenCalledWith(SCOPE, DOC_ID, cmdBody);

    mocks.command.mockRejectedValueOnce(new OpeningWritingError("CONFLICT", "版本冲突"));
    const conflict = await docRoute.POST(
      req(`http://localhost/api/opening/writing/${DOC_ID}`, "POST", JSON.stringify({ action: "save_checkpoint", focusBlockId: null })),
      ctx(),
    );
    expect(conflict.status).toBe(409);
    expect(conflict.headers.get("cache-control")).toBe("private, no-store");

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      mocks.command.mockRejectedValueOnce(new Error("internal sql detail"));
      const err = await docRoute.POST(
        req(`http://localhost/api/opening/writing/${DOC_ID}`, "POST", JSON.stringify({ action: "save_checkpoint", focusBlockId: null })),
        ctx(),
      );
      expect(err.status).toBe(500);
      const errBody = await err.json();
      expect(JSON.stringify(errBody)).not.toContain("internal sql detail");
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
