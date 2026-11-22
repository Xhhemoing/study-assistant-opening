import { describe, expect, it, vi } from "vitest";
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


function expectSealedEvidence(
  chunks: readonly PedagogicalChunk[],
  text: string,
  secrets: readonly string[],
  publicText?: string,
) {
  for (const chunk of chunks) expect(text.slice(chunk.startOffset, chunk.endOffset)).toBe(chunk.text);
  for (const allowHintGated of [false, true]) {
    const { sealedChunks, indexableChunks } = partitionPedagogicalChunks(chunks, { allowHintGated });
    const ranked = rankPedagogicalEvidence({
      chunks,
      authorization: { admissibleSourceIds: ["captions"], allowHintGated },
      lexicalRanking: chunks.map(chunk => ({ id: chunk.id, score: 1 })),
      options: { maxResults: chunks.length },
    });
    expect(ranked.diagnostics.filteredSealedChunks).toBe(sealedChunks.length);
    for (const secret of secrets) {
      expect(sealedChunks.some(chunk => chunk.text.includes(secret))).toBe(true);
      expect(indexableChunks.some(chunk => chunk.text.includes(secret))).toBe(false);
      expect(ranked.ranked.some(result => result.chunk.text.includes(secret))).toBe(false);
    }
    if (publicText) {
      expect(indexableChunks.find(chunk => chunk.text.includes(publicText))?.visibility).toBe("public");
      expect(ranked.ranked.some(result => result.chunk.text.includes(publicText))).toBe(true);
    }
  }
}

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

  it("applies protected spans and section visibility across structured cues without changing anchors or offsets", () => {
    const texts = [
      "  Public before \\begin{solution}inline-secret\\end{solution} public after. ",
      "<details><summary>Hint</summary>gated-clue</details> public tail",
      "参考答案\n---",
      "section-secret",
      "Back to lecture\n---",
      "public again\n> [!hint] callout-clue",
      "<details><summary>Solution</summary>cross-cue-secret",
      "second-secret</details> public ending",
    ];
    const cues = texts.map((text, i) => ({
      text, startMs: i * 100, endMs: (i + 1) * 100, keyframeChunkId: `frame-${i}`,
    }));
    const chunks = chunkTranscriptCues({ sourceId: "media", sourceVersion: 1, cues });
    expect(chunks.filter(c => c.startMs === 0).map(c => c.visibility))
      .toEqual(["public", "sealed", "public"]);
    expect(chunks.filter(c => c.startMs === 100).map(c => c.visibility)).toEqual(["hint_gated", "public"]);
    for (const [snippet, visibility] of [
      ["inline-secret", "sealed"], ["gated-clue", "hint_gated"],
      ["section-secret", "sealed"], ["public again", "public"],
      ["callout-clue", "hint_gated"], ["cross-cue-secret", "sealed"],
      ["second-secret", "sealed"], ["public ending", "public"],
    ]) {
      expect(chunks.filter(c => c.text.includes(snippet!)).map(c => c.visibility)).toEqual([visibility]);
    }
    const joined = texts.join("\n");
    let previousEnd = 0;
    for (const chunk of chunks) {
      expect(chunk.startOffset).toBeGreaterThanOrEqual(previousEnd);
      expect(joined.slice(chunk.startOffset, chunk.endOffset)).toBe(chunk.text);
      const cue = cues[chunk.startMs! / 100]!;
      expect(chunk).toMatchObject({
        startMs: cue.startMs, endMs: cue.endMs, keyframeChunkId: cue.keyframeChunkId,
      });
      previousEnd = chunk.endOffset;
    }
    expect(chunkTranscriptCues({
      sourceId: "media", sourceVersion: 1, defaultVisibility: "sealed",
      cues: [{ ...cues[0]!, visibility: "public" }],
    }).every(chunk => chunk.visibility === "sealed")).toBe(true);
  });

  it.each([
    ["$$", "$$y = 2$$"], ["\\[", "\\[y = 2\\]"],
    ["\\begin{align}", "\\begin{align}y = 2\\end{align}"],
    ["Prose before $$", "$$y = 2$$"],
  ])("partitions malformed math %s before a protected heading in documents and cues", (opener, laterMath) => {
    const lines = [opener, "unfinished", "## Answer Key", "PRIVATE_ANSWER", laterMath, "PRIVATE_AFTER", "## Lecture", "Public explanation"];
    const expected = ["PRIVATE_ANSWER", "PRIVATE_AFTER", "y = 2"];
    const source = { sourceId: "source", sourceVersion: 1 };
    for (const chunks of [
      chunkPedagogicalDocument({ ...source, text: lines.join("\n") }),
      chunkTranscriptCues({
        ...source, cues: lines.map((line, i) => ({ text: line, startMs: i * 100, endMs: (i + 1) * 100 })),
      }),
    ]) {
      const partition = partitionPedagogicalChunks(chunks, { allowHintGated: true });
      const indexable = partition.indexableChunks.map(chunk => chunk.text).join("\n");
      const sealed = partition.sealedChunks.map(chunk => chunk.text).join("\n");
      expect(indexable).toContain("Public explanation");
      for (const snippet of expected) {
        expect(indexable).not.toContain(snippet);
        expect(sealed).toContain(snippet);
      }
    }
  });

  it("does not use later paragraph math as a closer for a stray flow fence", () => {
    const [first, second] = parsePedagogicalAst("$$\nunfinished\n\n$$y = 2$$");
    expect(first).toMatchObject({ text: "$$\nunfinished", visibility: "sealed" });
    expect(second).toMatchObject({ text: "$$y = 2$$", visibility: "public" });
  });

  it.each([
    ["$$", ["- :::solution", "  Worked answer:", "  $$x = 42$$", "  :::"]],
    ["$$", ["> :::solution", "> Worked answer:", "> $$x = 42$$", "> :::"]],
    ["$$", ["- > [!solution]", "  > Worked answer:", "  > $$x = 42$$"]],
    ["$$", ["- ## Answer Key", "  Worked answer:", "  $$x = 42$$"]],
    ["\\[", ["1. > :::solution", "   > Worked answer:", "   > \\[x = 42\\]", "   > :::"]],
  ] as const)("keeps nested protected blocks outside a stray math opener (%j)", (opener, nested) => {
    const text = [opener, ...nested, "", "Public afterward"].join("\n");
    const chunks = chunkPedagogicalDocument({ sourceId: "doc", sourceVersion: 1, text });
    const partition = partitionPedagogicalChunks(chunks, { allowHintGated: true });
    expect(partition.sealedChunks.some(chunk => chunk.text.includes("Worked answer:"))).toBe(true);
    expect(partition.sealedChunks.some(chunk => chunk.text.includes("x = 42"))).toBe(true);
    expect(partition.indexableChunks.some(chunk => /Worked answer:|x = 42/.test(chunk.text))).toBe(false);
    expect(partition.indexableChunks.some(chunk => chunk.text.includes("Public afterward"))).toBe(true);
  });

  it.each([
    "Answer Key\n---\nPRIVATE_MARKUP\n## Lecture",
    ":::solution\nPRIVATE_MARKUP\n$$y = 2$$\n:::",
    "> [!solution]\n> PRIVATE_MARKUP\n> $$y = 2$$",
    "<details><summary>Answer</summary>PRIVATE_MARKUP $$y = 2$$</details>",
    "\\begin{solution}PRIVATE_MARKUP $$y = 2$$\\end{solution}",
  ])("recovers from stray math before protected Markdown or LaTeX", protectedBody => {
    const chunks = chunkPedagogicalDocument({
      sourceId: "doc", sourceVersion: 1, text: `$$\n${protectedBody}\n\nPublic afterward`,
    });
    expect(chunks.filter(chunk => chunk.text.includes("PRIVATE_MARKUP")).map(chunk => chunk.visibility)).toEqual(["sealed"]);
    expect(chunks.find(chunk => chunk.text.includes("Public afterward"))?.visibility).toBe("public");
  });

  it("recovers from a stray math opener before same-line details containing a later formula", () => {
    const text = "Before $$ <details>PRIVATE_MARKUP $$y = 2$$</details> public afterward";
    const chunks = chunkPedagogicalDocument({ sourceId: "doc", sourceVersion: 1, text });
    expect(chunks.filter(chunk => chunk.text.includes("PRIVATE_MARKUP")).map(chunk => chunk.visibility)).toEqual(["sealed"]);
    expect(chunks.find(chunk => chunk.text.includes("public afterward"))?.visibility).toBe("public");
  });

  it.each([
    ["> [!solution]", "> PRIVATE_CUE", "sealed"],
    ["> [!hint]", "> PRIVATE_CUE", "hint_gated"],
    [":::solution", "PRIVATE_CUE\n:::", "sealed"],
    ["<details><summary>Answer</summary>", "PRIVATE_CUE</details>", "sealed"],
  ] as const)("preserves %s across structured cue boundaries", (opener, body, visibility) => {
    const cues = [opener, body, "Public afterward"].map((text, i) => ({
      text, startMs: i * 100, endMs: (i + 1) * 100, keyframeChunkId: `frame-${i}`,
    }));
    const chunks = chunkTranscriptCues({ sourceId: "media", sourceVersion: 1, cues });
    expect(chunks.find(chunk => chunk.text.includes("PRIVATE_CUE"))).toMatchObject({
      visibility, startMs: 100, endMs: 200, keyframeChunkId: "frame-1",
    });
    expect(chunks.find(chunk => chunk.text.includes("Public afterward"))?.visibility).toBe("public");
  });

  it.each([
    ["- > [!solution]", "  > PRIVATE_LIST", "sealed"],
    ["* > [!hint]", "  > PRIVATE_LIST", "hint_gated"],
    ["+ > [!answer]", "  > PRIVATE_LIST", "sealed"],
    ["1. > [!answer]", "   > PRIVATE_LIST", "sealed"],
    ["2) > [!answer]", "   > PRIVATE_LIST", "sealed"],
    ["- [ ] > [!solution]", "  > PRIVATE_LIST", "sealed"],
    ["-\t> [!solution]", "\t> PRIVATE_LIST", "sealed"],
    ["> > [!solution]", "> > PRIVATE_LIST", "sealed"],
    ["> - > [!answer]", ">   > PRIVATE_LIST", "sealed"],
    ["- :::solution", "  PRIVATE_LIST\n  :::", "sealed"],
    ["- <details><summary>Answer</summary>", "  PRIVATE_LIST\n  </details>", "sealed"],
  ] as const)("protects nested list and quote content after %s", (opener, body, visibility) => {
    const text = [opener, body, "", "Public afterward"].join("\n");
    const chunks = chunkPedagogicalDocument({ sourceId: "doc", sourceVersion: 1, text });
    expect(chunks.filter(chunk => chunk.text.includes("PRIVATE_LIST")).map(chunk => chunk.visibility)).toEqual([visibility]);
    expect(chunks.find(chunk => chunk.text.includes("Public afterward"))?.visibility).toBe("public");
  });

  it.each([
    { bodies: ["$$", "## Answer Key", "VALUE", "$$y = 2$$", "## Lecture", "Public afterward"], index: 2, visibility: "sealed" },
    { bodies: ["参考答案", "---", "VALUE", "## Lecture", "Public afterward"], index: 2, visibility: "sealed" },
    { bodies: ["> [!hint]", "> VALUE", "Public afterward"], index: 1, visibility: "hint_gated" },
    { bodies: [":::solution", "VALUE", ":::", "Public afterward"], index: 1, visibility: "sealed" },
    { bodies: ["<details>", "VALUE</details>", "Public afterward"], index: 1, visibility: "sealed" },
    { bodies: ["- - > [!solution]", "    > VALUE", "Public afterward"], index: 1, visibility: "sealed" },
  ])("parses timestamped cue bodies as Markdown and keeps each raw anchor (%j)", ({ bodies, index, visibility }) => {
    const lines = bodies.map((body, i) => `[00:0${i}-00:0${i + 1}] ${body}`);
    const text = ["Public introduction", "", ...lines, ""].join("\r\n");
    const chunks = chunkPedagogicalDocument({ sourceId: "captions", sourceVersion: 1, text });
    expect(chunks.find(chunk => chunk.text.includes("VALUE"))).toMatchObject({
      visibility, startMs: index * 1000, endMs: (index + 1) * 1000,
      startOffset: text.indexOf(lines[index]!), text: lines[index],
    });
    expect(chunks.find(chunk => chunk.text.includes("Public introduction"))).toMatchObject({ visibility: "public", startMs: null });
    expect(chunks.find(chunk => chunk.text.includes("Public afterward"))?.visibility).toBe("public");
    for (const chunk of chunks) {
      expect(text.slice(chunk.startOffset, chunk.endOffset)).toBe(chunk.text);
      if (chunk.startMs !== null) {
        const line = lines[chunk.startMs / 1000]!;
        expect(chunk.endOffset).toBeLessThanOrEqual(text.indexOf(line) + line.length);
      }
    }
  });

  it.each(["- - > [!solution]", "1. * > [!solution]", "> - - > [!solution]"])(
    "keeps a nested list callout active across structured cues after %s", opener => {
      const continuation = opener.startsWith(">") ? ">     > Value is 42" : /^\d/.test(opener) ? "     > Value is 42" : "    > Value is 42";
      const cues = [opener, continuation, "Public afterward"].map((text, i) => ({
        text, startMs: i * 1000, endMs: (i + 1) * 1000, keyframeChunkId: `k${i}`,
      }));
      const chunks = chunkTranscriptCues({ sourceId: "media", sourceVersion: 1, cues });
      expect(chunks.find(chunk => chunk.text.includes("Value is 42"))).toMatchObject({
        visibility: "sealed", startMs: 1000, endMs: 2000, keyframeChunkId: "k1",
      });
      expect(chunks.find(chunk => chunk.text.includes("Public afterward"))).toMatchObject({
        visibility: "public", startMs: 2000, endMs: 3000, keyframeChunkId: "k2",
      });
    },
  );

  it.each([["solution", "sealed"], ["hint", "hint_gated"]])(
    "keeps lazy continuations inside a %s callout", (kind, visibility) => {
      const text = `> [!${kind}]\n> The result is\nforty-two.\n2. The unit is seconds.\n\nPublic afterward`;
      const blocks = parsePedagogicalAst(text);
      expect(blocks.find(block => block.text.includes("forty-two."))?.visibility).toBe(visibility);
      expect(blocks.find(block => block.text.includes("The unit is seconds."))?.visibility).toBe(visibility);
      expect(blocks.at(-1)).toMatchObject({ visibility: "public", text: "Public afterward" });
    },
  );

  it("keeps a nested lazy continuation sealed across dropped quote markers", () => {
    const text = "> > [!solution]\n> > The result is\n> forty-two.\nThe unit is seconds.\n\nPublic afterward";
    const blocks = parsePedagogicalAst(text);
    expect(blocks.find(block => block.text.includes("forty-two."))?.visibility).toBe("sealed");
    expect(blocks.find(block => block.text.includes("The unit is seconds."))?.visibility).toBe("sealed");
    expect(blocks.at(-1)).toMatchObject({ visibility: "public", text: "Public afterward" });
  });

  it.each([
    ["- > [!solution]", "  > The result is"],
    ["1. - > [!solution]", "     > The result is"],
    ["- [x] > [!solution]", "  > The result is"],
  ])("keeps a callout lazy continuation inside its list item (%s)", (opener, paragraph) => {
    const text = [opener, paragraph, "forty-two.", "In seconds.", "", "Public afterward"].join("\n");
    const partition = partitionPedagogicalChunks(chunkPedagogicalDocument({ sourceId: "doc", sourceVersion: 1, text }));
    expect(partition.sealedChunks.some(chunk => chunk.text.includes("forty-two.\nIn seconds."))).toBe(true);
    expect(partition.indexableChunks.map(chunk => chunk.text).join("\n")).toContain("Public afterward");
    expect(partition.indexableChunks.map(chunk => chunk.text).join("\n")).not.toContain("forty-two.");
  });

  it.each(["## Lecture", "---", "+ Another item", "1. Another item", "```text\nfenced\n```", ":::example\nexample\n:::"])(
    "ends lazy list callouts at a real block boundary (%s)", boundary => {
      const text = ["- > [!solution]", "  > The result is", "forty-two.", boundary, "Public afterward"].join("\n");
      const blocks = parsePedagogicalAst(text);
      expect(blocks.find(block => block.text.includes("forty-two."))?.visibility).toBe("sealed");
      expect(blocks.at(-1)?.visibility).toBe("public");
    },
  );

  it.each([["~~~", "~~~~", "```"], ["```", "````", "~~~"]])(
    "keeps literal timestamp lines inside a document fence (%s)", (short, open, other) => {
      const text = [
        "## Answer Key", `${open}text`, short, other, `[00:00-00:01] ${open}`,
        "## Lecture", "Worked answer: 42", open, "## Lecture", "[00:01-00:02] Public afterward",
      ].join("\n");
      const blocks = parsePedagogicalAst(text);
      expect(blocks.find(block => block.text.includes("Worked answer: 42"))).toMatchObject({
        kind: "code", visibility: "sealed", startMs: null,
      });
      expect(blocks.find(block => block.text.includes("[00:00-00:01]"))?.startMs).toBeNull();
      expect(blocks.at(-1)).toMatchObject({ visibility: "public", startMs: 1000, endMs: 2000 });
    },
  );

  it("keeps per-cue timestamps in a fence opened in a cue", () => {
    const text = [
      "[00:00-00:01] ## Answer Key", "[00:01-00:02] ~~~text", "[00:02-00:03] ## Lecture",
      "[00:03-00:04] Worked answer: 42", "[00:04-00:05] ~~~",
      "[00:05-00:06] ## Lecture", "[00:06-00:07] Public afterward",
    ].join("\n");
    const blocks = parsePedagogicalAst(text);
    expect(blocks.find(block => block.text.includes("Worked answer: 42"))).toMatchObject({
      visibility: "sealed", startMs: 3000, endMs: 4000,
    });
    expect(blocks.at(-1)).toMatchObject({ visibility: "public", startMs: 6000, endMs: 7000 });
  });

  it.each([
    ["- ~~~text", "  sample", "  ~~~"],
    ["1. ````js", "   sample\n   ```", "   ````"],
    ["> ~~~text", "> sample", "> ~~~"],
    ["- > ~~~text", "  > sample", "  > ~~~"],
    ["- - ~~~text", "    sample", "    ~~~"],
    ["- ~~~text", "  sample", ""],
    ["> ~~~text", "> sample", ""],
    ["- > ~~~text", "  > sample", ""],
  ])("recognizes timed sections after a container-scoped fence (%s, %s, %j)", (open, sample, close) => {
    const text = [open, sample, close, "[00:00-00:01] ## Answer Key", "[00:01-00:02] forty-two",
      "[00:02-00:03] ## Lecture", "[00:03-00:04] Public afterward"].join("\n");
    const chunks = chunkPedagogicalDocument({ sourceId: "doc", sourceVersion: 1, text });
    const { indexableChunks, sealedChunks } = partitionPedagogicalChunks(chunks, { allowHintGated: true });
    expect(sealedChunks.find(chunk => chunk.text.includes("forty-two"))).toMatchObject({
      visibility: "sealed", startMs: 1000, endMs: 2000,
    });
    expect(indexableChunks.some(chunk => chunk.text.includes("forty-two"))).toBe(false);
    expect(indexableChunks.find(chunk => chunk.text.includes("Public afterward"))).toMatchObject({
      startMs: 3000, endMs: 4000,
    });
  });

  it("keeps literal timestamps inside a nested document fence", () => {
    const text = ["## Answer Key", "- > ~~~~text", "  > [00:00-00:01] ~~~~", "  > ## Lecture",
      "  > forty-two", "  > ~~~~", "## Lecture", "[00:01-00:02] Public afterward"].join("\n");
    const blocks = parsePedagogicalAst(text);
    expect(blocks.find(block => block.text.includes("forty-two"))).toMatchObject({
      visibility: "sealed", startMs: null,
    });
    expect(blocks.at(-1)).toMatchObject({ visibility: "public", startMs: 1000, endMs: 2000 });
  });

  it("keeps list fence markers literal when the tab leaves four columns of inner indentation", () => {
    const text = ["## Answer Key", "- ~~~text", "\t  ~~~", "  [00:00-00:01] ## Lecture",
      "  [00:01-00:02] forty-two", "  ~~~", "## Lecture", "[00:02-00:03] Public afterward"].join("\n");
    const blocks = parsePedagogicalAst(text);
    expect(blocks.find(block => block.text.includes("forty-two"))).toMatchObject({
      visibility: "sealed", startMs: null,
    });
    expect(blocks.at(-1)).toMatchObject({ visibility: "public", startMs: 2000, endMs: 3000 });
  });

  it.each([
    ["> Answer Key", "> ---", "> $$x = 42$$"],
    ["> Answer Key", "> ===", "> $$x = 42$$"],
    ["- Answer Key", "  ---", "  $$x = 42$$"],
    ["- > Answer Key", "  > ---", "  > $$x = 42$$"],
    ["> - Answer Key", ">   ---", ">   $$x = 42$$"],
    ["100. First line\n     Answer Key", "     ---", "     $$x = 42$$"],
  ])("recovers from stray math before a container-scoped Setext answer heading (%s)", (title, underline, formula) => {
    const text = ["$$", title, underline, formula, "", "Public afterward"].join("\n");
    const chunks = chunkPedagogicalDocument({ sourceId: "doc", sourceVersion: 1, text });
    const { indexableChunks, sealedChunks } = partitionPedagogicalChunks(chunks, { allowHintGated: true });
    expect(sealedChunks.some(chunk => chunk.text.includes("x = 42"))).toBe(true);
    expect(indexableChunks.some(chunk => chunk.text.includes("x = 42"))).toBe(false);
    expect(indexableChunks.some(chunk => chunk.text.includes("Public afterward"))).toBe(true);
  });

  it("keeps a multiline Setext heading joined across pipe-containing cues", () => {
    const bodies = ["Answer Key | Unit 1", "Practice | Problems", "---", "forty-two"];
    const source = { sourceId: "captions", sourceVersion: 1 };
    const cues = bodies.map((text, index) => ({
      text, startMs: index * 1000, endMs: (index + 1) * 1000,
    }));
    const inline = bodies.map((body, index) => `[00:0${index}-00:0${index + 1}] ${body}`).join("\n");
    for (const chunks of [
      chunkPedagogicalDocument({ ...source, text: inline }),
      chunkTranscriptCues({ ...source, cues }),
    ]) {
      expect(chunks.find(chunk => chunk.text.includes("forty-two"))).toMatchObject({
        visibility: "sealed", startMs: 3000, endMs: 4000,
      });
    }
  });

  it.each([
    ["Time | Answer Key", "[00:00-00:01] | forty-two"],
    ["[00:00-00:01] | Answer Key", "[00:01-00:02] | forty-two"],
  ])("keeps literal timestamp cells in an untimed document table (%s)", (header, row) => {
    const text = [header, "--- | ---", row, "", "[00:02-00:03] Public afterward"].join("\n");
    const blocks = parsePedagogicalAst(text);
    expect(blocks.find(block => block.text.includes("forty-two"))).toMatchObject({
      text: "forty-two", visibility: "sealed", startOffset: text.indexOf("forty-two"), startMs: null,
    });
    expect(blocks.find(block => block.startOffset <= text.indexOf(row) && block.endOffset > text.indexOf(row)))
      .toMatchObject({ visibility: "public", startMs: null });
    expect(blocks.at(-1)).toMatchObject({ visibility: "public", startMs: 2000 });
    const chunks = chunkPedagogicalDocument({ sourceId: "doc", sourceVersion: 1, text });
    expect(partitionPedagogicalChunks(chunks, { allowHintGated: false }).indexableChunks.some(
      chunk => chunk.text.includes("forty-two"),
    )).toBe(false);
  });

  it.each(["t1 | forty-two", "[00:00-00:01] | forty-two", "| forty-two", "| t1 | forty-two |", "| | forty-two"])(
    "preserves answer-column index and source anchors in timed table rows (%s)", row => {
      const bodies = ["Time | Answer Key", "--- | ---", row, "t2 | SECOND_PRIVATE", "Public afterward"];
      const cues = bodies.map((text, index) => ({
        text, startMs: index * 1000, endMs: (index + 1) * 1000, keyframeChunkId: `k${index}`,
      }));
      const source = { sourceId: "captions", sourceVersion: 1 };
      const inline = bodies.map((body, index) => `[00:0${index}-00:0${index + 1}] ${body}`).join("\r\n");
      for (const { text, chunks, frame } of [
        { text: inline, chunks: chunkPedagogicalDocument({ ...source, text: inline }), frame: null },
        { text: bodies.join("\n"), chunks: chunkTranscriptCues({ ...source, cues }), frame: "k2" },
      ]) {
        const secret = chunks.find(chunk => chunk.text.includes("forty-two"));
        expect(secret).toMatchObject({
          visibility: "sealed", startMs: 2000, endMs: 3000, keyframeChunkId: frame,
          startOffset: text.indexOf("forty-two"),
        });
        expect(chunks.find(chunk => chunk.text.includes("SECOND_PRIVATE"))).toMatchObject({
          visibility: "sealed", startMs: 3000, endMs: 4000,
        });
        expect(chunks.find(chunk => chunk.text.includes("Public afterward"))).toMatchObject({
          visibility: "public", startMs: 4000, endMs: 5000,
        });
        for (const chunk of chunks) expect(text.slice(chunk.startOffset, chunk.endOffset)).toBe(chunk.text);
      }
    },
  );

  it("isolates short rows inside a multiline timed table without changing ordinary GFM rows", () => {
    const header = "Time | Answer Key | Note\n--- | --- | ---";
    const body = "t0 | First answer | Note\n| forty-two";
    const cues = [header, body].map((text, index) => ({ text, startMs: index * 1000, endMs: (index + 1) * 1000 }));
    const chunks = chunkTranscriptCues({ sourceId: "media", sourceVersion: 1, cues });
    expect(chunks.find(chunk => chunk.text.includes("forty-two"))).toMatchObject({
      text: "forty-two", visibility: "sealed", startMs: 1000, endMs: 2000,
    });
    const document = parsePedagogicalAst(`${header}\n| Public time |`);
    expect(document.find(block => block.text.includes("Public time"))?.visibility).toBe("public");
  });

  it("keeps pipe-less document table rows in the first column and preserves literal timestamp cells", () => {
    const text = ["Answer Key | Note", "--- | ---", "forty-two", "forty-three | note",
      "[00:00-00:01] another answer | note", "<!7 final answer", "", "[00:01-00:02] Public afterward"].join("\n");
    const blocks = parsePedagogicalAst(text);
    for (const secret of ["forty-two", "forty-three", "[00:00-00:01] another answer", "<!7 final answer"]) {
      expect(blocks.find(block => block.text.includes(secret))).toMatchObject({
        text: secret, visibility: "sealed", startOffset: text.indexOf(secret), startMs: null,
      });
    }
    expect(blocks.at(-1)).toMatchObject({ visibility: "public", startMs: 1000, endMs: 2000 });
  });

  it.each(["$$x | y$$", "One | Two | Three"])("recognizes timed headings after an invalid table header (%s)", header => {
    const text = [header, "--- | ---", "[00:00-00:01] ## Answer Key", "[00:01-00:02] forty-two"].join("\n");
    const secret = parsePedagogicalAst(text).find(block => block.text.includes("forty-two"));
    expect(secret).toMatchObject({ visibility: "sealed", startMs: 1000, endMs: 2000 });
  });

  it.each([
    "Norm $$|x|$$",
    "Norm $|x|$",
    "Norm \\|x\\|",
    "Norm `|x|`",
    "Norm ``one ` | two``",
    "Norm \\``|x|`",
    "```|x|```",
    "\\begin{solution} PRIVATE_HEADER | notes \\end{solution}",
    "Norm <details>PRIVATE_HEADER | notes</details>",
  ])("uses the same columns for table detection and extraction (%s)", firstCell => {
    const text = [
      firstCell + " | Answer Key", "--- | ---",
      "Unit $$|y|$$ | PRIVATE_DISPLAY", "Unit $|y|$ | PRIVATE_INLINE",
      "Unit `|y|` | PRIVATE_CODE", "Unit \\|y\\| | PRIVATE_ESCAPED",
    ].join("\n");
    const chunks = chunkPedagogicalDocument({ sourceId: "doc", sourceVersion: 1, text });
    const { indexableChunks, sealedChunks } = partitionPedagogicalChunks(chunks, { allowHintGated: true });
    expect(indexableChunks.some(chunk => chunk.text.includes("Unit"))).toBe(true);
    const secrets = ["PRIVATE_DISPLAY", "PRIVATE_INLINE", "PRIVATE_CODE", "PRIVATE_ESCAPED"];
    if (firstCell.includes("PRIVATE_HEADER")) secrets.push("PRIVATE_HEADER");
    for (const secret of secrets) {
      expect(indexableChunks.some(chunk => chunk.text.includes(secret))).toBe(false);
      expect(sealedChunks.some(chunk => chunk.text.includes(secret))).toBe(true);
    }
    for (const chunk of chunks) expect(text.slice(chunk.startOffset, chunk.endOffset)).toBe(chunk.text);
  });

  it.each([
    ["## Answer Key\n", "forty-two"],
    ["## Answer Key | notes\n--- | ---\n", "forty-two"],
    ["## Answer Key `x | y`\n", "forty-two"],
    ["## Answer Key \\| notes\n", "forty-two"],
    ["> [!solution]", "> forty-two"],
    ["- > [!solution]", "  > forty-two"],
    [":::solution", "forty-two\n[00:02-00:03] :::"],
    ["- :::solution", "  forty-two\n  :::"],
    ["~~~solution | notes", "forty-two\n[00:02-00:03] ~~~"],
    ["<details>", "forty-two</details>"],
    ["\\begin{solution}", "forty-two\n[00:02-00:03] \\end{solution}"],
    ["Answer Key\n---", "forty-two"],
  ])("keeps a timed protected block outside an unprefixed table (%s)", (open, answer) => {
    const text = ["Topic | Note", "--- | ---", "a | b", "[00:00-00:01] " + open,
      "[00:01-00:02] " + answer].join("\n");
    const chunks = chunkPedagogicalDocument({ sourceId: "doc", sourceVersion: 1, text });
    const { indexableChunks, sealedChunks } = partitionPedagogicalChunks(chunks, { allowHintGated: false });
    expect(indexableChunks.some(chunk => chunk.text.includes("forty-two"))).toBe(false);
    expect(sealedChunks.find(chunk => chunk.text.includes("forty-two"))).toMatchObject({
      visibility: "sealed", startMs: 1000, endMs: 2000,
    });
    for (const chunk of chunks) expect(text.slice(chunk.startOffset, chunk.endOffset)).toBe(chunk.text);
  });

  it("keeps a timed list-nested Setext heading and its underline together after a table", () => {
    const text = ["Topic | Note", "--- | ---", "a | b", "[00:00-00:01] - Answer Key",
      "[00:01-00:02]   ---", "[00:02-00:03]   forty-two"].join("\n");
    const chunks = chunkPedagogicalDocument({ sourceId: "doc", sourceVersion: 1, text });
    const { indexableChunks, sealedChunks } = partitionPedagogicalChunks(chunks, { allowHintGated: false });
    expect(indexableChunks.some(chunk => chunk.text.includes("forty-two"))).toBe(false);
    expect(sealedChunks.find(chunk => chunk.text.includes("forty-two"))).toMatchObject({
      visibility: "sealed", startMs: 2000, endMs: 3000,
    });
  });

  it("retains hint gating on a timed callout following a table", () => {
    const text = ["Topic | Note", "--- | ---", "a | b", "[00:00-00:01] > [!hint]",
      "[00:01-00:02] > forty-two"].join("\n");
    const chunks = chunkPedagogicalDocument({ sourceId: "doc", sourceVersion: 1, text });
    const { indexableChunks, hintGatedChunks } = partitionPedagogicalChunks(chunks, { allowHintGated: false });
    expect(indexableChunks.some(chunk => chunk.text.includes("forty-two"))).toBe(false);
    expect(hintGatedChunks.find(chunk => chunk.text.includes("forty-two"))).toMatchObject({
      visibility: "hint_gated", startMs: 1000, endMs: 2000,
    });
  });

  it.each(["-", "*", "+", "1."])("keeps a timestamped %s marker in a pipe-less table row", marker => {
    const text = ["Answer Key | Note", "--- | ---", `[00:00-00:01] ${marker} forty-two`, "forty-three"].join("\n");
    const chunks = chunkPedagogicalDocument({ sourceId: "doc", sourceVersion: 1, text });
    const { indexableChunks, sealedChunks } = partitionPedagogicalChunks(chunks, { allowHintGated: false });
    for (const secret of ["forty-two", "forty-three"]) {
      expect(indexableChunks.some(chunk => chunk.text.includes(secret))).toBe(false);
      expect(sealedChunks.find(chunk => chunk.text.includes(secret))).toMatchObject({
        visibility: "sealed", startMs: null, endMs: null,
      });
    }
  });

  it("keeps first-column protection on a list-like row with an explicit separator", () => {
    const text = "Answer Key | Note\n--- | ---\n[00:00-00:01] - forty-two | note";
    const block = parsePedagogicalAst(text).find(candidate => candidate.text.includes("forty-two"));
    expect(block).toMatchObject({ visibility: "sealed", startMs: null, endMs: null });
  });

  it.each(["- note", "* note", "+ note", "1. note"])(
    "preserves table column protection after a timestamped row starting with %s", firstCell => {
      const text = ["Time | Answer Key", "--- | ---", `[00:00-00:01] ${firstCell} | forty-two`,
        "[00:01-00:02] | forty-three", "t1 | forty-four", "", "[00:02-00:03] Public afterward"].join("\n");
      const chunks = chunkPedagogicalDocument({ sourceId: "doc", sourceVersion: 1, text });
      const { indexableChunks, sealedChunks } = partitionPedagogicalChunks(chunks, { allowHintGated: false });
      for (const secret of ["forty-two", "forty-three", "forty-four"]) {
        expect(indexableChunks.some(chunk => chunk.text.includes(secret))).toBe(false);
        expect(sealedChunks.find(chunk => chunk.text.includes(secret))).toMatchObject({
          text: secret, visibility: "sealed", startMs: null, endMs: null, startOffset: text.indexOf(secret),
        });
      }
      expect(chunks.at(-1)).toMatchObject({ visibility: "public", startMs: 2000, endMs: 3000 });
    },
  );

  it("keeps column protection on a timed heading with a pipe as it starts a new section", () => {
    const text = ["Time | Answer Key", "--- | ---", "[00:00-00:01] ## Lecture | forty-two",
      "[00:01-00:02] | forty-three", "t1 | forty-four", "", "[00:02-00:03] Public afterward"].join("\n");
    const chunks = chunkPedagogicalDocument({ sourceId: "doc", sourceVersion: 1, text });
    const { indexableChunks, sealedChunks } = partitionPedagogicalChunks(chunks, { allowHintGated: false });
    expect(indexableChunks.some(chunk => chunk.text.includes("forty-two"))).toBe(false);
    expect(sealedChunks.find(chunk => chunk.text.includes("forty-two"))).toMatchObject({
      visibility: "sealed", startMs: 0, endMs: 1000,
    });
    for (const secret of ["forty-three", "forty-four"]) {
      expect(indexableChunks.some(chunk => chunk.text.includes(secret))).toBe(false);
      expect(sealedChunks.some(chunk => chunk.text.includes(secret))).toBe(true);
    }
  });

  it.each([
    { title: ["Answer Key | Unit 1", "Practice | Problems"], visibility: "sealed" },
    { title: ["Unit 1", "Answer Key"], visibility: "sealed" },
    { title: ["Answer Key"], visibility: "sealed" },
    { title: ["Hints"], visibility: "hint_gated" },
  ])("separates a protected Setext title from a table ($title)", ({ title, visibility }) => {
    const bodies = ["Topic | Note", "--- | ---", ...title, "---", "forty-two"];
    const source = { sourceId: "captions", sourceVersion: 1 };
    const timing = (index: number) => ({ startMs: index * 1000, endMs: (index + 1) * 1000 });
    const timedLine = (body: string, index: number) => `[startMs=${timing(index).startMs},endMs=${timing(index).endMs}] ${body}`;
    const mixed = [bodies[0], bodies[1], timedLine(title[0]!, 0), ...title.slice(1), "---", timedLine("forty-two", 1)].join("\n");
    const inline = bodies.map(timedLine).join("\n");
    for (const { chunks, anchor } of [
      { chunks: chunkPedagogicalDocument({ ...source, text: mixed }), anchor: timing(1) },
      { chunks: chunkPedagogicalDocument({ ...source, text: inline }), anchor: timing(bodies.length - 1) },
      { chunks: chunkTranscriptCues({
        ...source, cues: bodies.map((text, index) => ({ text, ...timing(index) })),
      }), anchor: timing(bodies.length - 1) },
    ]) {
      expect(chunks.find(chunk => chunk.text.includes("forty-two"))).toMatchObject({ visibility, ...anchor });
      for (const allowHintGated of [false, true]) {
        const { indexableChunks } = partitionPedagogicalChunks(chunks, { allowHintGated });
        expect(indexableChunks.some(chunk => chunk.text.includes("forty-two")))
          .toBe(allowHintGated && visibility === "hint_gated");
      }
    }
  });

  it.each([
    { header: "Topic | Answer Key", preceding: ["[!note] | reference"], row: "x | forty-two" },
    { header: "Answer Key | Note", preceding: [], row: "- forty-two" },
    { header: "Answer Key | Note", preceding: [], row: "forty-two | note" },
  ])("preserves column privacy and cue anchors for literal table rows ($row)", ({ header, preceding, row }) => {
    const source = { sourceId: "captions", sourceVersion: 1 };
    const bodies = [header, "--- | ---", ...preceding, row];
    const cues = bodies.map((text, index) => ({ text, startMs: index * 1000, endMs: (index + 1) * 1000 }));
    const timed = cues.map(({ text, startMs, endMs }) => `[startMs=${startMs},endMs=${endMs}] ${text}`);
    const { startMs: rowStart, endMs: rowEnd } = cues.at(-1)!;
    for (const { chunks, startMs, endMs } of [
      { chunks: chunkPedagogicalDocument({
        ...source, text: [header, "--- | ---", ...timed.slice(2, -1),
          row.startsWith("- ") ? timed.at(-1)! : row].join("\n"),
      }),
        startMs: null, endMs: null },
      { chunks: chunkPedagogicalDocument({ ...source, text: timed.join("\n") }), startMs: rowStart, endMs: rowEnd },
      { chunks: chunkTranscriptCues({ ...source, cues }), startMs: rowStart, endMs: rowEnd },
    ]) {
      expect(chunks.find(chunk => chunk.text.includes("forty-two"))).toMatchObject({ visibility: "sealed", startMs, endMs });
      for (const allowHintGated of [false, true]) {
        const { indexableChunks } = partitionPedagogicalChunks(chunks, { allowHintGated });
        expect(indexableChunks.some(chunk => chunk.text.includes("forty-two"))).toBe(false);
      }
    }
  });

  it.each([
    ["\n", "sealed"],
    ["\n\n", "public"],
  ])("forms a table with a timed delimiter only when adjacent to the document header (%j)", (separator, visibility) => {
    const text = "Topic | Answer Key" + separator + "[00:00-00:01] --- | ---\n[00:01-00:02] x | forty-two";
    const chunks = chunkPedagogicalDocument({ sourceId: "doc", sourceVersion: 1, text });
    expect(chunks.find(chunk => chunk.text.includes("forty-two"))).toMatchObject({
      visibility, startMs: 1000, endMs: 2000,
    });
    for (const allowHintGated of [false, true]) {
      const { indexableChunks } = partitionPedagogicalChunks(chunks, { allowHintGated });
      expect(indexableChunks.some(chunk => chunk.text.includes("forty-two"))).toBe(visibility === "public");
    }
  });

  it("keeps cue anchors when only the header and body row carry timestamps", () => {
    const text = "[00:00-00:01] Topic | Answer Key\n--- | ---\n[00:01-00:02] x | forty-two";
    const chunks = chunkPedagogicalDocument({ sourceId: "doc", sourceVersion: 1, text });
    expect(chunks.find(chunk => chunk.text.includes("Topic"))).toMatchObject({ startMs: 0, endMs: 1000 });
    expect(chunks.find(chunk => chunk.text.includes("forty-two"))).toMatchObject({
      visibility: "sealed", startMs: 1000, endMs: 2000,
    });
  });

  it.each([
    {
      name: "heading following a delimiter in the same cue",
      bodies: ["Topic | Answer Key", "--- | ---\n## Lecture | forty-two"],
      inline: "Topic | Answer Key\n[00:00-00:01] --- | ---\n## Lecture | forty-two",
      cueStart: 1000,
      inlineStart: null,
    },
    {
      name: "short caption row before a hint heading",
      bodies: ["Topic | Answer Key", "--- | ---", "| forty-two", "Hints", "---"],
      inline: "[00:00-00:01] Topic | Answer Key\n[00:01-00:02] --- | ---\n[00:02-00:03] | forty-two\n[00:03-00:04] Hints\n[00:04-00:05] ---",
      cueStart: 2000,
      inlineStart: 2000,
    },
    {
      name: "untimed Setext title before a timed underline",
      bodies: ["Topic | Answer Key\n--- | ---\nHints | forty-two", "---"],
      inline: "Topic | Answer Key\n--- | ---\nHints | forty-two\n[00:00-00:01] ---",
      cueStart: 0,
      inlineStart: null,
    },
    {
      name: "public section after a protected heading in the same cue",
      bodies: ["Topic | Answer Key", "--- | ---", "## Lecture | forty-two\r\n\r\n## New topic\r\npublic example"],
      inline: "Topic | Answer Key\n--- | ---\n[00:00-00:01] ## Lecture | forty-two\n\n## New topic\npublic example",
      cueStart: 2000,
      inlineStart: 0,
      publicExample: true,
    },
  ])("scopes table protection to the source boundary ($name)", ({ bodies, inline, cueStart, inlineStart, publicExample }) => {
    const source = { sourceId: "captions", sourceVersion: 1 };
    const cues = bodies.map((text, index) => ({
      text, startMs: index * 1000, endMs: (index + 1) * 1000, keyframeChunkId: `k${index}`,
    }));
    for (const { chunks, text, startMs, keyframeChunkId } of [
      { chunks: chunkTranscriptCues({ ...source, cues }), text: bodies.join("\n"), startMs: cueStart,
        keyframeChunkId: `k${cueStart / 1000}` },
      { chunks: chunkPedagogicalDocument({ ...source, text: inline }), text: inline, startMs: inlineStart,
        keyframeChunkId: null },
    ]) {
      expect(chunks.find(chunk => chunk.text.includes("forty-two"))).toMatchObject({
        visibility: "sealed", startMs, endMs: startMs === null ? null : startMs + 1000, keyframeChunkId,
      });
      for (const allowHintGated of [false, true]) {
        const { indexableChunks } = partitionPedagogicalChunks(chunks, { allowHintGated });
        expect(indexableChunks.some(chunk => chunk.text.includes("forty-two"))).toBe(false);
        if (publicExample) {
          expect(indexableChunks.find(chunk => chunk.text.includes("public example"))?.visibility).toBe("public");
        }
      }
      for (const chunk of chunks) expect(text.slice(chunk.startOffset, chunk.endOffset)).toBe(chunk.text);
    }
  });

  it.each([
    { header: "Topic | Answer Key", block: "> [!hint] | forty-two\n> inside the callout" },
    { header: "Topic | Answer Key", block: "> ordinary quote | forty-two\n> quote continuation" },
    { header: "Topic | Answer Key", block: "~~~text | forty-two\ninside the fence\n~~~" },
    { header: "Topic | Answer Key", block: ":::example | forty-two\ninside the directive\n:::" },
    { header: "Answer Key | Note", block: "\\begin{hint}\nforty-two\n\\end{hint}" },
  ])("ends protected boundary blocks before the next paragraph ($block)", ({ header, block }) => {
    const source = { sourceId: "captions", sourceVersion: 1 };
    const body = block + "\n\npublic example";
    const inline = [header, "--- | ---", "[00:00-00:01] " + body].join("\n");
    const cues = [header, "--- | ---", body].map((text, index) => ({ text, startMs: index * 1000, endMs: (index + 1) * 1000 }));
    for (const chunks of [chunkPedagogicalDocument({ ...source, text: inline }), chunkTranscriptCues({ ...source, cues })]) {
      expect(chunks.find(chunk => chunk.text.includes("forty-two"))?.visibility).toBe("sealed");
      for (const allowHintGated of [false, true]) {
        const { indexableChunks } = partitionPedagogicalChunks(chunks, { allowHintGated });
        expect(indexableChunks.some(chunk => chunk.text.includes("forty-two"))).toBe(false);
        expect(indexableChunks.find(chunk => chunk.text.includes("public example"))?.visibility).toBe("public");
      }
    }
  });

  it("inherits the boundary floor within a quoted section until an equal-level heading", () => {
    const source = { sourceId: "captions", sourceVersion: 1 };
    const header = "> Topic | Answer Key";
    const caption = [
      "> --- | ---", "> ## Lecture | forty-two", "> ### Details", "> still private", ">",
      "> ## New topic", "> public example",
    ].join("\n");
    const inline = `[00:00-00:01] ${header}\n[00:01-00:02] ${caption}`;
    const cues = [header, caption].map((text, index) => ({
      text, startMs: index * 1000, endMs: (index + 1) * 1000,
    }));
    for (const chunks of [chunkPedagogicalDocument({ ...source, text: inline }), chunkTranscriptCues({ ...source, cues })]) {
      const { indexableChunks, sealedChunks } = partitionPedagogicalChunks(chunks, { allowHintGated: true });
      for (const secret of ["forty-two", "still private"]) {
        expect(sealedChunks.some(chunk => chunk.text.includes(secret))).toBe(true);
        expect(indexableChunks.some(chunk => chunk.text.includes(secret))).toBe(false);
      }
      expect(indexableChunks.find(chunk => chunk.text.includes("public example"))?.visibility).toBe("public");
    }
  });


  it.each([
    {
      name: "all lines of a Setext title",
      bodies: ["Topic | Answer Key", "--- | ---", "Unit 1", "Hints | forty-two", "---"],
      inline: "Topic | Answer Key\n--- | ---\nUnit 1\nHints | forty-two\n[00:00-00:01] ---",
      secrets: ["forty-two"],
    },
    {
      name: "table boundary inside an exercise",
      bodies: [":::exercise", "Topic | Answer Key", "--- | ---", "## Lecture | forty-two", ":::"],
      secrets: ["forty-two"],
    },
    {
      name: "short table row inside a details hint",
      bodies: ["<details>", "<summary>Hint</summary>", "Topic | Answer Key", "--- | ---", "| forty-two",
        "Hints", "---", "</details>"],
      secrets: ["forty-two"],
    },
    {
      name: "heading visibility across a quoted callout",
      bodies: ["> Topic | Answer Key", "> --- | ---", "> ## Lecture | first-value",
        "> [!example]", "> second-value", "> ## New topic", "> public-after"],
      plainDocument: true,
      secrets: ["first-value", "second-value"],
      publicText: "public-after",
    },
    {
      name: "heading inside a callout continuing into another callout",
      bodies: ["> [!example]", "> ## Answer Key", "> first-value",
        "> [!hint]", "> second-value", "> ## New topic", "> public-after"],
      plainDocument: true,
      secrets: ["first-value", "second-value"],
      hintText: "public-after",
    },
    {
      name: "heading formatted as a callout title",
      bodies: ["> [!example] ## Answer Key", "> first-value", "", "public-after"],
      plainDocument: true,
      secrets: ["first-value"],
      publicText: "public-after",
    },
    {
      name: "nested directive heading does not end its enclosing quote section",
      bodies: ["> ## Answer Key", "> [!example]", "> :::example", "> ## Nested heading",
        "> :::", "> second-value", "> ## New topic", "> public-after"],
      plainDocument: true,
      secrets: ["second-value"],
      publicText: "public-after",
    },
    {
      name: "proof inside an exercise hint directive",
      bodies: ["::::exercise", ":::hint", "\\begin{proof}forty-two\\end{proof}", ":::", "::::"],
      plainDocument: true,
      secrets: ["forty-two"],
    },
    {
      name: "proof inside a details hint nested in an exercise quote",
      bodies: ["::::exercise", "> [!hint]", "> <details>", "> <summary>Hint</summary>",
        "> \\begin{proof}forty-two\\end{proof}", "> </details>", "::::"],
      plainDocument: true,
      secrets: ["forty-two"],
    },
  ])("keeps sealed evidence out of retrieval ($name)", ({ bodies, inline, plainDocument, secrets, publicText, hintText }) => {
    const source = { sourceId: "captions", sourceVersion: 1 };
    const document = bodies.join("\n");
    const cues = bodies.map((text, index) => ({
      text, startMs: index * 1000, endMs: (index + 1) * 1000, keyframeChunkId: "k" + index,
    }));
    const timed = inline ?? bodies.map((body, index) => "[00:0" + index + "-00:0" + (index + 1) + "] " + body).join("\n");
    for (const { chunks, text } of [
      { chunks: chunkTranscriptCues({ ...source, cues }), text: document },
      { chunks: chunkTranscriptCues({ ...source, cues: [{ text: document, startMs: 0, endMs: 1000 }] }), text: document },
      { chunks: chunkPedagogicalDocument({ ...source, text: timed }), text: timed },
      ...(plainDocument ? [{ chunks: chunkPedagogicalDocument({ ...source, text: document }), text: document }] : []),
    ]) {
      expectSealedEvidence(chunks, text, secrets, publicText);
      if (hintText) {
        expect(chunks.find(chunk => chunk.text.includes(hintText))?.visibility).toBe("hint_gated");
        for (const allowHintGated of [false, true]) {
          const { indexableChunks } = partitionPedagogicalChunks(chunks, { allowHintGated });
          expect(indexableChunks.some(chunk => chunk.text.includes(hintText))).toBe(allowHintGated);
        }
      }
    }
  });

  it.each(["\n", "\r\n", "\r"])("preserves UTF-16 offsets and visibility with %j line endings", newline => {
    const source = { sourceId: "captions", sourceVersion: 1 };
    const bodies = ["## Answer Key", "🔒 forty-two", "## New topic", "📖 public-after"];
    const text = bodies.join(newline) + newline;
    const inline = bodies.map((body, index) => "[00:0" + index + "-00:0" + (index + 1) + "] " + body).join(newline);
    for (const candidate of [text, inline]) {
      const chunks = chunkPedagogicalDocument({ ...source, text: candidate });
      expectSealedEvidence(chunks, candidate, ["forty-two"], "public-after");
    }
    const chunks = chunkTranscriptCues({ ...source, cues: [{ text, startMs: 1000, endMs: 2000, keyframeChunkId: "key" }] });
    expectSealedEvidence(chunks, text, ["forty-two"], "public-after");
    expect(chunks.find(chunk => chunk.text.includes("forty-two"))).toMatchObject({
      startMs: 1000, endMs: 2000, keyframeChunkId: "key",
    });
  });

  it.each([
    ["explicit solution callout", "> ## Hints\n> [!solution]\n> ## Worked steps\n> forty-two"],
    ["explicit solution after an inherited callout", "> ## Answer Key\n> [!example]\n> sealed-before\n> [!solution]\n> ## Worked steps\n> forty-two"],
    ["explicit solution with a Setext title after an inherited callout", "> ## Answer Key\n> [!example]\n> [!solution]\n> Worked steps\n> ---\n> forty-two"],
    ["commented solution closer", "\\begin{solution}\n% \\end{solution}\nforty-two\n\\end{solution}"],
    ["commented solution opener", "\\begin{solution}\n% \\begin{solution}\nforty-two\n\\end{solution}"],
    ["commented proof closer", ":::exercise\n\\begin{proof}\n% \\end{proof}\nforty-two\n\\end{proof}\n:::"],
    ["commented proof opener", ":::exercise\n\\begin{proof}\n% \\begin{proof}\nforty-two\n\\end{proof}\n:::"],
    ["commented details closer", "<details>\n<summary>Answer</summary>\n<!-- </details> -->\nforty-two\n</details>"],
    ["commented details opener", "<details>\n<summary>Answer</summary>\n<!--\n<details>\n-->\nforty-two\n</details>"],
    ["commented summary closer", "<details>\n<summary>Hint <!-- </summary> --> Answer</summary>\nforty-two\n</details>"],
    ["fenced details closer", "<details>\n<summary>Answer</summary>\n~~~html\n</details>\n~~~\nforty-two\n</details>"],
    ["nested fenced details closer", "<details>\n<summary>Answer</summary>\n- \x60\x60\x60html\n  </details>\n  \x60\x60\x60\nforty-two\n</details>"],
    ["list-continuation fence in details", "<details>\n<summary>Answer</summary>\n123. Item\n     ~~~html\n     </details>\n     ~~~\nforty-two\n</details>"],
    ["inline comment opener in details", "<details>\n<summary>Answer</summary>\nExample: \x60<!--\x60\nforty-two\n</details>"],
    ["inline details closer", "<details>\n<summary>Answer</summary>\nExample: \x60</details>\x60\nforty-two\n</details>"],
    ["multiline inline details closer", "<details>\r\n<summary>Answer</summary>\r\nExample: \x60\x60start\r\n</details> end\x60\x60\r\nforty-two\r\n</details>"],
    ["inline summary closer", "<details>\n<summary>Hint \x60</summary>\x60 Answer</summary>\nforty-two\n</details>"],
  ])("preserves explicit protection across %s", (_name, body) => {
    const source = { sourceId: "captions", sourceVersion: 1 };
    const text = body + "\n\npublic-after";
    const chunks = chunkPedagogicalDocument({ ...source, text });
    const cueChunks = chunkTranscriptCues({ ...source, cues: [
      { text: body, startMs: 0, endMs: 1000, keyframeChunkId: "key" },
      { text: "\npublic-after", startMs: 1000, endMs: 2000 },
    ] });
    expectSealedEvidence(chunks, text, ["forty-two"], "public-after");
    expectSealedEvidence(cueChunks, text, ["forty-two"], "public-after");
    expect(cueChunks.find(chunk => chunk.text.includes("forty-two"))).toMatchObject({
      startMs: 0, endMs: 1000, keyframeChunkId: "key",
    });
  });

  it("resets inherited quote visibility at a Setext heading after a callout marker", () => {
    const source = { sourceId: "captions", sourceVersion: 1 };
    const text = "> ## Answer Key\n> [!example]\n> New topic\n> ---\n> public-after";
    const chunks = chunkPedagogicalDocument({ ...source, text });
    const cueChunks = chunkTranscriptCues({ ...source, cues: [{ text, startMs: 0, endMs: 1000 }] });
    for (const candidate of [chunks, cueChunks]) expectSealedEvidence(candidate, text, [], "public-after");
  });

  it("ignores stronger callout markers inside quoted HTML comments", () => {
    const source = { sourceId: "captions", sourceVersion: 1 };
    const text = "> ## Answer Key\n> [!example]\n> confidential\n> <!--\n> [!solution]\n> -->\n> ## Reset\n> public-after";
    const chunks = chunkPedagogicalDocument({ ...source, text });
    const cueChunks = chunkTranscriptCues({ ...source, cues: [{ text, startMs: 0, endMs: 1000 }] });
    for (const candidate of [chunks, cueChunks]) expectSealedEvidence(candidate, text, ["confidential"], "public-after");
  });

  it("keeps a hint after an inherited callout protected at its own level", () => {
    const source = { sourceId: "captions", sourceVersion: 1 };
    const text = "> ## Answer Key\n> [!example]\n> [!hint]\n> confidential\n>\n> Worked steps\n> ---\n> hint-only";
    const chunks = chunkPedagogicalDocument({ ...source, text });
    const cueChunks = chunkTranscriptCues({ ...source, cues: [{ text, startMs: 0, endMs: 1000 }] });
    for (const candidate of [chunks, cueChunks]) {
      expectSealedEvidence(candidate, text, ["confidential"]);
      expect(candidate.find(chunk => chunk.text.includes("hint-only"))?.visibility).toBe("hint_gated");
    }
  });

  it.each([["$$", "$$"], ["\\[", "\\]"], ["\\begin{equation}", "\\end{equation}"]])(
    "ignores commented display-math tokens inside %s",
    (open, close) => {
      const text = [open, "% " + close + " " + open, "x = 4", close, "public-after"].join("\r");
      const blocks = parsePedagogicalAst(text);
      expect(blocks.find(block => block.kind === "display_math")).toMatchObject({
        text: text.slice(0, text.lastIndexOf("\r")), visibility: "public",
      });
    },
  );

  it("preserves real LaTeX closing tokens after an escaped percent", () => {
    const text = "\\begin{solution}\rforty-two \\% \\end{solution}\r\rpublic-after";
    expectSealedEvidence(chunkPedagogicalDocument({ sourceId: "captions", sourceVersion: 1, text }),
      text, ["forty-two"], "public-after");
  });

  it.each(["\n", "\r\n", "\r"])("recognizes fence and math boundaries with %j line endings", newline => {
    const source = { sourceId: "captions", sourceVersion: 1 };
    const text = [
      "## Answer Key", "~~~text", "[00:00-00:01] ~~~", "## Decoy", "🔒 fenced-value", "~~~",
      "## Lecture", "$$", "## Answer Key", "🔒 math-value", "$$x = 2$$", "## New topic", "📖 public-after",
    ].join(newline);
    const cues = [{ text, startMs: 0, endMs: 1000 }];
    for (const chunks of [chunkPedagogicalDocument({ ...source, text }), chunkTranscriptCues({ ...source, cues })]) {
      expectSealedEvidence(chunks, text, ["fenced-value", "math-value"], "public-after");
    }
  });

  it.each(["\n", "\r\n", "\r"])("keeps a cue ending in %j separate from a Setext underline", newline => {
    const bodies = ["Answer Key" + newline, "---", "public-after"];
    const cues = bodies.map((text, index) => ({ text, startMs: index * 1000, endMs: (index + 1) * 1000 }));
    const chunks = chunkTranscriptCues({ sourceId: "captions", sourceVersion: 1, cues });
    expectSealedEvidence(chunks, bodies.join("\n"), [], "public-after");
  });

  it.each(["\n", "\r\n", "\r"])("prefers paragraph breaks when splitting long text with %j", newline => {
    const paragraph = "12345" + newline.repeat(2);
    const text = paragraph + "abcdefghijklmnopqrstuvwxyz";
    const parts = safeSubsplitText(text, 12);
    expect(parts[0]?.text).toBe(paragraph);
    expect(parts.map(part => part.text).join("")).toBe(text);
    for (const part of parts) expect(text.slice(part.start, part.end)).toBe(part.text);
  });

  it("keeps CRLF intact at a hard chunk limit", () => {
    const parts = safeSubsplitText("1234\r\nabcdef", 5);
    expect(parts[0]?.text).toBe("1234");
    expect(parts[1]?.text.startsWith("\r\n")).toBe(true);
  });

  it("keeps a protected title that begins inside a multiline cue or on an untimed line", () => {
    const source = { sourceId: "captions", sourceVersion: 1 };
    const mixed = ["Topic | Note", "--- | ---", "Answer Key | Unit 1",
      "[00:00-00:01] Practice | Problems", "---", "[00:01-00:02] forty-two"].join("\n");
    const cues = [
      { text: "Topic | Note\n--- | ---\nAnswer Key | Unit 1", startMs: 0, endMs: 500 },
      { text: "Practice | Problems\n---", startMs: 500, endMs: 1000 },
      { text: "forty-two", startMs: 1000, endMs: 2000 },
    ];
    for (const chunks of [
      chunkPedagogicalDocument({ ...source, text: mixed }),
      chunkTranscriptCues({ ...source, cues }),
    ]) {
      expect(chunks.find(chunk => chunk.text.includes("forty-two"))).toMatchObject({
        visibility: "sealed", startMs: 1000, endMs: 2000,
      });
      expect(partitionPedagogicalChunks(chunks, { allowHintGated: true }).indexableChunks.some(
        chunk => chunk.text.includes("forty-two"),
      )).toBe(false);
    }
  });

  it.each([
    { bodies: ["> Topic | Answer Key", "> --- | ---", "> ## Lecture | forty-two"], secretAt: 2 },
    { bodies: ["> Answer Key | Note", "> --- | ---", "> - forty-two"], secretAt: 2 },
    { bodies: ["Topic | Answer Key", "--- | ---", "x | forty-two", "Hints", "---", "guidance"], secretAt: 2 },
    { bodies: ["Topic | Answer Key", "--- | ---", "public note", "x | forty-two", "Hints", "---", "guidance"], secretAt: 3 },
  ])("retains sealed table columns at timed boundaries ($bodies)", ({ bodies, secretAt }) => {
    const source = { sourceId: "captions", sourceVersion: 1 };
    const cues = bodies.map((text, index) => ({ text, startMs: index * 1000, endMs: (index + 1) * 1000 }));
    const inline = cues.map(({ text, startMs, endMs }) => `[startMs=${startMs},endMs=${endMs}] ${text}`).join("\n");
    for (const chunks of [chunkPedagogicalDocument({ ...source, text: inline }), chunkTranscriptCues({ ...source, cues })]) {
      expect(chunks.find(chunk => chunk.text.includes("forty-two"))).toMatchObject({
        visibility: "sealed", startMs: cues[secretAt]!.startMs, endMs: cues[secretAt]!.endMs,
      });
      for (const allowHintGated of [false, true]) {
        const { indexableChunks } = partitionPedagogicalChunks(chunks, { allowHintGated });
        expect(indexableChunks.some(chunk => chunk.text.includes("forty-two"))).toBe(false);
        if (bodies.at(-1) === "guidance") {
          expect(chunks.find(chunk => chunk.text.includes("guidance"))?.visibility).toBe("hint_gated");
          expect(indexableChunks.some(chunk => chunk.text.includes("guidance"))).toBe(allowHintGated);
        }
      }
    }
  });

  it("applies the first column's protection to a pipe-less timed block that ends the table", () => {
    const text = ["Answer Key | Note", "--- | ---", "[00:00-00:01] ## forty-two", "",
      "[00:01-00:02] Public afterward"].join("\n");
    const blocks = parsePedagogicalAst(text);
    expect(blocks.find(block => block.text.includes("forty-two"))).toMatchObject({
      visibility: "sealed", startMs: 0, endMs: 1000,
    });
    expect(blocks.at(-1)).toMatchObject({ visibility: "sealed", startMs: 1000, endMs: 2000 });
  });

  it("recognizes a timed heading with a pipe outside a table before a delimiter-like line", () => {
    const text = "[00:00-00:01] ## Answer Key | notes\n--- | ---\n\n[00:01-00:02] forty-two";
    expect(parsePedagogicalAst(text).find(block => block.text.includes("forty-two"))).toMatchObject({
      visibility: "sealed", startMs: 1000, endMs: 2000,
    });
  });

  it("does not interpret protected markup quoted in a table code span as a container", () => {
    const text = [
      "Topic | Answer Key", "--- | ---", "```|x|``` | PRIVATE_CODE",
      "`<details><summary>Hint</summary>` | PRIVATE_MARKUP", "</details>",
    ].join("\n");
    const chunks = chunkPedagogicalDocument({ sourceId: "doc", sourceVersion: 1, text });
    const { indexableChunks, sealedChunks } = partitionPedagogicalChunks(chunks, { allowHintGated: true });
    expect(indexableChunks.some(chunk => /PRIVATE_MARKUP|PRIVATE_CODE/.test(chunk.text))).toBe(false);
    for (const secret of ["PRIVATE_MARKUP", "PRIVATE_CODE"]) {
      expect(sealedChunks.some(chunk => chunk.text.includes(secret))).toBe(true);
    }
  });

  it.each(["# Lecture", "---", "- List", "1. List", "~~~\n~~~", "> Blockquote",
    "<div>", ":::example\n:::"])("ends a table at a block boundary (%s)", boundary => {
    const text = ["Answer Key | Note", "--- | ---", "forty-two", boundary, "Public afterward"].join("\n");
    const blocks = parsePedagogicalAst(text);
    expect(blocks.find(block => block.text.includes("forty-two"))?.visibility).toBe("sealed");
    expect(blocks.find(block => block.text.includes("Public afterward"))?.visibility).toBe("public");
  });

  it("preserves per-cue anchors and column policy on pipe-less timed table rows", () => {
    const bodies = ["Answer Key | Note", "--- | ---", "forty-two", "forty-three | note",
      "## Lecture", "Public afterward"];
    const source = { sourceId: "captions", sourceVersion: 1 };
    const cues = bodies.map((text, index) => ({
      text, startMs: index * 1000, endMs: (index + 1) * 1000, keyframeChunkId: `k${index}`,
    }));
    const inline = bodies.map((body, index) => `[00:0${index}-00:0${index + 1}] ${body}`).join("\r\n");
    for (const { text, chunks, frames } of [
      { text: inline, chunks: chunkPedagogicalDocument({ ...source, text: inline }), frames: [null, null] },
      { text: bodies.join("\n"), chunks: chunkTranscriptCues({ ...source, cues }), frames: ["k2", "k3"] },
    ]) {
      for (const [index, secret] of ["forty-two", "forty-three"].entries()) {
        const chunk = chunks.find(candidate => candidate.text.includes(secret));
        expect(chunk).toMatchObject({
          visibility: "sealed", startMs: (index + 2) * 1000, endMs: (index + 3) * 1000,
          keyframeChunkId: frames[index],
        });
      }
      expect(chunks.find(chunk => chunk.text.includes("Public afterward"))).toMatchObject({
        visibility: "sealed", startMs: 5000, endMs: 6000,
      });
      for (const chunk of chunks) expect(text.slice(chunk.startOffset, chunk.endOffset)).toBe(chunk.text);
    }
  });

  it.each([
    ["> ", "> "],
    ["- ", "  "],
    ["- > ", "  > "],
  ])("protects pipe-less table rows within a container (%j)", (open, continuation) => {
    const bodies = [`${open}Answer Key | Note`, `${continuation}--- | ---`, `${continuation}forty-two`,
      `${continuation}forty-three | note`, "Public afterward"];
    const source = { sourceId: "captions", sourceVersion: 1 };
    const cues = bodies.map((text, index) => ({
      text, startMs: index * 1000, endMs: (index + 1) * 1000, keyframeChunkId: `k${index}`,
    }));
    const inline = bodies.map((body, index) => `[00:0${index}-00:0${index + 1}] ${body}`).join("\n");
    for (const chunks of [
      chunkPedagogicalDocument({ ...source, text: inline }),
      chunkTranscriptCues({ ...source, cues }),
      chunkPedagogicalDocument({ ...source, text: [...bodies.slice(0, 4), "", bodies[4]].join("\n") }),
    ]) {
      const { indexableChunks, sealedChunks } = partitionPedagogicalChunks(chunks, { allowHintGated: true });
      expect(sealedChunks.some(chunk => chunk.text.includes("forty-two"))).toBe(true);
      expect(sealedChunks.some(chunk => chunk.text.includes("forty-three"))).toBe(true);
      expect(indexableChunks.some(chunk => /forty-two|forty-three/.test(chunk.text))).toBe(false);
      expect(indexableChunks.some(chunk => chunk.text.includes("Public afterward"))).toBe(true);
    }
  });

  it("shares heading state between timed and untimed lines and maps raw page spans", () => {
    const text = [
      "## Answer Key", "[startMs=100,endMs=200] Timed secret",
      "[startMs=200,endMs=300] ## Lecture", "Public afterward",
    ].join("\n");
    const pageSpans = [
      { page: 1, startOffset: 0, endOffset: text.indexOf("[startMs=200") },
      { page: 2, startOffset: text.indexOf("[startMs=200"), endOffset: text.length },
    ];
    const blocks = parsePedagogicalAst(text, { pageSpans });
    expect(blocks.find(block => block.text.includes("Timed secret"))).toMatchObject({
      visibility: "sealed", startMs: 100, endMs: 200, pageStart: 1, pageEnd: 1,
    });
    expect(blocks.at(-1)).toMatchObject({ visibility: "public", startMs: null, pageStart: 2, pageEnd: 2 });
  });

  it.each(["## Lecture", "---", "```text\ncode\n```", "~~~text\ncode\n~~~", ":::example\nexample\n:::"])(
    "ends a lazy callout at the block boundary %s", boundary => {
      const text = `> [!solution]\n> The result is\nThe answer is forty-two.\n${boundary}\nPublic afterward`;
      const blocks = parsePedagogicalAst(text);
      expect(blocks.find(block => block.text.includes("forty-two."))?.visibility).toBe("sealed");
      expect(blocks.at(-1)).toMatchObject({ visibility: "public", text: "Public afterward" });
    },
  );

  it.each([
    ["$$", "+ b", "$$"], ["$$", "- b", "$$"], ["$$", "* b", "$$"], ["\\[", "- b", "\\]"],
  ])("keeps arithmetic operators inside balanced display math (%j)", (open, operator, close) => {
    const math = [open, "a", operator, close].join("\n");
    expect(parsePedagogicalAst(`${math}\nPublic afterward`)).toMatchObject([
      { kind: "display_math", visibility: "public", text: math },
      { kind: "prose", visibility: "public", text: "Public afterward" },
    ]);
  });

  it("tracks multi-line Setext titles, heading levels and thematic breaks", () => {
    const text = [
      "Intro", "", "---", "", "From the instructor", "Answer Key", "===", "english-secret",
      "", "Why this works", "---", "nested-secret", "", "Next unit", "===", "public again",
      "", "参考答案", "---", "chinese-secret", "### Notes", "still-secret", "## Lecture", "public end",
    ].join("\n");
    const blocks = parsePedagogicalAst(text);
    expect(blocks.filter(block => block.kind === "heading").map(({ label, visibility }) => [label, visibility]))
      .toEqual([
        ["From the instructor\nAnswer Key", "sealed"], ["Why this works", "sealed"],
        ["Next unit", "public"], ["参考答案", "sealed"], ["Notes", "sealed"], ["Lecture", "public"],
      ]);
    const chunks = chunkPedagogicalDocument({ sourceId: "markdown", sourceVersion: 1, text });
    const publicText = partitionPedagogicalChunks(chunks).indexableChunks.map(chunk => chunk.text).join("\n");
    expect(publicText).not.toContain("-secret");
    expect(publicText).toContain("public again");
    expect(publicText).toContain("public end");
  });

  it.each(["$$", "\\[", "\\begin{align}", "prefix $$", "prefix \\[", "prefix \\begin{align}", "```text", "~~~text"])(
    "quarantines a malformed %s construct before private headings and containers",
    open => {
      const text = [
        "Public intro", "", open, "unfinished", "# Answer Key", "heading-secret",
        ":::hint", "private-clue", ":::", "<details>details-secret</details>",
      ].join("\n");
      const chunks = chunkPedagogicalDocument({ sourceId: "malformed", sourceVersion: 1, text });
      const partition = partitionPedagogicalChunks(chunks);
      const publicText = partition.indexableChunks.map(chunk => chunk.text).join("\n");
      expect(publicText).toContain("Public intro");
      expect(publicText).not.toMatch(/unfinished|secret|private-clue/);
      expect(partition.sealedChunks.map(chunk => chunk.text).join("\n")).toContain("heading-secret");
    },
  );

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

  it("seals unclosed <details>/\\begin{solution} inside containers and sealed headings and recurses into nested constructs inside timestamped transcript cues", () => {
    // 1. Sealed Answer Key heading with unclosed inline \begin{solution} must NOT reset at next same-level heading!
    const sealedHeadingDoc = [
      "## Answer Key \\begin{solution} SECRET_HDR_LINE_1",
      "SECRET_HDR_LINE_2",
      "## Next Public Section",
      "SECRET_HDR_LINE_3_STILL_OPEN",
    ].join("\n");
    const sealedHeadingChunks = chunkPedagogicalDocument({
      sourceId: "src-sealed-heading-unclosed",
      sourceVersion: 1,
      text: sealedHeadingDoc,
    });
    for (const c of sealedHeadingChunks) {
      expect(sealedHeadingDoc.slice(c.startOffset, c.endOffset)).toBe(c.text);
    }
    const sealedHeadingPart = partitionPedagogicalChunks(sealedHeadingChunks);
    expect(sealedHeadingPart.publicChunks).toHaveLength(0);
    expect(sealedHeadingPart.indexableChunks).toHaveLength(0);
    expect(sealedHeadingPart.sealedChunks.some(c => c.text.includes("SECRET_HDR_LINE_3_STILL_OPEN"))).toBe(true);

    // 2. Unclosed <details> inside :::exercise (block & inline) and unclosed \begin{solution} wrapping a closed \begin{hint}.
    const containerUnclosedDoc = [
      ":::exercise Problem 1",
      "Prompt A.",
      "<details><summary>Solution</summary>",
      "SECRET_DET_IN_EX",
      ":::",
      "",
      ":::exercise Problem 2",
      "Prompt B. <details><summary>Answer Key</summary> SECRET_INLINE_DET_IN_EX",
      "Still inside unclosed details.",
      ":::",
      "",
      "Prompt C. \\begin{solution} SECRET_BEFORE_HINT \\begin{hint} NESTED_HINT_MUST_STAY_SEALED \\end{hint} SECRET_AFTER_HINT",
    ].join("\n");
    const containerChunks = chunkPedagogicalDocument({
      sourceId: "src-container-unclosed",
      sourceVersion: 1,
      text: containerUnclosedDoc,
    });
    for (const c of containerChunks) {
      expect(containerUnclosedDoc.slice(c.startOffset, c.endOffset)).toBe(c.text);
    }
    const containerPart = partitionPedagogicalChunks(containerChunks);
    const containerWithHints = partitionPedagogicalChunks(containerChunks, { allowHintGated: true });
    for (const secret of [
      "SECRET_DET_IN_EX",
      "SECRET_INLINE_DET_IN_EX",
      "Still inside unclosed details.",
      "SECRET_BEFORE_HINT",
      "NESTED_HINT_MUST_STAY_SEALED",
      "SECRET_AFTER_HINT",
    ]) {
      expect(containerPart.publicChunks.some(c => c.text.includes(secret))).toBe(false);
      expect(containerWithHints.indexableChunks.some(c => c.text.includes(secret))).toBe(false);
      expect(containerPart.sealedChunks.some(c => c.text.includes(secret))).toBe(true);
    }

    // 3. Timestamped transcript cues MUST recurse into public (\begin{exercise}) and hint_gated (\begin{hint}, <details>) spans!
    const cueDoc = [
      "[01:05 - 01:30] \\begin{exercise} Compute $2+2$. \\begin{solution} SECRET_CUE_EX \\end{solution} \\end{exercise}",
      "[01:30 - 02:00] \\begin{hint} HINT_CUE_1 \\begin{solution} SECRET_CUE_IN_HINT \\end{solution} \\end{hint}",
      "[02:00 - 02:30] <details><summary>Hint</summary> HINT_CUE_DET \\begin{solution} SECRET_CUE_IN_DET_HINT \\end{solution}</details>",
    ].join("\n");
    const cueChunks = chunkPedagogicalDocument({
      sourceId: "src-cue-nested",
      sourceVersion: 1,
      privacyEpoch: 16,
      text: cueDoc,
    });
    for (let idx = 0; idx < cueChunks.length; idx++) {
      const c = cueChunks[idx]!;
      expect(cueDoc.slice(c.startOffset, c.endOffset)).toBe(c.text);
      if (idx > 0) expect(c.startOffset).toBeGreaterThanOrEqual(cueChunks[idx - 1]!.endOffset);
      expect(c.startMs).not.toBeNull();
      expect(c.endMs).not.toBeNull();
    }
    const cuePart = partitionPedagogicalChunks(cueChunks);
    const cueWithHints = partitionPedagogicalChunks(cueChunks, { allowHintGated: true });

    for (const secret of ["SECRET_CUE_EX", "SECRET_CUE_IN_HINT", "SECRET_CUE_IN_DET_HINT"]) {
      expect(cuePart.publicChunks.some(c => c.text.includes(secret))).toBe(false);
      expect(cuePart.indexableChunks.some(c => c.text.includes(secret))).toBe(false);
      expect(cueWithHints.indexableChunks.some(c => c.text.includes(secret))).toBe(false);
      expect(cuePart.sealedChunks.some(c => c.text.includes(secret) && c.kind === "solution")).toBe(true);
    }
    for (const hint of ["HINT_CUE_1", "HINT_CUE_DET"]) {
      expect(cuePart.publicChunks.some(c => c.text.includes(hint))).toBe(false);
      expect(cuePart.hintGatedChunks.some(c => c.text.includes(hint) && c.kind === "hint")).toBe(true);
      expect(cueWithHints.indexableChunks.some(c => c.text.includes(hint))).toBe(true);
    }
    const pubCue = cuePart.publicChunks.find(c => c.text.includes("Compute $2+2$."));
    expect(pubCue).toBeDefined();
    expect(pubCue!.startMs).toBe(65_000);
    expect(pubCue!.endMs).toBe(90_000);
  });
});

