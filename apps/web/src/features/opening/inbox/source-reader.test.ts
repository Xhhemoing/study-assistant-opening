// @vitest-environment jsdom

import { act, createElement, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceRecord } from "@aistudy/contracts";
import { Drawer } from "@aistudy/ui";
import { SourceReader, SourceReaderFrame } from "./source-reader";
import { captureReaderReturnPoint, type ReaderReturnPoint } from "./reader-return-point";
import { SaveSnippetDialog } from "../assistant/save-snippet-dialog";
import { StudyToolsPanel } from "../teaching/study-tools-panel";
import { publishVerifiedSessionIdentity } from "../../auth/session-identity";

const originalConversation = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock("../assistant/conversation-companion", () => ({ OriginalConversationSlot: (props: { conversationId: string; className?: string }) => {
  originalConversation.render(props); return createElement("input", { "data-original-conversation": props.conversationId, defaultValue: "原对话草稿" });
} }));
vi.mock("./native-pdf-runtime", () => ({ createPdfWorker: vi.fn(), loadPdfRuntime: async () => { throw new Error("PDF test transport unavailable"); } }));
vi.mock("./source-content", () => ({ SourceContent: () => createElement("section", { "aria-label": "解析正文" }, "提取文字") }));
const record = { id: "11111111-1111-4111-8111-111111111111", name: "讲义.pdf", mime: "application/pdf", version: 2, uploadState: "uploaded", parseState: "ready" } as SourceRecord;
let host: HTMLDivElement;
let root: Root;
let clearIdentity: () => void;
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "show");
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
beforeEach(() => {
  clearIdentity = publishVerifiedSessionIdentity({ id: "source-reader-owner", workspaceId: "source-reader-workspace" });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute("open"); } });
  for (const method of ["show", "showModal"]) Object.defineProperty(HTMLDialogElement.prototype, method, { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute("open", ""); } });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); clearIdentity(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, "close", originalClose); else Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  for (const [method, original] of [["show", originalShow], ["showModal", originalShowModal]] as const) {
    if (original) Object.defineProperty(HTMLDialogElement.prototype, method, original); else Reflect.deleteProperty(HTMLDialogElement.prototype, method);
  }
});
async function render(props: Partial<Parameters<typeof SourceReader>[0]> = {}) {
  await act(async () => root.render(createElement(SourceReader, { record, requestedVersion: 2, onClose() {}, ...props })));
  return document.querySelector<HTMLElement>("[data-material-reader]")!;
}
async function click(element: HTMLElement) { await act(async () => element.click()); }
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); }); }

