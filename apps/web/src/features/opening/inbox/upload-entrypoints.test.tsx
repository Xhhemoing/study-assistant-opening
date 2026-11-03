// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SourceRecord } from "@aistudy/contracts";
import { createOpeningApi, type OpeningApi } from "../client/api";
import { webcrypto } from "node:crypto";
import { Buffer } from "node:buffer";
import { putPrivateBytes } from "./put-private";
import { InboxPanel } from "./inbox-panel";
import { UploadStrip } from "../assistant/upload-strip";
import { StartUploads } from "../start/start-uploads";
import { setupUploadIdentity, uploadTestIdentity } from "./upload-identity-test-fixture";

const upload = vi.hoisted(() => vi.fn());
const organization = vi.hoisted(() => vi.fn());
vi.mock("../library/material-organization-client", () => ({ createMaterialOrganizationClient: () => ({ addToCourse: organization }) }));
const runtime = vi.hoisted(() => ({ real: false }));
vi.mock("./upload-client", async original => {
  const actual = await original<typeof import("./upload-client")>();
  return { ...actual, createUploadClient: (...args: Parameters<typeof actual.createUploadClient>) => runtime.real ? actual.createUploadClient(...args) : { uploadFile: upload } };
});
vi.mock("./put-private", async original => {
  const actual = await original<typeof import("./put-private")>();
  return { ...actual, putPrivateBytes: vi.fn(actual.putPrivateBytes) };
});
vi.mock("./source-cleanup-panel", () => ({ SourceCleanupPanel: () => null }));
const source = { id: "saved", name: "notes.pdf", mime: "application/pdf", bytes: 4, uploadState: "uploaded", parseState: "ready" } as SourceRecord;
let api = {} as OpeningApi;
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  setupUploadIdentity();
  runtime.real = false; api = {} as OpeningApi; vi.mocked(putPrivateBytes).mockClear();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); upload.mockReset(); organization.mockReset().mockResolvedValue({ succeeded: [], failed: [] });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

function localFile(name: string) {
  const file = new File(["data"], name, { type: "application/pdf" });
  const read = vi.fn(async () => new Uint8Array([1, 2, 3, 4]).buffer);
  Object.defineProperty(file, "arrayBuffer", { value: read });
  return { file, read };
}

function entrypoint(kind: "inbox" | "strip" | "start", changed: () => Promise<void> = vi.fn(async () => undefined), courseId: string | null = null) {
  let id = 0;
  return async (files: File[]) => {
    if (kind === "inbox") {
      await act(async () => root.render(createElement(InboxPanel, { api, sources: [], courseId, onChanged: changed, incomingFiles: { id: ++id, files } })));
    } else {
      await act(async () => root.render(kind === "start"
        ? createElement(StartUploads, { api, sources: [], courseId, onBusyChange: () => undefined, onUploaded: changed })
        : createElement(UploadStrip, { api, courseId, onUploaded: changed })));
      const input = host.querySelector<HTMLInputElement>('input[multiple]')!;
      Object.defineProperty(input, "files", { value: files, configurable: true });
      await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    }
  };
}

it.each(["inbox", "strip"] as const)("%s waits for upload before reading the next file", async kind => {
  let finish!: (value: SourceRecord) => void;
  upload.mockImplementationOnce(() => new Promise<SourceRecord>(resolve => { finish = resolve; })).mockResolvedValueOnce({ ...source, id: "second" });
  const first = localFile("first.pdf"), second = localFile("second.pdf");
  await entrypoint(kind)([first.file, second.file]);
  expect(first.read).toHaveBeenCalledOnce();
  expect(second.read).not.toHaveBeenCalled();
  expect(upload).toHaveBeenCalledOnce();
  expect(upload.mock.calls[0]?.[1]).toMatchObject({ expectedIdentity: uploadTestIdentity });
  await act(async () => finish(source));
  expect(second.read).toHaveBeenCalledOnce();
  expect(upload).toHaveBeenCalledTimes(2);
});

