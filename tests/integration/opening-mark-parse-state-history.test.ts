import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOpeningSourceChunksRepository, createOpeningSourceRepository, OpeningSourceError } from "@aistudy/database";
import { lockWorkspaceLearningHistory } from "../../packages/database/src/repositories/opening-learning-facts";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { openRaceSession } from "./opening-race-helpers";

let f: OpeningFixture;
beforeEach(async () => { f = await createOpeningFixture(); });
afterEach(async () => { await f?.close(); });
const staleError = { code: "CONFLICT", message: "job execution is no longer current" };
async function seed(scope = f.scope) {
  const id = randomUUID();
  await f.sql`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
    VALUES(${id},${scope.workspaceId},'notes.pdf','application/pdf',8,${"a".repeat(64)},1,'uploaded','running')`;
  return id;
}
async function jobScope(sourceId: string, scope = f.scope) {
  const id = randomUUID(), token = randomUUID();
  const [workspace] = await f.sql`SELECT privacy_epoch FROM workspaces WHERE id=${scope.workspaceId}`;
  const privacyEpoch = Number(workspace!.privacy_epoch);
  await f.sql`INSERT INTO opening_jobs(id,workspace_id,owner_user_id,key,kind,payload,state,claim_token,privacy_epoch)
    VALUES(${id},${scope.workspaceId},${scope.ownerUserId},${id},'parse',${f.sql.json({ sourceId })},'running',${token},${privacyEpoch})`;
  return { ...scope, jobExecution: { id, token, privacyEpoch } };
}
async function graph(sourceId: string) {
  const courseId = randomUUID(), nodeId = randomUUID(), chunkId = randomUUID();
  await f.sql`INSERT INTO opening_source_chunks(id,source_id,source_version,page,text)
    VALUES(${chunkId},${sourceId},1,1,'old nonempty evidence')`;
  await f.sql`INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability)
    SELECT id,version,workspace_id,bytes,sha256,'available' FROM opening_sources WHERE id=${sourceId}`;
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug)
    VALUES(${courseId},${f.scope.workspaceId},'Old graph',${courseId})`;
  await f.sql`INSERT INTO course_asset_memberships(id,workspace_id,course_id,asset_type,asset_id,role,sort_order,visibility)
    VALUES(${randomUUID()},${f.scope.workspaceId},${courseId},'source',${sourceId},'core',0,'course')`;
  const snapshot = { courseId, version: 1, nodes: [{ id: nodeId, courseId, label: 'Old concept', kind: 'concept',
    evidenceChunkIds: [chunkId], status: 'supported' }], edges: [] };
  await f.sql`INSERT INTO opening_course_knowledge(workspace_id,owner_user_id,course_id,version,snapshot,source_versions)
    VALUES(${f.scope.workspaceId},${f.scope.ownerUserId},${courseId},1,${f.sql.json(snapshot)},${f.sql.json({ [sourceId]: 1 })})`;
}
async function state(sourceId: string) {
  return {
    source: await f.sql`SELECT * FROM opening_sources WHERE id=${sourceId}`,
    chunks: await f.sql`SELECT * FROM opening_source_chunks WHERE source_id=${sourceId} ORDER BY id`,
    versions: await f.sql`SELECT * FROM opening_source_versions WHERE source_id=${sourceId} ORDER BY version`,
    graph: await f.sql`SELECT * FROM opening_course_knowledge WHERE source_versions ? ${sourceId}`,
    memberships: await f.sql`SELECT * FROM course_asset_memberships WHERE asset_id=${sourceId}`,
    jobs: await f.sql`SELECT * FROM opening_jobs WHERE workspace_id=${f.scope.workspaceId} ORDER BY id`,
    outbox: await f.sql`SELECT * FROM opening_outbox WHERE workspace_id=${f.scope.workspaceId} ORDER BY id`,
    eligibility: await f.sql`SELECT * FROM opening_learning_eligibility WHERE workspace_id=${f.scope.workspaceId}`,
  };
}
const history = () => f.sql`SELECT * FROM opening_workspace_history_revisions WHERE workspace_id=${f.scope.workspaceId} ORDER BY owner_user_id`;
function barrier() {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  return { ready, release };
}

// Only diagnostic interception; every statement and failure still executes on PG.
function observed(sql: Sql, hook: (query: string, tx: TransactionSql, phase: "before" | "after") => Promise<void>): Sql {
  return new Proxy(sql, { get(target, property) {
    if (property !== "begin") return Reflect.get(target, property);
    return (callback: (tx: TransactionSql) => Promise<unknown>) => target.begin(tx => callback(new Proxy(tx, {
      apply(targetTx, thisArg, args: [TemplateStringsArray, ...unknown[]]) {
        const query = args[0].join("?").replace(/\s+/g, " ").trim();
        return (async () => {
          await hook(query, tx, "before");
          const rows = await Reflect.apply(targetTx, thisArg, args);
          await hook(query, tx, "after");
          return rows;
        })();
      },
    })));
  } });
}
async function blocked(writer: number, holder: number, finished: () => boolean) {
  const deadline = Date.now() + 1800;
  do {
    const [wait] = await f.sql`SELECT a.query FROM pg_stat_activity a WHERE a.pid=${writer}
      AND ${holder}=ANY(pg_blocking_pids(a.pid))
      AND EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND NOT l.granted)`;
    if (wait) return String(wait.query);
  } while (!finished() && Date.now() < deadline);
  throw new Error("markParseState did not block on history before business locks");
}

describe("markParseState PG workspace history fence", () => {
  it.each([
    { job: true, mode: "lazy" }, { job: false, mode: "lazy" },
    { job: true, mode: "nonzero" }, { job: false, mode: "nonzero" },
    { job: true, mode: "other-workspace" }, { job: false, mode: "other-workspace" },
  ])("history barrier job=$job mode=$mode", async ({ job, mode }) => {
    const sourceId = await seed();
    await graph(sourceId);
    const execution = await jobScope(sourceId);
    const scope = job ? execution : { ...f.scope, ownerUserId: "" };
    if (mode !== "lazy") {
      await f.sql.begin(tx => lockWorkspaceLearningHistory(tx, f.scope));
      await f.sql`UPDATE opening_workspace_history_revisions SET revision=19 WHERE workspace_id=${f.scope.workspaceId}`;
    }
    const before = await state(sourceId);
    expect(before.graph).toHaveLength(1);
    expect(before.chunks).toHaveLength(1);
    const holder = openRaceSession(), writer = openRaceSession();
    const held = barrier(), release = barrier();
    let txHeld!: TransactionSql;
    let holding: Promise<unknown> | undefined, writing: Promise<unknown> | undefined;
    try {
      await Promise.all([holder.ready, writer.ready]);
      holding = holder.sql.begin(async tx => {
        await lockWorkspaceLearningHistory(tx, mode === "other-workspace" ? f.otherScope : f.scope);
        txHeld = tx; held.release(); await release.ready;
      });
      holding.catch(held.release);
      await Promise.race([held.ready, holding]);
      let finished = false;
      writing = createOpeningSourceRepository(writer.sql).markParseState(scope, sourceId, "ready");
      writing.then(() => { finished = true; }, () => { finished = true; });
      if (mode !== "other-workspace") {
        const query = await blocked(writer.pid, holder.pid, () => finished);
        expect(query).toContain("opening_workspace_history_revisions");
        const locks = await f.sql`SELECT c.relname,l.mode FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
          WHERE l.pid=${writer.pid} AND l.granted AND l.locktype='relation' AND c.relkind='r'
            AND l.mode IN ('RowShareLock','RowExclusiveLock')`;
        expect(locks.length).toBeGreaterThan(0);
        expect(locks.every(l => l.relname === "opening_workspace_history_revisions")).toBe(true);
        await txHeld`SELECT id FROM workspaces WHERE id=${f.scope.workspaceId} FOR UPDATE NOWAIT`;
        await txHeld`SELECT id FROM opening_jobs WHERE id=${execution.jobExecution.id} FOR UPDATE NOWAIT`;
        await txHeld`SELECT id FROM opening_sources WHERE id=${sourceId} FOR UPDATE NOWAIT`;
        expect(await state(sourceId)).toEqual(before);
        console.info("markParseState history barrier", { job, mode, ungranted: true, blockingPids: true, query, locks });
        release.release(); await holding;
      }
      await expect(writing).resolves.toMatchObject({ id: sourceId, parseState: "ready" });
      const after = await state(sourceId);
      expect(after.source[0]).toMatchObject({ ...before.source[0], parse_state: "ready", updated_at: expect.any(Date) });
      expect({ ...after, source: before.source }).toEqual(before);
      expect(await history()).toMatchObject([{ revision: mode === "lazy" ? "0" : "19" }]);
    } finally {
      release.release();
      await Promise.allSettled([holding, writing].filter(Boolean));
      await Promise.all([holder.sql.end({ timeout: 5 }), writer.sql.end({ timeout: 5 })]);
    }
  });

  it.each([true, false])("rolls back real UPDATE, graph and lazy history on later SQL failure (job=%s)", async job => {
    const sourceId = await seed(); await graph(sourceId);
    const scope = job ? await jobScope(sourceId) : f.scope;
    const before = await state(sourceId);
    let updated = false;
    const sql = observed(f.sql, async (query, tx, phase) => {
      if (query.startsWith("UPDATE opening_sources") && phase === "after") {
        expect(await tx`SELECT parse_state FROM opening_sources WHERE id=${sourceId}`).toEqual([{ parse_state: "ready" }]);
        updated = true;
        await tx`SELECT 1/0`;
      }
    });
    await expect(createOpeningSourceRepository(sql).markParseState(scope, sourceId, "ready")).rejects.toMatchObject({ code: "22012" });
    expect(updated).toBe(true);
    expect(await state(sourceId)).toEqual(before);
    expect(await history()).toEqual([]);
  });

  it.each(["epoch", "token", "state", "missing-job", "workspace-owner", "job-owner", "job-workspace"])(
    "keeps stale %s before missing/invalid source with no history ensure", async stale => {
      const sourceId = await seed(), scope = await jobScope(sourceId);
      if (stale === "epoch") scope.jobExecution.privacyEpoch++;
      if (stale === "token") scope.jobExecution.token = randomUUID();
      if (stale === "state") await f.sql`UPDATE opening_jobs SET state='cancelled' WHERE id=${scope.jobExecution.id}`;
      if (stale === "missing-job") await f.sql`DELETE FROM opening_jobs WHERE id=${scope.jobExecution.id}`;
      if (stale === "workspace-owner") scope.ownerUserId = f.otherScope.ownerUserId;
      if (stale === "job-owner") await f.sql`UPDATE opening_jobs SET owner_user_id=${f.otherScope.ownerUserId} WHERE id=${scope.jobExecution.id}`;
      if (stale === "job-workspace") await f.sql`UPDATE opening_jobs SET workspace_id=${f.otherScope.workspaceId} WHERE id=${scope.jobExecution.id}`;
      const before = await state(sourceId);
      for (const id of [randomUUID(), "bad-source-uuid"]) {
        await expect(createOpeningSourceRepository(f.sql).markParseState(scope, id, "ready")).rejects.toMatchObject(staleError);
      }
      expect(await state(sourceId)).toEqual(before);
      expect(await history()).toEqual([]);
    });

  it.each([true, false])("valid gate preserves source missing/invalid error and rollback (job=%s)", async job => {
    const sourceId = await seed(), scope = job ? await jobScope(sourceId) : f.scope;
    const id = randomUUID();
    const work = createOpeningSourceRepository(f.sql).markParseState(scope, id, "ready");
    await expect(work).rejects.toBeInstanceOf(OpeningSourceError);
    await expect(work).rejects.toMatchObject({ code: "NOT_FOUND", message: `Source not found: ${id}` });
    await expect(createOpeningSourceRepository(f.sql).markParseState(scope, "bad-source-uuid", "ready")).rejects.toMatchObject({ code: "22P02" });
    expect(await history()).toEqual([]);
  });

  it.each(["", "not-a-uuid", "other-owner"])("nonjob retains legacy supplied-owner %j behavior", async supplied => {
    const sourceId = await seed();
    await expect(createOpeningSourceRepository(f.sql).markParseState({ ...f.scope,
      ownerUserId: supplied === "other-owner" ? f.otherScope.ownerUserId : supplied }, sourceId, "ready"))
      .resolves.toMatchObject({ id: sourceId, parseState: "ready" });
    expect(await history()).toMatchObject([{ owner_user_id: f.scope.ownerUserId, revision: "0" }]);
  });

  it.each(["before-helper", "after-history"])("owner drift at %s rejects and rolls back instead of relocking another owner", async window => {
    const sourceId = await seed(); await graph(sourceId);
    // workspaces.owner_user_id is unique: free the second real owner first.
    await f.sql`DELETE FROM workspaces WHERE id=${f.otherScope.workspaceId}`;
    await f.sql`INSERT INTO opening_workspace_history_revisions(workspace_id,owner_user_id,revision)
      VALUES(${f.scope.workspaceId},${f.otherScope.ownerUserId},27)`;
    const before = await state(sourceId), historyBefore = await history();
    let changed = false;
    const sql = observed(f.sql, async (query, _tx, phase) => {
      const boundary = window === "before-helper"
        ? query.startsWith("SELECT owner_user_id") && !query.includes("FOR SHARE") && phase === "after"
        : query.startsWith("SELECT revision FROM opening_workspace_history_revisions") && phase === "after";
      if (!changed && boundary) {
        changed = true;
        await f.sql`UPDATE workspaces SET owner_user_id=${f.otherScope.ownerUserId} WHERE id=${f.scope.workspaceId}`;
      }
    });
    await expect(createOpeningSourceRepository(sql).markParseState({ ...f.scope, ownerUserId: "" }, sourceId, "ready"))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(changed).toBe(true);
    expect(await state(sourceId)).toEqual(before);
    expect(await history()).toEqual(historyBefore);
  });

  it.each(["before-helper", "after-history"])("job owner drift at %s retains original stale conflict", async window => {
    const sourceId = await seed(), scope = await jobScope(sourceId);
    await f.sql`DELETE FROM workspaces WHERE id=${f.otherScope.workspaceId}`;
    let changed = false;
    const sql = observed(f.sql, async (query, _tx, phase) => {
      const boundary = window === "before-helper"
        ? query.startsWith("SELECT id FROM opening_jobs") && !query.includes("FOR SHARE") && phase === "after"
        : query.startsWith("SELECT revision FROM opening_workspace_history_revisions") && phase === "after";
      if (!changed && boundary) {
        changed = true;
        await f.sql`UPDATE workspaces SET owner_user_id=${f.otherScope.ownerUserId} WHERE id=${f.scope.workspaceId}`;
      }
    });
    await expect(createOpeningSourceRepository(sql).markParseState(scope, "bad-source-uuid", "ready")).rejects.toMatchObject(staleError);
    expect(changed).toBe(true);
    expect(await history()).toEqual([]);
  });

  it.each([
    { window: "absent", invalid: false }, { window: "absent", invalid: true },
    { window: "before-helper", invalid: false }, { window: "before-helper", invalid: true },
    { window: "after-history", invalid: false }, { window: "after-history", invalid: true },
  ])("nonjob workspace deletion $window preserves missing/UUID error invalid=$invalid with no orphan counter", async ({ window, invalid }) => {
    // A workspace without business dependants lets the deletion commit at each
    // real read boundary, including after the non-FK history ensure.
    const id = invalid ? "bad-source-uuid" : randomUUID();
    let deleted = false;
    if (window === "absent") { await f.sql`DELETE FROM workspaces WHERE id=${f.scope.workspaceId}`; deleted = true; }
    const sql = observed(f.sql, async (query, _tx, phase) => {
      const boundary = window === "before-helper"
        ? query.startsWith("SELECT owner_user_id") && !query.includes("FOR SHARE") && phase === "after"
        : query.startsWith("SELECT revision FROM opening_workspace_history_revisions") && phase === "after";
      if (!deleted && boundary) { deleted = true; await f.sql`DELETE FROM workspaces WHERE id=${f.scope.workspaceId}`; }
    });
    const work = createOpeningSourceRepository(sql).markParseState({ ...f.scope, ownerUserId: "not-a-uuid" }, id, "ready");
    if (invalid) await expect(work).rejects.toMatchObject({ code: "22P02" });
    else {
      await expect(work).rejects.toBeInstanceOf(OpeningSourceError);
      await expect(work).rejects.toMatchObject({ code: "NOT_FOUND", message: `Source not found: ${id}` });
    }
    expect(deleted).toBe(true);
    expect(await history()).toEqual([]);
  });

  it.each(["before-helper", "after-history"])("job deletion at %s keeps stale ahead of invalid source and rolls history back", async window => {
    // The original gate requires a current job, not an existing source.
    const scope = await jobScope(randomUUID());
    let deleted = false;
    const sql = observed(f.sql, async (query, _tx, phase) => {
      const boundary = window === "before-helper"
        ? query.startsWith("SELECT id FROM opening_jobs") && !query.includes("FOR SHARE") && phase === "after"
        : query.startsWith("SELECT revision FROM opening_workspace_history_revisions") && phase === "after";
      if (!deleted && boundary) {
        deleted = true;
        await f.sql`DELETE FROM opening_jobs WHERE id=${scope.jobExecution.id}`;
        await f.sql`DELETE FROM workspaces WHERE id=${scope.workspaceId}`;
      }
    });
    await expect(createOpeningSourceRepository(sql).markParseState(scope, "bad-source-uuid", "ready")).rejects.toMatchObject(staleError);
    expect(deleted).toBe(true);
    expect(await history()).toEqual([]);
  });

  it("keeps chunk publication independent when the later parse-state phase is rejected", async () => {
    const sourceId = await seed(), scope = await jobScope(sourceId);
    await createOpeningSourceChunksRepository(f.sql).replaceChunks(scope, { sourceId, sourceVersion: 1,
      chunks: [{ page: 1, text: "committed first phase", slideLabel: null, startMs: null, endMs: null, imageObjectKey: null }] });
    const published = await state(sourceId), historyBefore = await history();
    expect(published.chunks[0]!.text).toBe("committed first phase");
    await f.sql`UPDATE workspaces SET privacy_epoch=privacy_epoch+1 WHERE id=${scope.workspaceId}`;
    await expect(createOpeningSourceRepository(f.sql).markParseState(scope, sourceId, "ready",
      { code: "PARSE_PARTIAL", message: "later phase", retryable: true })).rejects.toMatchObject(staleError);
    expect(await state(sourceId)).toEqual(published);
    expect(await history()).toEqual(historyBefore);
  });

  it.each(["epoch", "token", "missing-job"])("locked reread rejects %s changed while waiting on history", async change => {
    const sourceId = await seed(), scope = await jobScope(sourceId);
    await f.sql.begin(tx => lockWorkspaceLearningHistory(tx, f.scope));
    const before = await state(sourceId), historyBefore = await history();
    const holder = openRaceSession(), writer = openRaceSession();
    const held = barrier(), release = barrier();
    let heldTx!: TransactionSql;
    let holding: Promise<unknown> | undefined, writing: Promise<unknown> | undefined;
    try {
      await Promise.all([holder.ready, writer.ready]);
      holding = holder.sql.begin(async tx => { await lockWorkspaceLearningHistory(tx, f.scope); heldTx = tx; held.release(); await release.ready; });
      holding.catch(held.release); await Promise.race([held.ready, holding]);
      writing = createOpeningSourceRepository(writer.sql).markParseState(scope, "bad-source-uuid", "ready");
      let finished = false;
      const outcome = writing.then(() => null, error => error).finally(() => { finished = true; });
      expect(await blocked(writer.pid, holder.pid, () => finished)).toContain("opening_workspace_history_revisions");
      if (change === "epoch") await heldTx`UPDATE workspaces SET privacy_epoch=privacy_epoch+1 WHERE id=${scope.workspaceId}`;
      if (change === "token") await heldTx`UPDATE opening_jobs SET claim_token=${randomUUID()} WHERE id=${scope.jobExecution.id}`;
      if (change === "missing-job") await heldTx`DELETE FROM opening_jobs WHERE id=${scope.jobExecution.id}`;
      release.release(); await holding;
      expect(await outcome).toMatchObject(staleError);
      expect((await state(sourceId)).source).toEqual(before.source);
      expect(await history()).toEqual(historyBefore);
    } finally {
      release.release(); await Promise.allSettled([holding, writing].filter(Boolean));
      await Promise.all([holder.sql.end({ timeout: 5 }), writer.sql.end({ timeout: 5 })]);
    }
  });
});
