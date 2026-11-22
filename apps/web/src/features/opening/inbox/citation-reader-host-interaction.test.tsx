// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { SourceRecord } from "@aistudy/contracts";
import type { OpeningApi } from "../client/api";
import { CitationReaderHost } from "./citation-reader-host";
import { sourceViewerHref } from "./source-viewer";
const reader = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/opening/today" }));
vi.mock("./source-reader", () => ({
  SourceReader: (props: unknown) => { reader.render(props); return createElement("div", { "data-opened-reader": true }); },
  SourceReaderFrame: ({ children }: { children: ReactNode }) => createElement("div", null, children),
}));

it("passes the clicked conversation to the reader while preserving the exact source record and locator", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const sourceId = "11111111-1111-4111-8111-111111111111", conversationId = "22222222-2222-4222-8222-222222222222";
  const record = { id: sourceId, version: 3, uploadState: "uploaded", bytes: 9427, sha256: "ab".repeat(32) } as SourceRecord;
  const api = { listSources: vi.fn().mockResolvedValue([record]) } as unknown as OpeningApi;
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    const href = `${sourceViewerHref(sourceId, 2, { page: 7 })}&conversation=${conversationId}`;
    await act(async () => root.render(createElement("div", null, createElement("a", { href }, "打开材料"), createElement(CitationReaderHost, { api }))));
    await act(async () => host.querySelector("a")!.click());
    expect(reader.render.mock.lastCall?.[0]).toMatchObject({ record, requestedVersion: 2, page: 7, originalConversationId: conversationId });
    expect(reader.render.mock.lastCall?.[0].record).toBe(record);
    expect(reader.render.mock.lastCall?.[0].courseId).toBeUndefined();
  } finally { await act(async () => root.unmount()); host.remove(); vi.clearAllMocks(); }
});

it("forwards media range startMs, endMs, and keyframeChunkId from clicked citations to SourceReader", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const sourceId = "11111111-1111-4111-8111-111111111111";
  const record = { id: sourceId, name: "微积分网课.mp4", mime: "video/mp4", version: 2, uploadState: "uploaded", bytes: 9427, sha256: "ab".repeat(32) } as SourceRecord;
  const api = { listSources: vi.fn().mockResolvedValue([record]) } as unknown as OpeningApi;
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    const href = sourceViewerHref(sourceId, 2, { startMs: 65_000, endMs: 90_000, keyframeChunkId: "kf-65" });
    await act(async () => root.render(createElement("div", null, createElement("a", { href }, "打开媒体引用"), createElement(CitationReaderHost, { api }))));
    await act(async () => host.querySelector("a")!.click());
    expect(reader.render.mock.lastCall?.[0]).toMatchObject({
      record,
      requestedVersion: 2,
      startMs: 65_000,
      endMs: 90_000,
      keyframeChunkId: "kf-65",
    });
  } finally { await act(async () => root.unmount()); host.remove(); vi.clearAllMocks(); }
});