describe("sparsePpr exactness, dangling-node mass conservation, and validation", () => {
  it("conserves seed mass with finite weights whose sum would overflow", () => {
    const scores = sparsePpr([[], []], Float64Array.of(1e308, 1e308));
    expect(scores[0]).toBeCloseTo(0.5);
    expect(scores[1]).toBeCloseTo(0.5);
  });

  it("normalizes large outgoing weights before combining parallel edges", () => {
    const distinct = normalizeSparseAdjacency(2, [{ from: 0, to: 0, weight: 1e308 }, { from: 0, to: 1, weight: 1e308 }]);
    expect(distinct[0]).toEqual([[0, 0.5], [1, 0.5]]);
    const parallel = normalizeSparseAdjacency(2, [
      { from: 0, to: 1, weight: 1e308 }, { from: 0, to: 1, weight: 1e308 }, { from: 0, to: 0, weight: 1e308 },
    ]);
    expect(parallel[0]).toEqual([[0, 1 / 3], [1, 2 / 3]]);
    expect(parallel[1]).toEqual([]);
  });
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

  it.each([
    { visibility: "sealed" }, { visibility: "hint_gated" }, { sourceId: "revoked" },
    { sourceVersion: 99 }, { privacyEpoch: 8 }, { itemFamilyId: "withheld" }, null,
  ] satisfies (Partial<PedagogicalChunk> | null)[])(
    "gives a mixed-provenance edge zero PPR and ordering effect when support is inadmissible (%j)",
    rejected => {
      const prerequisite = makeChunk({ id: "pre", kind: "prose" });
      const dependent = makeChunk({ id: "dep", kind: "definition" });
      const support = makeChunk({ id: "good" });
      const chunks = [dependent, prerequisite, support, ...(rejected ? [makeChunk({ id: "bad", ...rejected })] : [])];
      const input = {
        chunks, seedScores: { dep: 1, pre: 0.5 },
        authorization: {
          admissibleSourceIds: ["src-notes"], admissibleSourceVersions: { "src-notes": prerequisite.sourceVersion },
          expectedPrivacyEpoch: 7, excludedItemFamilyIds: ["withheld"],
        },
      };
      const edge = { from: "pre", to: "dep", kind: "prerequisite", privacyEpoch: 7, weight: 4 } as const;
      const baseline = rankPedagogicalEvidence(input);
      const mixed = rankPedagogicalEvidence({ ...input, edges: [{ ...edge, supportingChunkIds: ["good", "bad"] }] });
      expect(mixed.diagnostics).toMatchObject({ survivingEdges: 0, filteredEdges: 1 });
      expect(mixed.pprByNodeId).toEqual(baseline.pprByNodeId);
      expect(mixed.ranked).toEqual(baseline.ranked);
      for (const provenance of [{ supportingChunkIds: ["good"] }, { supportingSourceIds: ["src-notes"] }]) {
        const allowed = rankPedagogicalEvidence({ ...input, edges: [{ ...edge, ...provenance }] });
        expect(allowed.diagnostics.survivingEdges).toBe(1);
        expect(allowed.ranked.map(result => result.chunk.id)).toEqual(["pre", "dep"]);
        expect(allowed.pprByNodeId).not.toEqual(baseline.pprByNodeId);
      }
    },
  );

  it.each([false, true])("keeps ordering work linear for 512 chunks and one result (ordering=%s)", orderFoundationsFirst => {
    const chunks = Array.from({ length: 512 }, (_, i) => makeChunk({ id: `chunk-${i}` }));
    const edges: PedagogicalGraphEdge[] = chunks.slice(1).map((chunk, i) => ({
      from: chunks[i]!.id, to: chunk.id, kind: "prerequisite", privacyEpoch: 7,
    }));
    const add = Set.prototype.add;
    let additions = 0;
    const counted = vi.spyOn(Set.prototype, "add").mockImplementation(function (this: Set<unknown>, value) {
      additions++;
      return add.call(this, value);
    });
    let ranked;
    try {
      ranked = rankPedagogicalEvidence({
        chunks, edges, seedScores: { "chunk-511": 1 },
        authorization: { admissibleSourceIds: ["src-notes"], expectedPrivacyEpoch: 7 },
        options: { maxResults: 1, orderFoundationsFirst },
      }).ranked;
    } finally {
      counted.mockRestore();
    }
    expect(ranked.map(result => result.chunk.id)).toEqual(["chunk-511"]);
    expect(additions).toBeLessThan(chunks.length * 20);
  });

  it("orders selected endpoints across an unselected prerequisite", () => {
    const chunks = [makeChunk({ id: "first" }), makeChunk({ id: "middle" }), makeChunk({ id: "last" })];
    const edges: PedagogicalGraphEdge[] = [
      { from: "first", to: "middle", kind: "prerequisite", privacyEpoch: 7 },
      { from: "middle", to: "last", kind: "prerequisite", privacyEpoch: 7 },
    ];
    const result = rankPedagogicalEvidence({
      chunks, edges, seedScores: { last: 1, first: 0.5 },
      authorization: { admissibleSourceIds: ["src-notes"], expectedPrivacyEpoch: 7 },
      options: { maxResults: 2, seedWeight: 1, pprWeight: 0, prerequisiteWeight: 0 },
    });
    expect(result.ranked.map(item => item.chunk.id)).toEqual(["first", "last"]);
  });

  it("preserves the acyclic constraints into and out of explicit prerequisite cycles", () => {
    const chunks = [
      makeChunk({ id: "first", kind: "prose" }), makeChunk({ id: "a", kind: "prose" }),
      makeChunk({ id: "b", kind: "prose" }), makeChunk({ id: "last", kind: "definition" }),
    ];
    const edges: PedagogicalGraphEdge[] = [
      { from: "first", to: "a", kind: "prerequisite", privacyEpoch: 7 },
      { from: "a", to: "b", kind: "prerequisite", privacyEpoch: 7 },
      { from: "b", to: "a", kind: "prerequisite", privacyEpoch: 7 },
      { from: "b", to: "last", kind: "prerequisite", privacyEpoch: 7 },
    ];
    const input = {
      chunks, seedScores: { last: 1, b: 0.9, a: 0.8, first: 0.5 },
      authorization: { admissibleSourceIds: ["src-notes"], expectedPrivacyEpoch: 7 },
      options: { seedWeight: 1, pprWeight: 0, prerequisiteWeight: 0 },
    };
    const first = rankPedagogicalEvidence({ ...input, edges }).ranked.map(result => result.chunk.id);
    const reversed = rankPedagogicalEvidence({ ...input, edges: [...edges].reverse() }).ranked.map(result => result.chunk.id);
    expect(first).toEqual(reversed);
    expect(first[0]).toBe("first");
    expect(first.at(-1)).toBe("last");
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
