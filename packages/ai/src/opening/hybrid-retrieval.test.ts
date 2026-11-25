import { describe, expect, it } from "vitest";
import type { SourceChunk } from "@aistudy/contracts";
import {
  budgetRankedMaterial,
  materialSegmentKey,
  rankMaterialContext,
  segmentMaterialChunks,
  type MaterialPedagogicalGraph,
} from "./hybrid-retrieval";
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

  it("keeps a numeric inline formula followed immediately by display math intact", () => {
    const prefix = "a".repeat(5998);
    for (const display of ["$$z$$", "$$" + "z".repeat(6400) + "$$", "$$% ignored $$\nz$$"]) {
      const text = prefix + "$2x$" + display;
      const segments = segmentMaterialChunks([chunk("adjacent-display", text)]);
      expect(segments.map(({ chunk }) => chunk.text)).toEqual(
        display.length > 6000 ? [prefix, "$2x$", display] : [prefix, "$2x$" + display],
      );
    }
  });

  it("matches start-sorted span selection for nested, oversized, crossing and rescanned spans", () => {
    const nested = "\\[\\(x + y\\) = z\\]";
    const oversized = "\\[" + "b".repeat(8190) + "$x + y$\\]";
    const crossing = "\\[\\(a\\]" + "b".repeat(50) + "$x + y$\\)";
    const unclosed = "$x$ $$ unclosed " + "b".repeat(35) + nested;
    const cases = [
      { body: nested, formulas: [nested, "\\(x + y\\)"] },
      { body: oversized, formulas: [oversized, "$x + y$"] },
      { body: crossing, formulas: ["\\[\\(a\\]", crossing.slice(2), "$x + y$"] },
      { body: unclosed, formulas: ["$x$", nested, "\\(x + y\\)"] },
    ];

    for (const { body, formulas } of cases) {
      const text = "a".repeat(61) + body + " tail";
      const spans = formulas.flatMap(formula => {
        const start = text.indexOf(formula);
        expect(start).toBeGreaterThanOrEqual(0);
        return formula.length <= 8192 ? [{ start, end: start + formula.length }] : [];
      }).sort((a, b) => a.start - b.start || b.end - a.end);
      const topLevel: typeof spans = [];
      for (const span of spans) {
        if (span.start >= (topLevel.at(-1)?.end ?? 0)) topLevel.push(span);
      }

      for (const maxBytes of [24, 64, 117]) {
        const expected = [];
        let start = 0;
        while (start < text.length) {
          const limit = Math.min(start + maxBytes, text.length);
          const spanAtCut = topLevel.find(span => span.start < limit && limit < span.end);
          const end = spanAtCut ? (spanAtCut.start > start ? spanAtCut.start : spanAtCut.end) : limit;
          expected.push(text.slice(start, end));
          start = end;
        }
        const actual = segmentMaterialChunks([chunk("span-oracle", text)], maxBytes);
        expect(actual.map(segment => segment.chunk.text)).toEqual(expected);
      }
    }
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

  it("bounds display lookahead across repeated numeric delimiters and long line comments", () => {
    const text = "$1$$$$%".repeat(24_000) + "comment ".repeat(24_000) + "\r\nA real formula: $x^2 + y^2$";
    const start = performance.now();
    const segments = segmentMaterialChunks([chunk("display-comment", text)], 4096);
    expect(performance.now() - start).toBeLessThan(1500);
    expect(segments.map(segment => segment.chunk.text).join("")).toBe(text);
    expect(segments.some(segment => segment.chunk.text.includes("$x^2 + y^2$"))).toBe(true);
  });

  it("advances by code point with a four-byte segment budget", () => {
    const formula = "$\\frac{1}{2}$";
    const text = "🙂".repeat(60_000) + formula + "界".repeat(60_000);
    const start = performance.now();
    const segments = segmentMaterialChunks([chunk("small-budget", text)], 4);
    expect(performance.now() - start).toBeLessThan(1500);
    expect(segments).toHaveLength(120_001);
    expect(segments[60_000]?.chunk.text).toBe(formula);
    expect(segments.map(segment => segment.chunk.text).join("")).toBe(text);
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

  it.each(["$\\Box $", "$\\square $", "$\\blacksquare $", "$1 + 1 = 2 \\Box $"])(
    "keeps spaced QED inline math %s unbroken across the 6,000-byte boundary",
    formula => {
      const prefix = "a".repeat(5997);
      const text = `${prefix}${formula} tail`;
      const segments = segmentMaterialChunks([chunk("spaced-qed", text)], 6000);
      expect(segments.map(s => s.chunk.text)).toEqual([prefix, `${formula} tail`]);
    },
  );

  it("keeps adjacent and display-followed spaced QED formulas intact while leaving prose currency unmerged", () => {
    const prefix = "a".repeat(5998);
    expect(segmentMaterialChunks([chunk("adj-spaced-qed", `${prefix}$2x$$\\Box $ tail`)], 6000).map(s => s.chunk.text))
      .toEqual([prefix, "$2x$$\\Box $ tail"]);

    const prefixDisplay = "a".repeat(5997);
    expect(segmentMaterialChunks([chunk("disp-spaced-qed", `${prefixDisplay}$\\Box $$$y$$ tail`)], 6000).map(s => s.chunk.text))
      .toEqual([prefixDisplay, "$\\Box $$$y$$ tail"]);

    // Escaped backslash before Box is not a \Box token, and ordinary prose currency still splits at maxBytes.
    const escapedSlash = "a".repeat(5997) + "$\\\\Box $ tail";
    expect(segmentMaterialChunks([chunk("escaped-box", escapedSlash)], 6000)[0]?.chunk.text.length).toBe(6000);

    const currencyProse = "a".repeat(5998) + "$5 and $6 in cash";
    expect(segmentMaterialChunks([chunk("currency-prose", currencyProse)], 6000)[0]?.chunk.text.length).toBe(6000);
  });

  it("keeps nested LaTeX environments intact when an enclosing $$...$$ display exceeds 8,192 bytes", () => {
    const alignedBlock = "\\begin{aligned}\n" + "x_i + y_i &= z_i \\\\\n".repeat(24) + "\\end{aligned}";
    expect(Buffer.byteLength(alignedBlock, "utf8")).toBeGreaterThan(450);
    expect(Buffer.byteLength(alignedBlock, "utf8")).toBeLessThan(8192);
    const displayLead = "$$" + "a + ".repeat(1450);
    expect(Buffer.byteLength(displayLead, "utf8")).toBe(5802);
    const displayTail = " + b".repeat(800) + "$$";
    const oversizedDisplay = displayLead + alignedBlock + displayTail;
    expect(Buffer.byteLength(oversizedDisplay, "utf8")).toBeGreaterThan(9000);

    const segments = segmentMaterialChunks([chunk("oversized-display-env", oversizedDisplay)], 6000);
    const texts = segments.map(s => s.chunk.text);
    expect(texts.join("")).toBe(oversizedDisplay);
    expect(texts.every(part => Buffer.byteLength(part, "utf8") <= 6000)).toBe(true);
    expect(texts.some(part => part.includes(alignedBlock))).toBe(true);
  });

  it("isolates unclosed \\begin{...} inside $$...$$ from \\end{...} outside $$...$$", () => {
    const malformedPrefix = "$$ \\begin{aligned} x = 1 $$ ";
    const strayEnd = "\\end{aligned} ";
    const middleProse = "p".repeat(5995 - malformedPrefix.length - strayEnd.length);
    const text = malformedPrefix + middleProse + strayEnd + "$a + b = c$ tail";

    const segments = segmentMaterialChunks([chunk("malformed-display-env", text)], 6000);
    const texts = segments.map(s => s.chunk.text);
    expect(texts.join("")).toBe(text);
    expect(texts).toEqual([
      malformedPrefix + middleProse + strayEnd,
      "$a + b = c$ tail",
    ]);

    // Also verify when \end{aligned} straddles the 6,000-byte boundary: if \begin{aligned}
    // inside $$...$$ had leaked onto the outer stack, bytes 3..6007 (<= 8,192 B) would have
    // forced an early cut before $$ instead of cutting normally at byte 6,000.
    const straddling = malformedPrefix + "p".repeat(5995 - malformedPrefix.length) + "\\end{aligned} tail";
    const straddlingSegments = segmentMaterialChunks([chunk("straddling-stray-end", straddling)], 6000);
    expect(straddlingSegments[0]?.chunk.text.length).toBe(6000);
  });

  it("rejects unclosed $$ via displayCloseFrom in single pass while protecting closed $$ with % comments", () => {
    const unclosedWithCommentedDisplay = "$$ a % comment $$\n";
    const padBeforeInline = "p".repeat(5998 - unclosedWithCommentedDisplay.length);
    const inlineFormula = "$x+y$";
    const unclosedText = unclosedWithCommentedDisplay + padBeforeInline + inlineFormula + " tail";
    const unclosedSegments = segmentMaterialChunks([chunk("unclosed-comment-display", unclosedText)], 6000);
    expect(unclosedSegments.map(s => s.chunk.text)).toEqual([
      unclosedWithCommentedDisplay + padBeforeInline,
      inlineFormula + " tail",
    ]);

    const closedWithComment = "$$ a % $$\nb $$";
    const padBeforeClosed = "p".repeat(5995);
    const closedText = padBeforeClosed + closedWithComment + " tail";
    const closedSegments = segmentMaterialChunks([chunk("closed-comment-display", closedText)], 6000);
    expect(closedSegments.map(s => s.chunk.text)).toEqual([
      padBeforeClosed,
      closedWithComment + " tail",
    ]);
  });

  describe("sparse PPR pedagogical retrieval wiring", () => {
    it("recalls zero-lexical/zero-dense prerequisite definitions via Sparse PPR and orders foundations before dependent theorems without promoting unrelated definitions", () => {
      const defVec = chunk(
        "def-vec",
        ":::definition Inner Product\nLet V be a real bilinear symmetric positive-definite space with form <u, v>.\n:::",
        10,
      );
      const lemmaDisc = chunk(
        "lemma-disc",
        ":::lemma Quadratic Discriminant\nA non-negative real polynomial a t^2 + 2 b t + c >= 0 satisfies b^2 <= a c.\n:::",
        11,
      );
      const thmCs = chunk(
        "thm-cs",
        ":::theorem Cauchy-Schwarz Inequality\nFor vectors in V, the Cauchy-Schwarz bound holds on norms.\n:::",
        25,
      );
      const unrelatedDef = chunk(
        "def-unrelated",
        ":::definition Topological Compactness\nEvery open cover admits a finite subcover.\n:::",
        90,
      );
      const weakUnrelatedDef = chunk(
        "def-weak-unrelated",
        ":::definition Banach Norm\nCompleteness under a sequence norm bound.\n:::",
        91,
      );

      const allChunks = [thmCs, unrelatedDef, weakUnrelatedDef, lemmaDisc, defVec];
      const pedagogicalGraph: MaterialPedagogicalGraph = {
        concepts: [
          { id: "c-inner", label: "Inner Product", supportingSourceIds: ["def-vec"], evidenceChunkIds: ["def-vec"], privacyEpoch: 4 },
          { id: "c-disc", label: "Discriminant", supportingSourceIds: ["lemma-disc"], evidenceChunkIds: ["lemma-disc"], privacyEpoch: 4 },
          { id: "c-cs", label: "Cauchy-Schwarz", supportingSourceIds: ["thm-cs"], evidenceChunkIds: ["thm-cs"], privacyEpoch: 4 },
          { id: "c-compact", label: "Compactness", supportingSourceIds: ["def-unrelated"], evidenceChunkIds: ["def-unrelated"], privacyEpoch: 4 },
          { id: "c-banach", label: "Banach", supportingSourceIds: ["def-weak-unrelated"], evidenceChunkIds: ["def-weak-unrelated"], privacyEpoch: 4 },
        ],
        edges: [
          { from: "c-inner", to: "c-disc", kind: "prerequisite", supportingSourceIds: ["def-vec", "lemma-disc"], privacyEpoch: 4 },
          { from: "c-disc", to: "c-cs", kind: "prerequisite", supportingSourceIds: ["lemma-disc", "thm-cs"], privacyEpoch: 4 },
        ],
        authorization: {
          admissibleSourceIds: allChunks.map(c => c.sourceId),
          admissibleSourceVersions: Object.fromEntries(allChunks.map(c => [c.sourceId, c.sourceVersion])),
          expectedPrivacyEpoch: 4,
        },
      };

      const ranked = rankMaterialContext({
        chunks: allChunks,
        query: "Explain the Cauchy-Schwarz inequality bound",
        maxCharacters: 5000,
        pedagogicalGraph,
      });

      const ids = ranked.map(c => c.id);
      // Unseeded 2-hop prerequisite definition and 1-hop lemma are both recalled and ordered before the theorem.
      expect(ids).toContain("def-vec");
      expect(ids).toContain("lemma-disc");
      expect(ids).toContain("thm-cs");
      expect(ids.indexOf("def-vec")).toBeLessThan(ids.indexOf("lemma-disc"));
      expect(ids.indexOf("lemma-disc")).toBeLessThan(ids.indexOf("thm-cs"));
      // Unseeded unrelated definition receives 0 seed and 0 PPR mass; weak unrelated definition does not hijack rank 1.
      expect(ids).not.toContain("def-unrelated");
      expect(ids.indexOf("thm-cs")).toBeLessThan(ids.indexOf("def-weak-unrelated"));
    });

    it("prevents mixed theorem+definition excerpts from impersonating standalone prerequisite definitions", () => {
      const pureDef = {
        ...chunk("pure-def", "Definition 1.1 (Eigenvalue): Scalar lambda where A v = lambda v.", 1),
        sourceId: "src-shared",
      };
      const mixedThmDef = {
        ...chunk(
          "mixed-thm-def",
          "Theorem 2.1 (Spectral Theorem): Every symmetric matrix diagonalizes.\n\nDefinition 2.2: Auxiliary note on spectral radius.",
          2,
        ),
        sourceId: "src-shared",
      };
      const graph: MaterialPedagogicalGraph = {
        concepts: [
          {
            id: "c-spec",
            label: "Spectral Theory",
            supportingSourceIds: ["src-shared"],
            evidenceChunkIds: ["pure-def", "mixed-thm-def"],
            privacyEpoch: 1,
          },
        ],
        edges: [],
        authorization: {
          admissibleSourceIds: ["src-shared"],
          admissibleSourceVersions: { "src-shared": 1 },
          expectedPrivacyEpoch: 1,
        },
      };

      const ranked = rankMaterialContext({
        chunks: [mixedThmDef, pureDef],
        query: "Spectral Theorem diagonalizes symmetric matrix",
        maxCharacters: 4000,
        pedagogicalGraph: graph,
      });
      expect(ranked.map(c => c.id)).toEqual(["pure-def", "mixed-thm-def"]);
    });

    it("discards foreign/deleted chunks, withdrawn sources, stale versions, mixed authorized+unauthorized evidence, stale/absent privacyEpoch, and solves edges with zero influence", () => {
      const cA = chunk("chunk-a", "Theorem: Fundamental theorem of calculus relates differentiation and integration.", 2);
      const cB = chunk("chunk-b", "Definition: Antiderivative F satisfies F'(x) = f(x).", 1);
      const staleChunkInInput = { ...chunk("chunk-stale", "Definition: Stale v1 excerpt.", 1), sourceId: "src-stale", sourceVersion: 1 };
      const withdrawnChunkInInput = { ...chunk("chunk-withdrawn", "Definition: Withdrawn source excerpt.", 1), sourceId: "src-withdrawn" };
      const staleEpochChunk = Object.assign(
        chunk("chunk-bad-epoch", "Definition: Old privacy epoch chunk.", 1),
        { privacyEpoch: 2 },
      );
      const absentEpochChunk = Object.assign(
        chunk("chunk-undef-epoch", "Definition: Missing privacy epoch chunk.", 1),
        { privacyEpoch: undefined },
      );

      const baseline = rankMaterialContext({
        chunks: [cA, cB],
        query: "Fundamental theorem of calculus",
        maxCharacters: 3000,
      });

      const poisonedGraph: MaterialPedagogicalGraph = {
        concepts: [
          // Foreign / deleted chunk reference
          { id: "c-foreign", label: "Foreign", supportingSourceIds: ["chunk-a"], evidenceChunkIds: ["foreign-course-chunk"], privacyEpoch: 3 },
          // Mixed [authorized, unauthorized] evidence on concept -> ENTIRE concept must be discarded!
          { id: "c-mixed-foreign", label: "Mixed Foreign", supportingSourceIds: ["chunk-b"], evidenceChunkIds: ["chunk-b", "deleted-chunk"], privacyEpoch: 3 },
          { id: "c-mixed-withdrawn", label: "Mixed Withdrawn", supportingSourceIds: ["chunk-b"], evidenceChunkIds: ["chunk-b", "chunk-withdrawn"], privacyEpoch: 3 },
          { id: "c-mixed-stale", label: "Mixed Stale", supportingSourceIds: ["chunk-b"], evidenceChunkIds: ["chunk-b", "chunk-stale"], privacyEpoch: 3 },
          // Withdrawn supportingSourceIds despite authorized chunk
          { id: "c-bad-src", label: "Bad Source", supportingSourceIds: ["chunk-b", "src-withdrawn"], evidenceChunkIds: ["chunk-b"], privacyEpoch: 3 },
          // Stale or absent privacyEpoch on concept
          { id: "c-old-epoch", label: "Old Epoch", supportingSourceIds: ["chunk-b"], evidenceChunkIds: ["chunk-b"], privacyEpoch: 2 },
          { id: "c-no-epoch", label: "No Epoch", supportingSourceIds: ["chunk-b"], evidenceChunkIds: ["chunk-b"] },
        ],
        edges: [
          // Direct chunk-level edges with stale/absent epoch, solves kind, or mixed supportingChunkIds
          { from: "chunk-b", to: "chunk-a", kind: "prerequisite", privacyEpoch: 2 },
          { from: "chunk-b", to: "chunk-a", kind: "prerequisite" },
          { from: "chunk-b", to: "chunk-a", kind: "solves", privacyEpoch: 3 },
          { from: "chunk-b", to: "chunk-a", kind: "prerequisite", sourceId: "src-withdrawn", privacyEpoch: 3 },
          { from: "chunk-b", to: "chunk-a", kind: "prerequisite", supportingSourceIds: ["chunk-b", "src-withdrawn"], privacyEpoch: 3 },
          { from: "chunk-b", to: "chunk-a", kind: "prerequisite", supportingChunkIds: ["chunk-b", "deleted-chunk"], privacyEpoch: 3 },
          { from: "chunk-bad-epoch", to: "chunk-a", kind: "prerequisite", privacyEpoch: 3 },
          { from: "chunk-undef-epoch", to: "chunk-a", kind: "prerequisite", privacyEpoch: 3 },
        ],
        authorization: {
          admissibleSourceIds: ["chunk-a", "chunk-b", "src-stale", "chunk-bad-epoch", "chunk-undef-epoch"],
          admissibleSourceVersions: {
            "chunk-a": 1,
            "chunk-b": 1,
            "src-stale": 2, // chunk-stale has sourceVersion: 1 -> rejected!
            "chunk-bad-epoch": 1,
            "chunk-undef-epoch": 1,
          },
          expectedPrivacyEpoch: 3,
        },
      };

      const actual = rankMaterialContext({
        chunks: [cA, cB, staleChunkInInput, withdrawnChunkInInput, staleEpochChunk, absentEpochChunk],
        query: "Fundamental theorem of calculus",
        maxCharacters: 3000,
        pedagogicalGraph: poisonedGraph,
      });

      // Zero surviving concepts/edges and quarantined invalid chunks -> bit-for-bit identical to baseline [cA]!
      expect(actual).toEqual(baseline);
      expect(actual.map(c => c.id)).toEqual(["chunk-a"]);

      // Also verify mixed supportingChunkIds on a concept-to-concept edge is completely discarded.
      const validConceptsOnly: MaterialPedagogicalGraph = {
        concepts: [
          { id: "c-def", label: "Antiderivative", supportingSourceIds: ["chunk-b"], evidenceChunkIds: ["chunk-b"], privacyEpoch: 3 },
          { id: "c-thm", label: "FTC", supportingSourceIds: ["chunk-a"], evidenceChunkIds: ["chunk-a"], privacyEpoch: 3 },
        ],
        edges: [
          { from: "c-def", to: "c-thm", kind: "prerequisite", supportingChunkIds: ["chunk-b", "foreign-chunk"], privacyEpoch: 3 },
          { from: "c-thm", to: "c-def", kind: "solves", supportingChunkIds: ["chunk-a"], privacyEpoch: 3 },
        ],
        authorization: {
          admissibleSourceIds: ["chunk-a", "chunk-b"],
          admissibleSourceVersions: { "chunk-a": 1, "chunk-b": 1 },
          expectedPrivacyEpoch: 3,
        },
      };
      const withoutPoisonedEdge = rankMaterialContext({
        chunks: [cA, cB],
        query: "Fundamental theorem of calculus",
        maxCharacters: 3000,
        pedagogicalGraph: validConceptsOnly,
      });
      expect(withoutPoisonedEdge.map(c => c.id)).toEqual(["chunk-a"]);
    });

    it("quarantines AST sealed blocks unconditionally and gates hint_gated blocks on allowHintGated", () => {
      const publicDef = chunk("pub-def", ":::definition Continuity\nA function f is continuous at a if lim_{x->a} f(x) = f(a).\n:::", 1);
      const latexSolution = chunk("latex-sol", "\\begin{solution}\nSecret continuous limit answer is 17.\n\\end{solution}", 2);
      const inlineAnswer = chunk("inline-ans", "Answer: Secret continuous limit value is 17.", 3);
      const fencedHint = chunk("fenced-hint", ":::hint\nFactor (x - a) before taking the continuous limit.\n:::", 4);
      const inlineHint = chunk("inline-hint", "Hint: Rewrite the continuous limit using conjugate multiplication.", 5);
      const longMixed = chunk(
        "long-mixed",
        "Definition 1.1: Public continuous preamble. " + "p".repeat(5960) + "\\begin{solution}Trailing secret 99\\end{solution}",
        6,
      );

      const allChunks = [publicDef, latexSolution, inlineAnswer, fencedHint, inlineHint, longMixed];
      const baseAuth = {
        admissibleSourceIds: allChunks.map(c => c.sourceId),
        admissibleSourceVersions: Object.fromEntries(allChunks.map(c => [c.sourceId, c.sourceVersion])),
        expectedPrivacyEpoch: 5,
      };

      const makeGraph = (allowHintGated?: boolean): MaterialPedagogicalGraph => ({
        concepts: [
          { id: "c-cont", label: "Continuity", evidenceChunkIds: ["pub-def"], privacyEpoch: 5 },
          // Concepts attempting to cite sealed chunks are discarded
          { id: "c-sol", label: "Solution", evidenceChunkIds: ["latex-sol"], privacyEpoch: 5 },
          { id: "c-hint", label: "Hint", evidenceChunkIds: ["fenced-hint"], privacyEpoch: 5 },
        ],
        edges: [
          { from: "c-cont", to: "c-sol", kind: "solves", privacyEpoch: 5 },
          { from: "c-hint", to: "c-cont", kind: "prerequisite", privacyEpoch: 5 },
        ],
        authorization: { ...baseAuth, ...(allowHintGated !== undefined ? { allowHintGated } : {}) },
      });

      const defaultRanked = rankMaterialContext({
        chunks: allChunks,
        query: "continuous limit secret answer factor",
        maxCharacters: 12_000,
        dense: [
          { chunk: latexSolution, segmentIndex: 0 },
          { chunk: inlineAnswer, segmentIndex: 0 },
          { chunk: fencedHint, segmentIndex: 0 },
        ],
        pedagogicalGraph: makeGraph(),
      });
      const defaultIds = defaultRanked.map(c => c.id);
      expect(defaultIds).toContain("pub-def");
      expect(defaultIds).toContain("long-mixed");
      expect(defaultIds).not.toContain("latex-sol");
      expect(defaultIds).not.toContain("inline-ans");
      expect(defaultIds).not.toContain("fenced-hint");
      expect(defaultIds).not.toContain("inline-hint");
      expect(JSON.stringify(defaultRanked)).not.toContain("Secret");
      expect(JSON.stringify(defaultRanked)).not.toContain("Trailing secret 99");

      const hintAllowedRanked = rankMaterialContext({
        chunks: allChunks,
        query: "continuous limit secret answer factor",
        maxCharacters: 12_000,
        pedagogicalGraph: makeGraph(true),
      });
      const hintAllowedIds = hintAllowedRanked.map(c => c.id);
      expect(hintAllowedIds).toContain("fenced-hint");
      expect(hintAllowedIds).toContain("inline-hint");
      // Sealed blocks STILL never rank even when allowHintGated is true!
      expect(hintAllowedIds).not.toContain("latex-sol");
      expect(hintAllowedIds).not.toContain("inline-ans");
      expect(JSON.stringify(hintAllowedRanked)).not.toContain("Secret");
    });

    it("retains prerequisite foundations beyond 24 candidates without truncating before the 64-segment material selection", () => {
      const prereqDef = chunk("prereq-def", ":::definition Bilinear Form\nSymmetric mapping on vector pairs.\n:::", 1);
      const mainThm = chunk("main-thm", ":::theorem target spectral decomposition\nPrimary target spectral decomposition result.\n:::", 2);
      const extras = Array.from({ length: 30 }, (_, idx) =>
        chunk(`extra-${idx}`, `target spectral decomposition corollary example ${idx}`, idx + 3),
      );
      const allChunks = [prereqDef, mainThm, ...extras];

      const graph: MaterialPedagogicalGraph = {
        concepts: [
          { id: "c-pre", label: "Bilinear Form", evidenceChunkIds: ["prereq-def"], privacyEpoch: 1 },
          { id: "c-main", label: "Spectral Decomposition", evidenceChunkIds: ["main-thm"], privacyEpoch: 1 },
          ...extras.map((c, idx) => ({
            id: `c-extra-${idx}`,
            label: `Extra ${idx}`,
            evidenceChunkIds: [c.id],
            privacyEpoch: 1,
          })),
        ],
        edges: [
          { from: "c-pre", to: "c-main", kind: "prerequisite", privacyEpoch: 1 },
        ],
        authorization: {
          admissibleSourceIds: allChunks.map(c => c.sourceId),
          admissibleSourceVersions: Object.fromEntries(allChunks.map(c => [c.sourceId, c.sourceVersion])),
          expectedPrivacyEpoch: 1,
        },
      };

      const ranked = rankMaterialContext({
        chunks: allChunks,
        query: "target spectral decomposition",
        maxCharacters: 20_000,
        pedagogicalGraph: graph,
      });

      expect(ranked.length).toBe(32);
      const ids = ranked.map(c => c.id);
      expect(ids).toContain("prereq-def");
      expect(ids.indexOf("prereq-def")).toBeLessThan(ids.indexOf("main-thm"));
    });

    it("preserves #493 dense validation, legacy blind-cut recovery, physical chunk [\\u2026] merging, and explicit preferChunkId / preferPage priority", () => {
      const formulaTail = "$$x + y = z$$ Cauchy-Schwarz theorem tail";
      const shiftedThm = chunk("shifted-thm", "a".repeat(5990) + formulaTail, 5);
      const prereqDef = chunk("prereq-def", ":::definition Inner Product\nPositive-definite form.\n:::", 1);
      const preferredPageChunk = chunk("pref-page", "User-selected page note with zero query overlap.", 9);
      const preferredIdChunk = chunk("pref-id", "Explicitly pinned chunk id.", 8);
      const allChunks = [shiftedThm, prereqDef, preferredPageChunk, preferredIdChunk];

      const shiftedSegments = segmentMaterialChunks([shiftedThm]);
      expect(shiftedSegments).toHaveLength(2);
      const legacySeg1 = { chunk: { ...shiftedThm, text: shiftedThm.text.slice(6000) }, segmentIndex: 1 };

      const graph: MaterialPedagogicalGraph = {
        concepts: [
          { id: "c-def", label: "Inner Product", evidenceChunkIds: ["prereq-def"], privacyEpoch: 2 },
          { id: "c-thm", label: "Cauchy-Schwarz", evidenceChunkIds: ["shifted-thm"], privacyEpoch: 2 },
        ],
        edges: [
          { from: "c-def", to: "c-thm", kind: "prerequisite", privacyEpoch: 2 },
        ],
        authorization: {
          admissibleSourceIds: allChunks.map(c => c.sourceId),
          admissibleSourceVersions: Object.fromEntries(allChunks.map(c => [c.sourceId, c.sourceVersion])),
          expectedPrivacyEpoch: 2,
        },
      };

      const ranked = rankMaterialContext({
        chunks: allChunks,
        query: "orthogonal projection", // 0 lexical overlap; seeded purely via valid legacy dense hit + direct seg0 hit
        maxCharacters: 15_000,
        preferChunkId: "pref-id",
        preferPage: 9,
        dense: [
          // Invalid dense hits that MUST be rejected:
          { ...legacySeg1, chunk: { ...legacySeg1.chunk, sourceVersion: 99 } },
          { ...legacySeg1, chunk: { ...legacySeg1.chunk, text: "tampered text" } },
          { ...legacySeg1, chunk: { ...legacySeg1.chunk, id: "foreign-id" } },
          { chunk: prereqDef, segmentIndex: -1 },
          { chunk: prereqDef, segmentIndex: 1.5 },
          // Valid direct + legacy blind-cut hits (plus a duplicate to verify dedupe):
          shiftedSegments[0]!,
          legacySeg1,
          legacySeg1,
        ],
        pedagogicalGraph: graph,
      });

      // Explicit preferChunkId (2) -> preferPage (1) -> foundation prerequisite -> merged dependent theorem!
      expect(ranked.map(c => c.id)).toEqual(["pref-id", "pref-page", "prereq-def", "shifted-thm"]);
      expect(ranked[3]?.text).toBe(`${shiftedSegments[0]!.chunk.text}\n[…]\n${shiftedSegments[1]!.chunk.text}`);
    });

    it("produces bit-for-bit identical output when pedagogicalGraph has empty concepts and edges", () => {
      const rows = [
        chunk("c1", "Linear independence and spanning sets in R^n.", 1),
        chunk("c2", "Basis dimension theorem and rank-nullity.", 2),
        chunk("c3", "Unrelated syllabus logistics.", 3),
      ];
      const withoutGraph = rankMaterialContext({
        chunks: rows,
        query: "dimension theorem rank-nullity",
        maxCharacters: 2000,
        preferPage: 3,
      });
      const withEmptyGraph = rankMaterialContext({
        chunks: rows,
        query: "dimension theorem rank-nullity",
        maxCharacters: 2000,
        preferPage: 3,
        pedagogicalGraph: {
          concepts: [],
          edges: [],
          authorization: {
            admissibleSourceIds: rows.map(r => r.sourceId),
            admissibleSourceVersions: Object.fromEntries(rows.map(r => [r.sourceId, r.sourceVersion])),
            expectedPrivacyEpoch: 1,
          },
        },
      });
      expect(withEmptyGraph).toEqual(withoutGraph);
    });
  });
});
