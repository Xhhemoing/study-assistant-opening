import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  scope: vi.fn(),
  getDownloadStream: vi.fn(),
}));

vi.mock("../../../../../../features/opening/runtime", () => ({
  requireOpeningScope: mocks.scope,
}));

vi.mock("../../../../../../features/opening/sources/source-service", () => ({
  createOpeningSourceService: () => ({
    getDownloadStream: mocks.getDownloadStream,
  }),
}));

import { ApiError } from "../../../../../../features/auth/service";
import { OpeningSourceError, OpeningStorageError } from "@aistudy/database";
import { GET } from "./route";

const SOURCE_ID = "00000000-0000-4000-8000-0000000000aa";
const principal = { userId: "u", workspaceId: "w", sessionId: "s" };

function getRequest(version?: number) {
  const url =
    version === undefined
      ? `http://localhost/api/opening/sources/${SOURCE_ID}/download`
      : `http://localhost/api/opening/sources/${SOURCE_ID}/download?version=${version}`;
  return new Request(url, { method: "GET" });
}

function bytesStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.scope.mockResolvedValue({ principal, sql: {} });
  mocks.getDownloadStream.mockResolvedValue({
    body: bytesStream(new Uint8Array([1, 2, 3])),
    contentType: "application/pdf",
    contentLength: 3,
    contentDisposition: 'attachment; filename="doc.pdf"; filename*=UTF-8\'\'doc.pdf',
    version: 0,
    currentVersion: 0,
    versionMismatch: false,
  });
});

describe("GET /api/opening/sources/:id/download", () => {
  it("streams bytes with disposition headers and never embeds MinIO hosts", async () => {
    const response = await GET(getRequest(0), {
      params: Promise.resolve({ id: SOURCE_ID }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Content-Disposition")).toContain("attachment");
    expect(response.headers.get("Content-Length")).toBe("3");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Opening-Source-Version")).toBe("0");
    expect(response.headers.get("X-Opening-Source-Current-Version")).toBe("0");
    expect(response.headers.get("X-Opening-Source-Version-Mismatch")).toBe("0");

    const body = Buffer.from(await response.arrayBuffer());
    expect(body.equals(Buffer.from([1, 2, 3]))).toBe(true);

    const headerBlob = [...response.headers.entries()].flat().join(" ");
    expect(headerBlob).not.toContain("127.0.0.1:9000");
    expect(headerBlob).not.toContain(":9000");
    // Body is binary — ensure no JSON url payload leaked
    const asText = body.toString("utf8");
    expect(asText).not.toContain("127.0.0.1:9000");
    expect(asText).not.toContain("presign");
    expect(mocks.getDownloadStream).toHaveBeenCalledWith(principal, SOURCE_ID, 0);
  });

  it("rejects a non-integer version with 422", async () => {
    const response = await GET(
      new Request(`http://localhost/api/opening/sources/${SOURCE_ID}/download?version=nope`, {
        method: "GET",
      }),
      { params: Promise.resolve({ id: SOURCE_ID }) },
    );
    expect(response.status).toBe(422);
    expect(mocks.getDownloadStream).not.toHaveBeenCalled();
  });

  it("maps missing versions to 404", async () => {
    mocks.getDownloadStream.mockRejectedValue(
      new OpeningSourceError("NOT_FOUND", "cited source version is unavailable"),
    );
    const response = await GET(getRequest(9), {
      params: Promise.resolve({ id: SOURCE_ID }),
    });
    expect(response.status).toBe(404);
  });

  it("maps storage failures to 503", async () => {
    mocks.getDownloadStream.mockRejectedValue(
      new OpeningStorageError("UNAVAILABLE", "storage service unavailable"),
    );
    const response = await GET(getRequest(), {
      params: Promise.resolve({ id: SOURCE_ID }),
    });
    expect(response.status).toBe(503);
  });

  it("requires authentication", async () => {
    mocks.scope.mockRejectedValue(
      new ApiError("UNAUTHENTICATED", "Authentication required", 401),
    );
    const response = await GET(getRequest(), {
      params: Promise.resolve({ id: SOURCE_ID }),
    });
    expect(response.status).toBe(401);
    expect(mocks.getDownloadStream).not.toHaveBeenCalled();
  });
});
