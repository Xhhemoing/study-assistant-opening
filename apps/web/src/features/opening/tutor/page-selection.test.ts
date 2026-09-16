import { describe, expect, it } from "vitest";
import { validatePageSelection } from "./page-selection";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const C1 = "33333333-3333-4333-8333-333333333333";
const C2 = "44444444-4444-4444-8444-444444444444";
const C3 = "55555555-5555-4555-8555-555555555555";

const chunks = [
  { id: C1, sourceId: S1, page: 4 },
  { id: C2, sourceId: S1, page: 5 },
  { id: C3, sourceId: S2, page: 4 },
];

describe("validatePageSelection (RU-03)", () => {
  it("does not invent a page when selection is absent", () => {
    expect(
      validatePageSelection({ sourceIds: [S1] }, chunks),
    ).toEqual({ ok: true, matchedChunkIds: [] });
  });

  it("accepts currentPage membership within selected sources", () => {
    expect(
      validatePageSelection({ sourceIds: [S1], currentPage: 4 }, chunks),
    ).toEqual({ ok: true, matchedChunkIds: [C1] });
  });

  it("rejects page not in selected sources (file != page)", () => {
    expect(
      validatePageSelection({ sourceIds: [S1], currentPage: 99 }, chunks),
    ).toEqual({ ok: false, code: "page_not_in_sources" });
  });

  it("rejects chunk outside selected sources", () => {
    expect(
      validatePageSelection(
        { sourceIds: [S1], chunkId: C3 },
        chunks,
      ),
    ).toEqual({ ok: false, code: "chunk_not_in_sources" });
  });

  it("rejects page/chunk mismatch when chunk.page is set", () => {
    expect(
      validatePageSelection(
        { sourceIds: [S1], currentPage: 4, chunkId: C2 },
        chunks,
      ),
    ).toEqual({ ok: false, code: "page_chunk_mismatch" });
  });

  it("accepts matching page + chunk", () => {
    expect(
      validatePageSelection(
        { sourceIds: [S1], currentPage: 5, chunkId: C2 },
        chunks,
      ),
    ).toEqual({ ok: true, matchedChunkIds: [C2] });
  });
});
