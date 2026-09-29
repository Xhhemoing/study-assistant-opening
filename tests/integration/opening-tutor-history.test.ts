import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createOpeningConversationRepository, createOpeningTutorJobsRepository } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
let f: OpeningFixture;
beforeAll(async () => { f = await createOpeningFixture(); });
beforeEach(async () => {
  await f.reset();
  await f.sql`TRUNCATE opening_privacy_exclusions RESTART IDENTITY CASCADE`;
});
afterAll(async () => { await f?.close(); });
async function seed() {
  const repo = createOpeningConversationRepository(f.sql);
  const c = await repo.create(f.scope, { title: "history", courseId: null });
  const append = (text: string) => repo.appendSavedTurn({ scope: f.scope, conversationId: c.id, text, mode: "hint", clientKey: randomUUID(), sourceIds: [], learningSessionId: null, currentPage: null, chunkId: null });
  const prior = await append("previous question");
  await f.sql`UPDATE opening_turns SET created_at = now() - interval '1 hour' WHERE id IN (${prior.turnId}, ${prior.assistantTurnId})`;
  await f.sql`UPDATE opening_turns SET status='complete', text='step two', context_source_refs='[]'::jsonb WHERE id=${prior.assistantTurnId}`;
  const current = await append("continue");
  return { repo, c, prior, current, jobs: createOpeningTutorJobsRepository(f.sql) };
}
it("loads only prior completed exchanges in the owned conversation", async () => {
  const { current, jobs, prior } = await seed();
  expect(await jobs.loadHistory(f.scope, current.turnId)).toEqual([{ role: "user", text: "previous question" }, { role: "assistant", text: "step two" }]);
  expect(await jobs.loadHistory(f.otherScope, current.turnId)).toEqual([]);
  await f.sql`UPDATE opening_turns SET status='pending' WHERE id=${prior.assistantTurnId}`;
  expect(await jobs.loadHistory(f.scope, current.turnId)).toEqual([]);
});
it("clears derived history when an earlier source was revoked or its cited version changed", async () => {
  const { current, jobs, prior } = await seed();
  const id = randomUUID();
  await f.sql`INSERT INTO opening_sources (id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state) VALUES (${id},${f.scope.workspaceId},'a.pdf','application/pdf',1,${'a'.repeat(64)},0,'uploaded','ready')`;
  await f.sql`UPDATE opening_turns SET source_ids=ARRAY[${id}]::uuid[], source_versions=jsonb_build_object(${id}::text,0) WHERE id=${prior.turnId}`;
  expect(await jobs.loadHistory(f.scope, current.turnId)).toHaveLength(2);
  await f.sql`UPDATE opening_sources SET upload_state='rejected' WHERE id=${id}`;
  expect(await jobs.loadHistory(f.scope, current.turnId)).toEqual([]);
  await f.sql`UPDATE opening_sources SET upload_state='uploaded', version=1 WHERE id=${id}`;
  await f.sql`UPDATE opening_turns SET citations=${f.sql.json([{ sourceId: id, sourceVersion: 0 }])} WHERE id=${prior.assistantTurnId}`;
  expect(await jobs.loadHistory(f.scope, current.turnId)).toEqual([]);
});
it("clears derived history when a referenced source is privacy-excluded", async () => {
  const { current, jobs, prior } = await seed();
  const id = randomUUID();
  await f.sql`INSERT INTO opening_sources (id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state) VALUES (${id},${f.scope.workspaceId},'a.pdf','application/pdf',1,${'a'.repeat(64)},0,'uploaded','ready')`;
  await f.sql`UPDATE opening_turns SET source_ids=ARRAY[${id}]::uuid[], source_versions=jsonb_build_object(${id}::text,0) WHERE id=${prior.turnId}`;
  expect(await jobs.loadHistory(f.scope, current.turnId)).toHaveLength(2);
  await f.sql`INSERT INTO opening_privacy_exclusions (id, workspace_id, source_id, memory_id, deleted_at) VALUES (${randomUUID()}, ${f.scope.workspaceId}, ${id}, NULL, now())`;
  expect(await jobs.loadHistory(f.scope, current.turnId)).toEqual([]);
});
it("clears history for an excluded current source or citation-only source, not another workspace", async () => {
  const { current, jobs, prior } = await seed();
  const currentSource = randomUUID();
  const cited = randomUUID();
  const foreign = randomUUID();
  await f.sql`INSERT INTO opening_sources (id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state) VALUES
    (${currentSource},${f.scope.workspaceId},'current.pdf','application/pdf',1,${'b'.repeat(64)},0,'uploaded','ready'),
    (${cited},${f.scope.workspaceId},'cited.pdf','application/pdf',1,${'c'.repeat(64)},0,'uploaded','ready'),
    (${foreign},${f.otherScope.workspaceId},'foreign.pdf','application/pdf',1,${'d'.repeat(64)},0,'uploaded','ready')`;
  await f.sql`UPDATE opening_turns SET source_ids=ARRAY[${currentSource}]::uuid[] WHERE id=${current.turnId}`;
  await f.sql`INSERT INTO opening_privacy_exclusions (id, workspace_id, source_id, memory_id, deleted_at) VALUES (${randomUUID()}, ${f.scope.workspaceId}, ${currentSource}, NULL, now())`;
  expect(await jobs.loadHistory(f.scope, current.turnId)).toEqual([]);
  await f.sql`DELETE FROM opening_privacy_exclusions WHERE source_id=${currentSource}`;
  await f.sql`UPDATE opening_turns SET source_ids='{}', citations=${f.sql.json([{ sourceId: cited, sourceVersion: 0 }])} WHERE id=${prior.assistantTurnId}`;
  expect(await jobs.loadHistory(f.scope, current.turnId)).toHaveLength(2);
  await f.sql`INSERT INTO opening_privacy_exclusions (id, workspace_id, source_id, memory_id, deleted_at) VALUES (${randomUUID()}, ${f.scope.workspaceId}, ${cited}, NULL, now())`;
  expect(await jobs.loadHistory(f.scope, current.turnId)).toEqual([]);
  await f.sql`DELETE FROM opening_privacy_exclusions WHERE source_id=${cited}`;
  await f.sql`INSERT INTO opening_privacy_exclusions (id, workspace_id, source_id, memory_id, deleted_at) VALUES (${randomUUID()}, ${f.otherScope.workspaceId}, ${foreign}, NULL, now())`;
  expect(await jobs.loadHistory(f.scope, current.turnId)).toHaveLength(2);
});
it("bounds history by whole exchanges and excludes oversized recent turns", async () => {
  const { current, jobs, prior } = await seed();
  await f.sql`UPDATE opening_turns SET text=${'x'.repeat(12001)} WHERE id=${prior.turnId}`;
  expect(await jobs.loadHistory(f.scope, current.turnId)).toEqual([]);
});
