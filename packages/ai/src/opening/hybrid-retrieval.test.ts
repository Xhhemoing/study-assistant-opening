import { describe, expect, it } from "vitest";
import type { SourceChunk } from "@aistudy/contracts";
import { budgetRankedMaterial, rankMaterialContext, segmentMaterialChunks } from "./hybrid-retrieval";
import { renderContext } from "./context";

const chunk = (id: string, text: string, page = 1): SourceChunk => ({ id, text, page, sourceId: id, sourceVersion: 1,
  slideLabel: null, startMs: null, endMs: null, imageObjectKey: null });

describe("material hybrid retrieval", () => {
  it("segments long Unicode pages with the full tail and the same citation identity", () => {
    const original = chunk("long", "线性代数😀".repeat(2500) + "tail-not-lost");
    const segments = segmentMaterialChunks([original]);
    expect(segments.length).toBeGreaterThan(4);
    expect(segments.map(segment => segment.chunk.text).join("")).toBe(original.text);
    expect(segments.every(segment => new TextEncoder().encode(segment.chunk.text).length <= 6000)).toBe(true);
    expect(segments.map(segment => segment.segmentIndex)).toEqual(segments.map((_, index) => index));
    expect(segments.every(segment => segment.chunk.id === original.id && segment.chunk.sourceVersion === 1)).toBe(true);
  });

  it("recalls a differently worded source beyond the former six-source shortlist", () => {
    const chunks = Array.from({ length: 9 }, (_, index) => chunk(String(index), index === 8 ? "矩阵乘积为零的所有输入构成零空间。" : "课程通知"));
    const ranked = rankMaterialContext({ chunks, query: "Explain the kernel", maxCharacters: 2000,
      dense: [{ chunk: chunks[8]!, segmentIndex: 0 }] });
    expect(ranked[0]?.id).toBe("8");
  });

  it("retrieves a matching tail excerpt rather than dropping a page exceeding the context budget", () => {
    const long = chunk("long", "other ".repeat(3000) + "target theorem in the tail");
    const selected = rankMaterialContext({ chunks: [long], query: "target theorem", maxCharacters: 1200 });
    expect(selected[0]?.text).toContain("target theorem");
    expect(renderContext(selected).length).toBeLessThanOrEqual(1200);
  });

  it("keeps explicit location first and refuses dense results outside the input version", () => {
    const preferred = chunk("chosen", "Selected page", 3), semantic = chunk("semantic", "映射", 1);
    const ranked = rankMaterialContext({ chunks: [semantic, preferred], query: "map", maxCharacters: 500,
      preferPage: 3, dense: [{ chunk: semantic, segmentIndex: 0 }, { chunk: chunk("foreign", "private"), segmentIndex: 0 }] });
    expect(ranked[0]?.id).toBe("chosen");
    expect(ranked.map(row => row.id)).not.toContain("foreign");
    expect(rankMaterialContext({ chunks: [preferred, semantic], query: "map", maxCharacters: 500,
      dense: [{ chunk: { ...semantic, sourceVersion: 2 }, segmentIndex: 0 }] })[0]?.id).toBe("chosen");
  });

  it("preserves semantic ranking through the final budget and merges citation identities", () => {
    const rows = [chunk("semantic", "矩阵的零空间"), chunk("literal", "kernel word")];
    expect(budgetRankedMaterial(rows, 500).map(row => row.id)).toEqual(["semantic", "literal"]);
    const long = chunk("long", "target ".repeat(1100));
    const selected = rankMaterialContext({ chunks: [long], query: "target", maxCharacters: 10000 });
    expect(selected).toHaveLength(1);
    expect(selected[0]?.id).toBe("long");
    expect(renderContext(selected).length).toBeLessThanOrEqual(10000);
  });
  it("never cuts a mathematical Unicode character while fitting a preferred excerpt", () => {
    const source = chunk("math", "𝑥 + 1");
    const overhead = renderContext([{ ...source, text: "" }]).length;
    expect(budgetRankedMaterial([source], overhead + 1)).toEqual([]);
    expect(budgetRankedMaterial([source], overhead + 2)[0]?.text).toBe("𝑥");
  });
});
