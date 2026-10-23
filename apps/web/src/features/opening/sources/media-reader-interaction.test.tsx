// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { MediaSegmentsResponse } from "@aistudy/contracts";
import type { OpeningApi } from "../client/api";
import { MediaReader } from "./media-reader";

it("ignores a previous material's late media response and rejects mixed-revision segments", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let resolve!: (value: MediaSegmentsResponse) => void;
  const payload = (sourceId: string, text: string): MediaSegmentsResponse => ({ sourceId, sourceVersion: 2, durationMs: 1000, claimsVisualUnderstanding: false,
    segments: [{ sourceId, sourceVersion: 2, startMs: 0, endMs: 1000, text, frameChunkIds: [], quality: "needs_check" }] });
  const api = { getSourceSegments: vi.fn().mockImplementationOnce(() => new Promise<MediaSegmentsResponse>(done => { resolve = done; })).mockResolvedValueOnce(payload("B", "材料B片段")).mockResolvedValueOnce({ ...payload("C", "错误版本片段"), sourceVersion: 3 }) };
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(MediaReader, { sourceId: "A", api: api as unknown as OpeningApi })));
    await act(async () => root.render(createElement(MediaReader, { sourceId: "B", api: api as unknown as OpeningApi })));
    await act(async () => resolve(payload("A", "迟到的材料A片段")));
    expect(host.textContent).toContain("材料B片段"); expect(host.textContent).not.toContain("材料A片段");
    await act(async () => root.render(createElement(MediaReader, { sourceId: "C", api: api as unknown as OpeningApi })));
    expect(host.textContent).toContain("片段的材料来源或版本已失效"); expect(host.textContent).not.toContain("错误版本片段");
  } finally { await act(async () => root.unmount()); host.remove(); }
});
