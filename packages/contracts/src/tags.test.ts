import { describe, expect, it } from "vitest";
import {
  documentTagsUpdateSchema,
  normalizeDocumentTags,
} from "./tags";

describe("document tags", () => {
  it("normalizes Unicode whitespace and deduplicates case variants with first spelling", () => {
    expect(normalizeDocumentTags([
      "  \uFF34\uFF2F\uFF30\uFF29\uFF23  ",
      "topic",
      "  \u6807\u7B7E\u00A0\u00A0\u590D\u4E60 ",
    ])).toEqual(["TOPIC", "\u6807\u7B7E \u590D\u4E60"]);
  });

  it("validates limits after normalization rather than raw surrounding whitespace", () => {
    const padded = ` ${"x".repeat(80)} `;
    expect(documentTagsUpdateSchema.parse({ tags: [padded] })).toEqual({ tags: [padded] });
    expect(normalizeDocumentTags([padded])).toEqual(["x".repeat(80)]);
  });

  it("accepts an intentional empty tag collection", () => {
    expect(documentTagsUpdateSchema.parse({ tags: [] })).toEqual({ tags: [] });
  });

  it("rejects empty, oversized, and too many normalized tags", () => {
    expect(() => normalizeDocumentTags(["   "])).toThrow();
    expect(() => normalizeDocumentTags(["x".repeat(81)])).toThrow();
    expect(() => normalizeDocumentTags(Array.from({ length: 33 }, (_, index) => `tag-${index}`))).toThrow();
  });
});
