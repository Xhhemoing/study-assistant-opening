import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOpeningMemoryRepository, createOpeningPrivacyRepository, createOpeningSourceChunksRepository } from "@aistudy/database";
import { readOpeningSourceContent } from "../../packages/database/src/repositories/opening-source-content";
import { lockWorkspaceLearningHistory } from "../../packages/database/src/repositories/opening-learning-facts";
import { openRaceSession } from "./opening-race-helpers";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
let f: OpeningFixture;
beforeAll(async () => { f = await createOpeningFixture(); });
afterAll(async () => { await f?.close(); });
async function seed(scope = f.scope) {
  const id = randomUUID();
  await f.sql`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state) VALUES
    (${id},${scope.workspaceId},'notes.pdf','application/pdf',8,${'ab'.repeat(32)},1,'uploaded','running')`;
  return id;
}
const chunk = (text: string, page = 1) => ({ text, page, slideLabel: null, startMs: null, endMs: null, imageObjectKey: null });
function barrier() {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  return { ready, release };
}

// Wrap only BEGIN: all repository statements use real PG, with transaction-local
// diagnostic bounds. Independent max:1 sessions give stable observable PIDs.
function boundedTransactions(sql: Sql, before?: (tx: TransactionSql) => Promise<void>): Sql {
  return new Proxy(sql, { get(target, property) {
    if (property !== "begin") return Reflect.get(target, property);
    return (callback: (tx: TransactionSql) => Promise<unknown>) => target.begin(async tx => {
      await tx`SET LOCAL lock_timeout='1500ms'`;
      await tx`SET LOCAL statement_timeout='2000ms'`;
      if (before) await before(tx);
      return callback(tx);
    });
  } });
}

async function parseJob(sourceId: string) {
  const id = randomUUID(), token = randomUUID();
  const [workspace] = await f.sql`SELECT privacy_epoch FROM workspaces WHERE id=${f.scope.workspaceId}`;
  const privacyEpoch = Number(workspace!.privacy_epoch);
  await f.sql`INSERT INTO opening_jobs(id,workspace_id,owner_user_id,key,kind,payload,state,claim_token,privacy_epoch)
    VALUES(${id},${f.scope.workspaceId},${f.scope.ownerUserId},${id},'parse',
      ${f.sql.json({ sourceId, sourceVersion: 1 })},'running',${token},${privacyEpoch})`;
  return { ...f.scope, jobExecution: { id, token, privacyEpoch } };
}

async function semanticState(sourceId: string) {
  return {
    sources: await f.sql`SELECT * FROM opening_sources WHERE id=${sourceId}`,
    chunks: await f.sql`SELECT * FROM opening_source_chunks WHERE source_id=${sourceId} ORDER BY id`,
    knowledge: await f.sql`SELECT * FROM opening_course_knowledge WHERE source_versions ? ${sourceId}`,
    jobs: await f.sql`SELECT * FROM opening_jobs WHERE payload->>'sourceId'=${sourceId} ORDER BY id`,
    outbox: await f.sql`SELECT * FROM opening_outbox WHERE payload->>'sourceId'=${sourceId} ORDER BY id`,
  };
}

