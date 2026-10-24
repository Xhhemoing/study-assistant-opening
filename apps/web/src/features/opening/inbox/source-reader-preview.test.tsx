// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SourceRecord } from "@aistudy/contracts";
import { conceptPreviewResponseSchema, type ConceptPreviewResponse } from "../concepts/preview-contract";
import type { ConceptPreviewLoader } from "../concepts/concept-preview";
const api = vi.hoisted(() => ({ preview: vi.fn<ConceptPreviewLoader>(), context: vi.fn() }));
const caps = vi.hoisted(() => ({ explorePreview: true }));
vi.mock("../capabilities/capabilities-provider", () => ({ useOpeningCapabilities: () => caps }));
vi.mock("../concepts/preview-client", () => ({ requestConceptPreview: api.preview }));
vi.mock("../assistant/learning-prose", () => ({ LearningProse: ({ text }: { text: string }) => createElement("p", null, text) }));
vi.mock("../teaching/study-context-tools", () => ({ StudyContextTools: (props: unknown) => { api.context(props); return createElement("div", null, "提问草稿"); } }));
vi.mock("../assistant/conversation-companion", () => ({ OriginalConversationSlot: () => null }));
vi.mock("../teaching/study-tools-panel", () => ({ StudyToolsPanel: ({ children, panels, activePanel }: { children: ReactNode; activePanel: string; panels: { id: string; content: ReactNode }[] }) => createElement("div", null, children, panels.find(p => p.id === activePanel)?.content) }));
vi.mock("./source-content", () => ({ SourceContent: ({ sourceId, version }: { sourceId: string; version: number }) => createElement("p", { "data-study-reading-text": true, "data-source-id": sourceId, "data-source-version": version, "data-page-kind": "physical", "data-source-page": "3" }, "向量空间的原文") }));
vi.mock("./source-viewer", () => ({ buildSourceDownloadView: () => ({}), SourceViewer: () => null }));
import { SourceReader } from "./source-reader";
import { publishVerifiedSessionIdentity } from "../../auth/session-identity";
const id = "11111111-1111-4111-8111-111111111111";
// A parsed slide deck uses SourceContent as its main reading surface and retains physical pages.
// text/plain instead renders SourceViewer's inline text preview, without physical-page selection metadata.
const record: SourceRecord = { id, workspaceId: "22222222-2222-4222-8222-222222222222", version: 2, name: "线性代数", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", bytes: 100, sha256: "a".repeat(64), uploadState: "uploaded", parseState: "ready", error: null, createdAt: "2026-10-24T00:00:00.000Z" };
function available(): ConceptPreviewResponse {
  return conceptPreviewResponseSchema.parse({
    status: "available", kind: "source_excerpt", text: "向量空间的原文", term: "向量空间",
    selection: { text: "向量空间", start: 0, end: 4 },
    context: { scope: "same_page_paragraph", expanded: true, truncatedBefore: false, truncatedAfter: false },
    locator: { sourceId: id, sourceVersion: 2, page: 3, start: 0, end: "向量空间的原文".length, manifestRevision: 4 },
    contextAnchor: { sourceId: id, sourceVersion: 2, page: 3, purpose: "material_read" },
    exposureReceipts: [{ id: "33333333-3333-4333-8333-333333333333", releaseKey: `concept-preview:test:${"a".repeat(64)}`, contextAnchor: { sourceId: id, sourceVersion: 2, page: 3, purpose: "material_read" }, origin: "material_excerpt", supportDomain: "unknown", generatedAt: "2026-10-24T00:00:00.000Z", releasedAt: "2026-10-24T00:00:01.000Z", acknowledgedAt: null, historyRevision: 1 }],
  });
}
let container: HTMLDivElement, root: Root, clearIdentity: () => void;
const onClose = vi.fn();
beforeEach(() => {
  caps.explorePreview = true;
  clearIdentity = publishVerifiedSessionIdentity({ id: "reader-owner", workspaceId: "reader-workspace" });
  vi.resetAllMocks(); api.preview.mockResolvedValue({ status: "unavailable", reason: "未找到唯一原文" });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); window.getSelection()?.removeAllRanges(); clearIdentity(); });
