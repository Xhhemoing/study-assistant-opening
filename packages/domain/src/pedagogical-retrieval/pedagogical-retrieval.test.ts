import { describe, expect, it } from "vitest";
import {
  buildDualCitationBundle,
  chunkPedagogicalDocument,
  chunkTranscriptCues,
  computeRrfScores,
  normalizeSparseAdjacency,
  parsePedagogicalAst,
  partitionPedagogicalChunks,
  rankPedagogicalEvidence,
  safeSubsplitText,
  sparsePpr,
  type PageSpan,
  type PedagogicalChunk,
  type PedagogicalConceptNode,
  type PedagogicalGraphEdge,
} from "./index";

describe("AST pre-split structure-preserving pedagogical chunker", () => {
  it("seals display math ($$, \\[\\], align/equation/pmatrix/cases) without slicing inside formulas", () => {
    const doc = [
      "Intro paragraph discussing inner products and cost \\$5.",
      "",
      "$$",
      "\\langle u, v \\rangle = \\sum_{i=1}^n u_i v_i",
      "$$",
      "",
      "\\[",
      "|\\langle u, v \\rangle|^2 \\le \\langle u, u \\rangle \\langle v, v \\rangle",
      "\\]",
      "",
      "\\begin{align*}",
      "A &= \\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix} \\\\",
      "f(x) &= \\begin{cases} x^2 & x \\ge 0 \\\\ -x & x < 0 \\end{cases}",
      "\\end{align*}",
      "",
      "Closing remark after matrices.",
    ].join("\n");

    const chunks = chunkPedagogicalDocument({
      sourceId: "src-math",
      sourceVersion: 1,
      text: doc,
      maxChunkChars: 90,
      maxSealedChars: 1000,
    });

    // Exact offset round-trip for every emitted chunk.
    for (const chunk of chunks) {
      expect(doc.slice(chunk.startOffset, chunk.endOffset)).toBe(chunk.text);
      expect(chunk.oversizedSplit).toBe(false);
    }

    const mathChunks = chunks.filter(c => c.constructKinds.includes("display_math"));
    expect(mathChunks.length).toBeGreaterThanOrEqual(3);
    expect(mathChunks.some(c => c.text.includes("$$") && c.text.includes("\\sum_{i=1}^n"))).toBe(true);
    expect(mathChunks.some(c => c.text.includes("\\[") && c.text.includes("\\]"))).toBe(true);
    // Nested pmatrix and cases inside align* stay intact as one single sealed construct.
    const alignChunk = chunks.find(c => c.text.includes("\\begin{align*}"));
    expect(alignChunk).toBeDefined();
    expect(alignChunk!.text).toContain("\\begin{pmatrix}");
    expect(alignChunk!.text).toContain("\\end{pmatrix}");
    expect(alignChunk!.text).toContain("\\begin{cases}");
    expect(alignChunk!.text).toContain("\\end{cases}");
    expect(alignChunk!.text).toContain("\\end{align*}");
  });

  it("seals theorem, lemma, proof, definition, example, code, table, and callout constructs and isolates sealed solutions", () => {
    const doc = [
      ":::definition Inner Product",
      "An inner product is a positive-definite symmetric bilinear form.",
      ":::",
      "",
      ":::theorem Cauchy-Schwarz",
      "For all vectors $u, v$, $|\\langle u, v \\rangle| \\le \\|u\\| \\|v\\|$.",
      ":::",
      "",
      "> [!lemma] Discriminant Lemma",
      "> For real $t$, $\\|u + tv\\|^2 \\ge 0$ implies $b^2 - 4ac \\le 0$.",
      "",
      "\\begin{proof}",
      "Expand $\\|u + tv\\|^2$ as a quadratic in $t$:",
      "\\begin{equation}",
      "\\|v\\|^2 t^2 + 2 \\langle u, v \\rangle t + \\|u\\|^2 \\ge 0",
      "\\end{equation}",
      "\\end{proof}",
      "",
      "```ts",
      "export function dot(a: number[], b: number[]): number {",
      "  return a.reduce((acc, x, i) => acc + x * b[i]!, 0);",
      "}",
      "```",
      "",
      "| Property | Formula |",
      "| --- | --- |",
      "| Symmetry | $\\langle u,v \\rangle = \\langle v,u \\rangle$ |",
      "| Positivity | $\\langle u,u \\rangle \\ge 0$ |",
      "",
      ":::hint Step 1",
      "Consider the non-negative polynomial $p(t) = \\|u + tv\\|^2$.",
      ":::",
      "",
      ":::solution Official Answer",
      "The exact answer is $\\sqrt{14}$ by substituting $t = -\\langle u,v \\rangle / \\|v\\|^2$.",
      ":::",
    ].join("\n");

    const chunks = chunkPedagogicalDocument({
      sourceId: "src-linalg",
      sourceVersion: 2,
      privacyEpoch: 5,
      text: doc,
      maxChunkChars: 120,
      maxSealedChars: 2000,
    });

    for (const chunk of chunks) {
      expect(doc.slice(chunk.startOffset, chunk.endOffset)).toBe(chunk.text);
      expect(chunk.privacyEpoch).toBe(5);
    }

    const byKind = new Map(chunks.map(c => [c.kind, c]));
    expect(byKind.get("definition")?.visibility).toBe("public");
    expect(byKind.get("theorem")?.visibility).toBe("public");
    expect(byKind.get("lemma")?.visibility).toBe("public");
    expect(byKind.get("proof")?.visibility).toBe("public");
    expect(byKind.get("proof")?.text).toContain("\\begin{equation}");
    expect(byKind.get("proof")?.text).toContain("\\end{proof}");
    expect(byKind.get("code")?.text).toContain("export function dot");
    expect(byKind.get("table")?.text).toContain("| Positivity |");
    expect(byKind.get("hint")?.visibility).toBe("hint_gated");
    expect(byKind.get("solution")?.visibility).toBe("sealed");

    const partitioned = partitionPedagogicalChunks(chunks);
    expect(partitioned.sealedChunks.map(c => c.kind)).toEqual(["solution"]);
    expect(partitioned.hintGatedChunks.map(c => c.kind)).toEqual(["hint"]);
    expect(partitioned.indexableChunks.some(c => c.visibility === "sealed")).toBe(false);
    expect(partitioned.indexableChunks.some(c => c.visibility === "hint_gated")).toBe(false);

    const withHints = partitionPedagogicalChunks(chunks, { allowHintGated: true });
    expect(withHints.indexableChunks.some(c => c.visibility === "hint_gated")).toBe(true);
    expect(withHints.indexableChunks.some(c => c.visibility === "sealed")).toBe(false);
  });

  it("propagates sealed visibility under Answer Key / 参考答案 headings and quarantines legacy material when defaultVisibility=sealed", () => {
    const doc = [
      "## Exercises",
      "Compute the integral of $x^2$ on $[0, 1]$.",
      "",
      "## 参考答案",
      "The answer is $1/3$.",
      "",
      "## Next Chapter",
      "New public theorem overview.",
    ].join("\r\n");

    const chunks = chunkPedagogicalDocument({
      sourceId: "src-exam",
      sourceVersion: 1,
      text: doc,
    });

    for (const chunk of chunks) {
      expect(doc.slice(chunk.startOffset, chunk.endOffset)).toBe(chunk.text);
    }
    const answerChunk = chunks.find(c => c.text.includes("1/3"));
    const nextChapterChunk = chunks.find(c => c.text.includes("New public theorem"));
    expect(answerChunk?.visibility).toBe("sealed");
    expect(nextChapterChunk?.visibility).toBe("public");

    // Legacy quarantine mode seals unclassified text completely.
    const quarantined = chunkPedagogicalDocument({
      sourceId: "src-legacy",
      sourceVersion: 0,
      text: "Unclassified legacy OCR page containing question and answer mixed together.",
      defaultVisibility: "sealed",
    });
    expect(quarantined.every(c => c.visibility === "sealed")).toBe(true);
    expect(partitionPedagogicalChunks(quarantined).indexableChunks).toHaveLength(0);
  });

  it("preserves exact cross-page physicalPage spans and inline/structured transcript [startMs, endMs] ranges", () => {
    const page1 = ":::proof Cross-Page Proof\nFirst half on page 104.\n";
    const page2 = "Second half completing the proof on page 105.\n:::\n\n[01:05.500 - 01:18.250] Lecture explanation of the proof.";
    const fullText = page1 + page2;
    const pageSpans: PageSpan[] = [
      { page: 104, startOffset: 0, endOffset: page1.length },
      { page: 105, startOffset: page1.length, endOffset: fullText.length },
    ];

    const chunks = chunkPedagogicalDocument({
      sourceId: "src-book",
      sourceVersion: 3,
      text: fullText,
      pageSpans,
    });

    const proof = chunks.find(c => c.kind === "proof")!;
    expect(proof.pageStart).toBe(104);
    expect(proof.pageEnd).toBe(105);
    expect(fullText.slice(proof.startOffset, proof.endOffset)).toBe(proof.text);

    const cue = chunks.find(c => c.kind === "transcript_cue")!;
    expect(cue.startMs).toBe(65_500);
    expect(cue.endMs).toBe(78_250);

    const mediaChunks = chunkTranscriptCues({
      sourceId: "src-lecture-video",
      sourceVersion: 1,
      privacyEpoch: 9,
      cues: [
        { startMs: 12_000, endMs: 25_000, text: "First derivation step.", keyframeChunkId: "kf-1" },
        { startMs: 25_000, endMs: 42_500, text: "Second derivation step.", keyframeChunkId: "kf-2" },
      ],
    });
    expect(mediaChunks).toHaveLength(2);
    expect(mediaChunks[0]).toMatchObject({
      kind: "transcript_cue",
      startMs: 12_000,
      endMs: 25_000,
      keyframeChunkId: "kf-1",
      oversizedSplit: false,
    });
    expect(() =>
      chunkTranscriptCues({
        sourceId: "bad",
        sourceVersion: 1,
        cues: [{ startMs: 5000, endMs: 4000, text: "inverted" }],
      }),
    ).toThrow(RangeError);
  });

  it("safely sub-splits oversized sealed constructs with oversizedSplit=true without breaking LaTeX commands or UTF-16 surrogate pairs", () => {
    // Mathematical bold '𝐱' is a surrogate pair (\uD835\uDC31).
    const mathBoldX = "\uD835\uDC31";
    const repeatedBody = Array.from({ length: 12 }, (_, idx) => `${mathBoldX}_${idx} + \\frac{${idx}}{${idx + 1}}`).join(" ");
    const doc = `\\begin{equation}\n${repeatedBody}\n\\end{equation}`;

    const chunks = chunkPedagogicalDocument({
      sourceId: "src-oversized",
      sourceVersion: 1,
      text: doc,
      maxChunkChars: 40,
      maxSealedChars: 55,
    });

    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every(c => c.oversizedSplit)).toBe(true);
    // Exact contiguous reconstruction with zero dropped characters.
    expect(chunks.map(c => c.text).join("")).toBe(doc);
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]!;
      expect(doc.slice(c.startOffset, c.endOffset)).toBe(c.text);
      if (i > 0) expect(c.startOffset).toBe(chunks[i - 1]!.endOffset);
      // Never ends with an unpaired high surrogate or starts with an unpaired low surrogate.
      const lastCode = c.text.charCodeAt(c.text.length - 1);
      const firstCode = c.text.charCodeAt(0);
      expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false);
      expect(firstCode >= 0xdc00 && firstCode <= 0xdfff).toBe(false);
      // Never cuts mid-`\frac` command.
      expect(/\\(?:f|fr|fra)$/.test(c.text)).toBe(false);
    }

    // Direct torture test on tight surrogate + LaTeX boundary.
    const tight = `${mathBoldX}${mathBoldX}\\alpha${mathBoldX}\\beta`;
    const parts = safeSubsplitText(tight, 5);
    expect(parts.map(p => p.text).join("")).toBe(tight);
    for (const part of parts) {
      const last = part.text.charCodeAt(part.text.length - 1);
      const first = part.text.charCodeAt(0);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
      expect(/\\(?:a|al|alp|alph|b|be|bet)$/.test(part.text)).toBe(false);
    }
  });

  it("handles nested code fences inside ::: containers without premature closing", () => {
    const doc = [
      ":::example Code Example",
      "```markdown",
      ":::",
      "```",
      "Still inside example!",
      ":::",
    ].join("\n");

    const ast = parsePedagogicalAst(doc);
    expect(ast).toHaveLength(1);
    expect(ast[0]!.kind).toBe("example");
    expect(ast[0]!.text).toContain("Still inside example!");
  });
});

