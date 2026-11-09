import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpeningSourceActionsRepository, createOpeningSourceRepository, OpeningSourceError } from "@aistudy/database";
import { lockWorkspaceLearningHistory } from "../../packages/database/src/repositories/opening-learning-facts";
import { openRaceSession } from "./opening-race-helpers";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let f: OpeningFixture;
beforeEach(async () => { f = await createOpeningFixture(); });
afterEach(async () => { await f?.close(); });
const input = (uploadId = randomUUID()) => ({ uploadId, name: "same.pdf", mime: "application/pdf" as const, bytes: 4, sha256: "a".repeat(64) });

describe("upload ticket history fence with real SQL", () => {
  const lease = "2030-01-01T00:00:00.000Z";
  const ticket = { uploadUrl: "/staging/ticket", expiresAt: lease };
  const gate = () => {
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    return { wait, release };
  };
  async function seed() {
    const id = randomUUID();
    await f.sql`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state,upload_url_expires_at)
      VALUES(${id},${f.scope.workspaceId},'ticket.pdf','application/pdf',4,${"a".repeat(64)},0,'pending','not_started',${new Date(lease)})`;
    return id;
  }
  async function unboundOwner() {
    const id = randomUUID();
    await f.sql`INSERT INTO users(id,email,display_name,password_hash) VALUES(${id},${`${id}@example.com`},'Ticket owner','test')`;
    return id;
  }
  const history = () => f.sql`SELECT * FROM opening_workspace_history_revisions WHERE workspace_id=${f.scope.workspaceId} ORDER BY owner_user_id`;
  const source = (id: string) => f.sql`SELECT * FROM opening_sources WHERE id=${id}`;
  async function blocked(waiter: number, holder: number, query: string) {
    let evidence;
    const deadline = Date.now() + 1500;
    do {
      const [row] = await f.sql`SELECT a.pid,a.query,pg_blocking_pids(a.pid) AS blockers FROM pg_stat_activity a
        WHERE a.pid=${waiter} AND ${holder}=ANY(pg_blocking_pids(a.pid))
        AND EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND NOT l.granted)`;
      if (row) { evidence = row; break; }
    } while (Date.now() < deadline);
    expect(evidence, `backend ${waiter} must wait on ${query}`).toBeDefined();
    expect(evidence!.query).toContain(query);
    console.info("ticket lock evidence", evidence);
  }
  async function hold(session: ReturnType<typeof openRaceSession>, lock: (tx: TransactionSql) => Promise<unknown>) {
    const stop = gate();
    let ready!: (tx: TransactionSql) => void, failed!: (error: unknown) => void;
    const opened = new Promise<TransactionSql>((resolve, reject) => { ready = resolve; failed = reject; });
    const done = session.sql.begin(async tx => { await lock(tx); ready(tx); await stop.wait; });
    done.catch(failed);
    return { tx: await opened, done, release: stop.release };
  }
  // Only interpose a deterministic scheduling barrier; all statements still run
  // against PostgreSQL in the repository's actual transaction.
  function afterQuery(sql: Sql, match: (query: string) => boolean, after: (tx: TransactionSql) => Promise<void>): Sql {
    return new Proxy(sql, { get(target, key, receiver) {
      if (key !== "begin") return Reflect.get(target, key, receiver);
      return (callback: (tx: TransactionSql) => Promise<unknown>) => target.begin(tx => callback(new Proxy(tx, {
        apply(tag, _this, args: [TemplateStringsArray, ...unknown[]]) {
          const query = args[0].join("?").replace(/\s+/g, " ").trim();
          const result = Reflect.apply(tag, tag, args);
          return match(query) ? Promise.resolve(result).then(async rows => { await after(tx); return rows; }) : result;
        },
      })));
    } });
  }

  it.each(["missing", "nonpending"])("preserves static %s before lazy history or sign", async state => {
    const id = await seed();
    if (state === "missing") await f.sql`DELETE FROM opening_sources WHERE id=${id}`;
    else await f.sql`UPDATE opening_sources SET upload_state='uploaded' WHERE id=${id}`;
    const sign = vi.fn(async () => ticket);
    const work = createOpeningSourceRepository(f.sql).issueUploadTicket(f.scope, id, sign);
    await expect(work).rejects.toBeInstanceOf(OpeningSourceError);
    await expect(work).rejects.toMatchObject(state === "missing"
      ? { code: "NOT_FOUND", message: "Source not found" }
      : { code: "CONFLICT", message: "Upload is no longer pending" });
    expect(sign).not.toHaveBeenCalled();
    expect(await history()).toEqual([]);
  });

  it.each(["lazy", "nonzero", "other-workspace"])("ticket barrier precedes workspace/source locks: %s", async mode => {
    const id = await seed();
    if (mode === "nonzero") {
      await f.sql.begin(tx => lockWorkspaceLearningHistory(tx, f.scope));
      await f.sql`UPDATE opening_workspace_history_revisions SET revision=23 WHERE workspace_id=${f.scope.workspaceId}`;
    }
    const before = await source(id);
    const holder = openRaceSession(), writer = openRaceSession();
    let held: Awaited<ReturnType<typeof hold>> | undefined, writing: Promise<unknown> | undefined;
    const sign = vi.fn(async () => ({ ...ticket, expiresAt: "2031-01-01T00:00:00.000Z" }));
    try {
      await Promise.all([holder.ready, writer.ready]);
      held = await hold(holder, tx => lockWorkspaceLearningHistory(tx, mode === "other-workspace" ? f.otherScope : f.scope));
      writing = createOpeningSourceRepository(writer.sql).issueUploadTicket(f.scope, id, sign);
      writing.catch(() => undefined);
      if (mode !== "other-workspace") {
        await blocked(writer.pid, holder.pid, "opening_workspace_history_revisions");
        await held.tx`SELECT id FROM workspaces WHERE id=${f.scope.workspaceId} FOR UPDATE NOWAIT`;
        await held.tx`SELECT id FROM opening_sources WHERE id=${id} FOR UPDATE NOWAIT`;
        expect(sign).not.toHaveBeenCalled();
        expect(await source(id)).toEqual(before);
        held.release();
        await held.done;
      }
      await writing;
      expect(sign).toHaveBeenCalledTimes(1);
      expect(await history()).toMatchObject([{ owner_user_id: f.scope.ownerUserId, revision: mode === "nonzero" ? "23" : "0" }]);
      const after = await source(id);
      expect(after).toEqual([{ ...before[0], upload_url_expires_at: new Date("2031-01-01T00:00:00.000Z") }]);
    } finally {
      held?.release();
      await Promise.allSettled([held?.done, writing]);
      await Promise.all([holder.sql.end({ timeout: 5 }), writer.sql.end({ timeout: 5 })]);
    }
  });

  it.each(["nonpending", "delete", "move"])("rechecks source after history wait: %s", async change => {
    const id = await seed(), holder = openRaceSession(), writer = openRaceSession();
    const sign = vi.fn(async () => ticket);
    let held: Awaited<ReturnType<typeof hold>> | undefined, writing: Promise<unknown> | undefined;
    try {
      await Promise.all([holder.ready, writer.ready]);
      held = await hold(holder, tx => lockWorkspaceLearningHistory(tx, f.scope));
      writing = createOpeningSourceRepository(writer.sql).issueUploadTicket(f.scope, id, sign);
      writing.catch(() => undefined);
      await blocked(writer.pid, holder.pid, "opening_workspace_history_revisions");
      if (change === "nonpending") await held.tx`UPDATE opening_sources SET upload_state='uploaded' WHERE id=${id}`;
      else if (change === "delete") await held.tx`DELETE FROM opening_sources WHERE id=${id}`;
      else await held.tx`UPDATE opening_sources SET workspace_id=${f.otherScope.workspaceId} WHERE id=${id}`;
      held.release();
      await held.done;
      await expect(writing).rejects.toBeInstanceOf(OpeningSourceError);
      await expect(writing).rejects.toMatchObject(change === "nonpending"
        ? { code: "CONFLICT", message: "Upload is no longer pending" }
        : { code: "NOT_FOUND", message: "Source not found" });
      expect(sign).not.toHaveBeenCalled();
      expect(await history()).toMatchObject([{ revision: "0" }]);
      if (change !== "delete") expect((await source(id))[0]!.upload_url_expires_at).toEqual(new Date(lease));
    } finally {
      held?.release();
      await Promise.allSettled([held?.done, writing]);
      await Promise.all([holder.sql.end({ timeout: 5 }), writer.sql.end({ timeout: 5 })]);
    }
  });

  it.each(["metadata", "nonpending", "delete", "move"])("uses only the source reread after source lock wait: %s", async change => {
    const id = await seed(), holder = openRaceSession(), writer = openRaceSession();
    const sign = vi.fn(async () => ticket);
    let held: Awaited<ReturnType<typeof hold>> | undefined, writing: Promise<unknown> | undefined;
    try {
      await Promise.all([holder.ready, writer.ready]);
      held = await hold(holder, tx => tx`SELECT id FROM opening_sources WHERE id=${id} FOR UPDATE`);
      writing = createOpeningSourceRepository(writer.sql).issueUploadTicket(f.scope, id, sign);
      writing.catch(() => undefined);
      await blocked(writer.pid, holder.pid, "opening_sources");
      expect(sign).not.toHaveBeenCalled();
      if (change === "metadata") await held.tx`UPDATE opening_sources SET name='fresh.pdf',bytes=9 WHERE id=${id}`;
      else if (change === "nonpending") await held.tx`UPDATE opening_sources SET upload_state='rejected' WHERE id=${id}`;
      else if (change === "delete") await held.tx`DELETE FROM opening_sources WHERE id=${id}`;
      else await held.tx`UPDATE opening_sources SET workspace_id=${f.otherScope.workspaceId} WHERE id=${id}`;
      held.release();
      await held.done;
      if (change === "metadata") {
        await expect(writing).resolves.toMatchObject({ source: { name: "fresh.pdf", bytes: 9 } });
        expect(sign).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: "fresh.pdf", bytes: 9 }));
        expect(await history()).toMatchObject([{ revision: "0" }]);
      } else {
        await expect(writing).rejects.toBeInstanceOf(OpeningSourceError);
        await expect(writing).rejects.toMatchObject(change === "nonpending"
          ? { code: "CONFLICT", message: "Upload is no longer pending" }
          : { code: "NOT_FOUND", message: "Source not found" });
        expect(sign).not.toHaveBeenCalled();
        expect(await history()).toEqual([]);
      }
    } finally {
      held?.release();
      await Promise.allSettled([held?.done, writing]);
      await Promise.all([holder.sql.end({ timeout: 5 }), writer.sql.end({ timeout: 5 })]);
    }
  });

  it.each(["before-helper", "after-history"])("rejects dynamic owner drift with rollback: %s", async window => {
    const id = await seed(), before = await source(id), newOwner = await unboundOwner();
    let changed = false;
    const sql = afterQuery(f.sql, query => !changed && (window === "before-helper"
      ? query.startsWith("SELECT owner_user_id FROM workspaces")
      : query.startsWith("SELECT revision FROM opening_workspace_history_revisions")), async () => {
      changed = true;
      await f.sql`UPDATE workspaces SET owner_user_id=${newOwner} WHERE id=${f.scope.workspaceId}`;
    });
    const sign = vi.fn(async () => ticket);
    await expect(createOpeningSourceRepository(sql).issueUploadTicket(f.scope, id, sign))
      .rejects.toMatchObject({ code: "CONFLICT", message: "Upload history coordination changed" });
    expect(changed).toBe(true);
    expect(sign).not.toHaveBeenCalled();
    expect(await history()).toEqual([]);
    expect(await source(id)).toEqual(before);
  });

  it.each(["before-helper", "after-history"])("preserves missing workspace error and rolls back lazy history: %s", async window => {
    const id = await seed();
    let deleted = false;
    const sql = afterQuery(f.sql, query => !deleted && (window === "before-helper"
      ? query.startsWith("SELECT owner_user_id FROM workspaces")
      : query.startsWith("SELECT revision FROM opening_workspace_history_revisions")), async () => {
      deleted = true;
      await f.sql`DELETE FROM workspaces WHERE id=${f.scope.workspaceId}`;
    });
    const sign = vi.fn(async () => ticket);
    await expect(createOpeningSourceRepository(sql).issueUploadTicket(f.scope, id, sign))
      .rejects.toMatchObject({ code: "NOT_FOUND", message: "Source not found" });
    expect(deleted).toBe(true);
    expect(sign).not.toHaveBeenCalled();
    expect(await history()).toEqual([]);
  });

  it("retains static wrong-owner (including non-UUID input) and moved-workspace ticket scope", async () => {
    const id = await seed(), sign = vi.fn(async () => ticket), repo = createOpeningSourceRepository(f.sql);
    await repo.issueUploadTicket({ ...f.scope, ownerUserId: "not-an-owner-uuid" }, id, sign);
    expect(await history()).toMatchObject([{ owner_user_id: f.scope.ownerUserId, revision: "0" }]);
    await f.sql`UPDATE opening_sources SET workspace_id=${f.otherScope.workspaceId} WHERE id=${id}`;
    await repo.issueUploadTicket({ ...f.otherScope, ownerUserId: f.scope.ownerUserId }, id, sign);
    const newOwner = await unboundOwner();
    await f.sql`UPDATE workspaces SET owner_user_id=${newOwner} WHERE id=${f.scope.workspaceId}`;
    const another = await seed();
    await repo.issueUploadTicket(f.scope, another, sign);
    expect(sign).toHaveBeenCalledTimes(3);
    expect(await history()).toHaveLength(2);
  });

  it("holds history, source and workspace FOR SHARE throughout await sign; pending reissues each sign once", async () => {
    const id = await seed(), newOwner = await unboundOwner();
    const writer = openRaceSession(), contender = openRaceSession(), owner = openRaceSession(), historian = openRaceSession();
    const signing = gate(), entered = gate();
    const sign = vi.fn(async () => { entered.release(); await signing.wait; return ticket; });
    let writing: Promise<unknown> | undefined, changing: Promise<unknown> | undefined, moving: Promise<unknown> | undefined, recording: Promise<unknown> | undefined;
    try {
      await Promise.all([writer.ready, contender.ready, owner.ready, historian.ready]);
      writing = createOpeningSourceRepository(writer.sql).issueUploadTicket(f.scope, id, sign);
      writing.catch(() => undefined);
      await Promise.race([entered.wait, writing.then(() => { throw new Error("ticket completed before signer barrier"); })]);
      changing = contender.sql.begin(tx => tx`UPDATE opening_sources SET upload_state='uploaded' WHERE id=${id}`);
      moving = owner.sql.begin(tx => tx`UPDATE workspaces SET owner_user_id=${newOwner} WHERE id=${f.scope.workspaceId}`);
      recording = historian.sql.begin(tx => lockWorkspaceLearningHistory(tx, f.scope));
      for (const work of [changing, moving, recording]) work.catch(() => undefined);
      await blocked(contender.pid, writer.pid, "UPDATE opening_sources");
      await blocked(owner.pid, writer.pid, "UPDATE workspaces");
      await blocked(historian.pid, writer.pid, "opening_workspace_history_revisions");
      expect((await source(id))[0]!.upload_state).toBe("pending");
      expect(await f.sql`SELECT owner_user_id FROM workspaces WHERE id=${f.scope.workspaceId}`)
        .toEqual([{ owner_user_id: f.scope.ownerUserId }]);
      signing.release();
      await Promise.all([writing, changing, moving, recording]);
      expect(sign).toHaveBeenCalledTimes(1);
      expect(await history()).toMatchObject([{ revision: "0" }]);
      // No global ticket dedup: two legitimate pending reissues each call sign.
      await f.sql`UPDATE opening_sources SET upload_state='pending' WHERE id=${id}`;
      const reissue = vi.fn(async () => ticket);
      const repo = createOpeningSourceRepository(f.sql);
      await repo.issueUploadTicket(f.scope, id, reissue);
      await repo.issueUploadTicket(f.scope, id, reissue);
      expect(reissue).toHaveBeenCalledTimes(2);
    } finally {
      signing.release();
      await Promise.allSettled([writing, changing, moving, recording]);
      await Promise.all([writer, contender, owner, historian].map(session => session.sql.end({ timeout: 5 })));
    }
  });

  it.each(["signer", "after-lease-sql"])("rolls back lazy history and lease on %s failure, not external signer effects", async failure => {
    const id = await seed(), before = await source(id), sentinel = new Error(failure);
    let externalTickets = 0, updatedInside = false;
    const sql = afterQuery(f.sql, query => failure === "after-lease-sql" && query.startsWith("UPDATE opening_sources SET upload_url_expires_at"), async tx => {
      const [inside] = await tx`SELECT upload_url_expires_at FROM opening_sources WHERE id=${id}`;
      expect(inside!.upload_url_expires_at).toEqual(new Date("2032-01-01T00:00:00.000Z"));
      updatedInside = true;
      // Fail in PostgreSQL after the actual lease UPDATE, not a mocked write.
      await tx`SELECT 1 / 0`;
    });
    const sign = vi.fn(async () => {
      if (failure === "signer") throw sentinel;
      externalTickets++;
      return { ...ticket, expiresAt: "2032-01-01T00:00:00.000Z" };
    });
    const work = createOpeningSourceRepository(sql).issueUploadTicket(f.scope, id, sign);
    if (failure === "signer") await expect(work).rejects.toBe(sentinel);
    else await expect(work).rejects.toMatchObject({ code: "22012" });
    expect(sign).toHaveBeenCalledTimes(1);
    expect(updatedInside).toBe(failure === "after-lease-sql");
    expect(externalTickets).toBe(failure === "after-lease-sql" ? 1 : 0);
    expect(await source(id)).toEqual(before);
    expect(await history()).toEqual([]);
  });
});

