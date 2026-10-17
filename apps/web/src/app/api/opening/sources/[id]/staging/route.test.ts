import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  scope: vi.fn(),
  getStagingPutTarget: vi.fn(),
  putStagingStream: vi.fn(),
}));

vi.mock("../../../../../../features/opening/runtime", () => ({
  requireOpeningScope: mocks.scope,
}));

vi.mock("../../../../../../features/opening/sources/source-service", () => ({
  createOpeningSourceService: () => ({
    getStagingPutTarget: mocks.getStagingPutTarget,
    putStagingStream: mocks.putStagingStream,
  }),
}));

import { ApiError } from "../../../../../../features/auth/service";
import { OpeningSourceError, OpeningStorageError } from "@aistudy/database";
import { UploadPolicyError } from "../../../../../../features/opening/sources/upload-policy";
import { PUT } from "./route";

const SOURCE_ID = "00000000-0000-4000-8000-0000000000aa";
const principal = {
  userId: "u",
  workspaceId: "w",
  sessionId: "s",
};

function putRequest(body: Uint8Array, headers: Record<string, string> = {}) {
  return new Request(`http://localhost/api/opening/sources/${SOURCE_ID}/staging`, {
    method: "PUT",
    headers: {
      "content-type": "application/pdf",
      "content-length": String(body.byteLength),
      ...headers,
    },
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.scope.mockResolvedValue({ principal, sql: {} });
  mocks.getStagingPutTarget.mockResolvedValue({
    bytes: 4,
    mime: "application/pdf",
  });
  mocks.putStagingStream.mockResolvedValue({ ok: true });
});

describe("PUT /api/opening/sources/:id/staging", () => {
  it("stores the body and returns 204", async () => {
    const body = new Uint8Array([1, 2, 3, 4]);
    const response = await PUT(putRequest(body), {
      params: Promise.resolve({ id: SOURCE_ID }),
    });
    expect(response.status).toBe(204);
    expect(mocks.getStagingPutTarget).toHaveBeenCalledWith(principal, SOURCE_ID);
    expect(mocks.putStagingStream).toHaveBeenCalledWith(principal, SOURCE_ID, {
      contentType: "application/pdf",
      body: expect.any(ReadableStream),
      signal: expect.any(AbortSignal),
    });
  });

  it("passes the original unread stream through when Content-Length is absent", async () => {
    const request = putRequest(new Uint8Array([1, 2, 3, 4]));
    request.headers.delete("content-length");
    mocks.putStagingStream.mockImplementationOnce(async (_principal, _id, input) => {
      expect(input.body).toBe(request.body);
      expect(request.bodyUsed).toBe(false);
      return { ok: true };
    });
    expect((await PUT(request, { params: Promise.resolve({ id: SOURCE_ID }) })).status).toBe(204);
  });

  it.each(["3", "invalid"])("rejects invalid or incomplete declared length %s before starting storage", async (length) => {
    const response = await PUT(putRequest(new Uint8Array([1, 2, 3, 4]), { "content-length": length }), { params: Promise.resolve({ id: SOURCE_ID }) });
    expect(response.status).toBe(400);
    expect(mocks.putStagingStream).not.toHaveBeenCalled();
  });

  it("rejects declared Content-Length above the expected bytes with 413", async () => {
    const body = new Uint8Array([1, 2, 3, 4, 5]);
    const response = await PUT(
      putRequest(body, { "content-length": "5" }),
      { params: Promise.resolve({ id: SOURCE_ID }) },
    );
    expect(response.status).toBe(413);
    expect(mocks.putStagingStream).not.toHaveBeenCalled();
  });

  it("maps UploadPolicyError to 400", async () => {
    mocks.putStagingStream.mockRejectedValue(new UploadPolicyError("request mime mismatch"));
    const response = await PUT(putRequest(new Uint8Array([1, 2, 3, 4])), {
      params: Promise.resolve({ id: SOURCE_ID }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: "request mime mismatch" },
    });
  });

  it("maps missing/not-pending sources to 404", async () => {
    mocks.getStagingPutTarget.mockRejectedValue(
      new OpeningSourceError("NOT_FOUND", "source is not pending"),
    );
    const response = await PUT(putRequest(new Uint8Array([1, 2, 3, 4])), {
      params: Promise.resolve({ id: SOURCE_ID }),
    });
    expect(response.status).toBe(404);
  });

  it("maps storage failures to 503", async () => {
    mocks.putStagingStream.mockRejectedValue(
      new OpeningStorageError("UNAVAILABLE", "storage service unavailable"),
    );
    const response = await PUT(putRequest(new Uint8Array([1, 2, 3, 4])), {
      params: Promise.resolve({ id: SOURCE_ID }),
    });
    expect(response.status).toBe(503);
  });

  it("requires authentication", async () => {
    mocks.scope.mockRejectedValue(
      new ApiError("UNAUTHENTICATED", "Authentication required", 401),
    );
    const response = await PUT(putRequest(new Uint8Array([1, 2, 3, 4])), {
      params: Promise.resolve({ id: SOURCE_ID }),
    });
    expect(response.status).toBe(401);
    expect(mocks.putStagingStream).not.toHaveBeenCalled();
  });
});
