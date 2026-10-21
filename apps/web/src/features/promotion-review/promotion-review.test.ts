// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PromotionApi } from "./promotion-api";
import { PromotionReview } from "./promotion-review";

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.useFakeTimers();
  vi.spyOn(PromotionApi, "list").mockImplementation(() => new Promise(() => {}));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("promotion review", () => {
  it("shows a delayed loading state and keeps the return path to its exploration available", async () => {
    await act(async () => root.render(createElement(PromotionReview, { explorationId: "exploration-1" })));
    expect(PromotionApi.list).toHaveBeenCalledWith("exploration-1");
    expect(container.querySelector('a[href="/explore/exploration-1"]')).not.toBeNull();
    expect(container.textContent).not.toContain("还没有候选内容");
    await act(async () => vi.advanceTimersByTimeAsync(299));
    expect(container.querySelector('[role="status"]')).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(container.querySelector('[role="status"]')?.textContent).toBe("正在读取候选内容");
    expect(container.textContent).not.toContain("还没有候选内容");
    expect(container.querySelector('a[href="/explore/exploration-1"]')).not.toBeNull();
  });

  it("preserves explicit candidate creation fields and does not offer acceptance before loading", async () => {
    await act(async () => root.render(createElement(PromotionReview, { explorationId: "exploration-1" })));
    for (const label of ["候选类型", "候选标题", "候选内容"]) expect(container.querySelector(`[aria-label="${label}"]`)).not.toBeNull();
    expect(container.textContent).toContain("创建候选");
    expect(container.querySelector('[aria-label="接受候选"]')).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(container.querySelector('[aria-label="接受候选"]')).toBeNull();
  });
});
