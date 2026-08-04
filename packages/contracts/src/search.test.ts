import { describe, expect, it } from "vitest";
import {
  searchableDocumentsResponseSchema,
  searchHitSchema,
  searchRequestSchema,
  searchResponseSchema,
} from "./search";

describe("searchable document contracts", () => {
  it("parses the document response used by the mock search provider", () => {
    const parsed = searchableDocumentsResponseSchema.parse({
      documents: [{
        id: "document-1",
        title: "导数笔记",
        body: "导数的定义",
        tags: ["高数"],
      }],
    });

    expect(parsed.documents[0]?.title).toBe("导数笔记");
  });

  it("rejects a document response without a usable identity", () => {
    expect(() => searchableDocumentsResponseSchema.parse({
      documents: [{ title: "缺少 id" }],
    })).toThrow();
  });
});

describe("search contracts", () => {
  it("accepts a trimmed query with an optional bounded limit", () => {
    expect(searchRequestSchema.parse({ q: "  线性代数  " })).toEqual({
      q: "线性代数",
    });
    expect(searchRequestSchema.parse({ q: "matrix", limit: 10 })).toEqual({
      q: "matrix",
      limit: 10,
    });
  });

  it("rejects empty queries, oversized queries, and out-of-range limits", () => {
    expect(() => searchRequestSchema.parse({ q: "   " })).toThrow();
    expect(() => searchRequestSchema.parse({ q: "x".repeat(201) })).toThrow();
    expect(() => searchRequestSchema.parse({ q: "x", limit: 0 })).toThrow();
    expect(() => searchRequestSchema.parse({ q: "x", limit: 51 })).toThrow();
    expect(() => searchRequestSchema.parse({ q: "x", limit: 1.5 })).toThrow();
  });

  it("rejects unknown request fields", () => {
    expect(() => searchRequestSchema.parse({ q: "x", page: 2 })).toThrow();
  });

  it("parses a search hit and its lifecycle and course metadata", () => {
    const hit = {
      id: "11111111-1111-4111-8111-111111111111",
      type: "document",
      title: "线性代数笔记",
      snippet: "矩阵的行列式…",
      score: 5,
      lifecycle: "confirmed",
      courseMemberships: [{
        id: "22222222-2222-4222-8222-222222222222",
        title: "高等数学",
      }],
    };
    expect(searchHitSchema.parse(hit)).toEqual(hit);
    expect(searchResponseSchema.parse({ hits: [hit] })).toEqual({
      hits: [hit],
    });
  });

  it("rejects hits with an unknown type or non-numeric score", () => {
    expect(() =>
      searchHitSchema.parse({
        id: "x",
        type: "artifact",
        title: "t",
        snippet: "",
        score: 1,
      }),
    ).toThrow();
    expect(() =>
      searchHitSchema.parse({
        id: "x",
        type: "document",
        title: "t",
        snippet: "",
        score: "high",
      }),
    ).toThrow();
  });
});
