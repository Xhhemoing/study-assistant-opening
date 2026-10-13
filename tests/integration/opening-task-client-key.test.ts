/**
 * PR-E: quick-add clientKey idempotency on real PG. Every race uses independent
 * connections and a pg_locks barrier (waitUntilBlocked); no sleeps.
 */
import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOpeningPlansRepository, type OpeningScope } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { closeRace, openRaceSession, track, waitUntilBlocked, type RaceSession } from "./opening-race-helpers";

let fx: OpeningFixture;
let thirdScope: OpeningScope;
const sessions: Sql[] = [];

const body = (title: string, clientKey?: string) => ({
  title, minutes: 25, dueAt: null, priority: 1, candidateId: null,
  ...(clientKey === undefined ? {} : { clientKey }),
});

async function race(): Promise<RaceSession> {
  const s = openRaceSession();
  sessions.push(s.sql);
  return s.ready;
}

async function keyedRows(scope: OpeningScope, key: string) {
  return fx.sql<{ id: string; title: string }[]>`SELECT id, title FROM opening_tasks
    WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND client_key=${key}`;
}

/** Holds `key` in an open transaction on its own connection (the "old writer" / in-flight winner). */
async function holdKey(scope: OpeningScope, key: string, title = "held", finish: "commit" | "rollback" = "commit") {
  const holder = await race();
  const id = randomUUID();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let ready!: () => void;
  const held = new Promise<void>((r) => { ready = r; });
  const done = track(holder.sql.begin(async (tx) => {
    // Pre-PR-E writer shape: plain INSERT carrying the key, no ON CONFLICT.
    await tx`INSERT INTO opening_tasks (id, workspace_id, owner_user_id, title, minutes, due_at, due_text,
      priority, status, version, candidate_id, client_key)
      VALUES (${id}, ${scope.workspaceId}, ${scope.ownerUserId}, ${title}, 25, NULL, NULL, 1, 'pending', 1, NULL, ${key})`;
    ready();
    await gate;
    if (finish === "rollback") throw new Error("holder-rollback");
  }));
  await held;
  return { id, pid: holder.pid, release, done };
}

beforeAll(async () => {
  fx = await createOpeningFixture();
  // One workspace per owner (workspaces_owner_user_uidx): a third tenant for isolation.
  const user = randomUUID();
  const ws = randomUUID();
  await fx.sql`INSERT INTO users (id, email, display_name, password_hash)
    VALUES (${user}, ${`${user}@example.com`}, 'Third fixture', 'test')`;
  await fx.sql`INSERT INTO workspaces (id, owner_user_id) VALUES (${ws}, ${user})`;
  thirdScope = { workspaceId: ws, ownerUserId: user };
});
afterAll(async () => {
  for (const s of sessions) await closeRace(s);
  await fx?.close();
});

