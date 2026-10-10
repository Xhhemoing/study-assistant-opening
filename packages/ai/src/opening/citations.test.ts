import { describe, expect, it } from "vitest";
import type { SourceChunk } from "@aistudy/contracts";
import { resolveCitations } from "./citations";

const base = (id: string, values: Partial<SourceChunk> = {}): SourceChunk => ({
  id,
  sourceId: "00000000-0000-0000-0000-000000000001",
  sourceVersion: 2,
  page: 3,
  slideLabel: null,
  startMs: null,
  endMs: null,
  text: "text",
  imageObjectKey: null,
  ...values,
});

describe("opening citations", () => {
  it("soft-filters unknown ids by default and never fabricates rows", () => {
    expect(resolveCitations(["invented"], [])).toEqual([]);
    expect(resolveCitations([], [])).toEqual([]);
    expect(resolveCitations(["ok", "missing"], [base("ok")])).toEqual([
      expect.objectContaining({ chunkId: "ok", page: 3 }),
    ]);
  });

  it("strict mode still throws on unknown ids", () => {
    expect(() => resolveCitations(["invented"], [], { soft: false })).toThrowError(
      new RangeError("unknown citation: invented"),
    );
    expect(() =>
      resolveCitations(["ok", "missing"], [base("ok")], { soft: false }),
    ).toThrow(/unknown citation: missing/);
  });

  it("preserves order, formats labels, and populates locator fields", () => {
    const resolved = resolveCitations(
      ["b", "a"],
      [base("a"), base("b", { page: 4, startMs: 65000 })],
    );
    expect(resolved).toEqual([
      expect.objectContaining({
        chunkId: "b",
        page: 4,
        startMs: 65000,
        label: "source 00000000-0000-0000-0000-000000000001 v2 page 4 at 1:05",
      }),
      expect.objectContaining({ chunkId: "a", page: 3 }),
    ]);
    expect(resolved[0]).not.toHaveProperty("slideLabel");
    const slide = resolveCitations(
      ["slide"],
      [base("slide", { page: null, slideLabel: "A-1" })],
    )[0];
    expect(slide.label).toContain("slide A-1");
    expect(slide.slideLabel).toBe("A-1");
    expect(slide.page).toBeUndefined();
    expect(slide.startMs).toBeUndefined();
  });

  it("humanizes label with sourceNames when provided", () => {
    const [cite] = resolveCitations(
      ["a"],
      [base("a", { page: 2 })],
      { sourceNames: { "00000000-0000-0000-0000-000000000001": "牛顿力学讲义" } },
    );
    expect(cite.label).toBe("牛顿力学讲义 v2 page 2");
  });
});