describe("sparsePpr exactness, dangling-node mass conservation, and validation", () => {
  it("matches exact analytical Personalized PageRank and conserves probability mass at 1.0 with dangling nodes", () => {
    // Graph: 0 -> 1 (weight 1), 1 is dangling!
    // Seed s = [1, 0].
    // Analytical steady state:
    //   p0 = alpha + (1 - alpha) * p1
    //   p1 = (1 - alpha) * p0
    // => p0 = alpha / (1 - (1 - alpha)^2) = 1 / (2 - alpha)
    // => p1 = (1 - alpha) / (2 - alpha)
    const alpha = 0.15;
    const adj = normalizeSparseAdjacency(2, [{ from: 0, to: 1, weight: 3.5 }]);
    const ppr = sparsePpr(adj, new Float64Array([1, 0]), {
      alpha,
      tolerance: 1e-12,
      maxIterations: 200,
    });

    const expectedP0 = 1 / (2 - alpha);
    const expectedP1 = (1 - alpha) / (2 - alpha);
    expect(ppr[0]).toBeCloseTo(expectedP0, 9);
    expect(ppr[1]).toBeCloseTo(expectedP1, 9);
    expect(ppr[0]! + ppr[1]!).toBeCloseTo(1.0, 12);
  });

  it("conserves probability mass at 1.0 on cyclic + dangling + multi-seed sparse graphs", () => {
    const adj = normalizeSparseAdjacency(5, [
      { from: 0, to: 1, weight: 2 },
      { from: 0, to: 2, weight: 1 },
      { from: 1, to: 2, weight: 1 },
      { from: 2, to: 3, weight: 4 },
      { from: 3, to: 0, weight: 1 },
      // node 4 is isolated/dangling; node 3 also points to 4
      { from: 3, to: 4, weight: 1 },
    ]);
    const ppr = sparsePpr(adj, new Float64Array([2, 0, 1, 0, 0]));
    const totalMass = ppr.reduce((sum, x) => sum + x, 0);
    expect(totalMass).toBeCloseTo(1.0, 12);
    // Node 4 receives flow from 3, and its dangling mass returns to nodes 0 and 2.
    expect(ppr[4]!).toBeGreaterThan(0);
    expect(ppr[0]!).toBeGreaterThan(ppr[4]!);
  });

  it("returns zero vector for all-zero seeds and rejects invalid parameters", () => {
    const adj = normalizeSparseAdjacency(2, [{ from: 0, to: 1, weight: 1 }]);
    expect(Array.from(sparsePpr(adj, new Float64Array([0, 0])))).toEqual([0, 0]);
    expect(() => sparsePpr(adj, new Float64Array([1]), { alpha: 0.15 })).toThrow(RangeError);
    expect(() => sparsePpr(adj, new Float64Array([1, 0]), { alpha: 0 })).toThrow(RangeError);
    expect(() => sparsePpr(adj, new Float64Array([1, 0]), { alpha: 1 })).toThrow(RangeError);
    expect(() => sparsePpr(adj, new Float64Array([-1, 1]))).toThrow(RangeError);
    expect(() => normalizeSparseAdjacency(2, [{ from: 0, to: 2, weight: 1 }])).toThrow(RangeError);
  });

  it("computes deterministic RRF scores over admissible IDs only", () => {
    const scores = computeRrfScores(
      [
        [
          { id: "c-secret", score: 100 },
          { id: "c-b", score: 0.9 },
          { id: "c-a", score: 0.9 },
        ],
        [
          { id: "c-a", score: 0.8 },
          { id: "c-b", score: 0.4 },
        ],
      ],
      new Set(["c-a", "c-b"]),
      60,
    );
    expect(scores.has("c-secret")).toBe(false);
    // In list 1 tie (`0.9`), "c-a" < "c-b" lexicographically -> rank 1 vs rank 2.
    expect(scores.get("c-a")!).toBeGreaterThan(scores.get("c-b")!);
  });
});

