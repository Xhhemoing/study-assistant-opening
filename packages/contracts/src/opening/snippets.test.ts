import { describe, expect, it } from "vitest";
import { snippetCreateInputSchema } from "./snippets";
import { ephemeralTurnInputSchema, ephemeralTurnResponseSchema } from "./tutor";
const id = "10000000-0000-4000-8000-000000000001";

describe("explicit linked snippet input", () => {
  it("accepts only confirmed text and a server receipt, never client supplied source refs", () => {
    expect(snippetCreateInputSchema.parse({ title: " note ", text: " selected ", provenanceId: id })).toEqual({ title: "note", text: "selected", provenanceId: id });
    expect(snippetCreateInputSchema.safeParse({ title: "note", text: "selected", provenanceId: id, sourceRefs: [] }).success).toBe(false);
    for (const text of ["", " ", "x".repeat(20_001)]) expect(snippetCreateInputSchema.safeParse({ title: "note", text, provenanceId: id }).success).toBe(false);
  });
  it("carries per-message receipts and treats legacy responses as unknown", () => {
    expect(ephemeralTurnInputSchema.parse({ text: "next", sourceIds: [], mode: "listen", history: [{ role: "assistant", text: "previous", provenanceId: id }] }).history[0]!.provenanceId).toBe(id);
    expect(ephemeralTurnResponseSchema.parse({ text: "answer", citedChunkIds: [], candidates: [], requestId: null, inputTokens: 1, outputTokens: 1, privacyEpoch: 0, historyDiscarded: false }).provenanceId).toBeNull();
  });
});
