import type { Sql, TransactionSql } from "postgres";
import { describe, expect, it, vi } from "vitest";
import { containsPdfAnswerLabel, filterPublicSamePagePdfChunks, isPublicSourceChunk, preserveOpeningKnowledgeDefinitions, readCitedChunk, type ArchivePdfCursorState, type ArchivedSealSpan } from "./opening-knowledge-definitions";
import { chunksHaveReadableContent, createOpeningSourceChunksRepository, type NewSourceChunk } from "./opening-source-chunks";

const base = { page: 1, slideLabel: null, startMs: null, endMs: null };

function mockQueryText(strings: TemplateStringsArray, values: unknown[]): string {
  return strings.reduce((query, part, index) => {
    const value = values[index];
    const fragment = value && typeof value === "object" && "sqlFragment" in value && typeof value.sqlFragment === "string"
      ? value.sqlFragment : "?";
    return query + part + (index < values.length ? fragment : "");
  }, "").replace(/\s+/gu, " ").trim();
}

describe("empty PDF chunk publication", () => {
  const sourceId = "source";
  const scope = {
    workspaceId: "workspace", ownerUserId: "owner", jobExecution: { id: "parse", token: "claim", privacyEpoch: 0 },
  };

  function setup() {
    const statements: Array<{ query: string; values: unknown[] }> = [];
    const tx = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?").replace(/\s+/gu, " ").trim();
      statements.push({ query, values });
      if (query.startsWith("SELECT id FROM workspaces") || query.startsWith("SELECT id FROM opening_jobs")) return [{ id: "owner" }];
      if (query.startsWith("SELECT id,version,upload_state FROM opening_sources")) return [{ id: sourceId, version: 4, upload_state: "uploaded" }];
      if (query.startsWith("SELECT c.id, staged.matched_id")) return [{ id: "old-answer", removed: true }];
      if (query.startsWith("SELECT w.privacy_epoch")) return [{ privacy_epoch: 0 }];
      return [];
    }, { json: (value: unknown) => value });
    const begin = vi.fn(async (publish: (sql: typeof tx) => Promise<void>) => publish(tx));
    async function* emptyStage(): AsyncGenerator<NewSourceChunk> { /* empty staged stream */ }
    return {
      repo: createOpeningSourceChunksRepository({ begin } as unknown as Sql),
      input: { sourceId, sourceVersion: 4, chunks: emptyStage(), preservePages: [] },
      begin,
      statements,
    };
  }

  it("withdraws the old same-version chunks and queues indexing in the same transaction", async () => {
    const { repo, input, begin, statements } = setup();
    const reopened = { page: 1, text: "", imagePath: null, hadSealedContent: false, reopenedSection: true };
    await repo.replacePdfChunks(scope, { ...input, allowSealedEmpty: true, publicationSeals: [reopened] });
    expect(begin).toHaveBeenCalledTimes(1);

    const position = (prefix: string) => {
      const index = statements.findIndex(({ query }) => query.startsWith(prefix));
      expect(index).toBeGreaterThanOrEqual(0);
      return index;
    };
    const history = position("SELECT revision FROM opening_workspace_history_revisions");
    const execution = position("SELECT id FROM opening_jobs");
    const workspace = position("SELECT id FROM workspaces WHERE id=? AND owner_user_id=? FOR SHARE");
    const source = position("SELECT id,version,upload_state FROM opening_sources");
    const backfill = position("UPDATE opening_course_knowledge graph");
    const deletion = position("DELETE FROM opening_source_chunks c");
    const seals = position("DELETE FROM opening_pdf_parse_segments");
    expect(statements[seals]?.values).toEqual([scope.workspaceId, sourceId, 4, "pdf-publication-page-seal-v1", [1]]);
    const ready = position("UPDATE opening_sources SET parse_state='ready'");
    const index = position("INSERT INTO opening_jobs");
    const steps = [history, execution, workspace, source, backfill, deletion, seals, ready, index];
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    expect(statements[deletion]?.values).toEqual([sourceId, 4]);
    expect(statements.some(({ query }) => query.includes("node_definitions"))).toBe(false);
  });

  it("removes unsafe archived PDF evidence before the legacy definition backfill", async () => {
    const { repo, input, statements } = setup();
    async function* mixedStage() {
      yield { ...base, text: "Public replacement", imageObjectKey: null };
    }
    await repo.replacePdfChunks(scope, { ...input, chunks: mixedStage(), unsafeLegacyPages: [1] });

    const evidenceRemoval = statements.findIndex(({ query }) =>
      query.startsWith("DELETE FROM opening_source_chunks c") && query.includes("pdf-publication-page-seal-v1"));
    const evidenceRead = statements.findIndex(({ query }) => query.startsWith("SELECT graph.course_id, missing.node_indexes"));
    const finalDeletion = statements.findLastIndex(({ query }) => query.startsWith("DELETE FROM opening_source_chunks c"));
    expect(evidenceRemoval).toBeGreaterThanOrEqual(0);
    expect(evidenceRead).toBeGreaterThan(evidenceRemoval);
    expect(finalDeletion).toBeGreaterThan(evidenceRead);
    expect(statements[evidenceRemoval]?.values).toEqual([sourceId, 4, [1], scope.workspaceId]);
    expect(statements[evidenceRemoval]?.query).toContain("staged.matched_id=c.id");
  });

  it("rejects an ordinarily empty PDF before deleting old chunks", async () => {
    const { repo, input, statements } = setup();
    await expect(repo.replacePdfChunks(scope, input)).rejects.toThrow("source has no readable text");
    expect(statements.some(({ query }) => query.startsWith("DELETE FROM opening_source_chunks"))).toBe(false);
  });
});

