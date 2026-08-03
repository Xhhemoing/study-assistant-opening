import { describe, expect, it } from "vitest";
import { searchableDocumentsResponseSchema } from "./search";

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