it.each(["inbox", "strip"] as const)("%s counts prior failed batches before reading another file", async kind => {
  upload.mockResolvedValue({ phase: "interrupted", keptLocal: true, message: "网络中断，请重试。" });
  const changed = vi.fn(async () => undefined);
  const select = entrypoint(kind, changed);
  await select(Array.from({ length: 20 }, (_, index) => localFile(`${index}.pdf`).file));
  expect(upload).toHaveBeenCalledTimes(20);
  if (kind === "strip") expect(changed).toHaveBeenCalledExactlyOnceWith([], []);
  const extra = localFile("extra.pdf");
  await select([extra.file]);
  expect(extra.read).not.toHaveBeenCalled();
  expect(upload).toHaveBeenCalledTimes(20);
  expect(host.textContent).toContain("最多 20 份");
});

it.each(["inbox", "strip"] as const)("%s hides unexpected publication exception details", async kind => {
  upload.mockResolvedValue(source);
  const changed = vi.fn(async () => { throw new Error("https://private.example?token=secret\n at privateFunction"); });
  await entrypoint(kind, changed)([localFile("notes.pdf").file]);
  expect(changed).toHaveBeenCalledOnce();
  expect(host.textContent).not.toContain("private.example");
  expect(host.textContent).not.toContain("privateFunction");
  expect(host.textContent).toContain("未完成");
});


it.each(["inbox", "strip", "start"] as const)("%s retains course-assignment failures for retry without re-uploading", async kind => {
  upload.mockResolvedValue(source);
  organization.mockResolvedValueOnce({ succeeded: [], failed: [{ id: source.id, message: "private upstream stack" }] })
    .mockResolvedValueOnce({ succeeded: [source.id], failed: [] });
  const changed = vi.fn(async () => undefined), selected = localFile("notes.pdf");
  await entrypoint(kind, changed, "course-id")([selected.file]);
  expect(host.textContent).toContain("归入课程未完成");
  expect(host.textContent).not.toContain("private upstream");
  if (kind !== "inbox") expect(changed).not.toHaveBeenCalled();
  const retry = Array.from(host.querySelectorAll("button")).find(button => button.textContent?.includes("重试"))!;
  await act(async () => retry.click());
  expect(organization).toHaveBeenCalledTimes(2);
  expect(upload).toHaveBeenCalledOnce();
  expect(selected.read).toHaveBeenCalledOnce();
  expect(changed).toHaveBeenCalled();
  expect(host.textContent).not.toContain("归入课程未完成");
});