async function render(props: Partial<Parameters<typeof SourceReader>[0]> = {}) { await act(async () => root.render(createElement(SourceReader, { record, requestedVersion: 2, onClose, ...props }))); }
function button(text: string) { return Array.from(document.querySelectorAll("button")).find(b => b.textContent === text || b.getAttribute("aria-label") === text)!; }
async function click(text: string) { expect(button(text)).toBeTruthy(); await act(async () => button(text).click()); }
async function select() {
  const text = document.querySelector("[data-study-reading-text]")!.firstChild!;
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 4);
  await act(async () => { window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range); document.dispatchEvent(new Event("selectionchange")); });
}
it("OFF never mounts or requests concepts and keeps protected original selection help", async () => {
  caps.explorePreview = false;
  await render(); await select();
  expect(button("查看概念")).toBeUndefined();
  expect(document.querySelector('[aria-label="概念预览"]')).toBeNull();
  await click("问选中内容");
  expect(api.context.mock.calls.at(-1)?.[0]).toMatchObject({ context: { fragment: "向量空间" } });
  await render({ questionProtected: true }); await select(); await click("问选中内容");
  expect(api.context.mock.calls.at(-1)?.[0].questionBlockedReason).toContain("原题的提问入口");
  expect(api.preview).not.toHaveBeenCalled();
});
it("reader explicitly loads then hands frozen source/version/page to existing unsent context tools", async () => {
  api.preview.mockResolvedValue(available());
  await render({ latestRecord: { ...record, name: "线性代数（新名称）" } }); await select(); expect(api.preview).not.toHaveBeenCalled();
  button("查看概念").focus(); await click("查看概念");
  expect(api.preview.mock.calls[0][0]).toMatchObject({ sourceId: id, sourceVersion: 2, page: 3, selection: { text: "向量空间" } });
  expect(document.querySelector("[data-preview-citation]")?.textContent).toBe("来源：线性代数（新名称） · v2 · 第 3 页");
  await act(async () => { window.getSelection()?.removeAllRanges(); document.dispatchEvent(new Event("selectionchange")); });
  await click("继续问");
  expect(api.context.mock.calls.at(-1)?.[0]).toMatchObject({ context: { sourceId: id, sourceVersion: 2, page: 3, fragment: "向量空间" }, initialQuestion: "" });
  expect(document.body.textContent).toContain("尚未发送"); expect(onClose).not.toHaveBeenCalled();
});
it("Radix capture Escape closes preview first, then tools, and only then reader", async () => {
  await render(); await select(); await click("问选中内容"); await select(); await click("查看概念");
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(document.querySelector('[aria-label="概念预览"]')).toBeNull(); expect(document.body.textContent).toContain("提问草稿"); expect(onClose).not.toHaveBeenCalled();
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(document.body.textContent).not.toContain("提问草稿"); expect(onClose).not.toHaveBeenCalled();
});
it("source revision changes invalidate preview, and protected questions keep original help restrictions", async () => {
  let finish!: (value: ConceptPreviewResponse) => void; api.preview.mockReturnValueOnce(new Promise<ConceptPreviewResponse>(resolve => { finish = resolve; }));
  await render(); await select(); await click("查看概念");
  await render({ requestedVersion: 3 }); await act(async () => finish({ status: "unavailable", reason: "旧响应" }));
  expect(document.body.textContent).not.toContain("旧响应"); expect(document.querySelector('[aria-label="概念预览"]')).toBeNull();
  await render({ questionProtected: true }); await select(); expect(button("查看概念").disabled).toBe(true);
  await click("问选中内容"); expect(api.context.mock.calls.at(-1)?.[0].questionBlockedReason).toContain("原题的提问入口"); expect(api.preview).toHaveBeenCalledTimes(1);
});
it("a new verified identity cannot reuse the previous reader preview", async () => {
  await render(); await select(); await click("查看概念");
  clearIdentity(); clearIdentity = publishVerifiedSessionIdentity({ id: "other-owner", workspaceId: "other-workspace" });
  await render(); expect(document.querySelector('[aria-label="概念预览"]')).toBeNull(); expect(api.preview).toHaveBeenCalledTimes(1);
  await select(); await click("查看概念"); expect(api.preview).toHaveBeenCalledTimes(2);
});
