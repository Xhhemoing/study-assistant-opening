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