// Exercise each real component adapter through the queue, client, HTTP API and XHR wrapper.
class ControlledXhr {
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
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

it.each(["inbox", "strip", "start"] as const)("%s cancels real PUT/refresh and reconciles an unknown complete without re-upload", async kind => {
  runtime.real = true;
  vi.stubGlobal("crypto", {
    randomUUID: () => webcrypto.randomUUID(),
    subtle: { digest: (algorithm: string, bytes: Uint8Array) => webcrypto.subtle.digest(algorithm, Buffer.from(bytes)) },
  });
  const saved: SourceRecord = {
    id: "33333333-3333-4333-8333-333333333333", workspaceId: uploadTestIdentity.workspaceId,
    name: "notes.pdf", mime: "application/pdf", bytes: 4, sha256: "ab".repeat(32), version: 0,
    uploadState: "uploaded", parseState: "queued", error: null, createdAt: "2026-11-03T00:00:00.000Z",
  };
  const ticket = { source: { ...saved, uploadState: "pending", parseState: "not_started" },
    uploadUrl: `https://example.test/api/opening/sources/${saved.id}/staging`, expiresAt: "2026-11-04T00:00:00.000Z" };
  const refresh = deferred<Response>(), receipt = deferred<Response>();
  let refreshCount = 0, completeCount = 0;
  const transport = vi.fn<typeof fetch>(async url => {
    if (String(url).endsWith("/upload-ticket")) return ++refreshCount === 1 ? refresh.promise : Response.json(ticket);
    if (String(url).endsWith("/complete")) return ++completeCount === 1 ? receipt.promise : Response.json(saved);
    return Response.json(ticket);
  });
  api = createOpeningApi(transport);
  const requests: ControlledXhr[] = [];
  vi.stubGlobal("XMLHttpRequest", class extends ControlledXhr { constructor() { super(); requests.push(this); } });
  const changed = vi.fn(async () => undefined), selected = localFile("notes.pdf");
  await entrypoint(kind, changed)([selected.file]);
  await act(async () => { await vi.waitFor(() => expect(requests).toHaveLength(1)); });
  const firstPut = vi.mocked(putPrivateBytes).mock.calls[0]!;
  const firstSignal = firstPut[6]!;
  expect(firstSignal).toBeInstanceOf(AbortSignal);
  expect(firstPut[5]).toEqual(uploadTestIdentity);
  expect(transport.mock.calls[0]?.[1]?.signal).toBe(firstSignal);
  for (const [name, value] of Object.entries({ "x-upload-user-id": uploadTestIdentity.id, "x-upload-workspace-id": uploadTestIdentity.workspaceId })) {
    expect(new Headers(transport.mock.calls[0]?.[1]?.headers).get(name)).toBe(value);
    expect(requests[0]!.setRequestHeader).toHaveBeenCalledWith(name, value);
  }
  const cancel = async () => {
    const button = kind === "start" ? host.querySelector<HTMLButtonElement>('[aria-label="移除上传记录 notes.pdf"]')
      : Array.from(host.querySelectorAll("button")).find(button => button.textContent === "取消");
    expect(button).toBeTruthy(); expect(button!.disabled).toBe(false);
    await act(async () => button!.click());
  };
  const retry = async () => {
    const button = Array.from(host.querySelectorAll("button")).find(button => button.textContent === "重试");
    expect(button).toBeTruthy(); await act(async () => button!.click());
  };
  await cancel();
  expect(firstSignal.aborted).toBe(true);
  expect(requests[0]!.abort).toHaveBeenCalledOnce();
  expect(completeCount).toBe(0);
  expect(changed).not.toHaveBeenCalledWith([saved.id], [saved]);
  await retry();
  expect(refreshCount).toBe(1);
  const refreshSignal = transport.mock.calls[1]?.[1]?.signal;
  expect(refreshSignal).toBeInstanceOf(AbortSignal);
  expect(new Headers(transport.mock.calls[1]?.[1]?.headers).get("x-upload-user-id")).toBe(uploadTestIdentity.id);
  await cancel();
  expect(refreshSignal?.aborted).toBe(true);
  await act(async () => refresh.resolve(Response.json(ticket)));
  expect(requests).toHaveLength(1); expect(completeCount).toBe(0);
  await retry();
  expect(refreshCount).toBe(2); expect(requests).toHaveLength(2);
  const secondPut = vi.mocked(putPrivateBytes).mock.calls[1]!;
  expect(secondPut[6]).toBe(transport.mock.calls[2]?.[1]?.signal);
  expect(secondPut[5]).toEqual(uploadTestIdentity);
  expect(Array.from(secondPut[1])).toEqual([1, 2, 3, 4]);
  await act(async () => requests[1]!.onload?.());
  expect(completeCount).toBe(1);
  expect(transport.mock.calls[3]?.[1]?.signal).toBeUndefined();
  await cancel();
  await act(async () => receipt.reject(new Error("receipt lost")));
  expect(host.textContent).toContain("可能已保存，待核对");
  expect(host.textContent).toContain("notes.pdf");
  await retry();
  expect(completeCount).toBe(2);
  expect(transport.mock.calls.map(([url]) => String(url))).toEqual([
    "/api/opening/sources", `/api/opening/sources/${saved.id}/upload-ticket`,
    `/api/opening/sources/${saved.id}/upload-ticket`, `/api/opening/sources/${saved.id}/complete`,
    `/api/opening/sources/${saved.id}/complete`,
  ]);
  expect(requests).toHaveLength(2); expect(selected.read).toHaveBeenCalledOnce();
  if (kind === "inbox") {
    expect(changed).toHaveBeenCalledExactlyOnceWith();
    expect(host.querySelector('[aria-label="已上传任务"]')?.textContent).toContain("notes.pdf");
    expect(host.textContent).toContain("已上传 1 份材料");
  } else expect(changed).toHaveBeenCalledWith([saved.id], [saved]);
  expect(host.textContent).not.toContain("可能已保存，待核对");
});