describe("begin upload operation identity with real SQL", () => {
  it.each([
    { mode: "lazy", uploadId: true }, { mode: "nonzero", uploadId: true },
    { mode: "replay", uploadId: true }, { mode: "other-workspace", uploadId: true },
    { mode: "lazy", uploadId: false }, { mode: "nonzero", uploadId: false },
    { mode: "other-workspace", uploadId: false },
  ])("history barrier before business locks: $mode, uploadId=$uploadId", async ({ mode, uploadId }) => {
    const oldId = randomUUID(), chunkId = randomUUID(), courseId = randomUUID(), nodeId = randomUUID();
    await f.sql`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
      VALUES(${oldId},${f.scope.workspaceId},'old.pdf','application/pdf',4,${"b".repeat(64)},1,'uploaded','ready')`;
    await f.sql`INSERT INTO opening_source_chunks(id,source_id,source_version,page,text)
      VALUES(${chunkId},${oldId},1,1,'old evidence')`;
    await f.sql`INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability)
      VALUES(${oldId},1,${f.scope.workspaceId},4,${"b".repeat(64)},'available')`;
    await f.sql`INSERT INTO courses(id,workspace_id,title,slug)
      VALUES(${courseId},${f.scope.workspaceId},'Old graph',${courseId})`;
    await f.sql`INSERT INTO course_asset_memberships(id,workspace_id,course_id,asset_type,asset_id,role,sort_order,visibility)
      VALUES(${randomUUID()},${f.scope.workspaceId},${courseId},'source',${oldId},'core',0,'course')`;
    const snapshot = { courseId, version: 1, nodes: [{ id: nodeId, courseId, label: 'Old concept', kind: 'concept',
      evidenceChunkIds: [chunkId], status: 'supported' }], edges: [] };
    await f.sql`INSERT INTO opening_course_knowledge(workspace_id,owner_user_id,course_id,version,snapshot,source_versions)
      VALUES(${f.scope.workspaceId},${f.scope.ownerUserId},${courseId},1,${f.sql.json(snapshot)},${f.sql.json({ [oldId]: 1 })})`;
    const { uploadId: identity, ...plain } = input();
    const operation = uploadId ? { ...plain, uploadId: identity } : plain;
    const quota = { maxBytes: mode === "replay" ? 8 : 12, maxObjects: mode === "replay" ? 2 : 3 };
    const repo = createOpeningSourceRepository(f.sql, { quota });
    if (mode === "replay") await repo.create(f.scope, operation);
    if (mode !== "lazy") {
      await f.sql.begin(tx => lockWorkspaceLearningHistory(tx, f.scope));
      await f.sql`UPDATE opening_workspace_history_revisions SET revision=19 WHERE workspace_id=${f.scope.workspaceId}`;
    }
    const state = async () => ({
      workspace: await f.sql`SELECT * FROM workspaces WHERE id=${f.scope.workspaceId}`,
      sources: await f.sql`SELECT * FROM opening_sources WHERE workspace_id=${f.scope.workspaceId} ORDER BY id`,
      versions: await f.sql`SELECT * FROM opening_source_versions WHERE workspace_id=${f.scope.workspaceId} ORDER BY source_id,version`,
      chunks: await f.sql`SELECT * FROM opening_source_chunks WHERE source_id=${oldId}`,
      graph: await f.sql`SELECT * FROM opening_course_knowledge WHERE course_id=${courseId}`,
    });
    const before = await state();
    const holder = openRaceSession(), writer = openRaceSession();
    let release!: () => void;
    const proceed = new Promise<void>(resolve => { release = resolve; });
    let ready!: (tx: TransactionSql) => void, failed!: (error: unknown) => void;
    const opened = new Promise<TransactionSql>((resolve, reject) => { ready = resolve; failed = reject; });
    let holding: Promise<unknown> | undefined, writing: ReturnType<typeof repo.create> | undefined;
    try {
      await Promise.all([holder.ready, writer.ready]);
      holding = holder.sql.begin(async tx => {
        await lockWorkspaceLearningHistory(tx, mode === "other-workspace" ? f.otherScope : f.scope);
        ready(tx);
        await proceed;
      });
      holding.catch(failed);
      const tx = await opened;
      let settled = false;
      writing = createOpeningSourceRepository(writer.sql, { quota }).create(f.scope, operation);
      writing.then(() => { settled = true; }, () => { settled = true; });
      if (mode !== "other-workspace") {
        let blocked = false;
        const deadline = Date.now() + 1500;
        do {
          const [wait] = await f.sql`SELECT a.query FROM pg_stat_activity a WHERE a.pid=${writer.pid}
            AND ${holder.pid}=ANY(pg_blocking_pids(a.pid))
            AND EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND NOT l.granted)`;
          if (wait) {
            expect(wait.query).toContain("opening_workspace_history_revisions");
            blocked = true;
            break;
          }
        } while (!settled && Date.now() < deadline);
        expect(blocked, "create must block on the real history row before business locks").toBe(true);
        await tx`SELECT id FROM workspaces WHERE id=${f.scope.workspaceId} FOR UPDATE NOWAIT`;
        await tx`SELECT id FROM opening_sources WHERE workspace_id=${f.scope.workspaceId} FOR UPDATE NOWAIT`;
        expect(await state()).toEqual(before);
        console.info("source create history barrier", { mode, uploadId, ungranted: true, blockedByHolder: true });
        release();
        await holding;
      }
      const created = await writing;
      expect(created).toMatchObject({ workspaceId: f.scope.workspaceId, uploadState: "pending", parseState: "not_started", version: 0 });
      if (uploadId) expect(created.id).toBe(identity);
      expect(await f.sql`SELECT revision::int AS revision FROM opening_workspace_history_revisions WHERE workspace_id=${f.scope.workspaceId}`)
        .toEqual([{ revision: mode === "lazy" ? 0 : 19 }]);
      const after = await state();
      expect({ ...after, sources: before.sources }).toEqual(before);
      expect(after.sources).toHaveLength(2);
      expect(after.sources.find(row => row.id === oldId)).toEqual(before.sources.find(row => row.id === oldId));
    } finally {
      release();
      await Promise.allSettled([holding, writing].filter(Boolean));
      await Promise.all([holder.sql.end({ timeout: 5 }), writer.sql.end({ timeout: 5 })]);
    }
  });

  it("replays concurrent same-owner starts once even at the object and byte quota", async () => {
    const repo = createOpeningSourceRepository(f.sql, { quota: { maxBytes: 4, maxObjects: 1 } });
    const operation = input();
    const [first, repeated] = await Promise.all([repo.create(f.scope, operation), repo.create(f.scope, operation)]);
    expect(first.id).toBe(operation.uploadId);
    expect(repeated).toEqual(first);
    expect(await f.sql`SELECT id FROM opening_sources WHERE workspace_id=${f.scope.workspaceId}`).toEqual([{ id: first.id }]);
  });

  it.each([
    { name: "changed.pdf" }, { mime: "text/plain" as const }, { bytes: 3 }, { sha256: "b".repeat(64) },
  ])("rejects reuse with changed original metadata %j", async changed => {
    const repo = createOpeningSourceRepository(f.sql), operation = input();
    await repo.create(f.scope, operation);
    await expect(repo.create(f.scope, { ...operation, ...changed })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await f.sql`SELECT id,name,mime,bytes,sha256 FROM opening_sources WHERE id=${operation.uploadId}`)
      .toEqual([{ id: operation.uploadId, name: operation.name, mime: operation.mime, bytes: operation.bytes, sha256: operation.sha256 }]);
  });

  it("keeps intentional uploads separate and never rebinds an identity to another owner", async () => {
    const repo = createOpeningSourceRepository(f.sql), operation = input();
    const first = await repo.create(f.scope, operation);
    await expect(repo.create(f.otherScope, operation)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const wrongOwner = repo.create({ ...f.scope, ownerUserId: f.otherScope.ownerUserId }, operation);
    await expect(wrongOwner).rejects.toBeInstanceOf(OpeningSourceError);
    await expect(wrongOwner).rejects.toMatchObject({ code: "NOT_FOUND", message: "Upload operation unavailable" });
    const second = await repo.create(f.scope, { ...operation, uploadId: randomUUID() });
    expect(second.id).not.toBe(first.id);
    expect(await f.sql`SELECT id FROM opening_sources WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(2);
  });

  it.each(["exclude", "delete"] as const)("never revives an identity after %s, including from a different workspace", async action => {
    const repo = createOpeningSourceRepository(f.sql), operation = input();
    const source = await repo.create(f.scope, operation);
    await createOpeningSourceActionsRepository(f.sql).apply(f.scope, source.id,
      { action, expectedVersion: 0, expectedMembershipIds: [] },
      { stagingKey: id => `opening/staging/${id}`, finalKey: (id, version) => `opening/sources/${id}/v${version}` }, new Date());
    await expect(repo.create(f.scope, operation)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(repo.create(f.otherScope, operation)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await f.sql`SELECT id FROM opening_sources WHERE id=${source.id}`).toHaveLength(action === "delete" ? 0 : 1);
  });

  it("rejects a historical orphan identity instead of attaching its old references to a new upload", async () => {
    const operation = input();
    await f.sql`INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability)
      VALUES(${operation.uploadId},0,${f.scope.workspaceId},4,${operation.sha256},'unavailable')`;
    await expect(createOpeningSourceRepository(f.sql).create(f.otherScope, operation)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await f.sql`SELECT id FROM opening_sources WHERE id=${operation.uploadId}`).toEqual([]);
  });
});
