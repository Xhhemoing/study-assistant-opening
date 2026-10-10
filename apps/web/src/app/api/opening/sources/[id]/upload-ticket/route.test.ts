import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  scope: vi.fn(),
  reissueUploadTicket: vi.fn(),
}));

vi.mock("../../../../../../features/opening/runtime", () => ({
  requireOpeningScope: mocks.scope,
}));

vi.mock("../../../../../../features/opening/sources/source-service", () => ({
  createOpeningSourceService: () => ({
    reissueUploadTicket: mocks.reissueUploadTicket,
  }),
}));

import { ApiError } from "../../../../../../features/auth/service";
import { OpeningSourceError } from "@aistudy/database";
import { POST } from "./route";

const SOURCE_ID = "00000000-0000-4000-8000-0000000000aa";
const principal = { userId: "u", workspaceId: "w", sessionId: "s" };

function postRequest() {
  return new Request(`http://localhost/api/opening/sources/${SOURCE_ID}/upload-ticket`, {
    method: "POST",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.scope.mockResolvedValue({ principal, sql: {} });
  mocks.reissueUploadTicket.mockResolvedValue({
    source: {
      id: SOURCE_ID,
      workspaceId: "w",
      name: "a.pdf",
      mime: "application/pdf",
      bytes: 4,
      sha256: "a".repeat(64),
      version: 0,
      uploadState: "pending",
      parseState: "not_started",
      error: null,
      createdAt: "2026-10-10T12:00:00.000Z",
    },
    uploadUrl: `http://127.0.0.1:3000/api/opening/sources/${SOURCE_ID}/staging`,
    expiresAt: "2026-10-10T12:15:00.000Z",
  });
});

describe("POST /api/opening/sources/:id/upload-ticket", () => {
  it("returns a refreshed same-origin staging ticket", async () => {
    const response = await POST(postRequest(), {
      params: Promise.resolve({ id: SOURCE_ID }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.source.id).toBe(SOURCE_ID);
    expect(body.uploadUrl).toBe(
      `http://127.0.0.1:3000/api/opening/sources/${SOURCE_ID}/staging`,
    );
    expect(body.uploadUrl).toContain("/api/opening/sources/");
    expect(body.uploadUrl).toContain("/staging");
    expect(body.uploadUrl).not.toContain(":9000");
    expect(body.expiresAt).toBe("2026-10-10T12:15:00.000Z");
    expect(mocks.reissueUploadTicket).toHaveBeenCalledWith(principal, SOURCE_ID);
  });

  it("maps non-pending sources to 409", async () => {
    mocks.reissueUploadTicket.mockRejectedValue(
      new OpeningSourceError("CONFLICT", "Upload is no longer pending"),
    );
    const response = await POST(postRequest(), {
      params: Promise.resolve({ id: SOURCE_ID }),
    });
    expect(response.status).toBe(409);
  });

  it("maps missing sources to 404", async () => {
    mocks.reissueUploadTicket.mockRejectedValue(
      new OpeningSourceError("NOT_FOUND", "Source not found"),
    );
    const response = await POST(postRequest(), {
      params: Promise.resolve({ id: SOURCE_ID }),
    });
    expect(response.status).toBe(404);
  });

  it("requires authentication", async () => {
    mocks.scope.mockRejectedValue(
      new ApiError("UNAUTHENTICATED", "Authentication required", 401),
    );
    const response = await POST(postRequest(), {
      params: Promise.resolve({ id: SOURCE_ID }),
    });
    expect(response.status).toBe(401);
    expect(mocks.reissueUploadTicket).not.toHaveBeenCalled();
  });
});
