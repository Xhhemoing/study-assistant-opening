import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { SystemQueryResult } from "@aistudy/contracts";
import { materialRetrievalEvaluationSchema } from "../../../contracts/src/opening/material-retrieval-evaluation";
import { runMaterialRetrievalEvaluation } from "./material-retrieval-evaluation";
import { createFixtureMaterialReader, loadMaterialRetrievalFixture, materialFixtureChunkId } from "../../../../scripts/study-retrieval/fixture";
const root = fileURLToPath(new URL("../../../../", import.meta.url));
async function fixture() {
  const dataset = materialRetrievalEvaluationSchema.parse(JSON.parse(await readFile(new URL("../../../../tests/fixtures/opening/retrieval/rank-nullspace-annotations.json", import.meta.url), "utf8")));
  const chunks = await loadMaterialRetrievalFixture(root);
  return { dataset, chunks, reader: createFixtureMaterialReader(chunks, dataset.scope) };
}
describe("material retrieval evaluation against existing allowlisted teaching pages", () => {
  it("runs substantive source pages and reports paired rankings, misses and unavailable labels separately", async () => {
    const { dataset, chunks, reader } = await fixture();
    expect(chunks).toHaveLength(14);
    expect(chunks.reduce((sum, chunk) => sum + chunk.text.length, 0)).toBeGreaterThan(3500);
    expect(chunks.every(chunk => chunk.originPath.includes("/materials/") && !chunk.originPath.includes("eval-heldout"))).toBe(true);
    const result = await runMaterialRetrievalEvaluation(dataset, reader, { mode: "fixture_replay" });
    expect(result.coverage).toEqual({ total: 17, pairedScored: 14, noRelevantTargets: 1, unableToJudge: 2 });
    expect(result.cases.find(test => test.id === "context-rref")).toMatchObject({ baseline: { metrics: { recallAtK: 0 } }, contextAlias: { retrievedChunkIds: [materialFixtureChunkId(4, 2)], metrics: { recallAtK: 1, reciprocalRank: 1 } } });
    expect(result.cases.find(test => test.id === "en-rref")?.baseline.metrics?.recallAtK).toBe(3 / 5);
    expect(result.cases.find(test => test.id === "unjudged-visual")).toMatchObject({ status: "unable_to_judge", reason: "relevance_not_annotated", baseline: { metrics: null } });
    expect(result.cases.find(test => test.id === "unavailable-label")).toMatchObject({ status: "unable_to_judge", reason: "relevant_chunk_not_in_accessible_corpus" });
    expect(result.cases.find(test => test.id === "negative-topic")).toMatchObject({ status: "judged_no_relevant_chunks", baseline: { retrievedChunkIds: [], metrics: null } });
    expect(JSON.stringify(result)).not.toContain(chunks[0]!.text);
  });
  it("never uses relevance labels to generate alias queries or rankings", async () => {
    const { dataset, reader } = await fixture();
    const changed = { ...dataset, cases: [dataset.cases[0]!, { ...dataset.cases[0]!, id: "other-judgment", relevantChunkIds: [materialFixtureChunkId(5, 2)] }] };
    const result = await runMaterialRetrievalEvaluation(changed, reader, { mode: "fixture_replay" });
    expect(result.cases[0]!.expansionQueries).toEqual(result.cases[1]!.expansionQueries);
    expect(result.cases[0]!.contextAlias.retrievedChunkIds).toEqual(result.cases[1]!.contextAlias.retrievedChunkIds);
    expect(result.cases[0]!.contextAlias.metrics).not.toEqual(result.cases[1]!.contextAlias.metrics);
  });
  it("rejects a permission revision change instead of comparing two grants", async () => {
    const { dataset, reader } = await fixture();
    let calls = 0;
    const changingReader = async (...args: Parameters<typeof reader>): Promise<SystemQueryResult> => {
      const result = await reader(...args);
      return { ...result, authorization: { ...result.authorization, permissionRevision: calls++ > 4 ? "changed" : result.authorization.permissionRevision } };
    };
    const result = await runMaterialRetrievalEvaluation(dataset, changingReader, { mode: "fixture_replay" });
    expect(result.coverage.pairedScored).toBe(0);
    expect(result.aggregate.baseline.recallAtK).toBeNull();
    expect(result.cases.every(test => test.reason === "authorization_changed")).toBe(true);
  });
  it("marks a changing version-pinned chunk inventory unjudgeable rather than a retrieval miss", async () => {
    const { dataset, reader } = await fixture();
    let inventoryCalls = 0;
    const changingReader = async (...args: Parameters<typeof reader>): Promise<SystemQueryResult> => {
      const result = await reader(...args);
      if (args[0].name === "materials" && !args[0].arguments.query && args[0].arguments.sourceId === dataset.sources[0]!.sourceId && ++inventoryCalls > 1 && result.name === "materials") {
        return { ...result, data: result.data.map((row, index) => index === 0 ? { ...row, id: materialFixtureChunkId(99, 1) } : row) };
      }
      return result;
    };
    const result = await runMaterialRetrievalEvaluation(dataset, changingReader, { mode: "fixture_replay" });
    expect(result.coverage.unableToJudge).toBe(dataset.cases.length);
    expect(result.cases.every(test => test.reason === "corpus_changed_or_unavailable")).toBe(true);
  });
  it("keeps context outside the frozen corpus and unknown relevance out of metric denominators", async () => {
    const { dataset, reader } = await fixture();
    const result = await runMaterialRetrievalEvaluation({ ...dataset, cases: [{ ...dataset.cases[0]!, context: { sourceId: dataset.sources[0]!.sourceId, sourceVersion: 2 } }] }, reader, { mode: "fixture_replay" });
    expect(result.cases[0]).toMatchObject({ status: "unable_to_judge", reason: "context_outside_frozen_corpus" });
    expect(result.aggregate.contextAlias.count).toBe(0);
  });
  it("validates dataset IDs, exact versions and duplicate judgments at the JSON boundary", async () => {
    const { dataset } = await fixture();
    expect(materialRetrievalEvaluationSchema.safeParse({ ...dataset, sources: [...dataset.sources, dataset.sources[0]] }).success).toBe(false);
    expect(materialRetrievalEvaluationSchema.safeParse({ ...dataset, cases: [...dataset.cases, dataset.cases[0]] }).success).toBe(false);
    expect(materialRetrievalEvaluationSchema.safeParse({ ...dataset, scope: { workspaceId: "not-a-uuid", ownerUserId: dataset.scope.ownerUserId } }).success).toBe(false);
  });
});
