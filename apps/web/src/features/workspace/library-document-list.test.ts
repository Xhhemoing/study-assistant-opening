// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: ReactNode; href: string }) =>
    createElement("a", { ...props, href }, children),
}));

import { LibraryDocumentList } from "./library-document-list";
import { ObjectConversationContext } from "../opening/assistant/conversation-object-context";

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
  const conversation = "11111111-1111-4111-8111-111111111111", note = "22222222-2222-4222-8222-222222222222";
  it.each(["/opening/library", "/library"] as const)("carries the original conversation only to supported note details under %s", async basePath => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ documents: [{ id: note, title: "本课笔记", lifecycle: "active", updatedAt: "2026-10-22T08:00:00Z" }] }));
    await act(async () => root.render(createElement(ObjectConversationContext.Provider, { value: conversation }, createElement(LibraryDocumentList, { basePath, courseId: "course", documentIds: [note] }))));
    expect(container.querySelector('ul[aria-label="笔记列表"] a')?.getAttribute("href")).toBe(`${basePath}/${note}${basePath === "/opening/library" ? `?conversation=${conversation}` : ""}`);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("keeps the existing course-bound creation URL outside the conversation whitelist", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ documents: [] }));
    await act(async () => root.render(createElement(ObjectConversationContext.Provider, { value: conversation }, createElement(LibraryDocumentList, { basePath: "/opening/library", courseId: "course / 1" }))));
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/opening/library/new?courseId=course%20%2F%201");
  });
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
