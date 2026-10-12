/**
 * PR-E: retest accept clientKey idempotency + 0060 unique protection on real PG.
 * Independent connections, pg_locks barriers, no sleeps.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createOpeningPlansRepository, type OpeningScope } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { backupRows } from "./opening-backup-records-fixture";
import { closeRace, openRaceSession, track, waitUntilBlocked, type RaceSession } from "./opening-race-helpers";

let fx: OpeningFixture;
const sessions: Sql[] = [];

async function race(): Promise<RaceSession> {
  const s = openRaceSession();
  sessions.push(s.sql);
  return s.ready;
}

type Candidate = { id: string; payload: Record<string, unknown> };

async function candidate(scope: OpeningScope): Promise<Candidate> {
  const id = randomUUID();
  const sourceId = await backupRows(fx.sql, scope).source();
  const courseId = randomUUID();
  await fx.sql`INSERT INTO courses (id, workspace_id, title, slug) VALUES (${courseId}, ${scope.workspaceId}, 'Retest course', ${courseId})`;
  const payload = { kind: "task", id, courseId, skillLabel: "fractions", prompt: "Retest fractions", sourceIds: [sourceId], dueAt: "2026-09-14T10:00:00.000Z", accepted: false };
  await fx.sql`INSERT INTO opening_jobs (id, workspace_id, owner_user_id, key, kind, payload, state)
    VALUES (${id}, ${scope.workspaceId}, ${scope.ownerUserId}, ${`retest:${id}`}, 'retest', ${fx.sql.json(payload as never)}, 'succeeded')`;
  return { id, payload };
}

function input(c: Candidate, clientKey: string, minutes = 20) {
  return {
    title: "Retest fractions", minutes, dueAt: null, priority: 1, candidateId: c.id, clientKey, baseVersion: 0,
    inputSnapshot: { kind: "retest" as const, candidateId: c.id, courseId: c.payload.courseId as string, skillLabel: "fractions",
      prompt: "Retest fractions", sourceIds: c.payload.sourceIds as string[], dueAt: c.payload.dueAt as string, heuristic: true },
  };
}

async function tasksFor(scope: OpeningScope, candidateId: string) {
  return fx.sql<{ id: string }[]>`SELECT id FROM opening_tasks WHERE workspace_id=${scope.workspaceId} AND candidate_id=${candidateId}`;
}

/** Waiter is blocked on any lock (chained waiters queue behind each other, not only the holder). */
async function waitUntilWaiting(pid: number, label: string) {
  await vi.waitFor(async () => {
    const rows = await fx.sql<{ n: number }[]>`SELECT count(*)::int n FROM pg_locks WHERE pid=${pid} AND NOT granted`;
    if ((rows[0]?.n ?? 0) < 1) throw new Error(`${label} not waiting yet`);
  }, { timeout: 5_000, interval: 40 });
}

/** Holds a transaction open on its own connection after `work` ran. */
async function hold(work: (tx: Sql) => Promise<unknown>, finish: "commit" | "rollback" = "commit") {
  const holder = await race();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let ready!: () => void;
  const held = new Promise<void>((r) => { ready = r; });
  const done = track(holder.sql.begin(async (tx) => {
    await work(tx as unknown as Sql);
    ready();
    await gate;
    if (finish === "rollback") throw new Error("holder-rollback");
  }));
  await Promise.race([held, done]);
  return { pid: holder.pid, release, done };
}

beforeAll(async () => { fx = await createOpeningFixture(); });
afterAll(async () => {
  for (const s of sessions) await closeRace(s);
  await fx?.close();
});

