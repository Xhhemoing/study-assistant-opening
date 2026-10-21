import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { putPrivateBytes } from "./put-private";
import { clearSessionExpiry, createSessionFetch, subscribeToSessionExpiry } from "../../auth/session-expiry";
import { createUploadClient } from "./upload-client";
import { createUploadQueue } from "./upload-queue";
import type { UploadTicket } from "@aistudy/contracts";

class FakeXhr {
  status = 200;
  upload = { onprogress: (_event: ProgressEvent) => undefined };
  responseText = "";
  autoLoad = true;
  open = vi.fn();
  setRequestHeader = vi.fn();
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  send(body: Uint8Array) {
    this.upload.onprogress({ lengthComputable: true, loaded: 4, total: body.byteLength } as ProgressEvent);
    this.upload.onprogress({ lengthComputable: true, loaded: body.byteLength, total: body.byteLength } as ProgressEvent);
    if (this.autoLoad) this.onload?.();
  }
}

let onExpired: ReturnType<typeof vi.fn>;
let unsubscribe: () => void;
beforeEach(() => {
  vi.stubGlobal("window", Object.assign(new EventTarget(), { location: new URL("https://study.example/opening/library") }));
  onExpired = vi.fn();
  unsubscribe = subscribeToSessionExpiry(onExpired);
});
afterEach(() => { unsubscribe(); clearSessionExpiry(); vi.unstubAllGlobals(); });

const sessionError = { error: { code: "UNAUTHENTICATED" } };
const stagingUrl = "/api/opening/sources/s1/staging";
const bytes = new Uint8Array([1, 2, 3, 4]);
const asXhr = (xhr: FakeXhr) => xhr as unknown as XMLHttpRequest;

describe("putPrivateBytes", () => {
  it("reports actual uploaded bytes for a private PUT", async () => {
    const seen: number[] = [];
    const body = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    await putPrivateBytes(
      "https://minio.local/private",
      body,
      "application/pdf",
      (loaded, total) => seen.push(loaded / total),
      () => new FakeXhr() as unknown as XMLHttpRequest,
    );
    expect(seen).toEqual([0.5, 1]);
  });
});


describe("private upload session boundary", () => {
  it("uses the shared expiry notification and blocks both later XHR and fetch writes", async () => {
    const xhr = new FakeXhr();
    xhr.status = 401;
    xhr.responseText = JSON.stringify(sessionError);
    await expect(putPrivateBytes(stagingUrl, bytes, "application/pdf", undefined, () => asXhr(xhr))).rejects.toThrow("上传对象失败 (401)");
    expect(onExpired).toHaveBeenCalledOnce();
    const factory = vi.fn(() => asXhr(new FakeXhr()));
    await expect(putPrivateBytes(stagingUrl, bytes, "application/pdf", undefined, factory)).rejects.toThrow("请先登录原账户");
    expect(factory).not.toHaveBeenCalled();
    const beginTransport = vi.fn<typeof fetch>();
    expect((await createSessionFetch(beginTransport)("/api/opening/sources/begin", { method: "POST" })).status).toBe(401);
    expect(beginTransport).not.toHaveBeenCalled();
    clearSessionExpiry();
    await putPrivateBytes(stagingUrl, bytes, "application/pdf", undefined, factory);
    expect(factory).toHaveBeenCalledOnce();
  });

  it.each([
    [stagingUrl, 401, JSON.stringify({ error: { code: "PROVIDER_AUTH" } })],
    [stagingUrl, 401, "gateway unauthorized"],
    [stagingUrl, 403, JSON.stringify(sessionError)],
    [stagingUrl, 429, JSON.stringify(sessionError)],
    ["https://provider.example/api/upload", 401, JSON.stringify(sessionError)],
  ])("keeps upload failures separate from session expiry for %s (%s)", async (url, status, body) => {
    const xhr = new FakeXhr();
    xhr.status = status;
    xhr.responseText = body;
    await expect(putPrivateBytes(url, bytes, "application/pdf", undefined, () => asXhr(xhr))).rejects.toThrow(`上传对象失败 (${status})`);
    expect(onExpired).not.toHaveBeenCalled();
  });

  it("does not expire a revalidated session when an older XHR finishes late", async () => {
    const xhr = new FakeXhr();
    xhr.autoLoad = false;
    const request = putPrivateBytes(stagingUrl, bytes, "application/pdf", undefined, () => asXhr(xhr));
    clearSessionExpiry();
    xhr.status = 401;
    xhr.responseText = JSON.stringify(sessionError);
    xhr.onload?.();
    await expect(request).rejects.toThrow("上传对象失败 (401)");
    expect(onExpired).not.toHaveBeenCalled();
  });

  it("holds queued files and retries until the original identity has been revalidated", async () => {
    const ticket: UploadTicket = {
      source: { id: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222", name: "first.pdf", mime: "application/pdf", bytes: 4, sha256: "ab".repeat(32), version: 0, uploadState: "pending", parseState: "not_started", error: null, createdAt: "2026-10-21T00:00:00.000Z" },
      uploadUrl: stagingUrl,
      expiresAt: "2026-10-22T00:00:00.000Z",
    };
    let account = "A";
    const begin = vi.fn(async () => { expect(account).toBe("A"); return ticket; });
    const complete = vi.fn(async () => ({ ...ticket.source, uploadState: "uploaded" as const }));
    const refreshTicket = vi.fn(async () => ticket);
    const firstXhr = new FakeXhr();
    firstXhr.status = 401;
    firstXhr.responseText = JSON.stringify(sessionError);
    const factory = vi.fn().mockReturnValueOnce(asXhr(firstXhr)).mockImplementation(() => asXhr(new FakeXhr()));
    const client = createUploadClient({ begin, complete, refreshTicket, put: (url, body, progress, mime) => putPrivateBytes(url, body, mime, progress, factory) });
    const file = (name: string) => ({ name, type: "application/pdf", bytes });
    const queue = createUploadQueue(client, [file("first.pdf"), file("second.pdf")]);
    const stop = subscribeToSessionExpiry(() => { account = "B"; });
    try {
      await queue.start();
      expect(queue.items.map(item => item.state)).toEqual(["failed", "failed"]);
      expect(queue.items[1]?.message).toContain("验证原账户后重试");
      expect(begin).toHaveBeenCalledOnce();
      expect(complete).not.toHaveBeenCalled();
      await queue.start();
      await queue.retry(queue.items[0]!.id);
      expect(begin).toHaveBeenCalledOnce();
      expect(refreshTicket).not.toHaveBeenCalled();
      // AuthGate clears only after the original user + workspace match.
      account = "A";
      clearSessionExpiry();
      await queue.start();
      expect(begin).toHaveBeenCalledOnce();
      await queue.retry(queue.items[1]!.id);
      expect(queue.items.map(item => item.state)).toEqual(["failed", "saved"]);
      expect(begin).toHaveBeenCalledTimes(2);
      expect(complete).toHaveBeenCalledOnce();
    } finally { stop(); }
  });
});