describe("quick-add clientKey idempotency (PR-E)", () => {
  it("R3: a concurrent same-key loser returns the winner's task instead of 23505", async () => {
    const key = `r3-${randomUUID()}`;
    const hold = await holdKey(fx.scope, key, "R3");
    const loser = await race();
    const pending = track(createOpeningPlansRepository(loser.sql).createTask(fx.scope, body("R3", key)));
    await waitUntilBlocked(fx.sql, loser.pid, hold.pid, "R3 loser", /INSERT INTO opening_tasks/);
    hold.release();
    await hold.done;
    expect((await pending).id).toBe(hold.id);
    expect(await keyedRows(fx.scope, key)).toHaveLength(1);
  });

  it("N=4 concurrent same-key submits behind a committed winner: one row, all replay it", async () => {
    const key = `n4c-${randomUUID()}`;
    const hold = await holdKey(fx.scope, key, "N4");
    const waiters = await Promise.all([race(), race(), race(), race()]);
    const pending = waiters.map((w) =>
      track(createOpeningPlansRepository(w.sql).createTaskWithOutcome(fx.scope, body("N4", key))));
    for (const w of waiters) await waitUntilBlocked(fx.sql, w.pid, hold.pid, `waiter ${w.pid}`, /INSERT INTO opening_tasks/);
    hold.release();
    await hold.done;
    const outcomes = await Promise.all(pending);
    expect(outcomes.map((o) => o.task.id)).toEqual([hold.id, hold.id, hold.id, hold.id]);
    expect(outcomes.every((o) => o.replayed)).toBe(true);
    expect(await keyedRows(fx.scope, key)).toHaveLength(1);
  });

  it("N=4 new-path writers released together: exactly one creates, the rest replay", async () => {
    const key = `n4r-${randomUUID()}`;
    const hold = await holdKey(fx.scope, key, "N4R", "rollback");
    const waiters = await Promise.all([race(), race(), race(), race()]);
    const pending = waiters.map((w) =>
      track(createOpeningPlansRepository(w.sql).createTaskWithOutcome(fx.scope, body("N4R", key))));
    for (const w of waiters) await waitUntilBlocked(fx.sql, w.pid, hold.pid, `waiter ${w.pid}`, /INSERT INTO opening_tasks/);
    hold.release();
    await expect(hold.done).rejects.toThrow("holder-rollback");
    const outcomes = await Promise.all(pending);
    const rows = await keyedRows(fx.scope, key);
    expect(rows).toHaveLength(1);
    expect(outcomes.filter((o) => !o.replayed)).toHaveLength(1);
    expect(new Set(outcomes.map((o) => o.task.id))).toEqual(new Set([rows[0]!.id]));
  });

  it("retry after a lost response returns the same id and reports a replay", async () => {
    const repo = createOpeningPlansRepository(fx.sql);
    const key = `lost-${randomUUID()}`;
    const first = await repo.createTaskWithOutcome(fx.scope, body("lost", key)); // response "lost"
    const retry = await repo.createTaskWithOutcome(fx.scope, body("lost", key));
    expect(first.replayed).toBe(false);
    expect(retry).toEqual({ task: first.task, replayed: true });
    // Status changes after creation do not change the request fingerprint.
    await repo.updateTaskStatus(fx.scope, first.task.id, { status: "done", expectedVersion: 1, at: new Date().toISOString() });
    expect((await repo.createTaskWithOutcome(fx.scope, body("lost", key))).task.id).toBe(first.task.id);
  });

  it("same key with a different intent is CONFLICT, sequentially and under a race", async () => {
    const repo = createOpeningPlansRepository(fx.sql);
    const key = `diff-${randomUUID()}`;
    await repo.createTask(fx.scope, body("original", key));
    await expect(repo.createTask(fx.scope, body("changed", key))).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repo.createTask(fx.scope, { ...body("original", key), minutes: 45 })).rejects.toMatchObject({ code: "CONFLICT" });

    const raced = `diffr-${randomUUID()}`;
    const hold = await holdKey(fx.scope, raced, "winner-title");
    const loser = await race();
    const pending = track(createOpeningPlansRepository(loser.sql).createTask(fx.scope, body("other-title", raced)));
    await waitUntilBlocked(fx.sql, loser.pid, hold.pid, "conflict loser", /INSERT INTO opening_tasks/);
    hold.release();
    await hold.done;
    await expect(pending).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await keyedRows(fx.scope, raced)).toHaveLength(1);
  });

  it("different workspaces never block or collide on the same key", async () => {
    const key = `ws-${randomUUID()}`;
    const hold = await holdKey(fx.scope, key, "ws");
    const other = await race();
    const repo = createOpeningPlansRepository(other.sql);
    // Completes while the first workspace's holder is still open: no shared lock.
    const a = await repo.createTaskWithOutcome(thirdScope, body("ws", key));
    const b = await repo.createTaskWithOutcome(fx.otherScope, body("ws", key));
    hold.release();
    await hold.done;
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(false);
    expect(new Set([hold.id, a.task.id, b.task.id]).size).toBe(3);
    expect(await keyedRows(thirdScope, key)).toHaveLength(1);
    expect(await keyedRows(fx.otherScope, key)).toHaveLength(1);
  });

  it("old and new writers together: no duplicate keyed rows; an old plain INSERT is refused by the index", async () => {
    const repo = createOpeningPlansRepository(fx.sql);
    const key = `mix-${randomUUID()}`;
    const created = await repo.createTask(fx.scope, body("mix", key));
    // Old writer (pre-PR-E build) replays nothing and inserts blindly: the 0046 index stops it.
    await expect(fx.sql`INSERT INTO opening_tasks (id, workspace_id, owner_user_id, title, minutes, client_key)
      VALUES (${randomUUID()}, ${fx.scope.workspaceId}, ${fx.scope.ownerUserId}, 'mix', 25, ${key})`)
      .rejects.toMatchObject({ code: "23505" });
    expect((await keyedRows(fx.scope, key)).map((r) => r.id)).toEqual([created.id]);
  });

  it("no-key path (documented): every submit creates its own row with client_key NULL", async () => {
    const repo = createOpeningPlansRepository(fx.sql);
    const title = `nokey-${randomUUID()}`;
    const a = await repo.createTaskWithOutcome(fx.scope, body(title));
    const b = await repo.createTaskWithOutcome(fx.scope, body(title));
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(false);
    expect(a.task.id).not.toBe(b.task.id);
    const rows = await fx.sql<{ client_key: string | null }[]>`SELECT client_key FROM opening_tasks
      WHERE workspace_id=${fx.scope.workspaceId} AND title=${title}`;
    expect(rows.map((r) => r.client_key)).toEqual([null, null]);
  });

  it("history: NULL-key and identical-text legacy rows are never merged or deleted; no jobs/budget writes", async () => {
    const title = `legacy-${randomUUID()}`;
    const legacy = [randomUUID(), randomUUID()];
    for (const id of legacy) {
      await fx.sql`INSERT INTO opening_tasks (id, workspace_id, owner_user_id, title, minutes)
        VALUES (${id}, ${fx.scope.workspaceId}, ${fx.scope.ownerUserId}, ${title}, 25)`;
    }
    const side = async () => (await fx.sql<{ j: number; b: number }[]>`SELECT
      (SELECT count(*)::int FROM opening_jobs WHERE workspace_id=${fx.scope.workspaceId}) j,
      (SELECT count(*)::int FROM opening_budget_reservations WHERE workspace_id=${fx.scope.workspaceId}) b`)[0]!;
    const before = await side();
    const repo = createOpeningPlansRepository(fx.sql);
    const key = `hist-${randomUUID()}`;
    const keyed = await repo.createTask(fx.scope, body(title, key));
    await repo.createTask(fx.scope, body(title, key));
    const rows = await fx.sql<{ id: string }[]>`SELECT id FROM opening_tasks
      WHERE workspace_id=${fx.scope.workspaceId} AND title=${title} ORDER BY created_at, id`;
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set([...legacy, keyed.id]));
    expect(await side()).toEqual(before);
  });
});
