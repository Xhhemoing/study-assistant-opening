import type { Sql, TransactionSql } from "postgres";
import { describe, expect, it, vi } from "vitest";
import { preserveOpeningKnowledgeDefinitions } from "./opening-knowledge-definitions";
import { chunksHaveReadableContent, createOpeningSourceChunksRepository, type NewSourceChunk } from "./opening-source-chunks";

const base = { page: 1, slideLabel: null, startMs: null, endMs: null };

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
    await repo.replacePdfChunks(scope, { ...input, allowSealedEmpty: true });
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
    const ready = position("UPDATE opening_sources SET parse_state='ready'");
    const index = position("INSERT INTO opening_jobs");
    const steps = [history, execution, workspace, source, backfill, deletion, ready, index];
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
    { reason: "unknown earlier scan", marker: "publicationSealUnknown", available: false, text: "5 units." },
    { reason: "unstripped answer", available: true, text: "Answer Key\nx = 3." },
    { reason: "completed public publication", available: true, text: "Public introduction.", preservesDefinition: true },
  ])("handles $reason on a second cited source", async ({ marker, available, text, preservesDefinition }) => {
    const courseId = "00000000-0000-4000-8000-000000000001";
    const nodeId = "00000000-0000-4000-8000-000000000002";
    const [chunkB, chunkA] = ["00000000-0000-4000-8000-000000000003", "00000000-0000-4000-8000-000000000004"];
    const snapshot = { courseId, version: 1, nodes: [{ id: nodeId, courseId, label: "Concept", kind: "concept",
      evidenceChunkIds: [chunkB, chunkA], status: "supported" }], edges: [] };
    const writes: string[] = [];
    const citedIds: unknown[] = [];
    const tx = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?").replace(/\s+/gu, " ").trim();
      if (query.startsWith("SELECT id FROM workspaces")) return [{ id: "workspace" }];
      if (query.startsWith("SELECT graph.course_id, missing.node_indexes")) {
        expect(values).toContain("source-B");
        return [{ course_id: courseId, node_indexes: [0] }];
      }
      if (query.startsWith("SELECT snapshot")) return [{ snapshot }];
      if (query.startsWith("SELECT c.id,")) {
        const id = values.at(-1);
        citedIds.push(id);
        if (id === chunkA && marker) {
          expect(query).toContain("seal.workspace_id=s.workspace_id AND seal.source_id=c.source_id AND seal.source_version=c.source_version");
          expect(query).toContain("seal.parser_profile='pdf-publication-page-seal-v1' AND seal.state='ready'");
          expect(query).toContain("seal.page_start<=c.page");
          expect(query).toContain("s.parse_state<>'ready' OR seal.updated_at>s.updated_at");
          expect(query).toContain("c.image_object_key IS NOT NULL");
          expect(query).toContain("seal.pages->0->>'" + marker + "'='true'");
        }
        if (id === chunkA && !available) return [];
        return [{ ...base, id, sourceId: id === chunkA ? "source-A" : "source-B", sourceVersion: 4,
          text: id === chunkA ? text : "Study notes.", imageObjectKey: null }];
      }
      if (query.startsWith("UPDATE opening_course_knowledge")) writes.push(query);
      return [];
    };
    await preserveOpeningKnowledgeDefinitions(tx as unknown as TransactionSql,
      { workspaceId: "workspace", ownerUserId: "owner" }, "source-B", 4);
    expect(citedIds).toEqual([chunkB, chunkA]);
    expect(writes).toHaveLength(preservesDefinition ? 1 : 0);
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