describe("dedicated material reader", () => {
  it("opens the requested original as the only default reading view and keeps extracted text on demand", async () => {
    const dialog = await render({ requestedVersion: 0, page: 3 });
    const html = dialog.outerHTML;
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe("讲义.pdf");
    expect(html).toContain("返回");
    expect(html).toContain("version=0");
    expect(html).toContain("#page=3");
    expect(html).toContain("这份材料之后已有更新");
    expect(html).toContain("第 3 页");
    expect(html).toContain('data-source-page="3"');
    expect(html).toContain("PDF 阅读工具");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('aria-label="解析正文"');
    expect(html).not.toContain("上传材料");
  });
  it("mounts the explicitly selected original conversation in the single companion without a material binding", async () => {
    originalConversation.render.mockClear();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 1200 } as DOMRect);
    const conversationId = "22222222-2222-4222-8222-222222222222";
    const reader = await render({ originalConversationId: conversationId, courseId: "33333333-3333-4333-8333-333333333333" });
    const original = reader.querySelector<HTMLInputElement>("[data-original-conversation]")!;
    expect(original).not.toBeNull();
    expect(originalConversation.render.mock.lastCall?.[0]).toEqual({ conversationId, className: "min-h-0 min-w-0 flex-1" });
    original.value = "仍在写的原对话";
    const text = Array.from(reader.querySelectorAll("button")).find(button => button.textContent === "提取文字 / OCR 核对")!;
    await click(text);
    expect(reader.querySelector("[data-original-conversation]")).toBe(original);
    expect(original.value).toBe("仍在写的原对话");
    expect(reader.querySelectorAll("dialog")).toHaveLength(1);
  });
  it("shows the material first on a narrow reader, with the original conversation available on demand", async () => {
    originalConversation.render.mockClear();
    const reader = await render({ originalConversationId: "22222222-2222-4222-8222-222222222222" });
    const original = reader.querySelector<HTMLInputElement>("[data-original-conversation]")!;
    expect(original).not.toBeNull();
    expect(original.closest("[hidden]")).not.toBeNull();
    expect(reader.querySelector('[data-study-content]')?.classList.contains("hidden")).toBe(false);
    await click(Array.from(reader.querySelectorAll("button")).find(button => button.textContent === "工具")!);
    const open = Array.from(reader.querySelectorAll("button")).find(button => button.textContent === "原对话")!;
    await click(open);
    expect(reader.querySelector("[data-original-conversation]")).toBe(original);
    expect(original.closest("[hidden]")).toBeNull();
  });
  it("does not mount or restore an original conversation without an explicit identity", async () => {
    originalConversation.render.mockClear();
    await render();
    expect(originalConversation.render).not.toHaveBeenCalled();
    expect(document.querySelector("[data-original-conversation]")).toBeNull();
  });
  it("keeps media and slide citation positions explicit when the preview cannot synchronize them", async () => {
    const html = (await render({ startMs: 65000, slideLabel: "A-1" })).outerHTML;
    expect(html).toContain("幻灯片 A-1");
    expect(html).toContain("1:05");
    expect(html).toContain("尚不能同步确认该位置");
  });
  it("auto-seeks video/audio media citations to [startMs, endMs], pauses at endMs, and allows manual resume", async () => {
    const videoRecord: SourceRecord = { ...record, name: "微积分网课.mp4", mime: "video/mp4", version: 2 };
    const reader = await render({
      record: videoRecord,
      latestRecord: videoRecord,
      requestedVersion: 2,
      startMs: 65_000,
      endMs: 90_000,
      keyframeChunkId: "kf-65",
    });
    const video = reader.querySelector<HTMLVideoElement>("video")!;
    const player = reader.querySelector<HTMLElement>('[data-media-anchor-player="true"]')!;
    expect(video).not.toBeNull();
    expect(video.getAttribute("src")).toBe(`/api/opening/sources/${videoRecord.id}/download?version=2&disposition=inline`);
    expect(reader.textContent).toContain("1:05–1:30");
    expect(reader.textContent).not.toContain("尚不能同步确认该位置");
    expect(player.getAttribute("data-media-anchor-keyframe-id")).toBe("kf-65");
    expect(player.getAttribute("data-media-anchor-highlight")).toBe("active");
    const status = player.querySelector('[role="status"]')!;
    expect(video.readyState).toBe(0);
    expect(video.currentTime).toBe(0);
    expect(status.textContent).toContain("正在加载媒体信息，加载后将自动跳到引用位置。");
    expect(status.textContent).not.toContain("已定位");

    let paused = true;
    vi.spyOn(video, "paused", "get").mockImplementation(() => paused);
    const pauseSpy = vi.spyOn(video, "pause").mockImplementation(() => { paused = true; });
    const playSpy = vi.spyOn(video, "play").mockImplementation(() => {
      paused = false;
      return Promise.resolve();
    });

    // Simulate metadata load -> auto-seeks to startMs / 1000 = 65s and keeps highlight active while paused.
    Object.defineProperty(video, "readyState", { configurable: true, value: 1 });
    await act(async () => { video.dispatchEvent(new Event("loadedmetadata")); });
    expect(video.currentTime).toBe(65);
    expect(player.getAttribute("data-media-anchor-phase")).toBe("seeking_segment");
    expect(status.textContent).toBe("正在跳到引用位置。");

    await act(async () => { video.dispatchEvent(new Event("seeked")); });
    expect(player.getAttribute("data-media-anchor-phase")).toBe("ready_segment");
    expect(player.getAttribute("data-media-anchor-highlight")).toBe("active");
    expect(status.textContent).toBe("已定位到引用片段，播放至末尾会自动暂停。");

    // Mid-segment timeupdate does not pause.
    paused = false;
    await act(async () => { video.dispatchEvent(new Event("play")); });
    video.currentTime = 75;
    await act(async () => { video.dispatchEvent(new Event("timeupdate")); });
    expect(pauseSpy).not.toHaveBeenCalled();
    expect(player.getAttribute("data-media-anchor-highlight")).toBe("active");

    // Reaching endMs = 90_000ms triggers automatic pause while KEEPING range highlight active.
    video.currentTime = 90;
    await act(async () => { video.dispatchEvent(new Event("timeupdate")); });
    expect(pauseSpy).toHaveBeenCalledOnce();
    expect(reader.textContent).toContain("已播放到引用片段末尾");
    expect(player.getAttribute("data-media-anchor-phase")).toBe("paused_at_end");
    expect(player.getAttribute("data-media-anchor-highlight")).toBe("active");

    // Manual user resume releases the end bound and clears the jumped-range highlight.
    paused = false;
    await act(async () => { video.dispatchEvent(new Event("play")); });
    video.currentTime = 110;
    await act(async () => { video.dispatchEvent(new Event("timeupdate")); });
    expect(pauseSpy).toHaveBeenCalledOnce();
    expect(reader.textContent).toContain("已继续播放后续内容");
    expect(player.getAttribute("data-media-anchor-highlight")).toBe("inactive");

    // Clicking replay button seeks back to 65s, re-activates highlight, and re-arms the 90s auto-pause.
    const replayButton = Array.from(reader.querySelectorAll("button")).find(b => b.textContent === "重播片段")!;
    await click(replayButton);
    expect(video.currentTime).toBe(65);
    expect(status.textContent).toBe("正在跳到引用位置。");
    await act(async () => { video.dispatchEvent(new Event("seeked")); });
    expect(status.textContent).toBe("已定位到引用片段，播放至末尾会自动暂停。");
    expect(playSpy).toHaveBeenCalledOnce();
    expect(player.getAttribute("data-media-anchor-highlight")).toBe("active");
    video.currentTime = 90.2;
    await act(async () => { video.dispatchEvent(new Event("timeupdate")); });
    expect(pauseSpy).toHaveBeenCalledTimes(2);
    expect(player.getAttribute("data-media-anchor-highlight")).toBe("active");

    // Manually seeking elsewhere clears the jumped-range highlight.
    video.currentTime = 15;
    await act(async () => { video.dispatchEvent(new Event("seeked")); });
    expect(player.getAttribute("data-media-anchor-highlight")).toBe("inactive");
    expect(player.getAttribute("data-media-anchor-phase")).toBe("seeked_outside_range");
    expect(status.textContent).toBe("已跳转到其他时间位置，可随时重播引用片段。");
  });
  it("announces an audio citation point once programmatic seeking finishes", async () => {
    const audioRecord: SourceRecord = { ...record, name: "听力录音.mp3", mime: "audio/mpeg" };
    const reader = await render({ record: audioRecord, startMs: 30_000 });
    const player = reader.querySelector('[data-media-anchor-player="true"]')!;
    const audio = player.querySelector("audio")!;
    const status = player.querySelector('[role="status"]')!;

    expect(audio.readyState).toBe(0);
    expect(audio.currentTime).toBe(0);
    expect(status.textContent).toContain("正在加载媒体信息，加载后将自动跳到引用位置。");
    expect(status.textContent).not.toContain("已定位");

    Object.defineProperty(audio, "readyState", { configurable: true, value: 1 });
    await act(async () => { audio.dispatchEvent(new Event("loadedmetadata")); });
    expect(audio.currentTime).toBe(30);
    expect(status.textContent).toBe("正在跳到引用位置。");

    await act(async () => { audio.dispatchEvent(new Event("seeked")); });
    expect(status.textContent).toBe("已定位到引用时间点。");
    audio.currentTime = 45;
    await act(async () => { audio.dispatchEvent(new Event("seeked")); });
    expect(status.textContent).toBe("已跳转到其他时间位置，可随时跳回引用时间点。");
  });
  it("renders an audio player and rejects inverted [startMs, endMs] media ranges without seeking", async () => {
    const audioRecord: SourceRecord = { ...record, name: "听力录音.mp3", mime: "audio/mpeg", version: 1 };
    const reader = await render({
      record: audioRecord,
      latestRecord: audioRecord,
      requestedVersion: 1,
      startMs: 30_000,
      endMs: 10_000,
    });
    const audio = reader.querySelector<HTMLAudioElement>("audio")!;
    expect(audio).not.toBeNull();
    expect(audio.currentTime).toBe(0);
    expect(reader.textContent).toContain("引用时间范围无效");
  });
  it("keeps retryable parse failures actionable without pretending the original failed to upload", async () => {
    const html = (await render({ record: { ...record, parseState: "failed", error: { code: "PARSE_FAILED", message: "解析失败", retryable: true } }, onRetry: async () => {} })).outerHTML;
    expect(html).toContain("解析失败");
    expect(html).toContain("重新解析");
    expect(html).toContain("<canvas");
  });
  it("surfaces PARSE_PARTIAL warnings on ready sources and enables retry only when retryable=true on the latest version", async () => {
    const onRetry = vi.fn().mockRejectedValueOnce(new Error("raw english error")).mockResolvedValueOnce(undefined);
    const reader = await render({
      record: { ...record, parseState: "ready", error: { code: "PARSE_PARTIAL", message: "第 2 页未能识别，可以重新解析", retryable: true } },
      onRetry,
    });
    expect(reader.textContent).toContain("第 2 页未能识别，可以重新解析");
    const retry = Array.from(reader.querySelectorAll("button")).find(button => button.textContent === "重新解析");
    expect(retry).toBeTruthy();
    await click(retry!);
    expect(onRetry).toHaveBeenCalledOnce();
    expect(reader.textContent).toContain("重新解析未能完成，请重试。");
    expect(reader.textContent).not.toContain("raw english error");

    const nonRetryable = await render({
      record: { ...record, parseState: "ready", error: { code: "PARSE_PARTIAL", message: "第 1 页识别质量低", retryable: false } },
      onRetry,
    });
    expect(nonRetryable.textContent).toContain("第 1 页识别质量低");
    expect(Array.from(nonRetryable.querySelectorAll("button")).some(button => button.textContent === "重新解析")).toBe(false);

    const historical = await render({
      requestedVersion: 1,
      record: { ...record, version: 1 },
      latestRecord: { ...record, parseState: "ready", error: { code: "PARSE_PARTIAL", message: "第 2 页未能识别，可以重新解析", retryable: true } },
      onRetry,
    });
    expect(historical.textContent).not.toContain("第 2 页未能识别，可以重新解析");
    expect(Array.from(historical.querySelectorAll("button")).some(button => button.textContent === "重新解析")).toBe(false);
  });
  it("starts reading extracted content for parsed formats without an inline original viewer", async () => {
    const html = (await render({ record: { ...record, name: "slides.pptx", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" } })).outerHTML;
    expect(html).toContain('aria-label="解析正文"');
    expect(html).toContain("原件信息");
    expect(html).toContain("提问与笔记");
    expect(html).not.toContain("<iframe");
  });
  it("stacks above the assistant, keeps loading handoff focused, and returns to the same learning tree", async () => {
    const mount = vi.fn(), drawerClose = vi.fn();
    function Learning() {
      useEffect(() => { mount(); }, []);
      return createElement("input", { "aria-label": "原答", defaultValue: "保留的原答" });
    }
    function Example({ loaded }: { loaded: boolean }) {
      const [point, setPoint] = useState<ReaderReturnPoint | null>(null);
      const close = () => setPoint(null);
      return createElement("main", null,
        createElement(Drawer, { open: true, onClose: drawerClose, title: "学习助手", description: "当前对话", children: createElement("div", null,
          createElement(Learning), createElement("button", { "data-citation": true, onClick: event => setPoint(captureReaderReturnPoint(event.currentTarget)) }, "原件引用")) }),
        point ? loaded ? createElement(SourceReader, { record, requestedVersion: 0, page: 3, returnPoint: point, onClose: close })
          : createElement(SourceReaderFrame, { title: "查看引用材料", onClose: close, returnPoint: point, children: "正在读取引用材料…" }) : null);
    }
    await act(async () => root.render(createElement(Example, { loaded: false })));
    const opener = document.querySelector<HTMLButtonElement>("[data-citation]")!;
    const input = document.querySelector<HTMLInputElement>('input[aria-label="原答"]')!;
    input.value = "编辑中的原答"; opener.focus();
    await click(opener);
    const loading = document.querySelector<HTMLElement>("[data-material-reader]")!;
    expect(loading.closest('[aria-hidden="true"], [inert]')).toBeNull();
    expect(loading.contains(document.activeElement)).toBe(true);
    await act(async () => root.render(createElement(Example, { loaded: true })));
    await settle();
    const reader = document.querySelector<HTMLElement>("[data-material-reader]")!;
    expect(reader.closest('[aria-hidden="true"], [inert]')).toBeNull();
    expect(reader.contains(document.activeElement)).toBe(true);
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    await settle();
    expect(document.querySelector("[data-material-reader]")).toBeNull();
    expect(drawerClose).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')?.closest('[aria-hidden="true"], [inert]')).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(document.querySelector('input[aria-label="原答"]')).toBe(input);
    expect(input.value).toBe("编辑中的原答");
    expect(mount).toHaveBeenCalledOnce();
    await click(opener);
    await click(document.querySelector<HTMLButtonElement>("[data-material-reader] header button")!);
    await settle();
    expect(document.activeElement).toBe(opener);
    expect(drawerClose).not.toHaveBeenCalled();
  });
  it.each([false, true])("closes the inner reading tools before the reader when wide=%s", async wide => {
    vi.stubGlobal("matchMedia", () => ({ matches: wide, addEventListener() {}, removeEventListener() {} }));
    const onClose = vi.fn();
    const reader = await render({ onClose });
    const opener = Array.from(reader.querySelectorAll("button")).find(button => button.textContent === "工具")!;
    opener.focus(); await click(opener);
    const tools = reader.querySelector<HTMLDialogElement>("dialog")!;
    expect(tools.open).toBe(true);
    tools.querySelector<HTMLButtonElement>("button")!.focus();
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    expect(tools.open).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(opener);
    await act(async () => { opener.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    expect(onClose).toHaveBeenCalledOnce();
  });
  it("preserves a busy native save dialog's cancellation guard above the reader tools", async () => {
    const closeReader = vi.fn(), closeTool = vi.fn(), closeSave = vi.fn();
    let complete!: (value: { documentId: string }) => void;
    const api = { createSnippet: vi.fn(() => new Promise<{ documentId: string }>(resolve => { complete = resolve; })) };
    const draft = { input: { title: "片段标题", text: "尚在保存的学习片段", provenanceId: record.id } };
    function Example() {
      const [save, setSave] = useState(false);
      return createElement(SourceReaderFrame, { title: "材料", onClose: closeReader, onEscapeKeyDown: closeTool,
        children: createElement(StudyToolsPanel, { activePanel: "save", onPanelChange: closeTool, children: "原件",
          panels: [{ id: "save", label: "笔记工具", content: createElement("div", null,
            createElement("button", { "data-save-open": true, onClick: () => setSave(true) }, "保存片段"),
            save ? createElement(SaveSnippetDialog, { draft, api, onClose: closeSave }) : null) }] }) });
    }
    await act(async () => root.render(createElement(Example)));
    await click(document.querySelector<HTMLButtonElement>("[data-save-open]")!);
    const save = document.querySelector<HTMLDialogElement>("dialog dialog")!;
    await click(save.querySelector<HTMLButtonElement>('button[type="submit"]')!);
    expect(api.createSnippet).toHaveBeenCalledOnce();
    // Disabling all save controls can put focus outside the inner dialog.
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    expect(closeSave).not.toHaveBeenCalled();
    expect(closeTool).not.toHaveBeenCalled();
    expect(closeReader).not.toHaveBeenCalled();
    expect(save.open).toBe(true);
    await act(async () => complete({ documentId: record.id }));
    await act(async () => { save.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    expect(closeSave).toHaveBeenCalledOnce();
    expect(closeTool).not.toHaveBeenCalled();
    expect(closeReader).not.toHaveBeenCalled();
  });
});
