import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createOpeningConversationRepository, OpeningConversationError } from "../../packages/database/src/repositories/opening-conversations";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { closeRace, openRaceSession, track } from "./opening-race-helpers";
import { insertOwnedConversation, insertTurn } from "./opening-memory-candidate-fixture";

let f: OpeningFixture;
const input = { title: "metadata only", courseId: null };
beforeAll(async () => { f = await createOpeningFixture(); });
beforeEach(async () => {
  await f.sql`DELETE FROM opening_conversations WHERE workspace_id IN (${f.scope.workspaceId},${f.otherScope.workspaceId})`;
  await f.sql`DELETE FROM opening_workspace_history_revisions WHERE workspace_id IN (${f.scope.workspaceId},${f.otherScope.workspaceId})`;
});
afterAll(async () => { await f?.close(); });

async function graph() {
  return f.sql`SELECT to_jsonb(c) AS conversation,
    (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM opening_turns t WHERE t.conversation_id=c.id) AS turns,
    (SELECT coalesce(jsonb_agg(to_jsonb(j) ORDER BY j.id),'[]'::jsonb) FROM opening_tutor_jobs j WHERE j.conversation_id=c.id) AS jobs
    FROM opening_conversations c WHERE c.workspace_id=${f.scope.workspaceId} ORDER BY c.id`;
}
async function seedGraph() {
  const id = await insertOwnedConversation(f.sql, f.scope);
  const userId = await insertTurn(f.sql, f.scope, id), assistantId = await insertTurn(f.sql, f.scope, id);
  await f.sql`UPDATE opening_turns SET role='user' WHERE id=${userId}`;
  await f.sql`INSERT INTO opening_tutor_jobs(id,workspace_id,conversation_id,user_turn_id,assistant_turn_id,status,mode)
    VALUES(${randomUUID()},${f.scope.workspaceId},${id},${userId},${assistantId},'succeeded','explain')`;
  return graph();
}
async function history() {
  return f.sql`SELECT workspace_id,owner_user_id,revision FROM opening_workspace_history_revisions
    WHERE workspace_id IN (${f.scope.workspaceId},${f.otherScope.workspaceId}) ORDER BY workspace_id,owner_user_id`;
}
function gate() {
  let release = () => undefined as void, enter = () => undefined as void;
  const opened = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  return { opened, release, async pause() { enter(); await held; } };
}
// Only pause after an actual statement has completed, or after the callback but
// before COMMIT. All queries and all locks still belong to the real PG backend.
function pauseAfter(sql: Sql, pattern?: RegExp) {
  const barrier = gate();
  let paused = false;
  return { ...barrier, sql: new Proxy(sql, { get(target, property) {
    if (property !== "begin") return Reflect.get(target, property);
    return (work: (tx: TransactionSql) => Promise<unknown>) => target.begin(async tx => {
      const wrapped = new Proxy(tx, { apply(query, thisArg, args: [TemplateStringsArray, ...unknown[]]) {
        const result = Reflect.apply(query, thisArg, args);
        if (!pattern || paused || !pattern.test(args[0].join("?"))) return result;
        paused = true;
        return Promise.resolve(result).then(async rows => { await barrier.pause(); return rows; });
      } });
      const result = await work(wrapped);
      if (!pattern) await barrier.pause();
      return result;
    });
  } }) };
}
async function blocked(waiter: number, holder: number, statement: RegExp) {
  await vi.waitFor(async () => {
    const [row] = await f.sql`SELECT a.query, EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND NOT l.granted) AS ungranted,
      ${holder}=ANY(pg_blocking_pids(a.pid)) AS blocked FROM pg_stat_activity a WHERE a.pid=${waiter}`;
    expect(row).toMatchObject({ ungranted: true, blocked: true });
    expect(row!.query).toMatch(statement);
  }, { timeout: 1500, interval: 20 });
}
async function entered(barrier: ReturnType<typeof gate>, pending: Promise<unknown>) {
  await Promise.race([barrier.opened, pending.then(() => { throw new Error("create bypassed transaction barrier"); })]);
}

