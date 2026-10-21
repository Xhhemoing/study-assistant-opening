// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: ReactNode; href: string }) =>
    createElement("a", { ...props, href }, children),
}));

import { LibraryDocumentList } from "./library-document-list";

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
});

describe("library document list", () => {
  it("exposes a delayed accessible loading state without showing an empty library", async () => {
    await act(async () => root.render(createElement(LibraryDocumentList)));
    expect(fetch).toHaveBeenCalledWith("/api/documents", expect.objectContaining({ cache: "no-store" }));
    await act(async () => vi.advanceTimersByTimeAsync(299));
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.textContent).not.toContain("还没有笔记");
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(container.querySelector('[role="status"]')?.textContent).toBe("正在读取笔记...");
    expect(container.textContent).not.toContain("还没有笔记");
    expect(container.querySelector(".library-loading, .empty-state")).toBeNull();
  });
});
