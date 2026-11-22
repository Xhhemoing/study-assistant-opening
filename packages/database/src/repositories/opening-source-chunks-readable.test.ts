import type { Sql, TransactionSql } from "postgres";
import { describe, expect, it, vi } from "vitest";
import { preserveOpeningKnowledgeDefinitions } from "./opening-knowledge-definitions";
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
    const seals = position("INSERT INTO opening_pdf_parse_segments");
    expect(statements[seals]?.values).toContainEqual([{ ...reopened, publicationSealCommitted: true }]);
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
    { reason: "numbered decimal solution", available: true, text: "Solution 2.1: x = 3." },
    { reason: "numbered answer key", available: true, text: "Answer Key 3: x = 3." },
    { reason: "numbered qualified heading", available: true, text: "Official Answer 1\nx = 3." },
    { reason: "numbered Chinese exercise answer", available: true, text: "课后习题答案 1：x = 3。" },
    { reason: "numbered Chinese chapter answer", available: true, text: "章节答案 1、x = 3。" },
    { reason: "worked example continuation", available: true, text: "Solution:\nTake the square root.", preservesDefinition: true },
    { reason: "completed public publication", available: true, text: "Public introduction.", preservesDefinition: true },
    { reason: "Markdown answer label", available: true, text: "Answer: an HTTP response to a request.", mime: "text/markdown", preservesDefinition: true },
  ])("handles $reason on a second cited source", async ({ marker, available, text, preservesDefinition, mime = "application/pdf" }) => {
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
      if (strings[0]?.trimStart().startsWith("WITH pdf_pending_seals") || !query.startsWith("WITH") && query.includes("seal.pages->0")
        || query.startsWith("seal.source_id=") || query.startsWith("s.parse_state") || query.startsWith("ps.parse_state")) {
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
    expect(query).toContain("seal.source_id=c.source_id AND seal.source_version=c.source_version");
    expect(query.match(/\b(?:FROM|JOIN) (?:opening_\w+|workspaces)\b/gu)?.length).toBeLessThanOrEqual(10);
  }
  expect(queries.at(-1)).not.toContain("opening_pdf_parse_segments");
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