// A valid legacy graph makes a premature definition write observable too.
async function legacyGraph(sourceId: string, scope = f.scope) {
  const courseId = randomUUID(), nodeId = randomUUID(), chunkId = randomUUID();
  await f.sql`INSERT INTO opening_source_chunks(id,source_id,source_version,page,text)
    VALUES(${chunkId},${sourceId},1,1,'original evidence')`;
  await f.sql`INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability)
    SELECT id,version,workspace_id,bytes,sha256,'available' FROM opening_sources WHERE id=${sourceId}`;
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug)
    VALUES(${courseId},${scope.workspaceId},'Parser history test',${courseId})`;
  await f.sql`INSERT INTO course_asset_memberships(id,workspace_id,course_id,asset_type,asset_id,role,sort_order,visibility)
    VALUES(${randomUUID()},${scope.workspaceId},${courseId},'source',${sourceId},'core',0,'course')`;
  const snapshot = { courseId, version: 1, nodes: [{ id: nodeId, courseId, label: 'Concept', kind: 'concept',
    evidenceChunkIds: [chunkId], status: 'supported' }], edges: [] };
  await f.sql`INSERT INTO opening_course_knowledge(workspace_id,owner_user_id,course_id,version,snapshot,source_versions)
    VALUES(${scope.workspaceId},${scope.ownerUserId},${courseId},1,${f.sql.json(snapshot)},${f.sql.json({ [sourceId]: 1 })})`;
  return { courseId, nodeId, chunkId };
}

async function historyRace(privacy: boolean) {
  const sourceId = await seed(), graph = await legacyGraph(sourceId), scope = await parseJob(sourceId);
  // Commit the counter before holding it, so the parser waits on SELECT FOR UPDATE,
  // rather than on an uncommitted counter INSERT's unique constraint.
  await f.sql.begin(tx => lockWorkspaceLearningHistory(tx, scope));
  const before = await semanticState(sourceId);
  const historyBefore = await f.sql`SELECT revision FROM opening_workspace_history_revisions WHERE workspace_id=${scope.workspaceId}`;
  const holder = openRaceSession(), parser = openRaceSession();
  const held = barrier(), release = barrier(), started = barrier();
  let holding: Promise<unknown> | undefined, parsing: Promise<unknown> | undefined;
  try {
    await Promise.all([holder.ready, parser.ready]);
    holding = boundedTransactions(holder.sql).begin(async tx => {
      await lockWorkspaceLearningHistory(tx, scope);
      held.release();
      await release.ready;
      if (privacy) {
        // The real privacy repository re-enters this transaction via a savepoint;
        // it takes history then workspace UPDATE and increments the epoch itself.
        const nested = new Proxy(holder.sql, { get(target, property) {
          return property === 'begin' ? (callback: (inner: TransactionSql) => Promise<unknown>) => tx.savepoint(callback)
            : Reflect.get(target, property);
        } });
        await createOpeningPrivacyRepository(tx).recordExclusions(nested, scope,
          { sourceIds: [sourceId], memoryId: randomUUID(), deletedAt: new Date() });
      } else {
        // Prove the blocked parser has not taken workspace, job, graph or source
        // business locks. NOWAIT is diagnostic, not the production lock policy.
        await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} FOR UPDATE NOWAIT`;
        await tx`SELECT id FROM opening_jobs WHERE id=${scope.jobExecution.id} FOR UPDATE NOWAIT`;
        await tx`SELECT course_id FROM opening_course_knowledge WHERE course_id=${graph.courseId} FOR UPDATE NOWAIT`;
        await tx`SELECT id FROM opening_sources WHERE id=${sourceId} FOR UPDATE NOWAIT`;
      }
    });
    holding.catch(held.release);
    await Promise.race([held.ready, holding]);
    const startedAt = Date.now();
    parsing = createOpeningSourceChunksRepository(boundedTransactions(parser.sql, async () => { started.release(); }))
      .replaceChunks(scope, { sourceId, sourceVersion: 1, chunks: [chunk('replacement')] });
    let finished = false;
    const outcome = parsing.then(() => ({ code: 'ok' }), error => ({ code: error.code, message: error.message }))
      .finally(() => { finished = true; });
    await started.ready;
    let blocked = false;
    // Poll actual lock state without sleeps or an elapsed-time overlap assumption.
    while (Date.now() - startedAt < 1000) {
      const [wait] = await f.sql`SELECT a.query,${holder.pid}::int=ANY(pg_blocking_pids(a.pid)) AS blocked
        FROM pg_stat_activity a WHERE a.pid=${parser.pid}
          AND EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND NOT l.granted)`;
      if (wait?.blocked) {
        expect(wait.query).toMatch(/SELECT revision FROM opening_workspace_history_revisions/);
        blocked = true;
        break;
      }
      if (finished) break;
    }
    expect(blocked, 'parser must wait at the workspace history row, before its job gate').toBe(true);
    const locks = await f.sql`SELECT c.relname AS relation,l.mode FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
      WHERE l.pid=${parser.pid} AND l.granted AND l.locktype='relation' AND c.relkind='r'
        AND l.mode IN ('RowShareLock','RowExclusiveLock') ORDER BY c.relname,l.mode`;
    expect(locks.length).toBeGreaterThan(0);
    expect(locks.every(lock => lock.relation === 'opening_workspace_history_revisions')).toBe(true);
    expect(await semanticState(sourceId)).toEqual(before);
    console.info('[source-chunks history barrier]', { privacy, waitMs: Date.now() - startedAt, locks });
    release.release();
    await holding;
    const result = await outcome;
    console.info('[source-chunks history released]', { privacy, totalMs: Date.now() - startedAt, result });
    if (privacy) {
      const afterPrivacy = await semanticState(sourceId);
      expect(result).toMatchObject({ code: 'CONFLICT', message: 'job execution is no longer current' });
      expect(afterPrivacy).toEqual(before);
      expect(await semanticState(sourceId)).toEqual(afterPrivacy);
      expect(await f.sql`SELECT privacy_epoch FROM workspaces WHERE id=${scope.workspaceId}`)
        .toMatchObject([{ privacy_epoch: scope.jobExecution.privacyEpoch + 1 }]);
      const [historyAfter] = await f.sql`SELECT revision FROM opening_workspace_history_revisions WHERE workspace_id=${scope.workspaceId}`;
      expect(Number(historyAfter!.revision)).toBe(Number(historyBefore[0]!.revision) + 1);
    } else {
      expect(result).toEqual({ code: 'ok' });
      expect((await createOpeningSourceChunksRepository(f.sql).listChunks(scope, sourceId)).map(row => row.text)).toEqual(['replacement']);
      const [knowledge] = await f.sql`SELECT node_definitions FROM opening_course_knowledge WHERE course_id=${graph.courseId}`;
      expect(knowledge!.node_definitions).toHaveProperty(graph.nodeId);
      expect(await f.sql`SELECT revision FROM opening_workspace_history_revisions WHERE workspace_id=${scope.workspaceId}`).toEqual(historyBefore);
    }
  } finally {
    release.release();
    await Promise.allSettled([holding, parsing].filter(Boolean));
    await Promise.all([holder.sql.end({ timeout: 5 }), parser.sql.end({ timeout: 5 })]);
  }
}

