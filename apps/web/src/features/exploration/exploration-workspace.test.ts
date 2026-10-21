// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { explorationApi } from "./exploration-api";
import { ExplorationWorkspaceDetail, ExplorationWorkspaceList } from "./exploration-workspace";

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.useFakeTimers();
  vi.spyOn(explorationApi, "list").mockImplementation(() => new Promise(() => {}));
  vi.spyOn(explorationApi, "get").mockImplementation(() => new Promise(() => {}));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("persisted exploration workspace", () => {
  it("keeps creation available while the exploration list is loading", async () => {
    await act(async () => root.render(createElement(ExplorationWorkspaceList)));
    expect(explorationApi.list).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("自由探索");
    expect(container.querySelector('[aria-label="开始探索"]')).not.toBeNull();
    expect(container.textContent).not.toContain("还没有探索");
    await act(async () => vi.advanceTimersByTimeAsync(299));
    expect(container.querySelector('[role="status"]')).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(container.querySelector('[role="status"]')?.textContent).toBe("正在加载探索");
    expect(container.querySelector('[aria-label="开始探索"]')).not.toBeNull();
    expect(container.textContent).not.toContain("还没有探索");
  });

  it("does not expose editable branch content before the detail has loaded", async () => {
    await act(async () => root.render(createElement(ExplorationWorkspaceDetail, { explorationId: "exploration-1" })));
    expect(explorationApi.get).toHaveBeenCalledWith("exploration-1");
    expect(container.querySelector("#block-content")).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(container.querySelector('[role="status"]')?.textContent).toBe("正在加载探索");
    expect(container.querySelector("#block-content")).toBeNull();
  });
});
