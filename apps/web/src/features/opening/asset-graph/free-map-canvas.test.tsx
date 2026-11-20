// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetGraphEdge, AssetGraphNode } from "@aistudy/contracts";
import { FreeMapCanvas } from "./free-map-canvas";
import {
  buildFreeMapPersistKey,
  decodeFreeMapPositions,
  freeMapStorageKey,
  readFreeMapStorage,
  writeFreeMapStorage,
} from "./free-map-canvas-storage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COURSE_NODE = "course/10000000-0000-4000-8000-000000000001" as const;
const REQ_NODE = "requirement/30000000-0000-4000-8000-000000000001" as const;

describe("free-map-canvas-storage security and isolation", () => {
  it("isolates persistKey strictly by userId:workspaceId:contextKey and disables persistence without identity", () => {
    expect(buildFreeMapPersistKey(null, "course:1")).toBeUndefined();
    expect(
      buildFreeMapPersistKey({ id: "u1", workspaceId: "ws1" }, "course:course/1"),
    ).toBe("u1:ws1:course:course/1");
    expect(
      buildFreeMapPersistKey({ id: "u2", workspaceId: "ws1" }, "course:course/1"),
    ).not.toBe(
      buildFreeMapPersistKey({ id: "u1", workspaceId: "ws1" }, "course:course/1"),
    );
    expect(freeMapStorageKey(undefined)).toBeNull();
  });

  it("retains only finite bounded {x, y} coordinates from untrusted storage payloads", () => {
    const raw = JSON.stringify({
      valid: { x: 120, y: -45, extra: "ignored-caption" },
      nanCoord: { x: "120", y: 10 },
      hugeCoord: { x: 99_999_999, y: 0 },
      arrayVal: [1, 2],
      nullVal: null,
    });
    expect(decodeFreeMapPositions(raw)).toEqual({
      valid: { x: 120, y: -45 },
    });
    expect(decodeFreeMapPositions("{bad json")).toEqual({});
    expect(decodeFreeMapPositions(null)).toEqual({});
  });

  it("degrades gracefully when localStorage throws", () => {
    const getItemSpy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    try {
      expect(readFreeMapStorage("k")).toEqual({ ok: false, positions: {} });
      expect(writeFreeMapStorage("k", { a: { x: 1, y: 2 } })).toBe(false);
    } finally {
      getItemSpy.mockRestore();
      setItemSpy.mockRestore();
    }
  });
});

describe("FreeMapCanvas", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    window.localStorage.clear();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("pans to a focused offscreen node and preserves saved positions through a layout remount", () => {
    const persistKey = "u-canvas:ws-canvas:course:test";
    const stored = { [COURSE_NODE]: { x: 0, y: 0 }, [REQ_NODE]: { x: 5_000, y: 0 } };
    const key = freeMapStorageKey(persistKey)!;
    window.localStorage.setItem(key, JSON.stringify(stored));
    const props = {
      nodes: [
        { id: COURSE_NODE, kind: "course" as const, label: "高等数学" },
        { id: REQ_NODE, kind: "requirement" as const, label: "比较判别" },
      ],
      edges: [] as AssetGraphEdge[],
      onSelect: vi.fn(),
      selectedId: COURSE_NODE,
      mode: "exam" as const,
      persistKey,
    };
    act(() => root.render(createElement(FreeMapCanvas, { ...props, layoutKey: "first" })));
    const node = container.querySelector<SVGGElement>(`[data-graph-node="${REQ_NODE}"]`)!;
    const viewport = node.closest("svg")!.querySelector("g[transform]")!;
    const prior = viewport.getAttribute("transform");
    act(() => node.focus());
    expect(document.activeElement).toBe(node);
    expect(viewport.getAttribute("transform")).not.toBe(prior);

    act(() => root.render(createElement(FreeMapCanvas, { ...props, layoutKey: "second" })));
    expect(window.localStorage.getItem(key)).toBe(JSON.stringify(stored));
    expect(container.querySelector(`[data-graph-node="${REQ_NODE}"]`)?.getAttribute("transform"))
      .toBe("translate(5000 0)");
  });

  it("renders nodes with isolated geometry storage and supports keyboard selection & branch fold", () => {
    const nodes: AssetGraphNode[] = [
      { id: COURSE_NODE, kind: "course", label: "高等数学" },
      {
        id: REQ_NODE,
        kind: "requirement",
        label: "正项级数比较判别",
        summary: { learnerState: null, requirementStatus: "needs_verification" },
      },
    ];
    const edges: AssetGraphEdge[] = [
      {
        id: "e1",
        from: COURSE_NODE,
        to: REQ_NODE,
        relation: "scopes",
        basis: "recorded",
      },
    ];
    const onSelect = vi.fn();
    const persistKey = buildFreeMapPersistKey(
      { id: "u-canvas", workspaceId: "ws-canvas" },
      "course:test",
    );

    act(() => {
      root.render(
        createElement(FreeMapCanvas, {
          nodes,
          edges,
          selectedId: COURSE_NODE,
          mode: "exam",
          onSelect,
          layoutKey: "course:test:all",
          persistKey,
        }),
      );
    });

    const reqNode = container.querySelector<SVGGElement>(`[data-graph-node="${REQ_NODE}"]`)!;
    expect(reqNode).not.toBeNull();
    expect(reqNode.textContent).toContain("待独立检验");

    const svg = reqNode.closest("svg")!;
    const plainWheel = new WheelEvent("wheel", { deltaY: 36, bubbles: true, cancelable: true });
    const zoomWheel = new WheelEvent("wheel", { deltaY: 36, ctrlKey: true, bubbles: true, cancelable: true });
    act(() => { svg.dispatchEvent(plainWheel); svg.dispatchEvent(zoomWheel); });
    expect(plainWheel.defaultPrevented).toBe(false);
    expect(zoomWheel.defaultPrevented).toBe(true);

    act(() => {
      reqNode.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledWith(REQ_NODE);

    // Fold child branch via fold control
    const foldButton = container.querySelector<SVGGElement>('[data-map-control="fold"]')!;
    act(() => {
      foldButton.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(container.querySelector(`[data-graph-node="${REQ_NODE}"]`)).toBeNull();
  });
});