describe('source chunks workspace history fence', () => {
  it('waits on same-workspace history before taking job or business locks, then publishes with the original valid token', async () => {
    await historyRace(false);
  });
  it('lets the history holder commit real privacy exclusion, then rejects the original epoch without parser side effects', async () => {
    await historyRace(true);
  });
  it.each(['token', 'state', 'epoch'] as const)('rolls back even the newly ensured history counter when the original job %s is stale', async stale => {
    const isolated = await createOpeningFixture();
    try {
      const sourceId = await seed(isolated.scope);
      await legacyGraph(sourceId, isolated.scope);
      const id = randomUUID(), token = randomUUID();
      await f.sql`INSERT INTO opening_jobs(id,workspace_id,owner_user_id,key,kind,payload,state,claim_token,privacy_epoch)
        VALUES(${id},${isolated.scope.workspaceId},${isolated.scope.ownerUserId},${id},'parse',
          ${f.sql.json({ sourceId, sourceVersion: 1 })},${stale === 'state' ? 'cancelled' : 'running'},${token},0)`;
      const before = await semanticState(sourceId);
      await expect(createOpeningSourceChunksRepository(f.sql).replaceChunks({ ...isolated.scope,
        jobExecution: { id, token: stale === 'token' ? randomUUID() : token, privacyEpoch: stale === 'epoch' ? 1 : 0 } },
      { sourceId, sourceVersion: 1, chunks: [chunk('must not publish')] })).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(await semanticState(sourceId)).toEqual(before);
      expect(await f.sql`SELECT * FROM opening_workspace_history_revisions WHERE workspace_id=${isolated.scope.workspaceId}`).toEqual([]);
    } finally { await isolated.close(); }
  });
  it('does not block a different workspace and owner, and keeps identical replay identities, definitions and index work', async () => {
    await f.sql.begin(tx => lockWorkspaceLearningHistory(tx, f.scope));
    const holder = openRaceSession(), parser = openRaceSession();
    const held = barrier(), release = barrier();
    let holding: Promise<unknown> | undefined;
    try {
      await Promise.all([holder.ready, parser.ready]);
      holding = boundedTransactions(holder.sql).begin(async tx => {
        await lockWorkspaceLearningHistory(tx, f.scope); held.release(); await release.ready;
      });
      holding.catch(held.release);
      await Promise.race([held.ready, holding]);
      const otherId = await seed(f.otherScope), repo = createOpeningSourceChunksRepository(boundedTransactions(parser.sql));
      await repo.replaceChunks(f.otherScope, { sourceId: otherId, sourceVersion: 1, chunks: [chunk('other owner')] });
      expect((await repo.listChunks(f.otherScope, otherId))[0]?.text).toBe('other owner');
    } finally {
      release.release(); await holding;
      await Promise.all([holder.sql.end({ timeout: 5 }), parser.sql.end({ timeout: 5 })]);
    }
    const sourceId = await seed(), graph = await legacyGraph(sourceId), scope = await parseJob(sourceId);
    const repo = createOpeningSourceChunksRepository(f.sql);
    const input = { sourceId, sourceVersion: 1, chunks: [chunk('original evidence')] };
    await repo.replaceChunks(scope, input);
    const first = await semanticState(sourceId);
    expect(first.chunks[0]?.id).toBe(graph.chunkId);
    expect(first.knowledge[0]?.node_definitions).toHaveProperty(graph.nodeId);
    await repo.replaceChunks(scope, input);
    const replay = await semanticState(sourceId);
    expect(replay.chunks).toEqual(first.chunks);
    expect(replay.knowledge).toEqual(first.knowledge);
    expect(replay.jobs.filter(job => job.kind === 'index-source')).toHaveLength(2);
    expect(replay.outbox).toHaveLength(2);
    expect(replay.jobs.filter(job => job.kind === 'index-source').every(job =>
      job.privacy_epoch === scope.jobExecution.privacyEpoch && job.payload.sourceVersion === 1)).toBe(true);
  });
});

