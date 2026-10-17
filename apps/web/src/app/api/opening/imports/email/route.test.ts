import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ scope: vi.fn(), beginUpload: vi.fn(), putStaging: vi.fn(), completeUpload: vi.fn() }));
vi.mock("../../../../../features/opening/runtime", () => ({ requireOpeningScope: mocks.scope }));
vi.mock("../../../../../features/opening/sources/source-service", () => ({ createOpeningSourceService: () => mocks }));
import { ApiError } from "../../../../../features/auth/service";
import { POST } from "./route";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.scope.mockResolvedValue({ principal: { userId: "u", workspaceId: "w", sessionId: "s" }, sql: {} });
  mocks.beginUpload.mockImplementation(async (_principal, input) => ({ source: { id: "source", ...input } }));
  mocks.putStaging.mockResolvedValue({ ok: true });
  mocks.completeUpload.mockResolvedValue({ id: "source", name: "lesson.eml", bytes: 25 });
});
afterEach(() => vi.restoreAllMocks());

function streamRequest(body: ReadableStream<Uint8Array>, contentLength?: string) {
  return new Request("http://localhost/api/opening/imports/email", {
    method: "POST", headers: { "content-type": "multipart/form-data; boundary=fixture", ...(contentLength ? { "content-length": contentLength } : {}) },
    body, duplex: "half",
  } as RequestInit);
}

describe("email multipart body limit before parsing", () => {
  it("rejects an oversized declared request without reading or parsing it", async () => {
    let cancelled = false;
    const pull = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull, cancel() { cancelled = true; } }, { highWaterMark: 0 });
    const parse = vi.spyOn(Request.prototype, "formData");
    const response = await POST(streamRequest(body, String(32 * 1024 * 1024)));
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(pull).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
    expect(mocks.beginUpload).not.toHaveBeenCalled();
  });

  it.each([undefined, "1"])("rejects streamed excess with Content-Length %s, cancels the sender and skips multipart parsing", async (length) => {
    let cancelled = false;
    const chunk = new Uint8Array(4 * 1024 * 1024);
    const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(chunk); }, cancel() { cancelled = true; } });
    const parse = vi.spyOn(Request.prototype, "formData");
    const response = await POST(streamRequest(body, length));
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(parse).not.toHaveBeenCalled();
    expect(mocks.beginUpload).not.toHaveBeenCalled();
  });

  it("preserves a valid .eml payload and manual-source completion", async () => {
    const content = "From: a@example.edu\r\nSubject: lesson\r\n\r\nhello";
    const form = new FormData();
    form.append("file", new Blob([content], { type: "message/rfc822" }), "lesson.eml");
    const response = await POST(new Request("http://localhost/api/opening/imports/email", { method: "POST", body: form }));
    expect(response.status).toBe(201);
    expect(mocks.beginUpload.mock.calls[0]![1]).toMatchObject({ name: "lesson.eml", mime: "message/rfc822", bytes: new TextEncoder().encode(content).length });
    expect(mocks.putStaging.mock.calls[0]![2].bytes).toEqual(new TextEncoder().encode(content));
    expect(mocks.completeUpload).toHaveBeenCalledOnce();
    expect(await response.json()).toMatchObject({ sourceId: "source", manual: true });
  });

  it("retains authentication before consuming or parsing the request", async () => {
    mocks.scope.mockRejectedValueOnce(new ApiError("UNAUTHENTICATED", "Authentication required", 401));
    let cancelled = false;
    const pull = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull, cancel() { cancelled = true; } }, { highWaterMark: 0 });
    const response = await POST(streamRequest(body));
    expect(response.status).toBe(401);
    expect(cancelled).toBe(true);
    expect(pull).not.toHaveBeenCalled();
    expect(mocks.beginUpload).not.toHaveBeenCalled();
  });
});
