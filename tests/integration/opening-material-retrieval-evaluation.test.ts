import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createScopedOpeningSystemQueryReader } from "@aistudy/database";
import { materialRetrievalEvaluationSchema } from "../../packages/contracts/src/opening/material-retrieval-evaluation";
import { runMaterialRetrievalEvaluation } from "../../packages/ai/src/opening/material-retrieval-evaluation";
import { createFixtureMaterialReader, loadMaterialRetrievalFixture } from "../../scripts/study-retrieval/fixture";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
let fixture: OpeningFixture;
const root = fileURLToPath(new URL("../../", import.meta.url));
const annotations = materialRetrievalEvaluationSchema.parse(JSON.parse(await readFile(new URL("../fixtures/opening/retrieval/rank-nullspace-annotations.json", import.meta.url), "utf8")));
const chunks = await loadMaterialRetrievalFixture(root);
beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => {
  await fixture.reset();
  // Version history intentionally survives source deletion; this fixture reuses
  // stable corpus IDs across cases, so clear only its own previous versions.
  await fixture.sql`DELETE FROM opening_source_versions WHERE workspace_id=${fixture.scope.workspaceId}`;
  for (const source of annotations.sources) {
    await fixture.sql`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
      VALUES(${source.sourceId},${fixture.scope.workspaceId},${source.label!},'text/markdown',100,${'11'.repeat(32)},1,'uploaded','ready')`;
    await fixture.sql`INSERT INTO opening_source_versions(source_id,workspace_id,version,availability) VALUES(${source.sourceId},${fixture.scope.workspaceId},1,'available')`;
  }
  for (const chunk of chunks) await fixture.sql`INSERT INTO opening_source_chunks(id,source_id,source_version,page,text)
    VALUES(${chunk.id},${chunk.sourceId},${chunk.sourceVersion},${chunk.physicalPage},${chunk.text})`;
});
afterAll(async () => { await fixture?.close(); });
it("runs the actual owner-scoped material reader and matches replay rankings without changing learning facts", async () => {
  const [before] = await fixture.sql`SELECT count(*)::int AS n FROM opening_help_exposures WHERE workspace_id=${fixture.scope.workspaceId}`;
  const reader = createScopedOpeningSystemQueryReader(fixture.sql, fixture.scope, { purpose: "system_record_lookup" });
  const source = annotations.sources[0]!;
  const inventory = await reader({ name: "materials", arguments: { sourceId: source.sourceId, sourceVersion: source.sourceVersion, limit: 10, offset: 0 } }, new AbortController().signal);
  expect(inventory.status).toBe("ok");
  expect(inventory.data).toHaveLength(chunks.filter(chunk => chunk.sourceId === source.sourceId).length);
  const live = await runMaterialRetrievalEvaluation({ ...annotations, scope: fixture.scope }, reader);
  const replay = await runMaterialRetrievalEvaluation(annotations, createFixtureMaterialReader(chunks, annotations.scope), { mode: "fixture_replay" });
  expect(live.mode).toBe("scoped_postgres_reader");
  expect(live.coverage).toEqual(replay.coverage);
  expect(live.aggregate).toEqual(replay.aggregate);
  expect(live.cases.map(test => [test.id, test.baseline.retrievedChunkIds, test.contextAlias.retrievedChunkIds])).toEqual(replay.cases.map(test => [test.id, test.baseline.retrievedChunkIds, test.contextAlias.retrievedChunkIds]));
  const [after] = await fixture.sql`SELECT count(*)::int AS n FROM opening_help_exposures WHERE workspace_id=${fixture.scope.workspaceId}`;
  expect(after!.n).toBe(before!.n);
});
it("does not score inaccessible material under another owner's scope", async () => {
  const result = await runMaterialRetrievalEvaluation({ ...annotations, scope: fixture.otherScope }, createScopedOpeningSystemQueryReader(fixture.sql, fixture.otherScope));
  expect(result.coverage.pairedScored).toBe(0);
  expect(result.aggregate.baseline.mrrAtK).toBeNull();
  expect(result.cases.every(test => test.baseline.retrievedChunkIds.length === 0)).toBe(true);
});
it("distinguishes unavailable versions and privacy exclusions from retrieval failure", async () => {
  await fixture.sql`UPDATE opening_sources SET version=2 WHERE id=${annotations.sources[0]!.sourceId}`;
  const stale = await runMaterialRetrievalEvaluation({ ...annotations, scope: fixture.scope }, createScopedOpeningSystemQueryReader(fixture.sql, fixture.scope));
  expect(stale.coverage.unableToJudge).toBe(annotations.cases.length);
  expect(stale.aggregate.contextAlias.recallAtK).toBeNull();
});
