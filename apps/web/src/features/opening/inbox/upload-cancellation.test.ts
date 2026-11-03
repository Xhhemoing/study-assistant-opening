import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceRecord, UploadTicket } from "@aistudy/contracts";
import { clearSessionExpiry } from "../../auth/session-expiry";
import { createOpeningApi } from "../client/api";
import { putPrivateBytes } from "./put-private";
import { createUploadClient, type UploadClientDeps } from "./upload-client";
import { createUploadQueue } from "./upload-queue";
import { setupUploadIdentity, uploadTestIdentity } from "./upload-identity-test-fixture";

const id = "33333333-3333-4333-8333-333333333333";
const source: SourceRecord = {
  id, workspaceId: uploadTestIdentity.workspaceId, name: "cancel.pdf", mime: "application/pdf",
  bytes: 4, sha256: "ab".repeat(32), version: 0, uploadState: "uploaded", parseState: "queued",
  error: null, createdAt: "2026-11-03T00:00:00.000Z",
};
const ticket: UploadTicket = {
  source: { ...source, uploadState: "pending", parseState: "not_started" },
  uploadUrl: `https://example.test/api/opening/sources/${id}/staging`, expiresAt: "2026-11-04T00:00:00.000Z",
};
const local = () => ({ name: source.name, type: source.mime, bytes: new Uint8Array([1, 2, 3, 4]) });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function browserFile(read: () => Promise<ArrayBuffer>) {
  const file = new File([new Uint8Array([1, 2, 3, 4])], source.name, { type: source.mime });
  Object.defineProperty(file, "arrayBuffer", { value: read });
  return file;
}
let releaseIdentity: () => void;
beforeEach(() => { clearSessionExpiry(); releaseIdentity = setupUploadIdentity(); });
afterEach(() => { releaseIdentity(); clearSessionExpiry(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("upload cancellation receipt boundaries", () => {
  it("keeps an already-sent successful complete as saved, then clears only the task", async () => {
    const entered = deferred<void>(), receipt = deferred<SourceRecord>();
    const begin = vi.fn(async () => ticket), put = vi.fn(async () => undefined);
    const complete = vi.fn(() => { entered.resolve(); return receipt.promise; });
    const queue = createUploadQueue(createUploadClient({ begin, put, complete }), [local()]);
    const item = queue.items[0]!;
    const running = queue.start();
    await entered.promise;
    queue.dismiss(item.id);
    expect(queue.snapshot()[0]?.message).toContain("可能已保存");
    receipt.resolve(source);
    await running;
    expect(queue.snapshot()[0]).toMatchObject({ state: "saved", source, progress: 100 });
    expect(queue.snapshot()[0]?.message).toBeUndefined();
    queue.dismiss(item.id);
    expect(queue.snapshot()).toEqual([]);
    expect(source.uploadState).toBe("uploaded");
    expect(complete).toHaveBeenCalledOnce();
  });

  it("retains an unknown complete through dismiss and reconciles only the same source", async () => {
    const entered = deferred<void>(), receipt = deferred<SourceRecord>();
    const begin = vi.fn(async () => ticket), put = vi.fn(async () => undefined);
    const complete = vi.fn<UploadClientDeps["complete"]>()
      .mockImplementationOnce(() => { entered.resolve(); return receipt.promise; })
      .mockResolvedValueOnce(source);
    const queue = createUploadQueue(createUploadClient({ begin, put, complete }), [local()]);
    const item = queue.items[0]!;
    const running = queue.start();
    await entered.promise;
    queue.dismiss(item.id);
    receipt.reject(new Error("receipt lost"));
    await running;
    expect(queue.snapshot()[0]).toMatchObject({ state: "failed", ticket, completionPending: true });
    expect(queue.snapshot()[0]?.message).toContain("可能已保存，待核对");
    queue.dismiss(item.id);
    expect(queue.snapshot()[0]).toMatchObject({ id: item.id, ticket, completionPending: true });
    await queue.retry(item.id);
    expect(queue.snapshot()[0]).toMatchObject({ state: "saved", source });
    expect(begin).toHaveBeenCalledOnce();
    expect(put).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenLastCalledWith(id, uploadTestIdentity);
  });

  it("does not send another complete for an already-aborted unknown reconciliation", async () => {
    const complete = vi.fn(async () => source), controller = new AbortController();
    controller.abort();
    const client = createUploadClient({ begin: async () => ticket, put: async () => undefined, complete });
    const result = await client.uploadFile(local(), {
      signal: controller.signal, expectedIdentity: uploadTestIdentity, uploadId: id,
      resumeSourceId: id, ticket, completionPending: true,
    });
    expect(complete).not.toHaveBeenCalled();
    expect(result).toMatchObject({ phase: "interrupted", sourceId: id, ticket, completionPending: true });
    expect("message" in result && result.message).toContain("可能已保存，待核对");
  });

  it("settles cancellation during identity verification without reading or uploading", async () => {
    const entered = deferred<void>(), me = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(() => { entered.resolve(); return me.promise; }));
    const read = vi.fn(async () => new ArrayBuffer(4));
    const uploadFile = vi.fn(async () => source), queue = createUploadQueue({ uploadFile });
    const item = queue.addFiles([browserFile(read)])[0]!;
    const running = queue.start();
    await entered.promise;
    queue.dismiss(item.id);
    me.resolve(Response.json({ user: uploadTestIdentity }));
    await running;
    expect(queue.snapshot()[0]).toMatchObject({ state: "failed" });
    expect(read).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it("settles cancellation during a file read without starting an upload", async () => {
    const entered = deferred<void>(), bytes = deferred<ArrayBuffer>();
    const read = vi.fn(() => { entered.resolve(); return bytes.promise; });
    const uploadFile = vi.fn(async () => source), queue = createUploadQueue({ uploadFile });
    const item = queue.addFiles([browserFile(read)])[0]!;
    const running = queue.start();
    await entered.promise;
    queue.dismiss(item.id);
    bytes.resolve(new ArrayBuffer(4));
    await running;
    expect(queue.snapshot()[0]).toMatchObject({ state: "failed" });
    expect(uploadFile).not.toHaveBeenCalled();
    expect(queue.snapshot()[0]?.message).toContain("上传已停止");
  });

  it("does not read an idle second file when its task is removed", async () => {
    const firstRead = vi.fn(async () => new ArrayBuffer(4)), secondRead = vi.fn(async () => new ArrayBuffer(4));
    const uploadFile = vi.fn(async () => source), queue = createUploadQueue({ uploadFile });
    const items = queue.addFiles([browserFile(firstRead), browserFile(secondRead)]);
    queue.dismiss(items[1]!.id);
    await queue.start();
    expect(firstRead).toHaveBeenCalledOnce();
    expect(secondRead).not.toHaveBeenCalled();
    expect(uploadFile).toHaveBeenCalledOnce();
    expect(queue.snapshot()[0]?.state).toBe("saved");
  });

  it("keeps the stable operation id after begin loses its response, without claiming deletion", async () => {
    const begin = vi.fn<UploadClientDeps["begin"]>()
      .mockRejectedValueOnce(new Error("begin response lost")).mockResolvedValueOnce(ticket);
    const complete = vi.fn(async () => source), put = vi.fn(async () => undefined);
    const queue = createUploadQueue(createUploadClient({ begin, put, complete }), [local()]);
    const item = queue.items[0]!;
    await queue.start();
    queue.dismiss(item.id);
    expect(queue.snapshot()[0]).toMatchObject({ id: item.id, state: "failed" });
    expect(queue.snapshot()[0]?.message).toContain("待核对");
    await queue.retry(item.id);
    for (const [input] of begin.mock.calls) expect(input).toMatchObject({ uploadId: item.id });
    expect(queue.snapshot()[0]?.state).toBe("saved");
  });
});

class NetworkXhr {
  status = 200;
  responseText = "";
  withCredentials = false;
  upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
  open = vi.fn();
  setRequestHeader = vi.fn();
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  send = vi.fn();
  abort = vi.fn(() => this.onabort?.());
}

it("aborts the real private PUT wrapper and removes its external listener", async () => {
  const controller = new AbortController(), xhr = new NetworkXhr();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  const running = putPrivateBytes(ticket.uploadUrl, local().bytes, source.mime, undefined,
    () => xhr as unknown as XMLHttpRequest, uploadTestIdentity, controller.signal);
  expect(xhr.send).toHaveBeenCalledOnce();
  controller.abort();
  await expect(running).rejects.toThrow("上传已取消");
  expect(xhr.abort).toHaveBeenCalledOnce();
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
});

it("forwards the same signal and identity headers to begin and refresh, not complete", async () => {
  const controller = new AbortController();
  const transport = vi.fn<typeof fetch>(async url => Response.json(String(url).endsWith("/complete") ? source : ticket));
  const api = createOpeningApi(transport);
  await api.beginUpload({ name: source.name, mime: source.mime, bytes: source.bytes, sha256: source.sha256, uploadId: id }, uploadTestIdentity, controller.signal);
  await api.refreshUploadTicket(id, uploadTestIdentity, controller.signal);
  await api.completeUpload(id, uploadTestIdentity);
  expect(transport).toHaveBeenCalledTimes(3);
  for (const [, init] of transport.mock.calls.slice(0, 2)) {
    expect(init?.signal).toBe(controller.signal);
    expect(new Headers(init?.headers).get("x-upload-user-id")).toBe(uploadTestIdentity.id);
    expect(new Headers(init?.headers).get("x-upload-workspace-id")).toBe(uploadTestIdentity.workspaceId);
  }
  expect(transport.mock.calls[2]?.[1]?.signal).toBeUndefined();
  expect(transport.mock.calls.map(([url]) => String(url))).toEqual([
    "/api/opening/sources", `/api/opening/sources/${id}/upload-ticket`, `/api/opening/sources/${id}/complete`,
  ]);
});
