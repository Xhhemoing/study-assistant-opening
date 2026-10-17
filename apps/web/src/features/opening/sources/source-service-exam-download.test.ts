import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import type { SourceRecord } from "@aistudy/contracts";
import type { OpeningStorage } from "@aistudy/database";
import { createOpeningSourceService } from "./source-service";

const mocks = vi.hoisted(() => ({ get: vi.fn(), publicSource: vi.fn() }));
vi.mock("@aistudy/database", async importOriginal => ({
  ...await importOriginal<typeof import("@aistudy/database")>(),
  createOpeningSourceRepository: () => ({ get: mocks.get }),
  createOpeningSourceActionsRepository: () => ({}), createOpeningPrivacyRepository: () => ({}),
  readOpeningExamPublicSource: mocks.publicSource,
}));
const principal = { userId: "owner", workspaceId: "workspace", sessionId: "session" };
const source: SourceRecord = { id: "source", workspaceId: "workspace", name: "Math I public lessons.txt", mime: "text/plain",
  bytes: 1, sha256: "a".repeat(64), version: 0, uploadState: "uploaded", parseState: "ready", error: null,
  createdAt: "2026-10-17T12:00:00.000Z" };
beforeEach(() => { vi.clearAllMocks(); mocks.get.mockResolvedValue(source); mocks.publicSource.mockResolvedValue(null); });
function setup() {
  const getObjectStream = vi.fn().mockResolvedValue({ body: new ReadableStream<Uint8Array>(), contentType: "text/plain", contentLength: 1 });
  const storage = { finalKey: (id: string, version: number) => `${id}/${version}`, getObjectStream } as unknown as OpeningStorage;
  return { service: createOpeningSourceService({} as Sql, storage), getObjectStream };
}

describe("public exam lesson download", () => {
  it("serves verified public text through the same-origin stream without looking for an S3 object", async () => {
    const text = "数学串讲\n\n公开例题", bytes = Buffer.byteLength(text, "utf8");
    mocks.publicSource.mockResolvedValue({ text, bytes });
    const { service, getObjectStream } = setup();
    const result = await service.getDownloadStream(principal, "source");
    expect(await new Response(result.body).text()).toBe(text);
    expect(result).toMatchObject({ contentType: "text/plain", contentLength: bytes, version: 0, currentVersion: 0, versionMismatch: false });
    expect(result.contentDisposition).toContain("attachment");
    expect(mocks.publicSource).toHaveBeenCalledWith({}, { workspaceId: "workspace", ownerUserId: "owner" }, "source", 0);
    expect(getObjectStream).not.toHaveBeenCalled();
  });
  it("keeps ordinary text uploads on S3 and propagates storage failures", async () => {
    const { service, getObjectStream } = setup();
    await service.getDownloadStream(principal, "source");
    expect(getObjectStream).toHaveBeenCalledWith("source/0");
    getObjectStream.mockRejectedValueOnce(new Error("S3 unavailable"));
    await expect(service.getDownloadStream(principal, "source")).rejects.toThrow("S3 unavailable");
    expect(mocks.publicSource).toHaveBeenCalledTimes(2);
  });
  it("does not consult synthetic content for PDFs or nonzero versions", async () => {
    const { service, getObjectStream } = setup();
    mocks.get.mockResolvedValueOnce({ ...source, mime: "application/pdf" });
    await service.getDownloadStream(principal, "source");
    mocks.get.mockResolvedValueOnce({ ...source, version: 1 });
    await service.getDownloadStream(principal, "source", 1);
    expect(mocks.publicSource).not.toHaveBeenCalled();
    expect(getObjectStream).toHaveBeenNthCalledWith(2, "source/1");
  });
  it("fails closed when owner access or the frozen lesson integrity check fails", async () => {
    const { service, getObjectStream } = setup();
    mocks.get.mockRejectedValueOnce(Object.assign(new Error("not found"), { code: "NOT_FOUND" }));
    await expect(service.getDownloadStream(principal, "source")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.publicSource).not.toHaveBeenCalled();
    mocks.publicSource.mockRejectedValueOnce(Object.assign(new Error("integrity failed"), { code: "CONFLICT" }));
    await expect(service.getDownloadStream(principal, "source")).rejects.toMatchObject({ code: "CONFLICT" });
    expect(getObjectStream).not.toHaveBeenCalled();
  });
});
