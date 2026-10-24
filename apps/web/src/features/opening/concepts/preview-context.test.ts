import { describe, expect, it, vi } from "vitest";
import { conceptPreviewRequestSchema } from "./preview-contract";
import { expandPreviewContext, locatePreviewSelection } from "./preview-service";

// Pure locator/context coverage must never initialize a database repository.
vi.mock("@aistudy/database", () => ({
  createOpeningConceptPreviewRepository: () => { throw new Error("Unexpected database access in pure context test"); },
}));
vi.mock("server-only", () => ({}));
const input = conceptPreviewRequestSchema.parse({
  sourceId: "00000000-0000-4000-8000-000000000001", sourceVersion: 1, page: 1, term: "z̄", clientKey: "context-test",
});
function selection(text: string, quote: string, start = text.indexOf(quote)) {
  expect(start).toBeGreaterThanOrEqual(0);
  expect(text.slice(start, start + quote.length)).toBe(quote);
  return { text: quote, start, end: start + quote.length };
}
function exactSlice(text: string, selected: ReturnType<typeof selection>) {
  const result = expandPreviewContext(text, selected);
  expect(result.text).toBe(text.slice(result.start, result.end));
  expect(result.text.length).toBe(result.end - result.start);
  expect(result.text.length).toBeLessThanOrEqual(1200);
  expect(result.start).toBeGreaterThanOrEqual(0);
  expect(result.end).toBeLessThanOrEqual(text.length);
  expect(result.start).toBeLessThanOrEqual(selected.start);
  expect(result.end).toBeGreaterThanOrEqual(selected.end);
  expect(result.text.slice(selected.start - result.start, selected.end - result.start)).toBe(selected.text);
  expect(result.context.expanded).toBe(result.start < selected.start || result.end > selected.end);
  return result;
}