describe("cross-source legacy definition backfill", () => {
  it.each([
    { reason: "same-page seal", marker: "hadSealedContent", available: false, text: "x = 3." },
    { reason: "unresolved earlier section", marker: "sectionSealedAtEnd", available: false, text: "5 units." },
    { reason: "unresolved earlier inline answer", marker: "inlineSealedAtEnd", available: false, text: "5 units." },
    { reason: "unknown earlier scan", marker: "publicationSealUnknown", available: false, text: "5 units." },
    { reason: "unstripped answer", available: true, text: "Answer Key\nx = 3." },
    { reason: "numbered answer", available: true, text: "**Answer 1:** x = 3." },
    { reason: "numbered decimal solution outside an example", available: true, text: "Solution 2.1: x = 3.", archiveSealed: true },
    { reason: "numbered answer key", available: true, text: "Answer Key 3: x = 3." },
    { reason: "numbered qualified heading", available: true, text: "Official Answer 1\nx = 3." },
    { reason: "numbered Chinese exercise answer", available: true, text: "课后习题答案 1：x = 3。" },
    { reason: "numbered Chinese chapter answer", available: true, text: "章节答案 1、x = 3。" },
    { reason: "worked example continuation", available: true, text: "Solution:\nTake the square root.", preservesDefinition: true },
    { reason: "numbered worked example continuation", available: true, text: "Solution 2.1: Take the square root.", preservesDefinition: true },
    { reason: "answers to review questions", available: true, text: "# Answers to Review Questions\nx = 3." },
    { reason: "solutions to practice problems", available: true, text: "Solutions to Practice Problems (continued)\nx = 3." },
    { reason: "selected exercise answers", available: true, text: "Answers to Selected Odd-Numbered Exercises\nx = 3." },
    { reason: "numbered exercise range", available: true, text: "Answers to Exercises 1–5\nx = 3." },
    { reason: "numbered decimal problem range", available: true, text: "Solutions to Problems 1.1—1.8\nx = 3." },
    { reason: "wide spaces in assessment heading", available: true, text: "Answers\u00a0to\u202fReview\u3000Questions\nx = 3." },
    { reason: "sentence-case assessment range", available: true, text: "Solutions to problems 1–10 (cOnT.)\n5 units." },
    { reason: "sentence-case container assessment", available: true, text: "Chapter 3: answers to exercises\n5 units." },
    { reason: "sentence-case key", available: true, text: "Key to the exercises\n5 units." },
    { reason: "ordinary assessment prose", available: true, text: "Answers to exercises are omitted in this edition.", preservesDefinition: true },
    { reason: "ordinary common questions prose", available: true, text: "Answers to common questions are discussed in Chapter 2.", preservesDefinition: true },
    { reason: "Chinese review assessment heading", available: true, text: "复习题答案\nx = 3." },
    { reason: "ordinary solutions prose", available: true, text: "Solutions to problems of this type need more constraints.", preservesDefinition: true },
    { reason: "ordinary linear algebra prose", available: true, text: "Solutions to linear systems form a subspace.", preservesDefinition: true },
    { reason: "ordinary questions prose", available: true, text: "Answers to these scientific questions are uncertain.", preservesDefinition: true },
    { reason: "completed public publication", available: true, text: "Public introduction.", preservesDefinition: true },
    { reason: "Markdown answer label", available: true, text: "Answer: an HTTP response to a request.", mime: "text/markdown", preservesDefinition: true },
  ])("handles $reason on a second cited source", async ({ marker, available, text, preservesDefinition, archiveSealed, mime = "application/pdf" }) => {
    const courseId = "00000000-0000-4000-8000-000000000001";
    const nodeId = "00000000-0000-4000-8000-000000000002";
    const [chunkB, chunkA] = ["00000000-0000-4000-8000-000000000003", "00000000-0000-4000-8000-000000000004"];
    const snapshot = { courseId, version: 1, nodes: [{ id: nodeId, courseId, label: "Concept", kind: "concept",
      evidenceChunkIds: [chunkB, chunkA], status: "supported" }], edges: [] };
    const writes: string[] = [];
    const evidence: unknown[] = [];
    const citedIds: unknown[] = [];
    const tx = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = mockQueryText(strings, values);
      if (query.startsWith("c.source_id=? AND c.source_version=?")) {
        return { sqlFragment: `c.source_id=${values[0]} AND c.source_version=?` };
      }
      if (query.startsWith("pdf_archive_text AS") || strings[0]?.trimStart().startsWith("WITH pdf_read_sources")
        || !query.startsWith("WITH") && query.includes("seal.pages->0")
        || query.startsWith("s.id=") || query.startsWith("s.parse_state") || query.startsWith("ps.parse_state") || query.startsWith("seal.source_version<")) {
        return { sqlFragment: query };
      }
      if (query.startsWith("SELECT id FROM workspaces")) return [{ id: "workspace" }];
      if (query.startsWith("SELECT graph.course_id, missing.node_indexes")) {
        expect(values).toContain("source-B");
        return [{ course_id: courseId, node_indexes: [0] }];
      }
      if (query.startsWith("SELECT snapshot")) return [{ snapshot }];
      if (query.includes('SELECT c.id,c.source_id AS "sourceId"')) {
        const id = values.findLast(value => typeof value === "string");
        citedIds.push(id);
        if (id === chunkA && mime === "text/markdown") {
          expect(query).toContain("s.mime AS mime");
          expect(query).toContain("s.mime<>'application/pdf' OR c.page IS NULL OR");
        }
        if (id === chunkA && marker) {
          expect(query).toContain("seal.workspace_id=s.workspace_id AND seal.source_id=c.source_id AND seal.source_version=c.source_version");
          expect(query).toContain("seal.parser_profile='pdf-publication-page-seal-v1' AND seal.state='ready'");
          expect(query).toContain("boundary.first_page<=c.page");
          expect(query).toContain("seal.page_start=c.page AND seal.page_end=c.page");
          expect(query).toContain("WHEN 'true' THEN FALSE WHEN 'false' THEN TRUE");
          expect(query).toContain("c.image_object_key IS NOT NULL");
          const predecessor = query.split('SELECT c.id,c.source_id AS "sourceId"')[0];
          expect(marker === "hadSealedContent" ? query : predecessor).toContain("seal.pages->0->>'" + marker + "'='true'");
        }
        if (id === chunkA && !available) return [];
        return [{ ...base, id, sourceId: id === chunkA ? "source-A" : "source-B", sourceVersion: 4,
          mime: id === chunkA ? mime : "application/pdf",
          text: id === chunkA ? text : "Study notes.", imageObjectKey: null }];
      }
      if (archiveSealed && query.includes("c.source_id=source-A ")
        && query.endsWith("SELECT first_page,reopen_page,chunk_id FROM pdf_archive_sealed_spans")) {
        return [{ first_page: base.page, reopen_page: base.page + 1, chunk_id: chunkA }];
      }
      if (query.startsWith("INSERT INTO pg_temp.opening_legacy_knowledge_evidence")) evidence.push(values[0]);
      if (query.startsWith("UPDATE opening_course_knowledge")) writes.push(query);
      return [];
    };
    await preserveOpeningKnowledgeDefinitions(tx as unknown as TransactionSql,
      { workspaceId: "workspace", ownerUserId: "owner" }, "source-B", 4);
    expect(citedIds).toEqual([chunkB, chunkA]);
    expect(writes).toHaveLength(preservesDefinition ? 1 : 0);
    if (preservesDefinition) expect(evidence).toContainEqual(expect.stringContaining(JSON.stringify(text).slice(1, -1)));
  });
});

