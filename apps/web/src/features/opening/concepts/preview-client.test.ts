import { afterEach, describe, expect, it, vi } from "vitest";
import { conceptPreviewRequestSchema, conceptPreviewResponseSchema, type ConceptPreviewRequest } from "./preview-contract";
import { requestConceptPreview } from "./preview-client";

const ack = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../assistant/study-exposure-ack", () => ({ acknowledgeStudyExposure: ack }));

const input = conceptPreviewRequestSchema.parse({
  sourceId: "00000000-0000-4000-8000-000000000001", sourceVersion: 1, page: 1,
  term: "z̄", clientKey: "preview:test-1", selection: { text: "z̄", start: 2, end: 4 },
});
function available(request: ConceptPreviewRequest = input) {
  const contextAnchor = { sourceId: request.sourceId, sourceVersion: request.sourceVersion, page: request.page, purpose: "material_read" };
  const result = conceptPreviewResponseSchema.parse({
    status: "available", kind: "source_excerpt", term: request.term, text: "a z̄ b z̄",
    selection: { text: "z̄", start: 2, end: 4 },
    context: { scope: "same_page_paragraph", expanded: true, truncatedBefore: false, truncatedAfter: false },
    locator: { sourceId: request.sourceId, sourceVersion: request.sourceVersion, page: request.page, start: 0, end: 9, manifestRevision: 0 },
    contextAnchor,
    exposureReceipts: [{ id: "00000000-0000-4000-8000-000000000002", releaseKey: `concept-preview:${request.clientKey}:${"a".repeat(64)}`,
      contextAnchor: { ...contextAnchor }, origin: "material_excerpt", supportDomain: "unknown",
      generatedAt: "2026-10-24T00:00:00.000Z", releasedAt: "2026-10-24T00:00:01.000Z", acknowledgedAt: null, historyRevision: 1 }],
  });
  if (result.status !== "available") throw new Error("Expected available fixture");
  return result;
}
function reply(value: unknown) {
  const fetcher = vi.fn().mockResolvedValue(Response.json(value));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
afterEach(() => {
  vi.unstubAllGlobals();
  ack.mockReset().mockResolvedValue(undefined);
});

describe("preview client: validate the complete response before ACK", () => {
  it("POSTs a valid exact-combining-mark selection and ACKs the validated receipt, without forwarding cancellation", async () => {
    const value = available();
    const fetcher = reply(value);
    const controller = new AbortController();
    ack.mockImplementationOnce(async () => { controller.abort(); });
    expect(await requestConceptPreview(input, { signal: controller.signal })).toEqual(value);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("/api/opening/concepts/preview", {
      method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", cache: "no-store",
      body: JSON.stringify(input), signal: controller.signal,
    });
    expect(ack).toHaveBeenCalledExactlyOnceWith(value.exposureReceipts[0]);
    expect(ack.mock.calls[0]).toHaveLength(1);
    expect(controller.signal.aborted).toBe(true);
  });

  it("keeps accepted content when ACK rejects", async () => {
    const value = available();
    ack.mockRejectedValueOnce(new Error("ACK offline"));
    reply(value);
    expect(await requestConceptPreview(input)).toEqual(value);
    await Promise.resolve();
    expect(ack).toHaveBeenCalledExactlyOnceWith(value.exposureReceipts[0]);
  });

  it("accepts a 119-character client key and its full 200-character receipt key", async () => {
    const request = conceptPreviewRequestSchema.parse({ ...input, clientKey: "x".repeat(119) });
    const value = available(request);
    expect(value.exposureReceipts[0]!.releaseKey).toHaveLength(200);
    reply(value);
    expect(await requestConceptPreview(request)).toEqual(value);
    expect(ack).toHaveBeenCalledExactlyOnceWith(value.exposureReceipts[0]);
  });

  it("rejects a 120-character client key before fetch or ACK", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(conceptPreviewRequestSchema.safeParse({ ...input, clientKey: "x".repeat(120) }).success).toBe(false);
    await expect(requestConceptPreview({ ...input, clientKey: "x".repeat(120) })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
  });

  it.each(["ambiguous", "unavailable", "restricted", "stale"] as const)("returns %s without ACK", async status => {
    const value = conceptPreviewResponseSchema.parse({ status, reason: "policy_or_selection" });
    reply(value);
    expect(await requestConceptPreview(input)).toEqual(value);
    expect(ack).not.toHaveBeenCalled();
  });

  const mismatches: Array<[string, (value: ReturnType<typeof available>) => void]> = [
    ["source", v => {
      const sourceId = "00000000-0000-4000-8000-000000000099";
      v.locator.sourceId = sourceId; v.contextAnchor.sourceId = sourceId; v.exposureReceipts[0]!.contextAnchor.sourceId = sourceId;
    }],
    ["version", v => { v.locator.sourceVersion = 2; v.contextAnchor.sourceVersion = 2; v.exposureReceipts[0]!.contextAnchor.sourceVersion = 2; }],
    ["page", v => { v.locator.page = 2; v.contextAnchor.page = 2; v.exposureReceipts[0]!.contextAnchor.page = 2; }],
    ["term", v => { v.term = "z"; }],
    ["selection text", v => { v.selection = { text: "a z̄", start: 0, end: 4 }; }],
    ["same term at a different position", v => { v.selection = { text: "z̄", start: 7, end: 9 }; }],
    ["receipt intent", v => { v.exposureReceipts[0]!.releaseKey = `concept-preview:other:${"a".repeat(64)}`; }],
    ["receipt hash", v => { v.exposureReceipts[0]!.releaseKey = `concept-preview:${input.clientKey}:${"A".repeat(64)}`; }],
  ];
  it.each(mismatches)("rejects schema-valid cross-request %s before ACK", async (_name, mutate) => {
    const value = available(); mutate(value);
    // This must exercise request binding, not accidentally fail the response schema.
    expect(conceptPreviewResponseSchema.safeParse(value).success).toBe(true);
    reply(value);
    await expect(requestConceptPreview(input)).rejects.toThrow("does not match request");
    expect(ack).not.toHaveBeenCalled();
  });

  const invalid: Array<[string, (value: ReturnType<typeof available>) => unknown]> = [
    ["unknown status", v => ({ ...v, status: "future" })],
    ["unknown top-level field", v => ({ ...v, extra: true })],
    ["unknown locator field", v => ({ ...v, locator: { ...v.locator, extra: true } })],
    ["unknown context field", v => ({ ...v, context: { ...v.context, extra: true } })],
    ["wrong locator span", v => ({ ...v, locator: { ...v.locator, end: 8 } })],
    ["wrong selection span", v => ({ ...v, selection: { ...v.selection, end: 3 } })],
    ["selection outside context", v => ({ ...v, selection: { ...v.selection, start: 20, end: 22 } })],
    ["folded combining mark", v => ({ ...v, selection: { text: "z", start: 2, end: 3 } })],
    ["false expansion flag", v => ({ ...v, context: { ...v.context, expanded: false } })],
    ["anchor source", v => ({ ...v, contextAnchor: { ...v.contextAnchor, sourceId: "00000000-0000-4000-8000-000000000099" } })],
    ["anchor version", v => ({ ...v, contextAnchor: { ...v.contextAnchor, sourceVersion: 2 } })],
    ["anchor page", v => ({ ...v, contextAnchor: { ...v.contextAnchor, page: 2 } })],
    ["anchor purpose", v => ({ ...v, contextAnchor: { ...v.contextAnchor, purpose: "learning_help" } })],
    ["receipt anchor", v => ({ ...v, exposureReceipts: [{ ...v.exposureReceipts[0], contextAnchor: { ...v.contextAnchor, page: 2 } }] })],
    ["unreleased receipt", v => ({ ...v, exposureReceipts: [{ ...v.exposureReceipts[0], releasedAt: null }] })],
    ["wrong receipt origin", v => ({ ...v, exposureReceipts: [{ ...v.exposureReceipts[0], origin: "assistant" }] })],
    ["missing receipt", v => ({ ...v, exposureReceipts: [] })],
    ["extra receipt", v => ({ ...v, exposureReceipts: [...v.exposureReceipts, ...v.exposureReceipts] })],
  ];
  it.each(invalid)("rejects malformed %s without ACK", async (_name, mutate) => {
    const value = mutate(available());
    expect(conceptPreviewResponseSchema.safeParse(value).success).toBe(false);
    reply(value);
    await expect(requestConceptPreview(input)).rejects.toThrow();
    expect(ack).not.toHaveBeenCalled();
  });

  it("rejects bad JSON without ACK", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{")));
    await expect(requestConceptPreview(input)).rejects.toThrow();
    expect(ack).not.toHaveBeenCalled();
  });

  it.each([
    ["", "Concept preview request failed (409)"],
    ["{", "Concept preview request failed (409)"],
    [JSON.stringify({ error: "资料已更新" }), "资料已更新 (409)"],
    [JSON.stringify({ error: { message: "资料已更新" } }), "资料已更新 (409)"],
  ])("preserves HTTP error detail/fallback for %s", async (body, message) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 409 })));
    await expect(requestConceptPreview(input)).rejects.toThrow(message);
    expect(ack).not.toHaveBeenCalled();
  });
});