describe("source chunks usability", () => {
  it("retains unchanged identities on extension but removes changed or omitted chunks", async () => {
    const id = await seed(), repo = createOpeningSourceChunksRepository(f.sql);
    await repo.replaceChunks(f.scope, { sourceId: id, sourceVersion: 1, chunks: [chunk("saved"), chunk("old", 2)] });
    const before = await repo.listChunks(f.scope, id);
    await repo.replaceChunks(f.scope, { sourceId: id, sourceVersion: 1,
      chunks: [chunk("saved"), chunk("new", 2), chunk("added", 3)] });
    const extended = await repo.listChunks(f.scope, id);
    expect(extended[0]).toEqual(before[0]);
    expect(extended[1]!.id).not.toBe(before[1]!.id);
    expect(extended.map(row => row.text)).toEqual(["saved", "new", "added"]);
    await repo.replaceChunks(f.scope, { sourceId: id, sourceVersion: 1, chunks: [chunk("saved")] });
    expect(await repo.listChunks(f.scope, id)).toEqual([before[0]]);
  });
  it("reads only the requested owned version and page, preserves empty pages and bounds body output", async () => {
    const id = await seed(), repo = createOpeningSourceChunksRepository(f.sql);
    await repo.replaceChunks(f.scope, { sourceId: id, sourceVersion: 1, chunks: [chunk(""), chunk("B".repeat(21000), 2)] });
    const content = await readOpeningSourceContent(f.sql, f.scope, id, { version: 1, page: 2 });
    expect(content).toMatchObject({ version: 1, currentVersion: 1, page: 2, pages: [1,2], readablePages: 1, characters: 21000, truncated: true });
    expect(content.text.length).toBe(20000);
    expect((await readOpeningSourceContent(f.sql, f.scope, id, { version: 1, page: 1 })).text).toBe("");
    await expect(readOpeningSourceContent(f.sql, f.otherScope, id, { version: 1, page: 2 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(readOpeningSourceContent(f.sql, { ...f.scope, ownerUserId: f.otherScope.ownerUserId }, id, { version: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(readOpeningSourceContent(f.sql, f.scope, id, { version: 0 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(readOpeningSourceContent(f.sql, f.scope, id, { page: 99 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await f.sql`UPDATE opening_sources SET version=2,parse_state='running' WHERE id=${id}`;
    expect(await readOpeningSourceContent(f.sql, f.scope, id, { version: 1, page: 2 })).toMatchObject({ version: 1, currentVersion: 2 });
    await expect(readOpeningSourceContent(f.sql, f.scope, id, {})).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it.each([{ chunks: [] }, { chunks: [chunk(" \n\t")] }])("does not commit ready or erase prior chunks when parsing has no body (%#)", async ({ chunks }) => {
    const id = await seed(), repo = createOpeningSourceChunksRepository(f.sql);
    await repo.replaceChunks(f.scope, { sourceId: id, sourceVersion: 1, chunks: [chunk("earlier readable body")] });
    await expect(repo.replaceChunks(f.scope, { sourceId: id, sourceVersion: 1, chunks })).rejects.toThrow("no readable text");
    expect((await repo.listChunks(f.scope, id)).map(row => row.text)).toEqual(["earlier readable body"]);
  });
  it("preserves ready and pinned historical owner reads after a real memory AI exclusion without asset deletion", async () => {
    const id = await seed(), repo = createOpeningSourceChunksRepository(f.sql);
    await f.sql`UPDATE opening_sources SET parse_state='ready' WHERE id=${id}`;
    await f.sql`INSERT INTO opening_source_chunks(source_id,source_version,page,text)
      VALUES(${id},1,1,'PRIVATE-EXCLUDED-CONTENT')`;
    const conversationId = randomUUID(), turnId = randomUUID();
    await f.sql`INSERT INTO opening_conversations(id,workspace_id,owner_user_id,title)
      VALUES(${conversationId},${f.scope.workspaceId},${f.scope.ownerUserId},'privacy action')`;
    await f.sql`INSERT INTO opening_turns(id,workspace_id,conversation_id,role,text,mode,status,source_ids)
      VALUES(${turnId},${f.scope.workspaceId},${conversationId},'user','origin','listen','complete',${[id]})`;
    const memories = createOpeningMemoryRepository(f.sql);
    const memory = await memories.proposeMemory(f.scope, { text: 'private memory', sourceTurnIds: [turnId], expiresAt: null });
    await memories.deleteMemory(f.scope, { id: memory.id, expectedVersion: memory.version,
      deleteSourceText: false, clientKey: randomUUID() });
    const privacy = createOpeningPrivacyRepository(f.sql);
    expect(await privacy.isSourceExcluded(f.scope, id)).toBe(true);
    expect(await privacy.isSourceAssetDeleted(f.scope, id)).toBe(false);
    expect((await repo.listForSources(f.scope, [id])).map(row => row.text)).toEqual(['PRIVATE-EXCLUDED-CONTENT']);
    expect(await readOpeningSourceContent(f.sql, f.scope, id, { version: 1, page: 1 }))
      .toMatchObject({ version: 1, currentVersion: 1, text: 'PRIVATE-EXCLUDED-CONTENT' });
    await f.sql`UPDATE opening_sources SET version=2,parse_state='queued' WHERE id=${id}`;
    expect(await readOpeningSourceContent(f.sql, f.scope, id, { version: 1, page: 1 }))
      .toMatchObject({ version: 1, currentVersion: 2, text: 'PRIVATE-EXCLUDED-CONTENT' });
    await expect(readOpeningSourceContent(f.sql, f.scope, id, {})).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(readOpeningSourceContent(f.sql, { ...f.scope, ownerUserId: f.otherScope.ownerUserId }, id,
      { version: 1 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await repo.listForSources(f.scope, [id])).toEqual([]);
  });
  it("never opens raw unpublished PDF chunks just because a source is queued, running, failed or not_started", async () => {
    const id = await seed(), repo = createOpeningSourceChunksRepository(f.sql);
    await f.sql`INSERT INTO opening_source_chunks(source_id,source_version,page,text)
      VALUES(${id},1,1,'unpublished renderer output')`;
    for (const state of ["queued", "running", "failed", "not_started"]) {
      await f.sql`UPDATE opening_sources SET parse_state=${state} WHERE id=${id}`;
      await expect(readOpeningSourceContent(f.sql, f.scope, id, {})).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await repo.listForSources(f.scope, [id])).toEqual([]);
    }
  });
  it("preserves blank physical pages and already-published tutor text across a later failed retry", async () => {
    const id = await seed(), repo = createOpeningSourceChunksRepository(f.sql);
    await repo.replaceChunks(f.scope, { sourceId: id, sourceVersion: 1, chunks: [chunk(""), chunk("actual body", 2)] });
    expect((await repo.listChunks(f.scope, id)).map(row => row.page)).toEqual([1, 2]);
    expect((await repo.listForSources(f.scope, [id])).map(row => row.text)).toEqual(["actual body"]);
    await f.sql`UPDATE opening_sources SET parse_state='failed' WHERE id=${id}`;
    expect((await repo.listForSources(f.scope, [id])).map(row => row.text)).toEqual(["actual body"]);
    expect(await repo.listForSources(f.otherScope, [id])).toEqual([]);
  });
});