it("withdraws unresolved PDF continuations and numbered labels from public reads while keeping recovery rows", async () => {
  const scope = { workspaceId: "workspace", ownerUserId: "owner" };
  function row(id: string, source_id: string, text: string, mime = "application/pdf", image_object_key: string | null = null) {
    return { id, source_id, source_version: 4, page: 2, slide_label: null, start_ms: null, end_ms: null, text, mime, image_object_key };
  }
  const stale = row("stale", "pdf", "5 units.", "application/pdf", "stale-image");
  const numbered = row("numbered", "pdf", "Answer 1: x = 3.");
  const clean = row("clean", "pdf", "Public geometry notes.");
  const markdown = row("markdown", "markdown", numbered.text, "text/markdown");
  const queries: string[] = [];
  const sql = (strings: TemplateStringsArray | string[], ...values: unknown[]) => {
    if (!("raw" in strings)) return { sqlFragment: "(?)" };
    const query = mockQueryText(strings, values);
    if (!query.includes("SELECT c.*")) return { sqlFragment: query };
    queries.push(query);
    // Model the database returning the stale chunk when the inline predecessor is unguarded.
    const earlierSeal = query.split("SELECT c.*")[0]!;
    const rejectsStale = query.includes("boundary.first_page<=c.page") &&
      earlierSeal.includes("seal.pages->0->>'inlineSealedAtEnd'='true'") &&
      earlierSeal.includes("WHEN 'true' THEN FALSE WHEN 'false' THEN TRUE");
    if (!rejectsStale) return [stale, numbered, clean];
    return query.includes("JOIN workspaces") ? [numbered, clean, markdown] : [numbered, clean];
  };
  const repository = createOpeningSourceChunksRepository(sql as unknown as Sql);
  await expect(repository.listForSources(scope, ["pdf", "markdown"])).resolves.toMatchObject([
    { id: "clean", text: clean.text }, { id: "markdown", text: markdown.text },
  ]);
  await expect(repository.listChunksAtVersion(scope, "pdf", 4)).resolves.toMatchObject([{ id: "clean" }]);
  await expect(repository.listChunksAtVersion(scope, "pdf", 4, [2], { unpublishedPdfForRecovery: true })).resolves.toMatchObject([
    { id: "stale", text: stale.text, imageObjectKey: "stale-image" }, { id: "numbered" }, { id: "clean" },
  ]);
  for (const query of queries.slice(0, 2)) {
    expect(query).toContain("s.mime<>'application/pdf' OR c.page IS NULL OR");
    expect(query).toContain("pdf_pending_seals AS MATERIALIZED");
    expect(query).toContain("archived_page.source_id=c.source_id AND archived_page.source_version=c.source_version AND archived_page.page=c.page");
    expect(query).toContain("archived_chunk.chunk_id=c.id");
    expect(query).toContain("seal.source_id=c.source_id AND seal.source_version=c.source_version");
    expect(query.match(/\b(?:FROM|JOIN) (?:opening_\w+|workspaces)\b/gu)?.length).toBeLessThanOrEqual(10);
  }
  expect(queries.at(-1)).not.toContain("opening_pdf_parse_segments");
});

