// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SourceRecord } from "@aistudy/contracts";
import type { OpeningApi } from "../client/api";

const state = vi.hoisted(() => ({ upload: vi.fn() }));
vi.mock("./upload-client", () => ({ createUploadClient: () => ({ uploadFile: state.upload }) }));
vi.mock("./source-cleanup-panel", () => ({ SourceCleanupPanel: () => null }));
vi.mock("./source-actions-panel", () => ({ SourceActionsPanel: ({ onClose }: { onClose: () => void }) => createElement("div", null, createElement("input", { "aria-label": "管理中的草稿", defaultValue: "" }), createElement("button", { onClick: onClose }, "关闭管理表单")), sourceActionNotice: () => "完成" }));
import { InboxPanel } from "./inbox-panel";

const source: SourceRecord = { id: "source", workspaceId: "workspace", name: "notes.pdf", mime: "application/pdf", bytes: 3, sha256: "ab".repeat(32), version: 1, uploadState: "uploaded", parseState: "queued", error: null, createdAt: "2026-10-01T00:00:00.000Z" };
const api = {} as OpeningApi;
const onChanged = async () => {};
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.upload.mockReset().mockResolvedValue(source);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it("moves a completed parsing task into its normal row without remounting an open management draft", async () => {
  await act(async () => root.render(createElement(InboxPanel, { api, sources: [source], onChanged })));
  const manage = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "管理材料")!;
  await act(async () => manage.click());
  const input = container.querySelector<HTMLInputElement>('[aria-label="管理中的草稿"]')!;
  input.value = "保留编辑内容";
  await act(async () => root.render(createElement(InboxPanel, { api, sources: [{ ...source, parseState: "ready" }], onChanged })));
  expect(container.querySelector('[aria-label="材料处理任务"]')).toBeNull();
  expect(container.querySelector<HTMLInputElement>('[aria-label="管理中的草稿"]')).toBe(input);
  expect(input.value).toBe("保留编辑内容");
});
it.each(["parsing-filter", "outside-current-page"])("keeps an open management draft after parsing leaves %s until explicit close", async situation => {
  const unrelated = { ...source, id: "other", name: "other.pdf", parseState: "ready" as const };
  const sources = [source, unrelated];
  const before = situation === "parsing-filter" ? [source] : [unrelated];
  const after = situation === "parsing-filter" ? [] : [unrelated];
  await act(async () => root.render(createElement(InboxPanel, { api, sources, liveSources: sources, visibleSources: before, onChanged })));
  const task = container.querySelector('[aria-label="材料处理任务"]')!;
  await act(async () => Array.from(task.querySelectorAll("button")).find(button => button.textContent === "管理材料")!.click());
  const input = container.querySelector<HTMLInputElement>('[aria-label="管理中的草稿"]')!;
  input.value = "仍在编辑";
  const ready = [{ ...source, parseState: "ready" as const }, unrelated];
  await act(async () => root.render(createElement(InboxPanel, { api, sources: ready, liveSources: ready, visibleSources: after, onChanged })));
  expect(container.querySelector<HTMLInputElement>('[aria-label="管理中的草稿"]')).toBe(input);
  expect(input.value).toBe("仍在编辑");
  expect(container.textContent).toContain("正在编辑的材料暂时保留");
  await act(async () => Array.from(container.querySelectorAll("button")).find(button => button.textContent === "关闭管理表单")!.click());
  expect(container.querySelector('[aria-label="管理中的草稿"]')).toBeNull();
  expect(container.textContent).not.toContain("notes.pdf");
});
it("accepts a page file batch once across StrictMode effect replay and clears the external busy state", async () => {
  const file = { name: "notes.pdf", type: "application/pdf", size: 3, arrayBuffer: vi.fn(async () => new Uint8Array([1, 2, 3]).buffer) } as unknown as File;
  const accepted = vi.fn();
  const busy = vi.fn();
  const incomingFiles = { id: 1, files: [file] };
  await act(async () => root.render(createElement(StrictMode, null, createElement(InboxPanel, { api, sources: [], onChanged, incomingFiles, onIncomingFilesAccepted: accepted, onUploadBusyChange: busy }))));
  expect(file.arrayBuffer).toHaveBeenCalledTimes(1);
  expect(state.upload).toHaveBeenCalledTimes(1);
  expect(accepted).toHaveBeenCalledTimes(1);
  expect(busy.mock.calls.map(call => call[0])).toEqual([true, false]);
  expect(container.textContent).toContain("已上传 1 份材料");
});
