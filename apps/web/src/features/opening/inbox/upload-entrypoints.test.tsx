// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SourceRecord } from "@aistudy/contracts";
import type { OpeningApi } from "../client/api";
import { InboxPanel } from "./inbox-panel";
import { UploadStrip } from "../assistant/upload-strip";
import { StartUploads } from "../start/start-uploads";

const upload = vi.hoisted(() => vi.fn());
const organization = vi.hoisted(() => vi.fn());
vi.mock("../library/material-organization-client", () => ({ createMaterialOrganizationClient: () => ({ addToCourse: organization }) }));
vi.mock("./upload-client", () => ({ createUploadClient: () => ({ uploadFile: upload }) }));
vi.mock("./source-cleanup-panel", () => ({ SourceCleanupPanel: () => null }));
const source = { id: "saved", name: "notes.pdf", mime: "application/pdf", bytes: 4, uploadState: "uploaded", parseState: "ready" } as SourceRecord;
const api = {} as OpeningApi;
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); upload.mockReset(); organization.mockReset().mockResolvedValue({ succeeded: [], failed: [] });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

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