describe("expandPreviewContext: exact bounded same-page paragraphs", () => {
  it.each(["\n\n", "\r\n\r\n", "\n \t\n", "\r\n \t\r\n"])("stays in the enclosing paragraph with %j separators", separator => {
    const prefix = `previous paragraph${separator}`;
    const paragraph = "a z̄ b";
    const text = `${prefix}${paragraph}${separator}next paragraph`;
    expect(exactSlice(text, selection(text, "z̄"))).toEqual({
      text: paragraph, start: prefix.length, end: prefix.length + paragraph.length,
      context: { scope: "same_page_paragraph", expanded: true, truncatedBefore: false, truncatedAfter: false },
    });
  });

  it("keeps single newlines as context rather than treating them as paragraph breaks", () => {
    const text = "before\nz̄\nafter";
    expect(exactSlice(text, selection(text, "z̄"))).toEqual({
      text, start: 0, end: text.length,
      context: { scope: "same_page_paragraph", expanded: true, truncatedBefore: false, truncatedAfter: false },
    });
  });

  it("centers a short selection in a long paragraph and marks both clipped sides", () => {
    const text = "a".repeat(2000) + "z̄" + "b".repeat(2000);
    const result = exactSlice(text, selection(text, "z̄"));
    expect(result.start).toBe(1401);
    expect(result.end).toBe(2601);
    expect(result.text).toHaveLength(1200);
    expect(result.context).toEqual({ scope: "same_page_paragraph", expanded: true, truncatedBefore: true, truncatedAfter: true });
  });

  it("uses the page start without negative offsets and clips only after it", () => {
    const text = "z̄" + "b".repeat(2000);
    const result = exactSlice(text, selection(text, "z̄"));
    expect(result.start).toBe(0);
    expect(result.end).toBe(1200);
    expect(result.context).toEqual({ scope: "same_page_paragraph", expanded: true, truncatedBefore: false, truncatedAfter: true });
  });

  it("backfills to the full budget at the page end and clips only before it", () => {
    const text = "a".repeat(2000) + "z̄";
    const result = exactSlice(text, selection(text, "z̄"));
    expect(result.start).toBe(text.length - 1200);
    expect(result.end).toBe(text.length);
    expect(result.context).toEqual({ scope: "same_page_paragraph", expanded: true, truncatedBefore: true, truncatedAfter: false });
  });

  it("measures truncation against the paragraph, not the whole page", () => {
    const paragraph = "a".repeat(2000) + "z̄";
    const prefix = "unrelated\n\n";
    const text = prefix + paragraph + "\n\nmore unrelated";
    const result = exactSlice(text, selection(text, "z̄"));
    expect(result.end).toBe(prefix.length + paragraph.length);
    expect(result.start).toBe(result.end - 1200);
    expect(result.context).toMatchObject({ truncatedBefore: true, truncatedAfter: false });
    expect(result.text).not.toContain("unrelated");
  });

  it.each(["z̄", "\n\nz̄\n\n"])("does not invent expansion or truncation for a whole selected paragraph: %j", text => {
    const selected = selection(text, "z̄");
    expect(exactSlice(text, selected)).toEqual({
      ...selected, context: { scope: "same_page_paragraph", expanded: false, truncatedBefore: false, truncatedAfter: false },
    });
  });

  it("retains an entire maximum 1200-unit selection with no expansion even when both sides are truncated", () => {
    const quote = "z̄".repeat(600);
    const text = "a".repeat(2000) + quote + "b".repeat(2000);
    const selected = selection(text, quote);
    expect(conceptPreviewRequestSchema.safeParse({ ...input, selection: selected }).success).toBe(true);
    expect(exactSlice(text, selected)).toEqual({
      ...selected, context: { scope: "same_page_paragraph", expanded: false, truncatedBefore: true, truncatedAfter: true },
    });
    expect(conceptPreviewRequestSchema.safeParse({ ...input, selection: { text: quote + "x" } }).success).toBe(false);
  });

  it("does not mark a full-budget whole page truncated", () => {
    const text = "z̄".repeat(600);
    expect(exactSlice(text, selection(text, text))).toEqual({
      text, start: 0, end: 1200,
      context: { scope: "same_page_paragraph", expanded: false, truncatedBefore: false, truncatedAfter: false },
    });
  });

  it("keeps a 1199-unit selection intact while expanding by the one remaining unit", () => {
    const quote = "x".repeat(1197) + "z̄";
    const text = "a" + quote + "b";
    const result = exactSlice(text, selection(text, quote));
    expect(result.start).toBe(1);
    expect(result.end).toBe(1201);
    expect(result.context).toEqual({ scope: "same_page_paragraph", expanded: true, truncatedBefore: true, truncatedAfter: false });
  });

  it("disambiguates repeated exact terms by original position, even when expanded text is identical", () => {
    const text = "a z̄ b z̄ c";
    expect(locatePreviewSelection(text, input)).toEqual({ status: "ambiguous", selection: null });
    const first = selection(text, "z̄", 2);
    const second = selection(text, "z̄", 7);
    for (const selected of [first, second]) {
      expect(locatePreviewSelection(text, { ...input, selection: selected })).toEqual({ status: "available", selection: selected });
    }
    expect(first).not.toEqual(second);
    expect(exactSlice(text, first)).toEqual(exactSlice(text, second));
    expect(locatePreviewSelection(text, { ...input, selection: { text: "z̄", start: 3, end: 5 } })).toEqual({ status: "stale", selection: null });
  });

  it("preserves combining marks, case, astral UTF-16 offsets and source whitespace exactly", () => {
    const text = "🧮 Z z z̄\t end";
    const selected = selection(text, "z̄");
    expect(selected.start).toBe(7);
    expect(selected.end).toBe(9);
    expect(locatePreviewSelection(text, input)).toEqual({ status: "available", selection: selected });
    expect(exactSlice(text, selected).text).toBe(text);
    for (const other of ["Z", "z", "Z̄", "z\u0305"]) {
      expect(locatePreviewSelection(other, input)).toEqual({ status: "unavailable", selection: null });
    }
  });
});
