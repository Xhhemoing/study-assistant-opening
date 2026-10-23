// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { SourceRecord } from "@aistudy/contracts";
import type { OpeningApi } from "../client/api";
import { InboxPanel } from "./inbox-panel";
import { parseSourceViewerSearchParams } from "./source-viewer";
const reader = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock("./source-reader", () => ({ SourceReader: (props: unknown) => { reader.render(props); return createElement("div", { "data-opened-reader": true }); } }));
vi.mock("./source-cleanup-panel", () => ({ SourceCleanupPanel: () => null }));

it("keeps the explicit library deep-link conversation separate from the material revision and ordinary opens", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const id = "11111111-1111-4111-8111-111111111111", conversation = "22222222-2222-4222-8222-222222222222";
  const record = { id, name: "材料.pdf", mime: "application/pdf", bytes: 42, sha256: "ab".repeat(32), version: 3, uploadState: "uploaded", parseState: "ready", error: null } as SourceRecord;
  const target = parseSourceViewerSearchParams({ source: id, version: "2", page: "7", conversation });
  const props = { api: {} as OpeningApi, sources: [record], initialOpen: target, onChanged: async () => {}, hideUploadPicker: true };
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(InboxPanel, props)));
    expect(reader.render.mock.lastCall?.[0]).toMatchObject({ record, requestedVersion: 2, page: 7, originalConversationId: conversation });
    const nextConversation = "33333333-3333-4333-8333-333333333333";
    await act(async () => root.render(createElement(InboxPanel, { ...props, initialOpen: { ...target!, conversationId: nextConversation } })));
    expect(reader.render.mock.lastCall?.[0].originalConversationId).toBe(nextConversation);
    await act(async () => host.querySelector<HTMLButtonElement>("[data-source-open]")!.click());
    expect(reader.render.mock.lastCall?.[0]).toMatchObject({ record, requestedVersion: 3 });
    expect(reader.render.mock.lastCall?.[0].originalConversationId).toBeUndefined();
  } finally { await act(async () => root.unmount()); host.remove(); vi.clearAllMocks(); }
});