it.each([0, 17])("waits behind canonical history %s before workspace/business locks, then adds only metadata without advancing", async revision => {
  const before = await seedGraph();
  await f.sql`INSERT INTO opening_workspace_history_revisions(workspace_id,owner_user_id,revision)
    VALUES(${f.scope.workspaceId},${f.scope.ownerUserId},${revision}),(${f.otherScope.workspaceId},${f.otherScope.ownerUserId},29)`;
  const holder = await openRaceSession().ready, writer = await openRaceSession().ready, probe = await openRaceSession().ready;
  const hold = gate(), pending: Promise<unknown>[] = [];
  const held = track(holder.sql.begin(async tx => {
    await tx`SELECT revision FROM opening_workspace_history_revisions WHERE workspace_id=${f.scope.workspaceId}
      AND owner_user_id=${f.scope.ownerUserId} FOR UPDATE`;
    await hold.pause();
  }));
  pending.push(held);
  try {
    await entered(hold, held);
    // A syntactically different UUID and a valid wrong owner must still use the
    // canonical workspace owner solely as the internal coordination key.
    const scope = { workspaceId: f.scope.workspaceId.toUpperCase(), ownerUserId: f.otherScope.ownerUserId };
    const creation = track(createOpeningConversationRepository(writer.sql).create(scope, input));
    pending.push(creation);
    await Promise.race([blocked(writer.pid, holder.pid, /(?:INSERT INTO|SELECT revision FROM) opening_workspace_history_revisions/),
      creation.then(() => { throw new Error("create bypassed the held history fence"); })]);
    expect(await graph()).toEqual(before);
    // NOWAIT is a real lock probe, not an inference from elapsed time. This
    // conflicts with even KEY SHARE and detects a premature workspace lock.
    await probe.sql.begin(async tx => {
      await tx`SELECT id FROM workspaces WHERE id=${f.scope.workspaceId} FOR UPDATE NOWAIT`;
    });
    const unrelated = await createOpeningConversationRepository(probe.sql).create(f.otherScope, input);
    expect(unrelated).toMatchObject(input);
    hold.release(); await held;
    const created = await creation;
    expect(created).toEqual({ id: expect.any(String), ...input });
    expect((await graph()).filter(row => row.conversation.id !== created.id)).toEqual(before);
    expect((await graph()).find(row => row.conversation.id === created.id)).toMatchObject({
      conversation: { owner_user_id: f.otherScope.ownerUserId, title: input.title, course_id: null }, turns: [], jobs: [],
    });
    expect(await history()).toEqual(expect.arrayContaining([
      { workspace_id: f.scope.workspaceId, owner_user_id: f.scope.ownerUserId, revision: String(revision) },
      { workspace_id: f.otherScope.workspaceId, owner_user_id: f.otherScope.ownerUserId, revision: "29" },
    ]));
    expect(await history()).toHaveLength(2);
  } finally { hold.release(); await Promise.allSettled(pending); await closeRace(probe.sql); await closeRace(writer.sql); await closeRace(holder.sql); }
});

it("blocks on an uncommitted lazy history ensure before acquiring any workspace lock", async () => {
  const before = await seedGraph();
  const holder = await openRaceSession().ready, writer = await openRaceSession().ready, probe = await openRaceSession().ready;
  const hold = gate(), pending: Promise<unknown>[] = [];
  const held = track(holder.sql.begin(async tx => {
    await tx`INSERT INTO opening_workspace_history_revisions(workspace_id,owner_user_id,revision)
      VALUES(${f.scope.workspaceId},${f.scope.ownerUserId},0)`;
    await hold.pause();
  }));
  pending.push(held);
  try {
    await entered(hold, held);
    const creation = track(createOpeningConversationRepository(writer.sql).create(f.scope, input)); pending.push(creation);
    await blocked(writer.pid, holder.pid, /INSERT INTO opening_workspace_history_revisions/);
    expect(await graph()).toEqual(before); expect(await history()).toEqual([]);
    await probe.sql.begin(async tx => {
      await tx`SELECT id FROM workspaces WHERE id=${f.scope.workspaceId} FOR UPDATE NOWAIT`;
    });
    hold.release(); await held;
    const created = await creation;
    expect((await graph()).filter(row => row.conversation.id !== created.id)).toEqual(before);
    expect(await history()).toEqual([{ workspace_id: f.scope.workspaceId, owner_user_id: f.scope.ownerUserId, revision: "0" }]);
  } finally { hold.release(); await Promise.allSettled(pending); await closeRace(probe.sql); await closeRace(writer.sql); await closeRace(holder.sql); }
});

