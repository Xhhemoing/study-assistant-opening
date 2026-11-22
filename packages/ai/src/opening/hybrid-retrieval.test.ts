import { describe, expect, it } from "vitest";
import type { SourceChunk } from "@aistudy/contracts";
import { budgetRankedMaterial, materialSegmentKey, rankMaterialContext, segmentMaterialChunks } from "./hybrid-retrieval";
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

    const oversizedFormula = "$$" + "\\alpha + ".repeat(950) + "\\beta$$";
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

  it.each([
    ["$$", "$$"], ["\\[", "\\]"], ["\\(", "\\)"], ["\\begin{align}", "\\end{align}"], ["$", "$"],
  ])("ignores comment delimiters inside a long %s formula and recognizes escaped percents", (open, close) => {
    for (const bytes of [6424, 8192]) {
      const start = open + "2x \\% literal\n% ignored " + close + " $$ \\] \\end{align}\r\n";
      const formula = start + "x".repeat(bytes - Buffer.byteLength(start + close)) + close;
      const prefix = "a".repeat(140) + "\n";
      const segments = segmentMaterialChunks([chunk("latex-comments", prefix + formula + "\nTail.")]);
      expect(segments.map(segment => segment.chunk.text)).toEqual([prefix, formula, "\nTail."]);
    }
    const escaped = open + "x".repeat(6424 - open.length - close.length - 2) + "\\%" + close;
    expect(segmentMaterialChunks([chunk("escaped-percent", escaped)]).map(segment => segment.chunk.text)).toEqual([escaped]);
  });

  it.each([["$$", "$$"], ["\\[", "\\]"], ["\\(", "\\)"], ["\\begin{align}", "\\end{align}"]])(
    "protects a long %s formula after a percentage in prose on the same line", (open, close) => {
      const formula = open + "x".repeat(6400 - open.length - close.length) + close;
      for (const prefix of ["At 95% confidence, ", "Prices: $95% off and $5. "]) {
        const segments = segmentMaterialChunks([chunk("percentage-in-prose", prefix + formula + "\nTail.")]);
        expect(segments.map(segment => segment.chunk.text)).toEqual([prefix, formula, "\nTail."]);
      }
    },
  );

  it.each(["$2 xy$", "$2 x$", "$10 n^2$", "$3 ab + 1$"])("keeps %s whole across the 6,000-byte boundary", (formula) => {
    const prefix = "a".repeat(5997);
    const segments = segmentMaterialChunks([chunk("short-formula", prefix + formula)], 6000);
    expect(segments.map(segment => segment.chunk.text.length)).toEqual([prefix.length, formula.length]);
    expect(segments[1]?.chunk.text).toBe(formula);
  });

  it("keeps adjacent numeric-leading inline formulas whole at the byte boundary", () => {
    const prefix = "a".repeat(5998);
    const formulas = "$2x$$y$";
    const segments = segmentMaterialChunks([chunk("adjacent-inline", prefix + formulas)]);
    expect(segments.map(({ chunk }) => chunk.text)).toEqual([prefix, formulas]);
  });

  it("preserves a display formula after an unclosed numeric dollar amount", () => {
    const prefix = "a".repeat(5996) + "$2 in cash ";
    const formula = "$$" + "x".repeat(6400) + "$$";
    const segments = segmentMaterialChunks([chunk("display-after-price", prefix + formula)]);
    const texts = segments.map(({ chunk }) => chunk.text);
    expect(texts.join("")).toBe(prefix + formula);
    expect(texts.at(-1)).toBe(formula);
  });

  it.each(["$2.50.", "$2.50,"])("preserves a 6,404-byte display formula immediately after %s", amount => {
    const prefix = "a".repeat(5998) + amount;
    const formula = "$$" + "x".repeat(6400) + "$$";
    const segments = segmentMaterialChunks([chunk("display-after-currency", prefix + formula)]);
    const texts = segments.map(({ chunk }) => chunk.text);
    expect(texts.slice(0, -1).join("")).toBe(prefix);
    expect(texts.at(-1)).toBe(formula);
  });

  it("preserves 16,384 inline spans at UTF-16 and UTF-8 chunk boundaries", () => {
    const text = "$x$ ".repeat(16_384) + "𝑥$y$";
    const segments = segmentMaterialChunks([chunk("dense-inline-spans", text)], 14);
    const texts = segments.map(({ chunk }) => chunk.text);
    expect(texts.join("")).toBe(text);
    expect(texts.every(part => Buffer.byteLength(part) <= 14 && (part.match(/\$/gu)?.length ?? 0) % 2 === 0)).toBe(true);
  });

  it.each(["$2% ignore $$\n+2=4$", "$2% ignore $$\r\nx+2=4$", "$2% ignore $$\n% ignore $\n+2=4$", "$2% ignore $$\n3$"])(
    "ignores false dollar closers in comments following a numeric inline opener", formula => {
      const prefix = "a".repeat(5997);
      const chunks = segmentMaterialChunks([chunk("numeric-inline-comment", prefix + formula + " and 80% confidence.")]);
      expect(chunks[0]?.chunk.text).toBe(prefix);
      expect(chunks[1]?.chunk.text).toBe(formula + " and 80% confidence.");
    },
  );

  it("keeps repeated prices and percentages as prose before a closed numeric formula", () => {
    const prose = "$5, 20% off. ".repeat(5800);
    const formula = "$2% ignored $$\n3$";
    const chunks = segmentMaterialChunks([chunk("prose-prices", prose + formula)], 5805);
    expect(chunks.map(({ chunk }) => chunk.text).join("")).toBe(prose + formula);
    expect(chunks.at(-1)?.chunk.text).toContain(formula);
  });

  it.each([["$$", "$$"], ["\\[", "\\]"], ["\\begin{align}", "\\end{align}"], ["$", "$"]])(
    "keeps a closed %s formula intact above the default target and at the hard limit", (open, close) => {
      for (const bytes of [7005, 8192]) {
        const formula = open + "x".repeat(bytes - open.length - close.length) + close;
        const prefix = "Public introduction. ".repeat(10);
        const segments = segmentMaterialChunks([chunk("large-formula", prefix + formula + "\nTail.")]);
        expect(segments.map(segment => segment.chunk.text)).toEqual([prefix, formula, "\nTail."]);
        expect(segments.every(segment => Buffer.byteLength(segment.chunk.text) <= 8192)).toBe(true);
      }
    },
  );

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

  it("keeps >2048-char numeric-leading inline math unbroken across segments", () => {
    const mathBody = "$1+" + "x+".repeat(1100) + "x$";
    const text = "a".repeat(3000) + mathBody + " tail";
    const segments = segmentMaterialChunks([chunk("long-num-math", text)], 4096);
    expect(segments.map(s => s.chunk.text).join("")).toBe(text);
    expect(segments.every(s => Buffer.byteLength(s.chunk.text, "utf8") <= 4096)).toBe(true);
    expect(segments.some(s => s.chunk.text.includes(mathBody))).toBe(true);
  });

  it("namespaces math-shifted segment keys away from legacy 0..k keys and recalls pre-reindex dense hits", () => {
    const formulaTail = "$$x + y = z$$ eigenvalue theorem tail";
    const shifted = chunk("formula-doc", "a".repeat(5990) + formulaTail);
    const segments = segmentMaterialChunks([shifted]);
    expect(segments).toHaveLength(2);
    expect(segments.map(s => s.chunk.text).join("")).toBe(shifted.text);
    expect(segments[0]!.segmentIndex).toBeGreaterThanOrEqual(262_144);
    expect(segments[1]!.segmentIndex).toBe(segments[0]!.segmentIndex + 1);
    expect(segments[1]!.segmentIndex).toBeLessThan(2_147_483_647);
    expect(segmentMaterialChunks([shifted]).map(materialSegmentKey)).toEqual(segments.map(materialSegmentKey));

    const legacyKeys = new Set(["formula-doc:0", "formula-doc:1"]);
    expect(segments.some(s => legacyKeys.has(materialSegmentKey(s)))).toBe(false);

    const unshifted = chunk("plain-doc", "b".repeat(6010));
    expect(segmentMaterialChunks([unshifted]).map(s => s.segmentIndex)).toEqual([0, 1]);

    const legacySeg1 = { chunk: { ...shifted, text: shifted.text.slice(6000) }, segmentIndex: 1 };
    const decoys = Array.from({ length: 8 }, (_, idx) => chunk(`decoy-${idx}`, "unrelated syllabus announcement"));

    const recalled = rankMaterialContext({
      chunks: [...decoys, shifted],
      query: "orthogonal projection",
      maxCharacters: 500,
      dense: [legacySeg1],
    });
    expect(recalled[0]?.id).toBe("formula-doc");
    expect(recalled[0]?.text).toContain(formulaTail);

    const rejected = rankMaterialContext({
      chunks: [chunk("chosen", "Selected page", 3), shifted],
      query: "orthogonal projection",
      maxCharacters: 7000,
      preferChunkId: "chosen",
      dense: [
        { ...legacySeg1, chunk: { ...legacySeg1.chunk, sourceVersion: 2 } },
        { ...legacySeg1, chunk: { ...legacySeg1.chunk, text: "tampered slice text" } },
        { ...legacySeg1, chunk: { ...legacySeg1.chunk, id: "foreign-doc" } },
        { chunk: { ...shifted, text: shifted.text.slice(0, 5990) }, segmentIndex: segments[0]!.segmentIndex },
        { chunk: { ...shifted, text: shifted.text.slice(0, 6000) }, segmentIndex: 0 },
      ],
    });
    expect(rejected.map(row => row.id)).toEqual(["chosen", "formula-doc"]);
    expect(rejected[1]?.text).toBe("a".repeat(5990));

    // Batched reindexing (~32 segments/batch) can commit segment 0 before segment 1; legacy slices for segment 1 must still recall.
    const batchedReindex = rankMaterialContext({
      chunks: [...decoys, shifted],
      query: "orthogonal projection",
      maxCharacters: 7000,
      dense: [
        segments[0]!,
        legacySeg1,
      ],
    });
    expect(batchedReindex[0]?.id).toBe("formula-doc");
    expect(batchedReindex[0]?.text).toContain(formulaTail);
  });
});
