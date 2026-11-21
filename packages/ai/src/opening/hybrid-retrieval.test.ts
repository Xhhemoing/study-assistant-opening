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

  it("keeps LaTeX display, inline, and nested environments unbroken across segment boundaries", () => {
    const cases = [
      { name: "display $$", prefix: "a".repeat(90), formula: "$$\\int_0^1 x^2 \\, dx = \\frac{1}{3}$$" },
      { name: "display \\[...\\]", prefix: "b".repeat(90), formula: "\\[\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}\\]" },
      { name: "inline \\(...\\)", prefix: "c".repeat(90), formula: "\\(\\alpha + \\beta = \\gamma\\)" },
      { name: "nested env", prefix: "d".repeat(85), formula: "\\begin{cases} x & \\begin{cases} 1 \\\\ 2 \\end{cases} \\\\ y & 3 \\end{cases}" },
      { name: "inline $...$ with currency", prefix: "Item costs $25 and $30; " + "e".repeat(70), formula: "$f(x) = x^2 + 1$" },
      { name: "escaped \\$", prefix: "Price \\$10 " + "f".repeat(80), formula: "$g(x) = \\sqrt{x}$" },
    ];
    const encoder = new TextEncoder();
    for (const item of cases) {
      const full = item.prefix + item.formula + " tail";
      const segments = segmentMaterialChunks([chunk(item.name, full)], 120);
      expect(segments.map(s => s.chunk.text).join("")).toBe(full);
      expect(segments.every(s => encoder.encode(s.chunk.text).length <= 120)).toBe(true);
      expect(segments.some(s => s.chunk.text.includes(item.formula))).toBe(true);
    }
  });

  it("falls back safely on oversized, unclosed, or currency $ spans without dropping bytes or breaking surrogate pairs", () => {
    const encoder = new TextEncoder();
    const unclosed = "Cost $25\n\n" + "😀".repeat(40) + "$$unclosed math " + "z".repeat(150);
    const segUnclosed = segmentMaterialChunks([chunk("unclosed", unclosed)], 100);
    expect(segUnclosed.map(s => s.chunk.text).join("")).toBe(unclosed);
    expect(segUnclosed.every(s => encoder.encode(s.chunk.text).length <= 100)).toBe(true);

    const oversizedFormula = "$$" + "\\alpha + ".repeat(40) + "\\beta$$";
    const segOver = segmentMaterialChunks([chunk("oversized", oversizedFormula)], 80);
    expect(segOver.length).toBeGreaterThan(1);
    expect(segOver.map(s => s.chunk.text).join("")).toBe(oversizedFormula);
    expect(segOver.every(s => encoder.encode(s.chunk.text).length <= 80)).toBe(true);

    const unclosedEnv = "\\begin{align} x = 1 " + "😀".repeat(35) + "\\begin{cases} a \\\\ b \\end{cases}";
    const segEnv = segmentMaterialChunks([chunk("env", unclosedEnv)], 96);
    expect(segEnv.map(s => s.chunk.text).join("")).toBe(unclosedEnv);
    expect(segEnv.every(s => encoder.encode(s.chunk.text).length <= 96)).toBe(true);
    expect(segEnv.some(s => s.chunk.text.includes("\\begin{cases} a \\\\ b \\end{cases}"))).toBe(true);
  });

  it("protects numeric-leading inline LaTeX like $1, 2, \\dots, n$ and $5! = 120$ while ignoring currency", () => {
    const encoder = new TextEncoder();
    const numericSeq = "设 " + "a".repeat(60) + "$1, 2, \\dots, n$ 为正整数，$x + y = z$。";
    const segSeq = segmentMaterialChunks([chunk("seq", numericSeq)], 80);
    expect(segSeq.map(s => s.chunk.text).join("")).toBe(numericSeq);
    expect(segSeq.every(s => encoder.encode(s.chunk.text).length <= 80)).toBe(true);
    expect(segSeq.some(s => s.chunk.text.includes("$1, 2, \\dots, n$"))).toBe(true);

    const factorial = "Compute " + "w".repeat(65) + "$5! = 120$ now";
    const segFac = segmentMaterialChunks([chunk("fac", factorial)], 80);
    expect(segFac.map(s => s.chunk.text).join("")).toBe(factorial);
    expect(segFac.some(s => s.chunk.text.includes("$5! = 120$"))).toBe(true);

    const currency = "Tickets cost $50 and VIP costs $100. " + "x".repeat(60);
    const segCurrency = segmentMaterialChunks([chunk("currency", currency)], 40);
    expect(segCurrency.map(s => s.chunk.text).join("")).toBe(currency);
    expect(segCurrency.every(s => encoder.encode(s.chunk.text).length <= 40)).toBe(true);

    const setMembership = "If " + "u".repeat(65) + "$1 \\in A$ and $0 \\to \\infty$, done.";
    const segSet = segmentMaterialChunks([chunk("set", setMembership)], 80);
    expect(segSet.map(s => s.chunk.text).join("")).toBe(setMembership);
    expect(segSet.some(s => s.chunk.text.includes("$1 \\in A$"))).toBe(true);
    expect(segSet.some(s => s.chunk.text.includes("$0 \\to \\infty$"))).toBe(true);

    const singleZero = "For $0$: " + "v".repeat(60) + " ($x + y = z$)";
    const segZero = segmentMaterialChunks([chunk("zero", singleZero)], 75);
    expect(segZero.map(s => s.chunk.text).join("")).toBe(singleZero);
    expect(segZero.some(s => s.chunk.text.includes("$x + y = z$"))).toBe(true);

    const singleOne = "设$1$，且" + "w".repeat(60) + "$f(x) = x^2 + 1$。";
    const segOne = segmentMaterialChunks([chunk("one", singleOne)], 75);
    expect(segOne.map(s => s.chunk.text).join("")).toBe(singleOne);
    expect(segOne.some(s => s.chunk.text.includes("$f(x) = x^2 + 1$"))).toBe(true);

    const pricesList = "Prices: $10, $20, and $30 " + "p".repeat(50);
    const segPrices = segmentMaterialChunks([chunk("prices", pricesList)], 32);
    expect(segPrices.map(s => s.chunk.text).join("")).toBe(pricesList);
    expect(segPrices.every(s => encoder.encode(s.chunk.text).length <= 32)).toBe(true);

    const zhCurrencyBeforeMath = "售价$50，求解" + "u".repeat(55) + "$x + y = z$。";
    const segZh = segmentMaterialChunks([chunk("zh-curr", zhCurrencyBeforeMath)], 75);
    expect(segZh.map(s => s.chunk.text).join("")).toBe(zhCurrencyBeforeMath);
    expect(segZh.some(s => s.chunk.text.includes("$x + y = z$"))).toBe(true);

    const enCurrencyBeforeMath = "Cost $50;find" + "u".repeat(55) + "$x + y = z$.";
    const segEn = segmentMaterialChunks([chunk("en-curr", enCurrencyBeforeMath)], 75);
    expect(segEn.map(s => s.chunk.text).join("")).toBe(enCurrencyBeforeMath);
    expect(segEn.some(s => s.chunk.text.includes("$x + y = z$"))).toBe(true);
  });

  it("scans pathological backslash and mismatched-env inputs in linear O(N) time", () => {
    const backslashes = "\\".repeat(100_000);
    const envs = "\\begin{a}".repeat(5_000) + "\\end{b}".repeat(5_000);
    const started = performance.now();
    const s1 = segmentMaterialChunks([chunk("bs", backslashes)], 4096);
    const s2 = segmentMaterialChunks([chunk("env", envs)], 4096);
    const elapsedMs = performance.now() - started;
    expect(s1.map(s => s.chunk.text).join("")).toBe(backslashes);
    expect(s2.map(s => s.chunk.text).join("")).toBe(envs);
    expect(elapsedMs).toBeLessThan(1000);
  });
});
