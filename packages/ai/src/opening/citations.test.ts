import { describe, expect, it } from "vitest";
import type { SourceChunk } from "@aistudy/contracts";
import { renumberInlineCitations, resolveCitations } from "./citations";

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

describe("renumberInlineCitations", () => {
  const cited = ["a", "b", "c"];
  const citations = resolveCitations(["c", "a"], [base("a"), base("c")]);

  it("points each marker at its final citation and drops unresolved ones", () => {
    expect(renumberInlineCitations("甲[1]。乙[2]。丙[3][1]。越界[9]。", cited, citations))
      .toBe("甲[2]。乙。丙[1][2]。越界。");
  });

  it("leaves code, math, links, definitions and identifiers alone", () => {
    const text = "数组 `a[1]` 与 x[1]，$v[1]$，$$M[2]$$，[1](https://x.test)\n\n```ts\nb[1]\n```\n[2]: https://y.test";
    expect(renumberInlineCitations(text, cited, citations)).toBe(text);
  });

  it("keeps text unchanged when the model cited nothing", () => {
    expect(renumberInlineCitations("见 [1]。", [], [])).toBe("见 [1]。");
  });
});
