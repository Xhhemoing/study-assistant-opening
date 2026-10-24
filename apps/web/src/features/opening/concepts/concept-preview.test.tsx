// @vitest-environment jsdom
import { createElement, createRef, StrictMode } from "react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConceptPreview, type ConceptPreviewHandle, type ConceptPreviewLoader } from "./concept-preview";
import { conceptPreviewResponseSchema, type ConceptPreviewResponse } from "./preview-contract";

const id = "11111111-1111-4111-8111-111111111111";
const selection = { sourceId: id, version: 2, page: 3, text: "向量空间" };
function available(): Extract<ConceptPreviewResponse, { status: "available" }> {
  const text = "**向量空间**满足 $x^2$。<script>alert(1)</script> [危险](javascript:alert(1))";
  const contextAnchor = { sourceId: id, sourceVersion: 2, page: 3, purpose: "material_read" as const };
  const result: Extract<ConceptPreviewResponse, { status: "available" }> = {
    status: "available", kind: "source_excerpt", text, term: selection.text,
    selection: { text: selection.text, start: 2, end: 2 + selection.text.length },
    context: { scope: "same_page_paragraph", expanded: true, truncatedBefore: false, truncatedAfter: false },
    locator: { sourceId: id, sourceVersion: 2, page: 3, start: 0, end: text.length, manifestRevision: 4 }, contextAnchor,
    exposureReceipts: [{ id: "22222222-2222-4222-8222-222222222222", releaseKey: `concept-preview:test:${"a".repeat(64)}`, contextAnchor, origin: "material_excerpt", supportDomain: "unknown", generatedAt: "2026-10-24T00:00:00.000Z", releasedAt: "2026-10-24T00:00:01.000Z", acknowledgedAt: null, historyRevision: 1 }],
  };
  conceptPreviewResponseSchema.parse(result);
  return result;
}
let container: HTMLDivElement, root: Root;
const load = vi.fn<ConceptPreviewLoader>(), onContinue = vi.fn();
const handle = createRef<ConceptPreviewHandle>();
type Props = Parameters<typeof ConceptPreview>[0];
beforeEach(() => {
  vi.resetAllMocks(); load.mockResolvedValue(available());
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function render(props: Partial<Props> = {}) { await act(async () => root.render(createElement(StrictMode, null, createElement(ConceptPreview, { ref: handle, bindingKey: "reader", sourceId: id, sourceLabel: "线性代数", sourceVersion: 2, selection, load, onContinue, ...props })))); }
function button(label: string) { return Array.from(container.querySelectorAll("button")).find(b => b.textContent === label || b.getAttribute("aria-label") === label)!; }
async function click(label: string) { await act(async () => button(label).click()); }
function deferred() { let resolve!: (value: ConceptPreviewResponse) => void; const promise = new Promise<ConceptPreviewResponse>(yes => { resolve = yes; }); return { promise, resolve }; }

it("requests only explicitly, preserves pointer selection, renders safe prose/formula and exact citation", async () => {
  await render(); expect(load).not.toHaveBeenCalled();
  const event = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
  button("查看概念").dispatchEvent(event); expect(event.defaultPrevented).toBe(true);
  await click("查看概念");
  expect(load).toHaveBeenCalledTimes(1); expect(load.mock.calls[0][0]).toMatchObject({ sourceId: id, sourceVersion: 2, page: 3, term: "向量空间", selection: { text: "向量空间" } });
  expect(container.querySelector(".katex")).not.toBeNull(); expect(container.querySelector("script")).toBeNull();
  expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
  expect(container.querySelector("[data-preview-citation]")?.textContent).toBe("来源：线性代数 · v2 · 第 3 页");
  expect(container.querySelector("[data-preview-citation]")?.textContent).not.toContain(id);
  const diagnostics = container.querySelector<HTMLDetailsElement>("[data-preview-diagnostics]")!;
  expect(diagnostics.open).toBe(false); expect(diagnostics.textContent).toContain(id); expect(diagnostics.textContent).toContain("原选区字符 2–6");
  expect(container.querySelector('[aria-label="原选区"]')?.textContent).toContain(selection.text);
  expect(container.textContent).toContain("同一物理页"); expect(container.textContent).toContain("继续问只带入原选区");
  expect(container.textContent).toContain("不是 AI 生成");
});
it("freezes selection, hands off without sending, restores focus and scroll on close", async () => {
  await render(); button("查看概念").focus(); container.scrollTop = 45;
  await click("查看概念"); await render({ selection: { ...selection, text: "另一段", page: 4 } });
  expect(document.activeElement).toBe(button("关闭概念预览")); await click("继续问");
  expect(onContinue).toHaveBeenCalledExactlyOnceWith(selection); expect(document.activeElement).toBe(button("查看概念")); expect(container.scrollTop).toBe(45);
  expect(container.querySelector('[aria-label="概念预览"]')).toBeNull();
});
it("ignores superseded and closed requests even if the loader does not honor abort", async () => {
  const old = deferred(), next = deferred(); load.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
  await render(); await click("查看概念"); expect(container.textContent).toContain("正在核对");
  expect(button("继续问").disabled).toBe(true); await click("继续问"); expect(onContinue).not.toHaveBeenCalled();
  await render({ selection: { ...selection, text: "另一段" } }); await click("查看概念");
  await act(async () => next.resolve({ status: "unavailable", reason: "新的结果" }));
  await act(async () => old.resolve(available())); expect(container.textContent).toContain("新的结果"); expect(container.querySelector("[data-preview-citation]")).toBeNull();
  expect(load.mock.calls[0][1].aborted).toBe(true);
  const late = deferred(); load.mockReturnValueOnce(late.promise); await click("查看概念");
  await act(async () => { expect(handle.current?.close()).toBe(true); });
  await act(async () => late.resolve(available())); expect(container.querySelector('[aria-label="概念预览"]')).toBeNull();
});
it.each(["unavailable", "ambiguous", "restricted", "stale"] as const)("shows %s and preserves restriction", async status => {
  load.mockResolvedValue({ status, reason: "服务端说明" }); await render(); await click("查看概念");
  expect(container.textContent).toContain("服务端说明"); expect(button("继续问").disabled).toBe(status === "restricted" || status === "stale");
});
it("shows both context truncation markers without expanding the follow-up selection", async () => {
  const result = available(); result.context.truncatedBefore = true; result.context.truncatedAfter = true;
  load.mockResolvedValue(result); await render(); await click("查看概念");
  expect(container.textContent).toContain("前文已截断"); expect(container.textContent).toContain("后文已截断");
  await click("继续问"); expect(onContinue).toHaveBeenCalledExactlyOnceWith(selection);
});
it("describes an unexpanded selection accurately", async () => {
  const result = available(); result.text = selection.text; result.selection = { text: selection.text, start: 0, end: selection.text.length };
  result.locator.end = selection.text.length; result.context.expanded = false;
  conceptPreviewResponseSchema.parse(result); load.mockResolvedValue(result); await render(); await click("查看概念");
  expect(container.textContent).toContain("未扩展上下文"); expect(container.textContent).not.toContain("已截断");
});
it("translates restricted reasons without claiming closed-book mode", async () => {
  load.mockResolvedValue({ status: "restricted", reason: "reader_preview_restricted_material_or_open_attempt" });
  await render(); await click("查看概念");
  const message = container.querySelector('[role="status"]')?.textContent;
  expect(message).toContain("进行中的作答"); expect(message).toContain("返回原题"); expect(message).not.toContain("reader_preview"); expect(message).not.toContain("闭卷");
  expect(button("继续问").disabled).toBe(true);
});
it("retries one logical intent with the same key, but reopening has a fresh delivery key", async () => {
  load.mockRejectedValueOnce(new Error("网络断开")); await render(); await click("查看概念"); expect(container.querySelector('[role="alert"]')?.textContent).toContain("网络断开");
  await click("重试预览"); expect(load.mock.calls[1][0]).toEqual(load.mock.calls[0][0]);
  await click("关闭概念预览"); await click("查看概念"); expect(load.mock.calls[2][0].clientKey).not.toBe(load.mock.calls[0][0].clientKey);
});
it("drops previous authority synchronously without cache or auto-request", async () => {
  await render(); await click("查看概念"); await render({ bindingKey: "new-identity" });
  expect(container.querySelector("[data-preview-citation]")).toBeNull(); expect(load).toHaveBeenCalledTimes(1);
  await click("查看概念"); expect(load).toHaveBeenCalledTimes(2);
  await render({ sourceVersion: 3 }); expect(container.querySelector('[aria-label="概念预览"]')).toBeNull();
  await click("查看概念"); expect(load).toHaveBeenCalledTimes(2); expect(container.textContent).toContain("选区已失效");
});
it("blocks protected questions and unsupported pages; mismatched response becomes stale", async () => {
  await render({ questionProtected: true }); expect(button("查看概念").disabled).toBe(true); expect(load).not.toHaveBeenCalled();
  await render({ selection: { ...selection, page: undefined } }); await click("查看概念"); expect(load).not.toHaveBeenCalled(); expect(container.textContent).toContain("原提问入口");
  const wrong = available(); wrong.locator.sourceVersion = 9; wrong.contextAnchor.sourceVersion = 9;
  conceptPreviewResponseSchema.parse(wrong);
  load.mockResolvedValue(wrong); await render(); await click("查看概念"); expect(container.textContent).toContain("来源与当前选区不一致"); expect(container.querySelector(".katex")).toBeNull();
});
it("Escape closes preview and stops propagation", async () => {
  await render(); await click("查看概念"); const outer = vi.fn(); document.addEventListener("keydown", outer);
  await act(async () => button("关闭概念预览").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  document.removeEventListener("keydown", outer);
  expect(outer).not.toHaveBeenCalled(); expect(container.querySelector('[aria-label="概念预览"]')).toBeNull();
});