describe("page-less archived PDF chunks", () => {
  const example = "Example 1: Cyclic groups\nSolution: This group is abelian.";
  const stem = "1. Decide whether every cyclic group is abelian.";

  it.each([
    [example, true],
    [`${example}\n${stem}\n解答：\nYes.`, false],
    [`${example}\n${stem}\nSolution:\nYes.`, false],
    ["[图片描述]：Answer Key\n1. x = 3.", false],
    ["【图表观察描述，非原文或解答】\nExample 1: Cyclic groups\nSolution: Yes.", false],
    ["## Answers ##   ", false],
    [" ## Answers ## ", false],
    ["## Answer#", true],
    ["####### Answers ##", true],
    [`${example}\n## Introduction ##   \nSolution:\nYes.`, false],
    [`${example}\n ## ## \nSolution:\nYes.`, true],
    [`${example}\n ## \nSolution:\nYes.`, true],
    [`${example}\n${stem}\n## ##\nSolution:\nYes.`, false],
    [`${example}\n${stem}\n## ****\nSolution:\nYes.`, false],
    [`${example}\n${stem}\n## **** ##\nSolution:\nYes.`, false],
    [`${example}\n${stem}\n######\nSolution:\nYes.`, false],
    [`${example}\n${stem}\n###   \nSolution:\nYes.`, false],
    [`${example}\n${stem}\n#   #\nSolution:\nYes.`, false],
    [`${example}\n${stem}\n##\nSolution:\nYes.`, false],
    [`${example}\n${stem}\n## # ##\nSolution:\nYes.`, true],
    [`${example}\n${stem}\n## ## ##\nSolution:\nYes.`, true],
    [`${example}\n${stem}\n#######\nSolution:\nYes.`, true],
    ["Solutions\n## ##\n1. The result is 42.", false],
    ["Solutions\n######\n1. The result is 42.", false],
    ["Solutions\n###   \n1. The result is 42.", false],
    ["Solutions\n#   #\n1. The result is 42.", false],
    ["Solutions\n## ****\n1. The result is 42.", false],
    ["Solutions\n## **** ##\n1. The result is 42.", false],
    ["Solutions\n## __\n1. The result is 42.", false],
    ["[图片描述] ## ##\nSolutions\n1. The result is 42.", false],
    ["[图片描述] Solutions\n## ##\n1. The result is 42.", false],
    ["[图片描述] Solutions\n######\n1. The result is 42.", false],
    ["[图片描述] ## Answers ##", false],
    ["Solutions\n##\n1. Propositions.", false],
    ["Solutions\n## # ##\n1. Propositions.", true],
    ["Solutions\n## ## ##\n1. Propositions.", true],
    ["Solutions\n## Title ##\n1. Propositions.", true],
    ["Solutions\n#######\n1. Propositions.", true],
    ["Solutions\n** Page 42\n1. The result is 42.", true],
    ["Solutions\n**Page 42**\n1. The result is 42.", false],
    ["Solutions\nAlgebra | 第2张\n1. The result is 42.", false],
    ["Solutions\n第2张（共5页）\n1. The result is 42.", false],
    ["Solutions\n第2张（共10张）\n1. The result is 42.", false],
    ["Solutions\n第2張, 共5張\n1. The result is 42.", false],
    ["Solutions\n共5頁第2張\n1. The result is 42.", false],
    ["Solutions\n共10张第2张\n1. The result is 42.", false],
    ["Solutions\n共5张 2张\n1. The result is 42.", false],
    ["Solutions\n共10张\n1. The result is 42.", true],
    ["Solutions\n1/3张\n1. The result is 42.", false],
    ["Solutions\n共5页第2页\n1. The result is 42.", false],
    ["Solutions\nChapter 2: Algebra (第2张)\n1. The result is 42.", false],
    ["Solutions\nChapter 2 (Page 5)\n1. The result is 42.", false],
    ["Solutions\n第二章 代数（第2张）\n1. The result is 42.", false],
    ["Solutions\nChapter 2: 第2张\n1. The result is 42.", false],
    [`${example}\nChapter 2: Algebra (第2张)\nSolution: 2张`, true],
    [`${example}\nChapter 2 (Page 5)\nSolution: 2张`, true],
    [`${example}\n第二章 代数（第2张）\nSolution: 2张`, true],
    [`${example}\nChapter 2: 第2张\nSolution: 2张`, true],
    [`${example}\nChapter 2: Groups (Lagrange)\nSolution: 2张`, false],
    [`${example}\nChapter 2: Linear Maps (Part 1)\nSolution: 2张`, false],
    ["Solution: 2张", false],
    ["解答： 2张", false],
    ["Solution: Page 2", false],
  ])("checks local answer context in %j", (text, isPublic) => {
    expect(isPublicSourceChunk({ mime: "application/pdf", page: null, text })).toBe(isPublic);
  });

  it("normalizes closing ATX hashes and emphasis/counter suffixes in O(N) time (< 250 ms)", () => {
    expect(containsPdfAnswerLabel("## Answers ##   ")).toBe(true);
    expect(containsPdfAnswerLabel("## Answer#")).toBe(false);
    expect(containsPdfAnswerLabel("Solutions\n## ##\n1. The result is 42.")).toBe(true);
    expect(containsPdfAnswerLabel("Solutions\n######\n1. The result is 42.")).toBe(true);
    expect(containsPdfAnswerLabel("Solutions\n## # ##\n1. Propositions.")).toBe(false);
    expect(containsPdfAnswerLabel("Solutions\n#######\n1. Propositions.")).toBe(false);
    expect(containsPdfAnswerLabel("Solutions\nAlgebra | 第2张\n1. The result is 42.")).toBe(true);
    expect(containsPdfAnswerLabel("Solutions\n** Page 42\n1. The result is 42.")).toBe(false);
    expect(containsPdfAnswerLabel("Solutions\n**Page 42**\n1. The result is 42.")).toBe(true);
    expect(containsPdfAnswerLabel("Solution: 2张")).toBe(true);
    expect(containsPdfAnswerLabel("解答： 2张")).toBe(true);
    expect(containsPdfAnswerLabel("Solution: Page 2")).toBe(true);
    expect(isPublicSourceChunk({ mime: "application/pdf", page: 1, text: "## Answers ##   " })).toBe(false);
    expect(isPublicSourceChunk({ mime: "application/pdf", page: 1, text: "## Answer#" })).toBe(true);
    expect(isPublicSourceChunk({ mime: "application/pdf", page: 1, text: "Solutions\n## ##\n1. The result is 42." })).toBe(false);
    expect(isPublicSourceChunk({ mime: "application/pdf", page: 1, text: "Solutions\nAlgebra | 第2张\n1. The result is 42." })).toBe(false);

    const longSpaces = "## " + " ".repeat(25_000) + "prose";
    const longHashSpaces = "## " + "# ".repeat(25_000) + "prose";
    const longClosingAnswer = "## Answers" + " ".repeat(25_000) + "##   ";
    const longUnpairedStarPage = "** ".repeat(25_000) + "Page 42";
    const longUnpairedUnderSheet = "__ ".repeat(25_000) + "第2张";
    const longPairedStarPage = "**Page " + "4".repeat(25_000) + "**";
    const longStarTitled = "** ".repeat(25_000) + "a".repeat(200) + "| Page 42";
    const nearMatchStarEnd = "Page 42" + "** ".repeat(5_000) + "x";
    const nearMatchSpaceEnd = "Algebra : Page 42" + " ".repeat(5_000) + "x";
    const nearMatchLeadStar = "** ".repeat(5_000) + "Page 42 x";

    // Warm up V8 JIT across ATX, paired/unpaired emphasis, and page-counter paths before wall-clock checks.
    for (let i = 0; i < 4; i++) {
      containsPdfAnswerLabel("## Answers   ##");
      containsPdfAnswerLabel("Solutions\n**Page 42**\n__ 第2张\nAlgebra : Page 42 x\n1. The result is 42.");
      isPublicSourceChunk({ mime: "application/pdf", page: 1, text: "## prose   ##\n** x __ y | Page 42" });
    }

    const t0 = performance.now();
    expect(containsPdfAnswerLabel(longSpaces)).toBe(false);
    expect(isPublicSourceChunk({ mime: "application/pdf", page: 1, text: longSpaces })).toBe(true);
    expect(performance.now() - t0).toBeLessThan(250);

    const t1 = performance.now();
    expect(containsPdfAnswerLabel(longHashSpaces)).toBe(false);
    expect(isPublicSourceChunk({ mime: "application/pdf", page: 1, text: longHashSpaces })).toBe(true);
    expect(performance.now() - t1).toBeLessThan(250);

    const t2 = performance.now();
    expect(containsPdfAnswerLabel(longClosingAnswer)).toBe(true);
    expect(isPublicSourceChunk({ mime: "application/pdf", page: 1, text: longClosingAnswer })).toBe(false);
    expect(performance.now() - t2).toBeLessThan(250);

    const t3 = performance.now();
    expect(containsPdfAnswerLabel(`Solutions\n${longUnpairedStarPage}\n1. The result is 42.`)).toBe(false);
    expect(containsPdfAnswerLabel(`Solutions\n${longUnpairedUnderSheet}\n1. The result is 42.`)).toBe(false);
    expect(containsPdfAnswerLabel(`Solutions\n${longPairedStarPage}\n1. The result is 42.`)).toBe(true);
    expect(containsPdfAnswerLabel(longStarTitled)).toBe(false);
    expect(performance.now() - t3).toBeLessThan(250);

    const t4 = performance.now();
    expect(containsPdfAnswerLabel(`Solutions\n${nearMatchStarEnd}\n1. The result is 42.`)).toBe(false);
    expect(containsPdfAnswerLabel(`Solutions\n${nearMatchSpaceEnd}\n1. The result is 42.`)).toBe(false);
    expect(containsPdfAnswerLabel(`Solutions\n${nearMatchLeadStar}\n1. The result is 42.`)).toBe(false);
    expect(performance.now() - t4).toBeLessThan(250);
  });

  it("evaluates sequential same-page PDF chunk seals, continuations, worked examples, and reopenings", () => {
    const chunks = (texts: string[], page: number | null = 1) => texts.map((text, index) => ({ id: `c${index}`, page, text }));
    expect(filterPublicSamePagePdfChunks(chunks(["1. Find x.", "Solution:", "x = 2"])).map(c => c.text))
      .toEqual(["1. Find x."]);
    expect(filterPublicSamePagePdfChunks(chunks(["Chapter 2", "Answer:", "x = 2"])).map(c => c.text))
      .toEqual(["Chapter 2"]);
    expect(filterPublicSamePagePdfChunks(chunks(["Problem 1.", "Official Solution:", "x = 2"])).map(c => c.text))
      .toEqual(["Problem 1."]);
    for (const opener of ["Answer:", "Solutions", "Official Solution:"]) {
      expect(filterPublicSamePagePdfChunks(chunks([opener, "1. The result is 42.", "2. Next answer."]))).toEqual([]);
    }
    expect(filterPublicSamePagePdfChunks(chunks(["Worked Example 1: Factor x^2 - 1.", "Solution:", "(x - 1)(x + 1)."]))
      .map(c => c.text)).toEqual(["Worked Example 1: Factor x^2 - 1.", "Solution:", "(x - 1)(x + 1)."]);
    expect(filterPublicSamePagePdfChunks(chunks(["1. Find x.", "Solution: x = 2.", "## Theorem 2.1\nEvery cyclic group is abelian."]))
      .map(c => c.text)).toEqual(["1. Find x.", "## Theorem 2.1\nEvery cyclic group is abelian."]);
    expect(filterPublicSamePagePdfChunks(chunks(["1. Find x.", "Solution:\nx = 2.", "2. Find y."])).map(c => c.text))
      .toEqual(["1. Find x.", "2. Find y."]);
    expect(filterPublicSamePagePdfChunks(chunks(["1. Find x.", "Solution:\nx = 2.", "Therefore x = 2."])).map(c => c.text))
      .toEqual(["1. Find x."]);
    expect(filterPublicSamePagePdfChunks(chunks(["1. Find x.", "Solution: x = 2.\n\n2. Find y.", "Public follow-up."])).map(c => c.text))
      .toEqual(["1. Find x.", "Public follow-up."]);
    for (const label of ["答案 1：", "答案 1、", "答案 1。", "Answer to Exercise 1:", "Key 1:", "Solution to Exercise 1:", "解 1：", "【解析】", "Official Answer 1", "Official Solution 1."]) {
      expect(filterPublicSamePagePdfChunks(chunks(["1. Find x.", label, "x = 2"])).map(c => c.text), label)
        .toEqual(["1. Find x."]);
    }
    expect(filterPublicSamePagePdfChunks(chunks(["1. Find x.", "Solution: Proof. Substitution gives x = 2. ∎", "Chapter 2: Groups"])).map(c => c.text))
      .toEqual(["1. Find x.", "Chapter 2: Groups"]);
    expect(filterPublicSamePagePdfChunks(chunks(["1. Find x.", "Solution: Q.E.D.", "Proof: Another theorem."])).map(c => c.text))
      .toEqual(["1. Find x.", "Proof: Another theorem."]);
    const cursor: ArchivePdfCursorState = { inWorkedExample: false, inExercise: false, previousNumberedQuestion: false };
    expect(filterPublicSamePagePdfChunks(chunks(["Worked Example 1: Solve x = 2."], 1), cursor).map(c => c.text))
      .toEqual(["Worked Example 1: Solve x = 2."]);
    expect(cursor.inWorkedExample).toBe(true);
    expect(filterPublicSamePagePdfChunks(chunks(["Solution:", "Substitution gives x = 2."], 2), cursor).map(c => c.text))
      .toEqual(["Solution:", "Substitution gives x = 2."]);
  });

  it("suppresses public sibling imageObjectKey when a same-page sibling is sealed and drops empty suppressed rows in listForSources", async () => {
    const scope = { workspaceId: "workspace", ownerUserId: "owner" };
    const mkRow = (id: string, page: number, text: string, image_object_key: string | null) => ({
      id, source_id: "pdf", source_version: 4, page, slide_label: null, start_ms: null, end_ms: null,
      text, mime: "application/pdf", image_object_key,
    });
    const publicQuestion = mkRow("q1", 1, "1. Find x.", "scan/p1.png");
    const emptyImageOnly = mkRow("img1", 1, "   ", "scan/p1-blank.png");
    const sealedAnswer = mkRow("a1", 1, "Answer 1: x = 2.", "scan/p1-ans.png");
    const cleanPage = mkRow("p2", 2, "Chapter 2: Groups", "scan/p2.png");
    const sql = (strings: TemplateStringsArray | string[], ...values: unknown[]) => {
      if (!("raw" in strings)) return { sqlFragment: "(?)" };
      const query = mockQueryText(strings, values);
      if (!query.includes("SELECT c.*")) return { sqlFragment: query };
      return [publicQuestion, emptyImageOnly, sealedAnswer, cleanPage];
    };
    const repo = createOpeningSourceChunksRepository(sql as unknown as Sql);
    await expect(repo.listChunksAtVersion(scope, "pdf", 4)).resolves.toMatchObject([
      { id: "q1", text: "1. Find x.", imageObjectKey: null },
      { id: "img1", text: "   ", imageObjectKey: null },
      { id: "p2", text: "Chapter 2: Groups", imageObjectKey: "scan/p2.png" },
    ]);
    await expect(repo.listForSources(scope, ["pdf"])).resolves.toMatchObject([
      { id: "q1", text: "1. Find x.", imageObjectKey: null },
      { id: "p2", text: "Chapter 2: Groups", imageObjectKey: "scan/p2.png" },
    ]);
    await expect(repo.listChunksAtVersion(scope, "pdf", 4, [1], { unpublishedPdfForRecovery: true })).resolves.toMatchObject([
      { id: "q1", imageObjectKey: "scan/p1.png" },
      { id: "img1", imageObjectKey: "scan/p1-blank.png" },
      { id: "a1", imageObjectKey: "scan/p1-ans.png" },
      { id: "p2", imageObjectKey: "scan/p2.png" },
    ]);

    const spans = new Map<string, ArchivedSealSpan[]>([
      ["pdf:4", [{ first_page: 1, reopen_page: 2, chunk_id: "a1" }]],
    ]);
    const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = mockQueryText(strings, values);
      if (!query.includes('SELECT c.id,c.source_id AS "sourceId"')) return { sqlFragment: query };
      return [{ id: "q1", sourceId: "pdf", sourceVersion: 4, mime: "application/pdf", page: 1,
        slideLabel: null, startMs: null, endMs: null, text: "1. Find x.", imageObjectKey: "scan/p1.png" }];
    }) as unknown as TransactionSql;
    await expect(readCitedChunk(tx, scope, "course", "q1", spans)).resolves.toMatchObject({
      id: "q1", text: "1. Find x.", imageObjectKey: null,
    });
  });
});

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
