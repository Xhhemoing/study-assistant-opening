import { describe, expect, it, vi } from "vitest";
import { conceptPreviewRequestSchema } from "./preview-contract";
import { locatePreviewSelection } from "./preview-service";
import { requestConceptPreview } from "./preview-client";
const input = { sourceId: "00000000-0000-4000-8000-000000000001", sourceVersion: 1, page: 1, term: "z̄", clientKey: "test" };
describe("reader preview contract and exact locator", () => {
  it("caps client keys before server delivery key construction", () => {
    expect(conceptPreviewRequestSchema.safeParse({ ...input, clientKey: "x".repeat(119) }).success).toBe(true);
    expect(conceptPreviewRequestSchema.safeParse({ ...input, clientKey: "x".repeat(120) }).success).toBe(false);
  });
  it("rejects client policy, body and incomplete offsets", () => {
    for (const extra of [{ body: "trusted?" }, { attemptId: "fake" }, { selection: { text: "z̄", start: 0 } }]) expect(conceptPreviewRequestSchema.safeParse({ ...input, ...extra }).success).toBe(false);
  });
  it("does not conflate notation or use unrelated client text", () => {
    expect(locatePreviewSelection("z Z", input).status).toBe("unavailable");
    expect(locatePreviewSelection("z̄", { ...input, selection: { text: "injected z̄" } }).status).toBe("unavailable");
    expect(locatePreviewSelection("z̄", { ...input, selection: { text: "z̄", start: 1, end: 3 } }).status).toBe("stale");
  });
  it("requires unique occurrence unless exact offsets disambiguate", () => {
    expect(locatePreviewSelection("z̄ z̄", input).status).toBe("ambiguous");
    expect(locatePreviewSelection("z̄ z̄", { ...input, selection: { text: "z̄", start: 3, end: 5 } })).toMatchObject({ status: "available", selection: { text: "z̄", start: 3, end: 5 } });
  });
  it("POSTs explicitly without caching and preserves cancellation/key", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ status: "unavailable", reason: "no_match" }));
    vi.stubGlobal("fetch", fetcher);
    try {
      const signal = new AbortController().signal;
      expect(await requestConceptPreview(input, { signal })).toMatchObject({ status: "unavailable" });
      expect(fetcher).toHaveBeenCalledWith("/api/opening/concepts/preview", expect.objectContaining({ method: "POST", cache: "no-store", signal, body: JSON.stringify(input) }));
      fetcher.mockResolvedValue(new Response(null,{status:409}));
      await expect(requestConceptPreview(input)).rejects.toThrow("409");
    } finally { vi.unstubAllGlobals(); }
  });
});
