import type { Sql, TransactionSql } from "postgres";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createOpeningPlansRepository } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { closeRace, openRaceSession, track, waitUntilBlocked } from "./opening-race-helpers";

let f: OpeningFixture;
beforeAll(async () => { f = await createOpeningFixture(); });
beforeEach(async () => { await f.sql`DELETE FROM opening_tasks WHERE workspace_id=${f.scope.workspaceId}`; });
afterAll(async () => { await f?.close(); });

function beforeCommit(sql: Sql) {
  let release = () => undefined as void, entered = () => undefined as void;
  const opened = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const gated = new Proxy(sql, { get(target, property) {
    if (property !== "begin") return Reflect.get(target, property);
    return (work: (tx: TransactionSql) => Promise<unknown>) => target.begin(async tx => {
      const result = await work(tx);
      entered(); await gate;
      return result;
    });
  } });
  return { sql: gated, opened, release };
}

it.each(["skipped", "deferred"] as const)("commits only one feedback when done races %s on the same displayed version", async action => {
  const task = await createOpeningPlansRepository(f.sql).createTask(f.scope, {
    title: "Concurrent feedback", minutes: 20, priority: 1, dueAt: null, candidateId: null,
  });
  const a = await openRaceSession().ready, b = await openRaceSession().ready;
  const barrier = beforeCommit(a.sql);
  const at = new Date().toISOString();
  const winner = track(createOpeningPlansRepository(barrier.sql).updateTaskStatus(f.scope, task.id, { status: "done", expectedVersion: 1, at }));
  const pending: Promise<unknown>[] = [winner];
  try {
    await Promise.race([barrier.opened, winner.then(() => { throw new Error("winner bypassed commit barrier"); })]);
    const plans = createOpeningPlansRepository(b.sql);
    const loser = track(action === "skipped"
      ? plans.updateTaskStatus(f.scope, task.id, { status: "skipped", expectedVersion: 1, at })
      : plans.deferTask(f.scope, task.id, { notBefore: "2099-01-01T00:00:00.000Z", expectedVersion: 1 }));
    pending.push(loser);
    await waitUntilBlocked(f.sql, b.pid, a.pid, `done/${action}`);
    barrier.release();
    expect(await winner).toMatchObject({ status: "done", version: 2 });
    await expect(loser).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await f.sql`SELECT action, task_version FROM opening_plan_feedback WHERE task_id=${task.id}`)
      .toEqual([{ action: "done", task_version: 2 }]);
  } finally {
    barrier.release();
    await Promise.allSettled(pending);
    await closeRace(b.sql); await closeRace(a.sql);
  }
}, 15_000);
