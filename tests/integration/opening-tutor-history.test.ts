import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createCourseMembershipRepository, createOpeningConversationRepository, createOpeningMemoryRepository, createOpeningTutorJobsRepository } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { insertOwnedTurn, insertSource } from "./opening-memory-context-fixture";
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
it("accepts dependency metadata only in context refs and clears history on malformed citations in either turn", async () => {
  const { current, jobs, prior } = await seed();
  const memories = createOpeningMemoryRepository(f.sql);
  const active = await memories.proposeMemory(f.scope, {
    text: "Valid history dependency", sourceTurnIds: [await insertOwnedTurn(f.sql, f.scope)],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const rejected = await memories.proposeMemory(f.scope, { text: "Rejected history dependency", sourceTurnIds: [prior.turnId], expiresAt: null });
  await memories.reject(f.scope, rejected.id, rejected.version, randomUUID());
  const sourceId = await insertSource(f.sql, f.scope);
  const refs = [{ memoryDependencyIds: [active.id] }];
  await f.sql`UPDATE opening_turns SET context_source_refs=${f.sql.json(refs)} WHERE id=${prior.assistantTurnId}`;
  expect(await jobs.loadHistoryContext(f.scope, current.turnId)).toMatchObject({ memoryIds: [active.id] });

  for (const turnId of [prior.assistantTurnId, prior.turnId]) {
    for (const citations of [[{ memoryDependencyIds: [rejected.id] }], { sourceId, sourceVersion: 0 }]) {
      await f.sql`UPDATE opening_turns SET citations=${f.sql.json(citations)} WHERE id=${turnId}`;
      expect(await jobs.loadHistoryContext(f.scope, current.turnId)).toEqual({ history: [], sourceRefs: [] });
      expect(await jobs.loadHistory(f.scope, current.turnId)).toEqual([]);
    }
    await f.sql`UPDATE opening_turns SET citations='[]'::jsonb WHERE id=${turnId}`;
  }
  expect(await jobs.loadHistory(f.scope, current.turnId)).toHaveLength(2);
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

it("skips citation-only memory for a practice turn while keeping independent history", async () => {
  const { current, c, repo, jobs } = await seed();
  const courses = createCourseMembershipRepository(f.sql);
  const course = await courses.createCourse({ workspaceId: f.scope.workspaceId, title: "Purpose history", slug: randomUUID() });
  await f.sql`UPDATE opening_conversations SET course_id=${course.id} WHERE id=${c.id}`;
  const sourceId = await insertSource(f.sql, f.scope);
  await courses.addAssetMembership({ workspaceId: f.scope.workspaceId, courseId: course.id, assetType: "source",
    assetId: sourceId, role: "core", visibility: "course", purpose: "reference" });
  const origin = await insertOwnedTurn(f.sql, f.scope, { sourceIds: [sourceId] });
  const memory = await createOpeningMemoryRepository(f.sql).proposeMemory(f.scope, {
    courseId: course.id, text: "Reference memory", sourceTurnIds: [origin], expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  await f.sql`UPDATE opening_turns SET created_at=now()-interval '30 minutes' WHERE id=${current.turnId}`;
  await f.sql`UPDATE opening_turns SET status='complete', text='reference answer',
    context_source_refs=${f.sql.json([{ memoryDependencyIds: [memory.id] }])} WHERE id=${current.assistantTurnId}`;
  const next = await repo.appendSavedTurn({ scope: f.scope, conversationId: c.id, text: "Practice next", mode: "hint",
    clientKey: randomUUID(), sourceIds: [], learningSessionId: null, currentPage: null, chunkId: null });
  expect(await jobs.loadHistory(f.scope, next.turnId)).toHaveLength(4);
  await f.sql`UPDATE opening_turns SET context_anchor=${f.sql.json({ itemVersionId: randomUUID() })} WHERE id=${next.turnId}`;
  expect(await jobs.loadHistoryContext(f.scope, next.turnId)).toEqual({
    history: [{ role: "user", text: "previous question" }, { role: "assistant", text: "step two" }], sourceRefs: [],
  });

  await f.sql`UPDATE opening_memories SET expires_at=now()-interval '1 second' WHERE id=${memory.id}`;
  expect(await jobs.loadHistory(f.scope, next.turnId)).toEqual([]);
});

it("tracks temporary ancestors of legacy global memory-only history", async () => {
  const { current, prior, jobs } = await seed();
  const memories = createOpeningMemoryRepository(f.sql);
  const sourceId = await insertSource(f.sql, f.scope);
  const origin = await insertOwnedTurn(f.sql, f.scope);
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const temporary = await memories.proposeMemory(f.scope, { text: "Temporary fact", sourceTurnIds: [origin], expiresAt });
  const sourceRef = { sourceId, sourceVersion: 0 };
  const backingTurn = await insertOwnedTurn(f.sql, f.scope, {
    role: "assistant", contextSourceRefs: [sourceRef, { memoryDependencyIds: [temporary.id] }],
  });
  const candidate = await memories.proposeMemory(f.scope, { text: "Derived global fact", sourceTurnIds: [backingTurn], expiresAt: null });
  const backing = await memories.confirm(f.scope, candidate.id, candidate.version, randomUUID());
  await f.sql`UPDATE opening_turns SET context_source_refs=${f.sql.json([{ ...sourceRef, memoryOnly: true }])}
    WHERE id=${prior.assistantTurnId}`;

  const active = await jobs.loadHistoryContext(f.scope, current.turnId);
  expect(active.history).toHaveLength(2);
  expect(active.memoryIds).toEqual([backing.id, temporary.id].sort());
  expect(active.temporaryMemoryExpiresAt).toBe(expiresAt);
  await f.sql`UPDATE opening_memories SET expires_at=clock_timestamp() - interval '1 second' WHERE id=${temporary.id}`;
  expect(await jobs.loadHistoryContext(f.scope, current.turnId)).toEqual({ history: [], sourceRefs: [] });
});

it("keeps course-scoped memory history only while both turns resolve to its active course", async () => {
  const { current, jobs, prior, c, repo } = await seed();
  const courses = createCourseMembershipRepository(f.sql);
  const courseA = await courses.createCourse({ workspaceId: f.scope.workspaceId, title: "History course A", slug: "history-a" });
  const courseB = await courses.createCourse({ workspaceId: f.scope.workspaceId, title: "History course B", slug: "history-b" });
  const expiresAt = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
  const memory = await createOpeningMemoryRepository(f.sql).proposeMemory(f.scope, {
    courseId: courseA.id, text: "Course A study preference", sourceTurnIds: [prior.turnId], expiresAt,
  });
  const [source] = await f.sql<{ id: string }[]>`INSERT INTO opening_sources
    (id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
    VALUES (${randomUUID()},${f.scope.workspaceId},'notes.txt','text/plain',1,${"a".repeat(64)},0,'uploaded','ready') RETURNING id`;
  await courses.addAssetMembership({ workspaceId: f.scope.workspaceId, courseId: courseA.id, assetType: "source",
    assetId: source!.id, role: "core", visibility: "course", purpose: "teaching" });
  await f.sql`UPDATE opening_turns SET source_ids=ARRAY[${source!.id}]::uuid[],
    source_versions=jsonb_build_object(${source!.id}::text,0) WHERE id=${prior.turnId}`;
  const refs = [{ sourceId: source!.id, sourceVersion: 0, memoryOnly: true }, { memoryDependencyIds: [memory.id] }];
  await f.sql`UPDATE opening_turns SET context_source_refs=${f.sql.json(refs)} WHERE id=${prior.assistantTurnId}`;
  const anchor = async (id: string, courseId: string | null) => f.sql`UPDATE opening_turns
    SET context_anchor=${courseId === null ? null : f.sql.json({ purpose: "learning_help", courseId })} WHERE id=${id}`;
  const history = () => jobs.loadHistoryContext(f.scope, current.turnId);
  const expected = { history: [{ role: "user", text: "previous question" }, { role: "assistant", text: "step two" }],
    sourceRefs: [{ sourceId: source!.id, sourceVersion: 0 }], memoryIds: [memory.id], temporaryMemoryExpiresAt: expiresAt };

  await anchor(prior.turnId, courseA.id.toUpperCase());
  await anchor(current.turnId, courseA.id);
  expect(await history()).toEqual(expected);
  await anchor(current.turnId, null);
  expect(await history()).toEqual({ history: [], sourceRefs: [] });
  await anchor(current.turnId, courseB.id);
  expect(await history()).toEqual({ history: [], sourceRefs: [] });

  const memoryB = await createOpeningMemoryRepository(f.sql).proposeMemory(f.scope, {
    courseId: courseB.id, text: "Course B study preference", sourceTurnIds: [current.turnId], expiresAt,
  });
  await f.sql`UPDATE opening_turns SET created_at=now()-interval '30 minutes' WHERE id=${current.turnId}`;
  await f.sql`UPDATE opening_turns SET status='complete', text='Course B answer',
    context_source_refs=${f.sql.json([{ memoryDependencyIds: [memoryB.id] }])} WHERE id=${current.assistantTurnId}`;
  const third = await repo.appendSavedTurn({ scope: f.scope, conversationId: c.id, text: "Continue course B", mode: "hint",
    clientKey: randomUUID(), sourceIds: [], learningSessionId: null, currentPage: null, chunkId: null });
  await anchor(third.turnId, courseB.id);
  expect(await jobs.loadHistoryContext(f.scope, third.turnId)).toEqual({
    history: [{ role: "user", text: "continue" }, { role: "assistant", text: "Course B answer" }],
    sourceRefs: [], memoryIds: [memoryB.id], temporaryMemoryExpiresAt: expiresAt,
  });
  await f.sql`UPDATE opening_memories SET status='deleted' WHERE id=${memory.id}`;
  expect(await jobs.loadHistoryContext(f.scope, third.turnId)).toEqual({ history: [], sourceRefs: [] });
  await f.sql`UPDATE opening_memories SET status='active' WHERE id=${memory.id}`;

  await f.sql`UPDATE opening_conversations SET course_id=${courseA.id} WHERE id=${c.id}`;
  expect(await history()).toEqual(expected);
  await f.sql`UPDATE opening_memories SET expires_at=now() - interval '1 second' WHERE id=${memory.id}`;
  expect(await history()).toEqual({ history: [], sourceRefs: [] });
  await f.sql`UPDATE opening_memories SET expires_at=${expiresAt}, status='deleted' WHERE id=${memory.id}`;
  expect(await history()).toEqual({ history: [], sourceRefs: [] });
  await f.sql`UPDATE opening_memories SET status='active' WHERE id=${memory.id}`;
  await courses.setArchived({ ...f.scope, courseId: courseA.id, archived: true });
  expect(await history()).toEqual({ history: [], sourceRefs: [] });
});
