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

  it("isolates inline \\begin{solution} and \\begin{hint} inside prose and after display math without leaking as public display_math", () => {
    const doc = [
      "Problem 1. Evaluate $x$. \\begin{solution} SECRET_42 \\end{solution}",
      "",
      "Problem 2. Factor $x^2 - 1$. \\begin{hint} HINT_99 \\end{hint}",
      "",
      "Problem 3. Solve with steps. \\begin{solution}",
      "Step 1: isolate $x$.",
      "",
      "Step 2: SECRET_MULTILINE_77.",
      "\\end{solution} Public follow-up note.",
      "",
      "$$x + 1 = 2$$ \\begin{solution} SECRET_AFTER_MATH \\end{solution}",
      "",
      "Warmup: \\begin{exercise} Compute $3 \\times 4$. \\begin{solution} SECRET_INLINE_EX \\end{solution} \\end{exercise} Done.",
    ].join("\n");

    const chunks = chunkPedagogicalDocument({
      sourceId: "src-inline-leak",
      sourceVersion: 1,
      privacyEpoch: 11,
      text: doc,
    });

    for (let idx = 0; idx < chunks.length; idx++) {
      const c = chunks[idx]!;
      expect(doc.slice(c.startOffset, c.endOffset)).toBe(c.text);
      if (idx > 0) expect(c.startOffset).toBeGreaterThanOrEqual(chunks[idx - 1]!.endOffset);
    }

    const partitioned = partitionPedagogicalChunks(chunks);
    const withHints = partitionPedagogicalChunks(chunks, { allowHintGated: true });

    const secrets = ["SECRET_42", "SECRET_MULTILINE_77", "SECRET_AFTER_MATH", "SECRET_INLINE_EX"];
    for (const secret of secrets) {
      expect(partitioned.publicChunks.some(c => c.text.includes(secret))).toBe(false);
      expect(partitioned.indexableChunks.some(c => c.text.includes(secret))).toBe(false);
      expect(withHints.indexableChunks.some(c => c.text.includes(secret))).toBe(false);
      expect(partitioned.sealedChunks.some(c => c.text.includes(secret) && c.kind === "solution")).toBe(true);
    }

    // Inline hint is hint_gated: excluded by default, allowed only with allowHintGated=true.
    expect(partitioned.publicChunks.some(c => c.text.includes("HINT_99"))).toBe(false);
    expect(partitioned.indexableChunks.some(c => c.text.includes("HINT_99"))).toBe(false);
    expect(partitioned.hintGatedChunks.some(c => c.text.includes("HINT_99") && c.kind === "hint")).toBe(true);
    expect(withHints.indexableChunks.some(c => c.text.includes("HINT_99"))).toBe(true);

    // Public prose and follow-up text remain retrievable.
    expect(partitioned.publicChunks.some(c => c.text.includes("Problem 1. Evaluate $x$."))).toBe(true);
    expect(partitioned.publicChunks.some(c => c.text.includes("Public follow-up note."))).toBe(true);
    expect(partitioned.publicChunks.some(c => c.text.includes("Compute $3 \\times 4$."))).toBe(true);

    // End-to-end ranker guarantees 0.0 leakage even when every chunk gets high lexical score.
    const rankedNoHints = rankPedagogicalEvidence({
      chunks,
      lexicalRanking: chunks.map(c => ({ id: c.id, score: 10 })),
      authorization: { admissibleSourceIds: ["src-inline-leak"], expectedPrivacyEpoch: 11 },
    });
    const rankedTextNoHints = rankedNoHints.ranked.map(r => r.chunk.text).join("\n");
    for (const secret of secrets) {
      expect(rankedTextNoHints).not.toContain(secret);
    }
    expect(rankedTextNoHints).not.toContain("HINT_99");
    expect(rankedNoHints.diagnostics.filteredSealedChunks).toBe(partitioned.sealedChunks.length);
    expect(rankedNoHints.diagnostics.filteredHintGatedChunks).toBe(partitioned.hintGatedChunks.length);
  });

  it("maintains a monotonic heading visibility stack so nested Hints never downgrade Answer Key and nested Solutions never corrupt sibling Hints", () => {
    const doc = [
      "## Answer Key",
      "### Hints",
      "Hint A inside answer key.",
      "### Problem 2",
      "SECRET_P2 inside answer key.",
      "## Next Public Section",
      "Public prose resumes here.",
      "## Hints",
      "### Full Solution",
      "SECRET_SOL inside hints section.",
      "### Hint 2",
      "HINT_TWO stays hint gated.",
      "## Final Public Chapter",
      "Public epilogue.",
    ].join("\n");

    const ast = parsePedagogicalAst(doc);
    const byExact = (exact: string) => ast.find(b => b.text === exact);

    expect(byExact("## Answer Key")?.visibility).toBe("sealed");
    expect(byExact("### Hints")?.visibility).toBe("sealed");
    expect(byExact("Hint A inside answer key.")?.visibility).toBe("sealed");
    expect(byExact("### Problem 2")?.visibility).toBe("sealed");
    expect(byExact("SECRET_P2 inside answer key.")?.visibility).toBe("sealed");
    expect(byExact("## Next Public Section")?.visibility).toBe("public");
    expect(byExact("Public prose resumes here.")?.visibility).toBe("public");
    expect(byExact("## Hints")?.visibility).toBe("hint_gated");
    expect(byExact("### Full Solution")?.visibility).toBe("sealed");
    expect(byExact("SECRET_SOL inside hints section.")?.visibility).toBe("sealed");
    expect(byExact("### Hint 2")?.visibility).toBe("hint_gated");
    expect(byExact("HINT_TWO stays hint gated.")?.visibility).toBe("hint_gated");
    expect(byExact("## Final Public Chapter")?.visibility).toBe("public");
    expect(byExact("Public epilogue.")?.visibility).toBe("public");

    const chunks = chunkPedagogicalDocument({
      sourceId: "src-headings",
      sourceVersion: 1,
      privacyEpoch: 4,
      text: doc,
    });
    for (const chunk of chunks) {
      expect(doc.slice(chunk.startOffset, chunk.endOffset)).toBe(chunk.text);
    }

    const partitioned = partitionPedagogicalChunks(chunks);
    const withHints = partitionPedagogicalChunks(chunks, { allowHintGated: true });

    // Neither Hint A (under Answer Key) nor SECRET_P2 nor SECRET_SOL may leak even with allowHintGated=true.
    for (const sealedToken of ["Hint A", "SECRET_P2", "SECRET_SOL"]) {
      expect(partitioned.publicChunks.some(c => c.text.includes(sealedToken))).toBe(false);
      expect(withHints.indexableChunks.some(c => c.text.includes(sealedToken))).toBe(false);
      expect(partitioned.sealedChunks.some(c => c.text.includes(sealedToken))).toBe(true);
    }
    // HINT_TWO is strictly hint_gated.
    expect(partitioned.publicChunks.some(c => c.text.includes("HINT_TWO"))).toBe(false);
    expect(partitioned.hintGatedChunks.some(c => c.text.includes("HINT_TWO"))).toBe(true);
    expect(withHints.indexableChunks.some(c => c.text.includes("HINT_TWO"))).toBe(true);
    // Public sections remain public.
    expect(partitioned.publicChunks.some(c => c.text.includes("Public prose resumes here."))).toBe(true);
    expect(partitioned.publicChunks.some(c => c.text.includes("Public epilogue."))).toBe(true);
  });

  it("recursively extracts nested hints and sealed solutions out of public :::exercise, \\begin{exercise}, and callout containers with 0.0 ranker leakage", () => {
    const doc = [
      "::::exercise Problem 1",
      "Compute $\\int_0^1 x^2\\,dx$.",
      "",
      ":::hint",
      "HINT_FENCED_1: Use the power rule.",
      "",
      ":::solution",
      "SECRET_IN_HINT_1: $1/3$.",
      ":::",
      ":::",
      "",
      ":::solution",
      "SECRET_FENCED_1: Exact value is $1/3$.",
      ":::",
      "",
      "Part (b): Verify by differentiation.",
      "::::",
      "",
      "\\begin{exercise}",
      "Solve $2x = 14$ and prove uniqueness.",
      "\\begin{hint}",
      "HINT_LATEX_2: Divide both sides by 2.",
      "\\end{hint}",
      "\\begin{solution}",
      "SECRET_LATEX_2: $x = 7$.",
      "\\end{solution}",
      "\\begin{proof}",
      "SECRET_EXERCISE_PROOF_2: If $2x = 2y$ then $x = y$.",
      "\\end{proof}",
      "\\end{exercise}",
      "",
      "\\begin{exercise} Quick check $1+1$. \\end{exercise} \\begin{solution} SECRET_SAME_LINE_EX \\end{solution}",
      "",
      "> [!question] Callout Problem 3",
      "> Find the derivative of $\\sin x$.",
      ">",
      "> > [!hint]",
      "> > HINT_CALLOUT_3: Recall trig limits.",
      ">",
      "> > [!solution]",
      "> > SECRET_CALLOUT_3: $\\cos x$.",
      "",
      "> [!question] Callout Problem 4",
      "> Evaluate $5!$.",
      ">",
      "> [!solution]",
      "> SECRET_CALLOUT_SIBLING_4: $120$.",
      "",
      "> [!question] Callout Problem 5",
      "> Compute $\\log_2 8$. \\begin{solution} SECRET_CALLOUT_INLINE_5: 3 \\end{solution}",
      ">",
      "> ### Answer Key",
      "> SECRET_CALLOUT_HEADING_5: $2^3 = 8$.",
      "",
      "> Plain quote prompt.",
      "> > [!solution]",
      "> > SECRET_PLAIN_QUOTE_6",
      "",
      "\\begin{theorem}",
      "Public theorem statement.",
      "\\begin{proof}",
      "PUBLIC_THEOREM_PROOF remains visible.",
      "\\end{proof}",
      "\\end{theorem}",
    ].join("\n");

    const chunks = chunkPedagogicalDocument({
      sourceId: "src-nested",
      sourceVersion: 1,
      privacyEpoch: 12,
      text: doc,
    });

    // Exact non-overlapping substring offsets for every chunk.
    for (let idx = 0; idx < chunks.length; idx++) {
      const c = chunks[idx]!;
      expect(doc.slice(c.startOffset, c.endOffset)).toBe(c.text);
      if (idx > 0) expect(c.startOffset).toBeGreaterThanOrEqual(chunks[idx - 1]!.endOffset);
    }

    const partitioned = partitionPedagogicalChunks(chunks);
    const withHints = partitionPedagogicalChunks(chunks, { allowHintGated: true });

    const sealedSecrets = [
      "SECRET_IN_HINT_1",
      "SECRET_FENCED_1",
      "SECRET_LATEX_2",
      "SECRET_EXERCISE_PROOF_2",
      "SECRET_SAME_LINE_EX",
      "SECRET_CALLOUT_3",
      "SECRET_CALLOUT_SIBLING_4",
      "SECRET_CALLOUT_INLINE_5",
      "SECRET_CALLOUT_HEADING_5",
      "SECRET_PLAIN_QUOTE_6",
    ];
    for (const secret of sealedSecrets) {
      expect(partitioned.publicChunks.some(c => c.text.includes(secret))).toBe(false);
      expect(partitioned.indexableChunks.some(c => c.text.includes(secret))).toBe(false);
      expect(withHints.indexableChunks.some(c => c.text.includes(secret))).toBe(false);
      expect(partitioned.sealedChunks.some(c => c.text.includes(secret))).toBe(true);
    }

    const hintTokens = ["HINT_FENCED_1", "HINT_LATEX_2", "HINT_CALLOUT_3"];
    for (const hint of hintTokens) {
      expect(partitioned.publicChunks.some(c => c.text.includes(hint))).toBe(false);
      expect(partitioned.indexableChunks.some(c => c.text.includes(hint))).toBe(false);
      expect(partitioned.hintGatedChunks.some(c => c.text.includes(hint) && c.kind === "hint")).toBe(true);
      expect(withHints.indexableChunks.some(c => c.text.includes(hint))).toBe(true);
    }

    // Outer exercise prompts and trailing public parts stay public with kind "exercise".
    expect(partitioned.publicChunks.some(c => c.kind === "exercise" && c.text.includes("Compute $\\int_0^1 x^2\\,dx$."))).toBe(true);
    expect(partitioned.publicChunks.some(c => c.kind === "exercise" && c.text.includes("Part (b): Verify by differentiation."))).toBe(true);
    expect(partitioned.publicChunks.some(c => c.kind === "exercise" && c.text.includes("Solve $2x = 14$"))).toBe(true);
    expect(partitioned.publicChunks.some(c => c.kind === "exercise" && c.text.includes("Quick check $1+1$."))).toBe(true);
    expect(partitioned.publicChunks.some(c => c.kind === "exercise" && c.text.includes("Find the derivative of $\\sin x$."))).toBe(true);
    expect(partitioned.publicChunks.some(c => c.kind === "exercise" && c.text.includes("Evaluate $5!$."))).toBe(true);
    // Proof nested inside a public theorem remains public.
    expect(partitioned.publicChunks.some(c => c.kind === "theorem" && c.text.includes("PUBLIC_THEOREM_PROOF"))).toBe(true);

    // End-to-end rankPedagogicalEvidence guarantees 0.0 answer leakage.
    const ranked = rankPedagogicalEvidence({
      chunks,
      lexicalRanking: chunks.map(c => ({ id: c.id, score: 5 })),
      authorization: {
        admissibleSourceIds: ["src-nested"],
        expectedPrivacyEpoch: 12,
        allowHintGated: false,
      },
    });
    const rankedText = ranked.ranked.map(r => r.chunk.text).join("\n");
    for (const secret of sealedSecrets) {
      expect(rankedText).not.toContain(secret);
    }
    for (const hint of hintTokens) {
      expect(rankedText).not.toContain(hint);
    }
    expect(ranked.diagnostics.filteredSealedChunks).toBe(partitioned.sealedChunks.length);
    expect(ranked.diagnostics.filteredHintGatedChunks).toBe(partitioned.hintGatedChunks.length);
  });

  it("strips sealed and hint-gated inline directives from container, callout, tilde, and heading labels as well as text", () => {
    const doc = [
      ":::exercise Problem 1 \\begin{solution} SECRET_EX_HDR \\end{solution}",
      "Compute $\\int_0^1 x\\,dx$.",
      ":::",
      "",
      ":::exercise \\begin{solution} SECRET_ONLY_HDR \\end{solution}",
      "Prompt body with fallback label.",
      ":::",
      "",
      ":::exercise Problem 2 \\begin{hint} HINT_EX_HDR \\end{hint} (Part A)",
      "Factor $x^2 - 9$.",
      ":::",
      "",
      "> [!question] Callout Q1 \\begin{solution} SECRET_CALLOUT_HDR \\end{solution}",
      "> Evaluate $2^5$.",
      "",
      "~~~exercise Tilde Ex <details><summary>Answer Key</summary> SECRET_TILDE_HDR </details>",
      "Simplify $\\sqrt{49}$.",
      "~~~",
      "",
      "## Section 1 \\begin{proof_key} SECRET_HEADING_KEY \\end{proof_key}",
      "Public overview after heading.",
    ].join("\n");

    const chunks = chunkPedagogicalDocument({
      sourceId: "src-header-label-leak",
      sourceVersion: 1,
      privacyEpoch: 14,
      text: doc,
    });

    for (let idx = 0; idx < chunks.length; idx++) {
      const c = chunks[idx]!;
      expect(doc.slice(c.startOffset, c.endOffset)).toBe(c.text);
      if (idx > 0) expect(c.startOffset).toBeGreaterThanOrEqual(chunks[idx - 1]!.endOffset);
    }

    const partitioned = partitionPedagogicalChunks(chunks);
    const withHints = partitionPedagogicalChunks(chunks, { allowHintGated: true });

    const sealedSecrets = [
      "SECRET_EX_HDR",
      "SECRET_ONLY_HDR",
      "SECRET_CALLOUT_HDR",
      "SECRET_TILDE_HDR",
      "SECRET_HEADING_KEY",
    ];
    for (const secret of sealedSecrets) {
      expect(partitioned.publicChunks.some(c => c.text.includes(secret) || (c.label ?? "").includes(secret))).toBe(false);
      expect(partitioned.indexableChunks.some(c => c.text.includes(secret) || (c.label ?? "").includes(secret))).toBe(false);
      expect(withHints.indexableChunks.some(c => c.text.includes(secret) || (c.label ?? "").includes(secret))).toBe(false);
      expect(partitioned.sealedChunks.some(c => c.text.includes(secret))).toBe(true);
    }

    expect(partitioned.publicChunks.some(c => c.text.includes("HINT_EX_HDR") || (c.label ?? "").includes("HINT_EX_HDR"))).toBe(false);
    expect(partitioned.hintGatedChunks.some(c => c.text.includes("HINT_EX_HDR") && c.kind === "hint")).toBe(true);

    // Public chunks preserve safe sanitized labels without answer keys.
    expect(partitioned.publicChunks.some(c => c.kind === "exercise" && c.label === "Problem 1")).toBe(true);
    expect(partitioned.publicChunks.some(c => c.kind === "exercise" && c.label === "exercise")).toBe(true);
    expect(partitioned.publicChunks.some(c => c.kind === "exercise" && c.label === "Problem 2 (Part A)")).toBe(true);
    expect(partitioned.publicChunks.some(c => c.kind === "exercise" && c.label === "Callout Q1")).toBe(true);
    expect(partitioned.publicChunks.some(c => c.kind === "exercise" && c.label === "Tilde Ex")).toBe(true);
    expect(partitioned.publicChunks.some(c => c.kind === "heading" && c.label === "Section 1")).toBe(true);
  });

  it("extracts sealed solutions and hints from Markdown table cells and sealed/hint columns without leaking into public table chunks", () => {
    const doc = [
      "| Problem | Notes |",
      "| --- | --- |",
      "| Solve $2x = 6$ | \\begin{solution} SECRET_TBL_LATEX \\end{solution} |",
      "| Solve $3x = 9$ | Public note <details><summary>Solution</summary> SECRET_TBL_DETAILS </details> |",
      "| Solve $4x = 12$ | \\begin{hint} HINT_TBL_LATEX \\end{hint} and <details><summary>Hint</summary> HINT_TBL_DETAILS </details> |",
      "",
      "| Question | Answer Key | Hint |",
      "| --- | --- | --- |",
      "| What is $6 \\times 7$? \\begin{solution} X | Y \\end{solution} | SECRET_COL_42 | HINT_COL_MULT |",
      "| What is $8 \\times 9$? | SECRET_COL_72 | HINT_COL_NINES |",
    ].join("\n");

    const chunks = chunkPedagogicalDocument({
      sourceId: "src-table-leak",
      sourceVersion: 1,
      privacyEpoch: 15,
      text: doc,
    });

    for (let idx = 0; idx < chunks.length; idx++) {
      const c = chunks[idx]!;
      expect(doc.slice(c.startOffset, c.endOffset)).toBe(c.text);
      if (idx > 0) expect(c.startOffset).toBeGreaterThanOrEqual(chunks[idx - 1]!.endOffset);
    }

    const partitioned = partitionPedagogicalChunks(chunks);
    const withHints = partitionPedagogicalChunks(chunks, { allowHintGated: true });

    const sealedSecrets = ["SECRET_TBL_LATEX", "SECRET_TBL_DETAILS", "SECRET_COL_42", "SECRET_COL_72"];
    for (const secret of sealedSecrets) {
      expect(partitioned.publicChunks.some(c => c.text.includes(secret))).toBe(false);
      expect(partitioned.indexableChunks.some(c => c.text.includes(secret))).toBe(false);
      expect(withHints.indexableChunks.some(c => c.text.includes(secret))).toBe(false);
      expect(partitioned.sealedChunks.some(c => c.text.includes(secret))).toBe(true);
    }

    const hintTokens = ["HINT_TBL_LATEX", "HINT_TBL_DETAILS", "HINT_COL_MULT", "HINT_COL_NINES"];
    for (const hint of hintTokens) {
      expect(partitioned.publicChunks.some(c => c.text.includes(hint))).toBe(false);
      expect(partitioned.indexableChunks.some(c => c.text.includes(hint))).toBe(false);
      expect(partitioned.hintGatedChunks.some(c => c.text.includes(hint) && c.kind === "hint")).toBe(true);
      expect(withHints.indexableChunks.some(c => c.text.includes(hint))).toBe(true);
    }

    // Public question cells remain retrievable.
    const publicText = partitioned.publicChunks.map(c => c.text).join("\n");
    expect(publicText).toContain("Solve $2x = 6$");
    expect(publicText).toContain("Public note");
    expect(publicText).toContain("What is $6 \\times 7$?");
  });

  it("fails closed on unclosed :::, ~~~, <details>, and \\begin{solution|answer|proof_key|hint} directives and splits same-line prefix/suffix cleanly", () => {
    // 1. Same-line prefix + closed inline solution + trailing public suffix + second hint.
    const sameLineDoc =
      "Prefix prompt. \\begin{solution} SECRET_MID \\end{solution} Middle public suffix. \\begin{hint} HINT_MID \\end{hint} Final public tail.";
    const sameLineChunks = chunkPedagogicalDocument({
      sourceId: "src-same-line",
      sourceVersion: 1,
      text: sameLineDoc,
    });
    for (const c of sameLineChunks) {
      expect(sameLineDoc.slice(c.startOffset, c.endOffset)).toBe(c.text);
    }
    const sameLinePart = partitionPedagogicalChunks(sameLineChunks);
    const sameLinePublic = sameLinePart.publicChunks.map(c => c.text).join(" ");
    expect(sameLinePublic).toContain("Prefix prompt.");
    expect(sameLinePublic).toContain("Middle public suffix.");
    expect(sameLinePublic).toContain("Final public tail.");
    expect(sameLinePublic).not.toContain("SECRET_MID");
    expect(sameLinePublic).not.toContain("HINT_MID");
    expect(sameLinePart.sealedChunks.some(c => c.text.includes("SECRET_MID"))).toBe(true);
    expect(sameLinePart.hintGatedChunks.some(c => c.text.includes("HINT_MID"))).toBe(true);

    // 2. Unclosed sealed containers & inline directives MUST fail closed to EOF.
    const unclosedSealedCases: Array<{ readonly name: string; readonly doc: string; readonly secret: string }> = [
      {
        name: "unclosed :::solution",
        doc: "Public intro.\n\n:::solution\nSECRET_EOF_COLON\n\nTrailing paragraph.",
        secret: "SECRET_EOF_COLON",
      },
      {
        name: "unclosed ~~~solution",
        doc: "Public intro.\n\n~~~solution\nSECRET_EOF_TILDE\n\nTrailing paragraph.",
        secret: "SECRET_EOF_TILDE",
      },
      {
        name: "unclosed <details>",
        doc: "Public intro.\n\n<details>\n<summary>Answer</summary>\nSECRET_EOF_DETAILS\n\nTrailing paragraph.",
        secret: "SECRET_EOF_DETAILS",
      },
      {
        name: "unclosed inline \\begin{solution}",
        doc: "Prefix prompt. \\begin{solution} SECRET_EOF_INLINE\nLine 2.\n\nTrailing paragraph.",
        secret: "SECRET_EOF_INLINE",
      },
      {
        name: "unclosed \\begin{answer}",
        doc: "Public intro.\n\n\\begin{answer}\nSECRET_EOF_ANSWER\n\nTrailing paragraph.",
        secret: "SECRET_EOF_ANSWER",
      },
      {
        name: "unclosed \\begin{proof_key}",
        doc: "Public intro.\n\n\\begin{proof_key}\nSECRET_EOF_PROOF_KEY\n\nTrailing paragraph.",
        secret: "SECRET_EOF_PROOF_KEY",
      },
      {
        name: "unclosed inline \\begin{solution} in table cell",
        doc: "| Problem | Notes |\n| --- | --- |\n| Q1 | \\begin{solution} SECRET_EOF_TBL |\n\nTrailing paragraph.",
        secret: "SECRET_EOF_TBL",
      },
    ];

    for (const tc of unclosedSealedCases) {
      const chunks = chunkPedagogicalDocument({
        sourceId: `src-${tc.name}`,
        sourceVersion: 1,
        text: tc.doc,
      });
      for (const c of chunks) {
        expect(tc.doc.slice(c.startOffset, c.endOffset)).toBe(c.text);
      }
      const part = partitionPedagogicalChunks(chunks);
      expect(part.publicChunks.some(c => c.text.includes(tc.secret) || c.text.includes("Trailing paragraph."))).toBe(false);
      expect(part.sealedChunks.some(c => c.text.includes(tc.secret) && c.text.includes("Trailing paragraph."))).toBe(true);
    }

    // 3. Unclosed hint_gated containers & inline \begin{hint} fail closed as hint_gated to EOF.
    const unclosedHintCases = [
      "Public intro.\n\n:::hint\nHINT_EOF_COLON\n\nTrailing hint tail.",
      "Public intro.\n\n~~~hint\nHINT_EOF_TILDE\n\nTrailing hint tail.",
      "Public intro.\n\n<details><summary>Hint</summary>\nHINT_EOF_DETAILS\n\nTrailing hint tail.",
      "Prefix prompt. \\begin{hint} HINT_EOF_INLINE\n\nTrailing hint tail.",
    ];
    for (const doc of unclosedHintCases) {
      const chunks = chunkPedagogicalDocument({ sourceId: "src-unclosed-hint", sourceVersion: 1, text: doc });
      const part = partitionPedagogicalChunks(chunks);
      expect(part.publicChunks.some(c => c.text.includes("HINT_EOF_") || c.text.includes("Trailing hint tail."))).toBe(false);
      expect(part.hintGatedChunks.some(c => c.text.includes("HINT_EOF_") && c.text.includes("Trailing hint tail."))).toBe(true);
    }
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

  it("guards shared-concept tier ordering against reverse explicit prereqBeforePairs to avoid spurious 2-cycles", () => {
    const cMotivatingExample = makeChunk({
      id: "chunk-example-motivating",
      kind: "example",
      conceptIds: ["concept-shared"],
      pageStart: 1,
      pageEnd: 1,
    });
    const cFormalDef = makeChunk({
      id: "chunk-def-formal",
      kind: "definition",
      conceptIds: ["concept-shared"],
      pageStart: 2,
      pageEnd: 2,
    });

    const result = rankPedagogicalEvidence({
      chunks: [cMotivatingExample, cFormalDef],
      concepts: [
        { id: "concept-shared", label: "Shared Concept", supportingSourceIds: ["src-notes"], privacyEpoch: 7 },
      ],
      edges: [
        // Explicit prerequisite requires the higher-tier motivating example BEFORE the lower-tier definition.
        {
          from: "chunk-example-motivating",
          to: "chunk-def-formal",
          kind: "prerequisite",
          supportingSourceIds: ["src-notes"],
          privacyEpoch: 7,
        },
      ],
      lexicalRanking: [
        // Give the formal definition a higher lexical score so a spurious 2-cycle would emit it first.
        { id: "chunk-def-formal", score: 1.0 },
        { id: "chunk-example-motivating", score: 0.4 },
      ],
      authorization: {
        admissibleSourceIds: ["src-notes"],
        expectedPrivacyEpoch: 7,
      },
    });

    const ids = result.ranked.map(r => r.chunk.id);
    expect(ids).toEqual(["chunk-example-motivating", "chunk-def-formal"]);
  });

  it("quarantines filtered sealed and unreleased hint_gated chunk IDs so colliding concepts cannot reintroduce them into edges, seeds, or pprByNodeId", () => {
    const cDef = makeChunk({
      id: "chunk-def-safe",
      kind: "definition",
      conceptIds: ["concept-safe"],
      pageStart: 1,
      pageEnd: 1,
    });
    const cThm = makeChunk({
      id: "chunk-thm-safe",
      kind: "theorem",
      conceptIds: ["concept-safe"],
      pageStart: 2,
      pageEnd: 2,
    });
    const cSealed = makeChunk({
      id: "chunk-sealed-collide",
      kind: "solution",
      visibility: "sealed",
      pageStart: 3,
      pageEnd: 3,
    });
    const cHint = makeChunk({
      id: "chunk-hint-collide",
      kind: "hint",
      visibility: "hint_gated",
      pageStart: 4,
      pageEnd: 4,
    });

    const authorization = {
      admissibleSourceIds: ["src-notes"],
      expectedPrivacyEpoch: 7,
      allowHintGated: false,
    };

    const baseline = rankPedagogicalEvidence({
      chunks: [cDef, cThm],
      concepts: [
        { id: "concept-safe", label: "Safe", supportingSourceIds: ["src-notes"], privacyEpoch: 7 },
      ],
      lexicalRanking: [{ id: "chunk-thm-safe", score: 1.0 }],
      authorization,
    });

    // Poison with concepts whose IDs collide with the filtered sealed & unreleased hint_gated chunks,
    // plus edges and seeds targeting those quarantined IDs.
    const withCollidingConcepts = rankPedagogicalEvidence({
      chunks: [cDef, cThm, cSealed, cHint],
      concepts: [
        { id: "concept-safe", label: "Safe", supportingSourceIds: ["src-notes"], privacyEpoch: 7 },
        { id: "chunk-sealed-collide", label: "Colliding Sealed Concept", supportingSourceIds: ["src-notes"], privacyEpoch: 7 },
        { id: "chunk-hint-collide", label: "Colliding Hint Concept", supportingSourceIds: ["src-notes"], privacyEpoch: 7 },
      ],
      edges: [
        { from: "chunk-thm-safe", to: "chunk-sealed-collide", kind: "requires", supportingSourceIds: ["src-notes"], privacyEpoch: 7 },
        { from: "chunk-thm-safe", to: "chunk-hint-collide", kind: "requires", supportingSourceIds: ["src-notes"], privacyEpoch: 7 },
      ],
      lexicalRanking: [
        { id: "chunk-sealed-collide", score: 100 },
        { id: "chunk-hint-collide", score: 50 },
        { id: "chunk-thm-safe", score: 1.0 },
      ],
      seedScores: {
        "chunk-sealed-collide": 10,
        "chunk-hint-collide": 10,
      },
      authorization,
    });

    expect(withCollidingConcepts.ranked).toEqual(baseline.ranked);
    expect(withCollidingConcepts.pprByNodeId).toEqual(baseline.pprByNodeId);
    expect(withCollidingConcepts.pprByNodeId["chunk-sealed-collide"]).toBeUndefined();
    expect(withCollidingConcepts.pprByNodeId["chunk-hint-collide"]).toBeUndefined();
    expect(withCollidingConcepts.diagnostics.filteredSealedChunks).toBe(1);
    expect(withCollidingConcepts.diagnostics.filteredHintGatedChunks).toBe(1);
    expect(withCollidingConcepts.diagnostics.filteredEdges).toBe(2);
  });

  it("blocks transitive multi-hop cycles (A -> B explicit with B -> C and C -> A inferred tier edges) so explicit prerequisite A always precedes B", () => {
    // Tier hierarchy: definition (0) < theorem (2) < example (5).
    // Explicit prerequisite: A (example, tier 5) -> B (definition, tier 0).
    // Shared-concept tier edges:
    //   B (definition, c1) -> C (theorem, c1 & c2)  [tier 0 < tier 2]
    //   C (theorem, c2) -> A (example, c2)          [tier 2 < tier 5]
    // Without reachability checking, admitting both B->C and C->A forms cycle A->B->C->A!
    const chunkA = makeChunk({
      id: "chunk-A-example",
      kind: "example",
      conceptIds: ["concept-2"],
      pageStart: 1,
      pageEnd: 1,
    });
    const chunkB = makeChunk({
      id: "chunk-B-definition",
      kind: "definition",
      conceptIds: ["concept-1"],
      pageStart: 2,
      pageEnd: 2,
    });
    const chunkC = makeChunk({
      id: "chunk-C-theorem",
      kind: "theorem",
      conceptIds: ["concept-1", "concept-2"],
      pageStart: 3,
      pageEnd: 3,
    });
    const concepts: PedagogicalConceptNode[] = [
      { id: "concept-1", label: "C1", supportingSourceIds: ["src-notes"], privacyEpoch: 7 },
      { id: "concept-2", label: "C2", supportingSourceIds: ["src-notes"], privacyEpoch: 7 },
    ];
    const edges: PedagogicalGraphEdge[] = [
      {
        from: "chunk-A-example",
        to: "chunk-B-definition",
        kind: "prerequisite",
        supportingSourceIds: ["src-notes"],
        privacyEpoch: 7,
      },
    ];

    // Ordering 1: B has highest lexical score (so a cycle fallback would emit B before A).
    const resBFirst = rankPedagogicalEvidence({
      chunks: [chunkA, chunkB, chunkC],
      concepts,
      edges,
      lexicalRanking: [
        { id: "chunk-B-definition", score: 1.0 },
        { id: "chunk-C-theorem", score: 0.7 },
        { id: "chunk-A-example", score: 0.4 },
      ],
      authorization: { admissibleSourceIds: ["src-notes"], expectedPrivacyEpoch: 7 },
    });
    const idsBFirst = resBFirst.ranked.map(r => r.chunk.id);
    expect(idsBFirst.indexOf("chunk-A-example")).toBeLessThan(idsBFirst.indexOf("chunk-B-definition"));

    // Ordering 2: C has highest lexical score (so C->A is evaluated before B->C).
    const resCFirst = rankPedagogicalEvidence({
      chunks: [chunkA, chunkB, chunkC],
      concepts,
      edges,
      lexicalRanking: [
        { id: "chunk-C-theorem", score: 1.0 },
        { id: "chunk-B-definition", score: 0.8 },
        { id: "chunk-A-example", score: 0.4 },
      ],
      authorization: { admissibleSourceIds: ["src-notes"], expectedPrivacyEpoch: 7 },
    });
    const idsCFirst = resCFirst.ranked.map(r => r.chunk.id);
    expect(idsCFirst.indexOf("chunk-A-example")).toBeLessThan(idsCFirst.indexOf("chunk-B-definition"));
  });
});