describe("retest accept clientKey (PR-E)", () => {
  it("N=4 concurrent same-key accepts create exactly one task; one creates, three replay", async () => {
    const c = await candidate(fx.scope);
    const key = `retest-n4-${randomUUID()}`;
    // Barrier: hold the workspace learning-history row every retest accept locks first.
    const h = await hold((tx) => tx`SELECT revision FROM opening_workspace_history_revisions
      WHERE workspace_id=${fx.scope.workspaceId} AND owner_user_id=${fx.scope.ownerUserId} FOR UPDATE`.then(async (rows) => {
      if (!rows.length) {
        await tx`INSERT INTO opening_workspace_history_revisions(workspace_id, owner_user_id, revision)
          VALUES (${fx.scope.workspaceId}, ${fx.scope.ownerUserId}, 0)`;
      }
    }));
    const waiters = await Promise.all([race(), race(), race(), race()]);
    const pending = waiters.map((w) => track(createOpeningPlansRepository(w.sql).createTaskWithOutcome(fx.scope, input(c, key))));
    for (const w of waiters) await waitUntilWaiting(w.pid, `waiter ${w.pid}`);
    h.release();
    await h.done;
    const outcomes = await Promise.all(pending);
    const rows = await tasksFor(fx.scope, c.id);
    expect(rows).toHaveLength(1);
    expect(outcomes.map((o) => o.task.id)).toEqual(Array(4).fill(rows[0]!.id));
    expect(outcomes.filter((o) => !o.replayed)).toHaveLength(1);
  });

  it("retry after a lost response returns the same id and reports a replay", async () => {
    const c = await candidate(fx.scope);
    const repo = createOpeningPlansRepository(fx.sql);
    const key = `retest-lost-${randomUUID()}`;
    const first = await repo.createTaskWithOutcome(fx.scope, input(c, key));
    const retry = await repo.createTaskWithOutcome(fx.scope, input(c, key));
    expect(first.replayed).toBe(false);
    expect(retry.replayed).toBe(true);
    expect(retry.task.id).toBe(first.task.id);
    expect(await tasksFor(fx.scope, c.id)).toHaveLength(1);
  });

  it("same key with a different input is CONFLICT (same candidate and another candidate)", async () => {
    const repo = createOpeningPlansRepository(fx.sql);
    const c = await candidate(fx.scope);
    const other = await candidate(fx.scope);
    const key = `retest-diff-${randomUUID()}`;
    await repo.createTask(fx.scope, input(c, key));
    await expect(repo.createTask(fx.scope, input(c, key, 45))).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repo.createTask(fx.scope, input(other, key))).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await tasksFor(fx.scope, other.id)).toHaveLength(0);
  });

  it("different workspaces never block or collide on the same key", async () => {
    const mine = await candidate(fx.scope);
    const theirs = await candidate(fx.otherScope);
    const key = `retest-ws-${randomUUID()}`;
    // Hold tenant A's accept open (uncommitted receipt); tenant B must complete meanwhile.
    const a = await race();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let ready!: () => void;
    const held = new Promise<void>((r) => { ready = r; });
    const doneA = track(a.sql.begin(async (tx) => {
      await tx`UPDATE opening_jobs SET payload = payload || ${tx.json({ acceptClientKey: key })} WHERE id=${mine.id}`;
      ready();
      await gate;
    }));
    await held;
    const b = await createOpeningPlansRepository(fx.sql).createTaskWithOutcome(fx.otherScope, input(theirs, key));
    release();
    await doneA;
    expect(b.replayed).toBe(false);
    expect(await tasksFor(fx.otherScope, theirs.id)).toHaveLength(1);
  });

  it("0060 index stops a racing writer that bypasses the workspace lock: loser gets CONFLICT, no task", async () => {
    const winner = await candidate(fx.scope);
    const loserCandidate = await candidate(fx.scope);
    const key = `retest-idx-${randomUUID()}`;
    // Legacy JSON-only writer shape (opening-retests accept): result.clientKey, no workspace lock.
    const h = await hold((tx) => tx`UPDATE opening_jobs SET result = ${(tx as Sql).json({ accepted: true, clientKey: key })}
      WHERE id=${winner.id}`);
    const loser = await race();
    const pending = track(createOpeningPlansRepository(loser.sql).createTask(fx.scope, input(loserCandidate, key)));
    await waitUntilBlocked(fx.sql, loser.pid, h.pid, "index loser", /UPDATE opening_jobs/);
    h.release();
    await h.done;
    await expect(pending).rejects.toMatchObject({ code: "CONFLICT", message: "clientKey already used by a legacy retest accept" });
    expect(await tasksFor(fx.scope, loserCandidate.id)).toHaveLength(0);
    const [job] = await fx.sql<{ accepted: boolean | null }[]>`SELECT (payload->>'accepted')::boolean accepted FROM opening_jobs WHERE id=${loserCandidate.id}`;
    expect(job!.accepted).toBe(false);
  });

  it("the index rejects a second job row carrying the same key in the same workspace", async () => {
    const a = await candidate(fx.scope);
    const b = await candidate(fx.scope);
    const key = `retest-raw-${randomUUID()}`;
    await fx.sql`UPDATE opening_jobs SET payload = payload || ${fx.sql.json({ acceptClientKey: key })} WHERE id=${a.id}`;
    await expect(fx.sql`UPDATE opening_jobs SET result = ${fx.sql.json({ clientKey: key })} WHERE id=${b.id}`)
      .rejects.toMatchObject({ code: "23505", constraint_name: "opening_jobs_retest_accept_key_uidx" });
  });

  it("0060 blocks with a conflict report on pre-existing duplicates and deletes nothing", async () => {
    const body = readFileSync(path.resolve(__dirname, "../../packages/database/src/migrations/0060_opening_retest_accept_key.sql"), "utf8");
    const a = await candidate(fx.scope);
    const b = await candidate(fx.scope);
    const key = `retest-dup-${randomUUID()}`;
    const failure = await fx.sql.begin(async (tx) => {
      await tx`DROP INDEX opening_jobs_retest_accept_key_uidx`;
      await tx`UPDATE opening_jobs SET result = ${tx.json({ accepted: true, clientKey: key })} WHERE id IN (${a.id}, ${b.id})`;
      const error = await tx.unsafe(body).then(() => null, (e: unknown) => e);
      throw Object.assign(new Error("rollback"), { inner: error });
    }).catch((e: { inner?: { message?: string; detail?: string } }) => e.inner);
    expect(failure?.message).toMatch(/^PR-E 0060 blocked: 1 duplicate retest accept clientKey group/);
    expect(failure?.detail).toContain(a.id < b.id ? a.id : b.id);
    // Rolled back: index restored, rows untouched.
    const idx = await fx.sql`SELECT 1 FROM pg_indexes WHERE indexname='opening_jobs_retest_accept_key_uidx'`;
    expect(idx).toHaveLength(1);
    const kept = await fx.sql`SELECT id FROM opening_jobs WHERE id IN (${a.id}, ${b.id}) AND result IS NULL`;
    expect(kept).toHaveLength(2);
  });
});