it("holds workspace FOR SHARE through commit against non-key owner UPDATE", async () => {
  const writer = await openRaceSession().ready, updater = await openRaceSession().ready;
  const barrier = pauseAfter(writer.sql), pending: Promise<unknown>[] = [];
  const nextOwner = randomUUID();
  await f.sql`INSERT INTO users(id,email,display_name,password_hash) VALUES(${nextOwner},${`${nextOwner}@example.com`},'next','test')`;
  const creation = track(createOpeningConversationRepository(barrier.sql).create(f.scope, input));
  pending.push(creation);
  try {
    await entered(barrier, creation);
    expect(await graph()).toHaveLength(0);
    const update = track(updater.sql`UPDATE workspaces SET owner_user_id=${nextOwner} WHERE id=${f.scope.workspaceId}`.then(rows => rows));
    pending.push(update);
    await blocked(updater.pid, writer.pid, /UPDATE workspaces SET owner_user_id/);
    barrier.release(); const created = await creation; await update;
    expect(await graph()).toMatchObject([{ conversation: { id: created.id }, turns: [], jobs: [] }]);
  } finally {
    barrier.release(); await Promise.allSettled(pending);
    await f.sql`UPDATE workspaces SET owner_user_id=${f.scope.ownerUserId} WHERE id=${f.scope.workspaceId}`;
    await f.sql`DELETE FROM users WHERE id=${nextOwner}`;
    await closeRace(updater.sql); await closeRace(writer.sql);
  }
});

it("lazily ensures canonical zero and returns title/course unchanged without a source or course lookup", async () => {
  const courseId = randomUUID(); // Deliberately not a course FK or a learning event.
  const created = await createOpeningConversationRepository(f.sql).create(f.scope, { title: "  title  ", courseId });
  expect(created).toEqual({ id: expect.any(String), title: "  title  ", courseId });
  expect(await history()).toEqual([{ workspace_id: f.scope.workspaceId, owner_user_id: f.scope.ownerUserId, revision: "0" }]);
  expect(await graph()).toMatchObject([{ conversation: { id: created.id, title: "  title  ", course_id: courseId }, turns: [], jobs: [] }]);
});

it.each(["", "x".repeat(201)])("rolls back a new history ensure and row on the original title CHECK (%s)", async title => {
  const before = await seedGraph();
  await expect(createOpeningConversationRepository(f.sql).create(f.scope, { ...input, title })).rejects.toMatchObject({ code: "23514" });
  expect(await graph()).toEqual(before); expect(await history()).toEqual([]);
});

it.each([
  { field: "ownerUserId", code: "22P02" },
  { field: "workspaceId", code: "22P02" },
  { field: "courseId", code: "22P02" },
])("preserves PG UUID cast errors for $field and rolls back history", async ({ field, code }) => {
  const before = await seedGraph();
  const scope = { ...f.scope, ...(field !== "courseId" ? { [field]: "not-a-uuid" } : {}) };
  const value = { ...input, ...(field === "courseId" ? { courseId: "not-a-uuid" } : {}) };
  await expect(createOpeningConversationRepository(f.sql).create(scope, value)).rejects.toMatchObject({ code });
  expect(await graph()).toEqual(before); expect(await history()).toEqual([]);
});

it("keeps INSERT UUID-before-CHECK precedence for a present workspace and preserves a nonzero counter", async () => {
  const before = await seedGraph();
  await f.sql`INSERT INTO opening_workspace_history_revisions(workspace_id,owner_user_id,revision)
    VALUES(${f.scope.workspaceId},${f.scope.ownerUserId},17)`;
  const revisions = await history();
  await expect(createOpeningConversationRepository(f.sql).create({ ...f.scope, ownerUserId: "invalid-owner" }, { ...input, title: "" }))
    .rejects.toMatchObject({ code: "22P02" });
  await expect(createOpeningConversationRepository(f.sql).create(f.scope, { ...input, title: "" }))
    .rejects.toMatchObject({ code: "23514" });
  expect(await graph()).toEqual(before); expect(await history()).toEqual(revisions);
});

