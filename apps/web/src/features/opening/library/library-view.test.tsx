// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LibraryFileBatch } from "./library-view";
import type { OpeningApi } from "../client/api";

const state = vi.hoisted(() => ({ mounts: 0, empty: false, batches: [] as LibraryFileBatch[], refreshRevision: 0 }));
vi.mock("./material-library", () => ({
  MaterialLibrary: ({ incomingFiles, onIncomingFilesAccepted, onUploadRequested, onEmptyChange, refreshRevision }: { incomingFiles?: LibraryFileBatch | null; onIncomingFilesAccepted?: () => void; onUploadRequested?: () => void; onEmptyChange?: (empty: boolean) => void; refreshRevision?: number }) => {
    state.refreshRevision = refreshRevision ?? 0;
    useEffect(() => { state.mounts += 1; }, []);
    useEffect(() => { if (incomingFiles) { state.batches.push(incomingFiles); onIncomingFilesAccepted?.(); } }, [incomingFiles, onIncomingFilesAccepted]);
    useEffect(() => { onEmptyChange?.(state.empty); }, [onEmptyChange]);
    return createElement("div", { "data-materials": true }, "材料队列", state.empty ? createElement("button", { onClick: onUploadRequested }, "上传材料") : null);
  },
}));
vi.mock("./library-document-list", () => ({ LibraryDocumentList: () => createElement("div", null, "我的笔记") }));
vi.mock("../teaching/learner-state-card", () => ({ LearnerStateCard: () => null }));
vi.mock("../courses/course-note", () => ({ CourseNotes: () => null }));
import { LibraryView } from "./library-view";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  state.mounts = 0; state.empty = false; state.batches = []; state.refreshRevision = 0;
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.history.replaceState({}, "", "/opening/library?tab=notes&source=original&version=3");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});

it("waits for in-flight planning settings and refreshes after a successful capture", async () => {
  let resolveSettings!: (value: unknown) => void;
  const getPlanningSettings = vi.fn(() => new Promise(resolve => { resolveSettings = resolve; }));
  const api = { getPlanningSettings } as unknown as OpeningApi;
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ sourceId: "source", taskId: "task" }));
  vi.stubGlobal("fetch", fetcher);
  const courseId = "9a445539-4069-40ea-a981-eeafc28b6553";
  await act(async () => root.render(createElement(LibraryView, { api, courseId })));
  await act(async () => Array.from(container.querySelectorAll("button")).find(button => button.textContent === "粘贴讲解")!.click());
  const area = container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, "先列出方程");
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { Array.from(container.querySelectorAll("button")).find(button => button.textContent === "保存讲解")!.click(); await Promise.resolve(); });
  expect(fetcher).not.toHaveBeenCalled();
  await act(async () => resolveSettings({ settings: { timeZone: "Pacific/Kiritimati" } }));
  expect(getPlanningSettings).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toMatchObject({ courseId, timeZone: "Pacific/Kiritimati" });
  expect(state.refreshRevision).toBe(1);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function render() { await act(async () => root.render(createElement(LibraryView, { tab: "notes" }))); }
async function drop(files: File[]) {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files } });
  await act(async () => { container.querySelector("section")!.dispatchEvent(event); });
}
it("accepts a page drop from notes through the same validation and preserves pinned query context", async () => {
  await render();
  const file = new File(["pdf"], "notes.pdf", { type: "application/pdf" });
  await drop([file]);
  expect(state.batches).toHaveLength(1);
  expect(state.batches[0]?.files).toEqual([file]);
  expect(window.location.search).toContain("tab=materials");
  expect(window.location.search).toContain("source=original");
  expect(window.location.search).toContain("version=3");
  expect(state.mounts).toBe(1);
  expect(container.querySelector('[role="tab"][data-state="active"]')?.textContent).toBe("材料");
});
it("rejects unsupported and empty files without sending them into the queue", async () => {
  await render();
  await drop([new File(["x"], "photo.heic", { type: "image/heic" }), new File([], "empty.txt", { type: "text/plain" })]);
  expect(state.batches).toHaveLength(0);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("不支持的文件类型");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("为空");
  expect(window.location.search).toContain("tab=notes");
});
it("keeps the material queue mounted when switching to notes", async () => {
  await render();
  const materialTab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(button => button.textContent === "材料")!;
  await act(async () => { materialTab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })); });
  const notesTab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(button => button.textContent === "笔记")!;
  await act(async () => { notesTab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })); });
  expect(state.mounts).toBe(1);
  expect(container.querySelectorAll('[data-materials="true"]')).toHaveLength(1);
});

it("opens the existing page picker from the empty action and validates the selected files once", async () => {
  state.empty = true;
  await act(async () => root.render(createElement(LibraryView, { tab: "materials" })));
  const picker = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  const click = vi.spyOn(picker, "click");
  await act(async () => Array.from(container.querySelectorAll("button")).find(button => button.textContent === "上传材料")!.click());
  expect(click).toHaveBeenCalledTimes(1);
  expect(container.querySelectorAll('input[type="file"]')).toHaveLength(1);
  const file = new File(["pdf"], "notes.pdf", { type: "application/pdf" });
  Object.defineProperty(picker, "files", { configurable: true, value: [file] });
  await act(async () => picker.dispatchEvent(new Event("change", { bubbles: true })));
  expect(state.batches).toHaveLength(1);
  expect(state.batches[0]?.files).toEqual([file]);
});

it("opens text capture from notes and saves it to the active course", async () => {
  const courseId = "9a445539-4069-40ea-a981-eeafc28b6553";
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ sourceId: "source", taskId: "task" }));
  vi.stubGlobal("fetch", fetcher);
  await act(async () => root.render(createElement(LibraryView, { tab: "notes", courseId })));
  const toggle = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "粘贴讲解")!;
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  await act(async () => toggle.click());
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(window.location.search).toContain("tab=materials");
  const area = container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, "先列出方程");
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => toggle.click());
  expect(area.closest("[hidden]")).not.toBeNull();
  await act(async () => toggle.click());
  expect(area.value).toBe("先列出方程");
  await act(async () => Array.from(container.querySelectorAll("button")).find(button => button.textContent === "保存讲解")!.click());
  const captureCall = fetcher.mock.calls.find(([url]) => url === "/api/opening/imports/text")!;
  expect(JSON.parse(captureCall[1]!.body as string)).toMatchObject({ courseId, content: "先列出方程" });
  expect(container.querySelector('[role="status"]')?.textContent).toContain("讲解已保存");
  await act(async () => toggle.click());
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(area.closest("[hidden]")).not.toBeNull();
});
