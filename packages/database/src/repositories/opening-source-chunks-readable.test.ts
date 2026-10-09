import { describe, expect, it } from "vitest";
import { chunksHaveReadableContent } from "./opening-source-chunks";

const base = { page: 1, slideLabel: null, startMs: null, endMs: null };

describe("chunksHaveReadableContent", () => {
  it("accepts empty text when an image object key is present", () => {
    expect(chunksHaveReadableContent([{ ...base, text: "", imageObjectKey: "opening/sources/a/v0" }])).toBe(true);
  });

  it("rejects empty text without an image object key", () => {
    expect(chunksHaveReadableContent([{ ...base, text: "   ", imageObjectKey: null }])).toBe(false);
    expect(chunksHaveReadableContent([{ ...base, text: "", imageObjectKey: "  " }])).toBe(false);
    expect(chunksHaveReadableContent([])).toBe(false);
  });

  it("accepts non-empty text without an image key", () => {
    expect(chunksHaveReadableContent([{ ...base, text: "hello", imageObjectKey: null }])).toBe(true);
  });
});