// Static failures retain INSERT's PG precedence; dynamic coordination changes
// below deliberately use typed CONFLICT, not equivalence to the old INSERT.
it.each([
  { title: "valid", ownerUserId: randomUUID(), courseId: null, code: "23503" },
  { title: "", ownerUserId: randomUUID(), courseId: null, code: "23514" },
  { title: "", ownerUserId: "invalid-owner", courseId: null, code: "22P02" },
  { title: "", ownerUserId: randomUUID(), courseId: "invalid-course", code: "22P02" },
])("preserves static missing-workspace INSERT precedence: $code ($ownerUserId/$courseId/$title)", async ({ code, ...value }) => {
  const before = await seedGraph();
  await expect(createOpeningConversationRepository(f.sql).create({ workspaceId: randomUUID(), ownerUserId: value.ownerUserId },
    { title: value.title, courseId: value.courseId })).rejects.toMatchObject({ code });
  expect(await graph()).toEqual(before); expect(await history()).toEqual([]);
});

it.each(["before helper", "after ensure"] as const)("rejects owner drift %s with typed conflict and rolls back (not NOT_FOUND/relock/retry)", async window => {
  const before = await seedGraph();
  const writer = await openRaceSession().ready;
  const barrier = pauseAfter(writer.sql, window === "before helper" ? /SELECT owner_user_id FROM workspaces/ : /SELECT revision FROM opening_workspace_history_revisions/);
  const nextOwner = randomUUID();
  await f.sql`INSERT INTO users(id,email,display_name,password_hash) VALUES(${nextOwner},${`${nextOwner}@example.com`},'next','test')`;
  const creation = track(createOpeningConversationRepository(barrier.sql).create({ ...f.scope, ownerUserId: "invalid-owner" }, { ...input, title: "" }));
  try {
    await entered(barrier, creation);
    await f.sql`UPDATE workspaces SET owner_user_id=${nextOwner} WHERE id=${f.scope.workspaceId}`;
    barrier.release();
    await expect(creation).rejects.toBeInstanceOf(OpeningConversationError);
    await expect(creation).rejects.toMatchObject({ code: "CONFLICT", message: "Conversation history coordination changed" });
    expect(await graph()).toEqual(before); expect(await history()).toEqual([]);
  } finally {
    barrier.release(); await Promise.allSettled([creation]);
    await f.sql`UPDATE workspaces SET owner_user_id=${f.scope.ownerUserId} WHERE id=${f.scope.workspaceId}`;
    await f.sql`DELETE FROM users WHERE id=${nextOwner}`; await closeRace(writer.sql);
  }
});

it.each(["before helper", "after ensure"] as const)("rejects concurrent workspace deletion %s with typed conflict, never INSERT retry", async window => {
  // Use an empty temporary workspace: deletion itself must not erase the old graph.
  const before = await seedGraph(), workspaceId = randomUUID(), ownerUserId = randomUUID();
  await f.sql`INSERT INTO users(id,email,display_name,password_hash) VALUES(${ownerUserId},${`${ownerUserId}@example.com`},'temporary','test')`;
  await f.sql`INSERT INTO workspaces(id,owner_user_id) VALUES(${workspaceId},${ownerUserId})`;
  const writer = await openRaceSession().ready;
  const barrier = pauseAfter(writer.sql, window === "before helper" ? /SELECT owner_user_id FROM workspaces/ : /SELECT revision FROM opening_workspace_history_revisions/);
  const creation = track(createOpeningConversationRepository(barrier.sql).create({ workspaceId, ownerUserId }, input));
  try {
    await entered(barrier, creation);
    await f.sql`DELETE FROM workspaces WHERE id=${workspaceId}`;
    barrier.release();
    await expect(creation).rejects.toBeInstanceOf(OpeningConversationError);
    await expect(creation).rejects.toMatchObject({ code: "CONFLICT", message: "Conversation history coordination changed" });
    expect(await f.sql`SELECT * FROM opening_workspace_history_revisions WHERE workspace_id=${workspaceId}`).toEqual([]);
    expect(await f.sql`SELECT id FROM opening_conversations WHERE workspace_id=${workspaceId}`).toEqual([]);
    expect(await graph()).toEqual(before);
  } finally {
    barrier.release(); await Promise.allSettled([creation]);
    await f.sql`DELETE FROM users WHERE id=${ownerUserId}`; await closeRace(writer.sql);
  }
});