describe("rankPedagogicalEvidence security isolation, prerequisite recall, and foundational ordering", () => {
  function makeChunk(overrides: Partial<PedagogicalChunk> & { id: string }): PedagogicalChunk {
    return {
      sourceId: "src-notes",
      sourceVersion: 1,
      privacyEpoch: 7,
      kind: "prose",
      constructKinds: [overrides.kind ?? "prose"],
      visibility: "public",
      atomicConstruct: false,
      text: `Content for ${overrides.id}`,
      startOffset: 0,
      endOffset: 20,
      pageStart: 1,
      pageEnd: 1,
      startMs: null,
      endMs: null,
      keyframeChunkId: null,
      oversizedSplit: false,
      ...overrides,
    };
  }

  it("guarantees ZERO score mass leakage from sealed blocks, revoked sources, stale privacyEpoch, or excluded item families", () => {
    const cDef = makeChunk({
      id: "chunk-def-inner",
      kind: "definition",
      conceptIds: ["concept-inner"],
      pageStart: 12,
      pageEnd: 12,
    });
    const cThm = makeChunk({
      id: "chunk-thm-cs",
      kind: "theorem",
      conceptIds: ["concept-cs"],
      pageStart: 14,
      pageEnd: 14,
    });
    const cSealed = makeChunk({
      id: "chunk-sealed-sol",
      kind: "solution",
      visibility: "sealed",
      conceptIds: ["concept-cs"],
      pageStart: 15,
      pageEnd: 15,
    });
    const cRevokedSource = makeChunk({
      id: "chunk-revoked-src",
      sourceId: "src-revoked",
      kind: "lemma",
      conceptIds: ["concept-revoked"],
      pageStart: 2,
      pageEnd: 2,
    });
    const cStaleEpoch = makeChunk({
      id: "chunk-stale-epoch",
      privacyEpoch: 6,
      kind: "lemma",
      conceptIds: ["concept-inner"],
      pageStart: 9,
      pageEnd: 9,
    });
    const cExcludedFamily = makeChunk({
      id: "chunk-exam-family",
      itemFamilyId: "exam-family-42",
      kind: "example",
      conceptIds: ["concept-cs"],
      pageStart: 20,
      pageEnd: 20,
    });

    const concepts: PedagogicalConceptNode[] = [
      { id: "concept-inner", label: "Inner Product", supportingSourceIds: ["src-notes"], privacyEpoch: 7 },
      { id: "concept-cs", label: "Cauchy-Schwarz", supportingSourceIds: ["src-notes"], privacyEpoch: 7 },
      { id: "concept-revoked", label: "Revoked Concept", supportingSourceIds: ["src-revoked"], privacyEpoch: 7 },
    ];

    const cleanEdges: PedagogicalGraphEdge[] = [
      { from: "concept-inner", to: "concept-cs", kind: "prerequisite", supportingSourceIds: ["src-notes"], privacyEpoch: 7 },
    ];
    const poisonedEdges: PedagogicalGraphEdge[] = [
      ...cleanEdges,
      // Edge pointing from theorem into sealed solution (must be dropped pre-graph!)
      { from: "chunk-thm-cs", to: "chunk-sealed-sol", kind: "solves", supportingSourceIds: ["src-notes"], privacyEpoch: 7 },
      // Edge supported ONLY by revoked source connecting two surviving concepts!
      { from: "concept-cs", to: "concept-inner", kind: "requires", supportingSourceIds: ["src-revoked"], privacyEpoch: 7 },
      // Edge connecting surviving node to excluded family chunk
      { from: "chunk-thm-cs", to: "chunk-exam-family", kind: "illustrates", supportingSourceIds: ["src-notes"], privacyEpoch: 7 },
      // Edge with stale privacy epoch
      { from: "chunk-thm-cs", to: "chunk-stale-epoch", kind: "requires", supportingSourceIds: ["src-notes"], privacyEpoch: 6 },
    ];

    const authorization = {
      admissibleSourceIds: ["src-notes"],
      admissibleSourceVersions: { "src-notes": 1 },
      expectedPrivacyEpoch: 7,
      excludedItemFamilyIds: ["exam-family-42"],
    };

    const baseline = rankPedagogicalEvidence({
      chunks: [cDef, cThm],
      concepts: concepts.slice(0, 2),
      edges: cleanEdges,
      lexicalRanking: [{ id: "chunk-thm-cs", score: 1.0 }],
      authorization,
    });

    const withPoison = rankPedagogicalEvidence({
      chunks: [cDef, cThm, cSealed, cRevokedSource, cStaleEpoch, cExcludedFamily],
      concepts,
      edges: poisonedEdges,
      lexicalRanking: [
        { id: "chunk-sealed-sol", score: 999 },
        { id: "chunk-revoked-src", score: 888 },
        { id: "chunk-stale-epoch", score: 777 },
        { id: "chunk-exam-family", score: 666 },
        { id: "chunk-thm-cs", score: 1.0 },
      ],
      authorization,
    });

    // Exact bit-for-bit invariance: poisoned/excluded nodes & edges leaked 0.0 mass!
    expect(withPoison.ranked).toEqual(baseline.ranked);
    expect(withPoison.pprByNodeId).toEqual(baseline.pprByNodeId);
    expect(withPoison.diagnostics.filteredSealedChunks).toBe(1);
    expect(withPoison.diagnostics.filteredUnauthorizedChunks).toBe(2);
    expect(withPoison.diagnostics.filteredExcludedFamilyChunks).toBe(1);
    expect(withPoison.diagnostics.filteredEdges).toBe(4);
    expect(withPoison.diagnostics.totalPprMass).toBeCloseTo(1.0, 12);
    expect(withPoison.pprByNodeId["chunk-sealed-sol"]).toBeUndefined();
    expect(withPoison.pprByNodeId["chunk-revoked-src"]).toBeUndefined();
  });

  it("pulls in multi-hop prerequisite definitions via PPR and orders foundational definitions before dependent theorems without letting unrelated definitions hijack rank 1", () => {
    const cDefInner = makeChunk({
      id: "chunk-def-inner",
      privacyEpoch: 3,
      kind: "definition",
      conceptIds: ["concept-inner"],
      pageStart: 10,
      pageEnd: 10,
    });
    const cLemmaDisc = makeChunk({
      id: "chunk-lemma-disc",
      privacyEpoch: 3,
      kind: "lemma",
      conceptIds: ["concept-disc"],
      pageStart: 11,
      pageEnd: 11,
    });
    const cThmCs = makeChunk({
      id: "chunk-thm-cs",
      privacyEpoch: 3,
      kind: "theorem",
      conceptIds: ["concept-cs"],
      pageStart: 42,
      pageEnd: 42,
    });
    const cVideoCs = makeChunk({
      id: "chunk-video-cs",
      sourceId: "src-lecture",
      privacyEpoch: 3,
      kind: "transcript_cue",
      conceptIds: ["concept-cs"],
      pageStart: null,
      pageEnd: null,
      startMs: 872_000,
      endMs: 915_000,
      keyframeChunkId: "kf-872",
    });
    const cUnrelatedDef = makeChunk({
      id: "chunk-def-unrelated",
      privacyEpoch: 3,
      kind: "definition",
      conceptIds: ["concept-metric"],
      pageStart: 99,
      pageEnd: 99,
    });

    const concepts: PedagogicalConceptNode[] = [
      { id: "concept-inner", label: "Inner Product", supportingSourceIds: ["src-notes"], privacyEpoch: 3 },
      { id: "concept-disc", label: "Quadratic Discriminant", supportingSourceIds: ["src-notes"], privacyEpoch: 3 },
      { id: "concept-cs", label: "Cauchy-Schwarz", supportingSourceIds: ["src-notes", "src-lecture"], privacyEpoch: 3 },
      { id: "concept-metric", label: "Metric Space", supportingSourceIds: ["src-notes"], privacyEpoch: 3 },
    ];

    const edges: PedagogicalGraphEdge[] = [
      { from: "concept-inner", to: "concept-disc", kind: "prerequisite", privacyEpoch: 3 },
      { from: "concept-disc", to: "concept-cs", kind: "prerequisite", privacyEpoch: 3 },
    ];

    const result = rankPedagogicalEvidence({
      chunks: [cDefInner, cLemmaDisc, cThmCs, cVideoCs, cUnrelatedDef],
      concepts,
      edges,
      // Query directly matches the theorem + lecture video, plus tiny lexical hit on unrelated def.
      // Neither `chunk-def-inner` nor `chunk-lemma-disc` has ANY lexical/dense seed score!
      lexicalRanking: [
        { id: "chunk-thm-cs", score: 1.0 },
        { id: "chunk-video-cs", score: 0.7 },
        { id: "chunk-def-unrelated", score: 0.05 },
      ],
      authorization: {
        admissibleSourceIds: ["src-notes", "src-lecture"],
        expectedPrivacyEpoch: 3,
      },
    });

    const ids = result.ranked.map(r => r.chunk.id);
    // Multi-hop PPR recalled BOTH prerequisite lemma and foundational inner-product definition!
    expect(ids).toContain("chunk-def-inner");
    expect(ids).toContain("chunk-lemma-disc");
    expect(ids).toContain("chunk-thm-cs");
    expect(ids).toContain("chunk-video-cs");

    // Foundational topological ordering: Inner Product def -> Discriminant lemma -> Cauchy-Schwarz theorem -> Lecture cue!
    expect(ids.indexOf("chunk-def-inner")).toBeLessThan(ids.indexOf("chunk-lemma-disc"));
    expect(ids.indexOf("chunk-lemma-disc")).toBeLessThan(ids.indexOf("chunk-thm-cs"));
    expect(ids.indexOf("chunk-thm-cs")).toBeLessThan(ids.indexOf("chunk-video-cs"));

    // Unrelated definition must NOT hijack rank 1 ahead of Cauchy-Schwarz!
    expect(ids.indexOf("chunk-def-unrelated")).toBeGreaterThan(ids.indexOf("chunk-thm-cs"));

    // Dual independent verifiable citation bundle (physicalPage + [startMs, endMs, keyframeChunkId]).
    const dual = buildDualCitationBundle(result.ranked);
    expect(dual.documentAnchors.some(a => a.physicalPage === 42 && a.chunkId === "chunk-thm-cs")).toBe(true);
    expect(dual.mediaAnchors).toEqual([
      {
        kind: "media",
        sourceId: "src-lecture",
        sourceVersion: 1,
        chunkId: "chunk-video-cs",
        startMs: 872_000,
        endMs: 915_000,
        keyframeChunkId: "kf-872",
      },
    ]);
  });

  it("gates hint_gated blocks unless allowHintGated=true and stays excluded from the public @aistudy/domain root barrel", async () => {
    const cPublic = makeChunk({ id: "chunk-pub", visibility: "public" });
    const cHint = makeChunk({ id: "chunk-hint", kind: "hint", visibility: "hint_gated" });
    const cSealed = makeChunk({ id: "chunk-seal", kind: "solution", visibility: "sealed" });

    const withoutHints = rankPedagogicalEvidence({
      chunks: [cPublic, cHint, cSealed],
      lexicalRanking: [
        { id: "chunk-pub", score: 0.5 },
        { id: "chunk-hint", score: 1.0 },
        { id: "chunk-seal", score: 2.0 },
      ],
      authorization: { admissibleSourceIds: ["src-notes"], expectedPrivacyEpoch: 7 },
    });
    expect(withoutHints.ranked.map(r => r.chunk.id)).toEqual(["chunk-pub"]);
    expect(withoutHints.diagnostics.filteredHintGatedChunks).toBe(1);
    expect(withoutHints.diagnostics.filteredSealedChunks).toBe(1);

    const withHints = rankPedagogicalEvidence({
      chunks: [cPublic, cHint, cSealed],
      lexicalRanking: [
        { id: "chunk-pub", score: 0.5 },
        { id: "chunk-hint", score: 1.0 },
        { id: "chunk-seal", score: 2.0 },
      ],
      authorization: {
        admissibleSourceIds: ["src-notes"],
        expectedPrivacyEpoch: 7,
        allowHintGated: true,
      },
    });
    expect(withHints.ranked.map(r => r.chunk.id)).toContain("chunk-hint");
    expect(withHints.ranked.map(r => r.chunk.id)).not.toContain("chunk-seal");

    const rootDomain = await import("../index");
    expect(rootDomain).not.toHaveProperty("sparsePpr");
    expect(rootDomain).not.toHaveProperty("chunkPedagogicalDocument");
    expect(rootDomain).not.toHaveProperty("rankPedagogicalEvidence");
  });
});
