// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SourceRecord } from "@aistudy/contracts";
import type { OpeningApi } from "../client/api";
import type { LibraryFileBatch } from "./library-view";

const state = vi.hoisted(() => ({ sources: [] as SourceRecord[], upload: vi.fn(), addToCourse: vi.fn(), read: vi.fn() }));
vi.mock("../inbox/upload-client", () => ({ createUploadClient: () => ({ uploadFile: state.upload }) }));
vi.mock("../inbox/source-cleanup-panel", () => ({ SourceCleanupPanel: () => null }));
vi.mock("./material-organization-client", () => ({ createMaterialOrganizationClient: () => ({ read: state.read, addToCourse: state.addToCourse }) }));
import { MaterialLibrary } from "./material-library";

const source: SourceRecord = { id: "source", workspaceId: "workspace", name: "notes.pdf", mime: "application/pdf", bytes: 3, sha256: "ab".repeat(32), version: 1, uploadState: "uploaded", parseState: "ready", error: null, createdAt: "2026-10-01T00:00:00.000Z" };
const api = { listSources: async () => state.sources } as OpeningApi;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.history.replaceState({}, "", "/opening/library");
  state.sources = [source];
  state.read.mockReset().mockResolvedValue({ courses: [{ id: "course-a", title: "课程 A", archived: false }, { id: "course-b", title: "课程 B", archived: false }], memberships: [{ courseId: "course-a", sourceId: source.id, role: "reference" }] });
  state.addToCourse.mockReset().mockResolvedValue({ succeeded: [source.id], failed: [] });
  state.upload.mockReset().mockResolvedValue(source);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function render(courseId: string | null, incomingFiles?: LibraryFileBatch) {
  await act(async () => root.render(createElement(MaterialLibrary, { api, courseId, incomingFiles, hideUploadPicker: true })));
}
function button(text: string) { return Array.from(container.querySelectorAll("button")).find(item => item.textContent?.includes(text))!; }
function fileBatch(id: number): LibraryFileBatch {
  return { id, files: [{ name: `notes-${id}.pdf`, type: "application/pdf", arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } as File] };
}

it("clears an inbound course without rebinding an upload already in flight or the next upload", async () => {
  let finish!: (value: SourceRecord) => void;
  state.upload.mockImplementationOnce(() => new Promise<SourceRecord>(resolve => { finish = resolve; }));
  const first = fileBatch(1);
  await render("course-a");
  await render("course-a", first);
  expect(state.upload).toHaveBeenCalledTimes(1);
  await render(null, first);
  expect(button("全部原件").getAttribute("aria-pressed")).toBe("true");
  expect(window.location.search).not.toContain("courseId");
  await act(async () => finish(source));
  expect(state.addToCourse).toHaveBeenCalledExactlyOnceWith("course-a", [source.id], "reference");
  await render(null, fileBatch(2));
  expect(state.upload).toHaveBeenCalledTimes(2);
  expect(state.addToCourse).toHaveBeenCalledTimes(1);
});

it.each(["待整理", "课程 B"])("preserves a locally chosen %s when the previous course query clears", async target => {
  await render("course-a");
  await act(async () => button(target).click());
  await render(null);
  expect(button(target).getAttribute("aria-pressed")).toBe("true");
});

it("applies a cleared course after an in-flight organization action releases its lock", async () => {
  let finish!: (value: { succeeded: string[]; failed: [] }) => void;
  state.addToCourse.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await render("course-a");
  await act(async () => button("归入课程").click());
  const target = container.querySelector<HTMLSelectElement>('select[aria-label="归入课程"]')!;
  await act(async () => { target.value = "course-b"; target.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => button("确认归入").click());
  await render(null);
  await act(async () => finish({ succeeded: [source.id], failed: [] }));
  expect(button("全部原件").getAttribute("aria-pressed")).toBe("true");
  expect(window.location.search).not.toContain("courseId");
  expect(state.addToCourse).toHaveBeenCalledExactlyOnceWith("course-b", [source.id], "reference");
});

it("preserves an assignment selection after parsing no longer matches the filter and removes it on cancel", async () => {
  window.history.replaceState({}, "", "/opening/library?status=parsing");
  state.sources = [{ ...source, parseState: "queued" }];
  await render(null);
  await act(async () => button("归入课程").click());
  const target = container.querySelector<HTMLSelectElement>('select[aria-label="归入课程"]')!;
  const role = container.querySelector<HTMLSelectElement>('select[aria-label="材料用途"]')!;
  await act(async () => {
    target.value = "course-b"; target.dispatchEvent(new Event("change", { bubbles: true }));
    role.value = "core"; role.dispatchEvent(new Event("change", { bubbles: true }));
  });
  state.sources = [source];
  await act(async () => button("刷新状态").click());
  expect(container.querySelector('select[aria-label="归入课程"]')).toBe(target);
  expect(target.value).toBe("course-b");
  expect(role.value).toBe("core");
  expect(container.textContent).toContain("正在编辑的材料暂时保留");
  await act(async () => button("取消").click());
  expect(container.querySelector('select[aria-label="归入课程"]')).toBeNull();
  expect(container.textContent).not.toContain("notes.pdf");
});

it("connects the empty state action to the page upload picker without mounting a second picker", async () => {
  state.sources = [];
  const onUploadRequested = vi.fn(), onEmptyChange = vi.fn();
  await act(async () => root.render(createElement(MaterialLibrary, { api, hideUploadPicker: true, onUploadRequested, onEmptyChange })));
  expect(onEmptyChange).toHaveBeenLastCalledWith(true);
  const empty = container.querySelector('[aria-label="还没有材料"]')!;
  expect(empty.querySelectorAll("button")).toHaveLength(1);
  expect(container.querySelector('input[type="file"]')).toBeNull();
  await act(async () => empty.querySelector("button")!.click());
  expect(onUploadRequested).toHaveBeenCalledTimes(1);
});

it("does not claim the library is empty when the initial material read fails", async () => {
  const list = vi.spyOn(api, "listSources").mockRejectedValueOnce(new Error("read unavailable"));
  const onEmptyChange = vi.fn();
  try {
    await act(async () => root.render(createElement(MaterialLibrary, { api, hideUploadPicker: true, onEmptyChange })));
    expect(container.textContent).toContain("材料暂时无法读取");
    expect(container.querySelector('[aria-label="还没有材料"]')).toBeNull();
    expect(onEmptyChange).toHaveBeenLastCalledWith(false);
    await act(async () => root.render(createElement(MaterialLibrary, { api, onEmptyChange })));
    expect(container.querySelector('input[type="file"]')).not.toBeNull();
  } finally { list.mockRestore(); }
});

it("delays refresh feedback for 300ms while keeping an open assignment mounted", async () => {
  await render(null);
  await act(async () => button("归入课程").click());
  const target = container.querySelector<HTMLSelectElement>('select[aria-label="归入课程"]')!;
  await act(async () => { target.value = "course-b"; target.dispatchEvent(new Event("change", { bubbles: true })); });
  let finish!: (sources: SourceRecord[]) => void;
  const list = vi.spyOn(api, "listSources").mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  vi.useFakeTimers();
  try {
    await act(async () => button("刷新状态").click());
    await act(async () => vi.advanceTimersByTime(299));
    expect(container.textContent).not.toContain("正在刷新材料状态");
    await act(async () => vi.advanceTimersByTime(1));
    expect(container.textContent).toContain("正在刷新材料状态");
    expect(container.querySelector('select[aria-label="归入课程"]')).toBe(target);
    expect(target.value).toBe("course-b");
    await act(async () => finish([source]));
    expect(container.textContent).not.toContain("正在刷新材料状态");
    expect(container.querySelector('select[aria-label="归入课程"]')).toBe(target);
  } finally { vi.useRealTimers(); list.mockRestore(); }
});
