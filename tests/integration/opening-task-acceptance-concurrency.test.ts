import type { Sql, TransactionSql } from "postgres";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createOpeningPlansRepository } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { acceptInput, taskCandidate } from "./opening-task-acceptance-fixture";
import { closeRace, openRaceSession, track, waitUntilBlocked } from "./opening-race-helpers";

let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => {
  await fixture.reset();
  await fixture.sql`TRUNCATE opening_tasks, opening_conversations RESTART IDENTITY CASCADE`;
});
afterAll(async () => { await fixture?.close(); });

/** Real SQL/locks; hold the winner after its writes but before the actual COMMIT. */
function beforeCommit(sql: Sql) {
  let release = () => undefined as void;
  let entered = () => undefined as void;
  const opened = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const gated = new Proxy(sql, {
    get(target, property) {
      if (property !== "begin") return Reflect.get(target, property);
      return (work: (tx: TransactionSql) => Promise<unknown>) => target.begin(async (tx) => {
        const result = await work(tx);
        entered();
        await gate;
        return result;
      });
    },
  });
  return { sql: gated, release, opened };
}

it.each(["same-key", "different-key", "changed-intent", "different-target"])("coordinates concurrent %s accepts using real row/unique locks", async (mode) => {
  const first = await taskCandidate(fixture);
  const other = mode === "different-target" ? await taskCandidate(fixture) : first;
  const a = await openRaceSession().ready, b = await openRaceSession().ready;
  const barrier = beforeCommit(a.sql);
  const input = acceptInput(first.id);
  const next = acceptInput(other.id, mode === "different-key" ? undefined : input.clientKey);
  if (mode === "changed-intent") next.title = "变更意图";
  const winner = track(createOpeningPlansRepository(barrier.sql).createTask(fixture.scope, input));
  let loser: ReturnType<ReturnType<typeof createOpeningPlansRepository>["createTask"]>;
  const pending: Promise<unknown>[] = [winner];
  try {
    await Promise.race([barrier.opened, winner.then(() => { throw new Error("winner bypassed commit barrier"); })]);
    loser = track(createOpeningPlansRepository(b.sql).createTask(fixture.scope, next));
    pending.push(loser);
    await waitUntilBlocked(fixture.sql, b.pid, a.pid, mode,
      mode === "different-target" ? /UPDATE opening_assistant_candidates/ : /FOR UPDATE/);
    barrier.release();
    const task = await winner;
    if (mode === "changed-intent" || mode === "different-target") {
      await expect(loser).rejects.toMatchObject({ code: "CONFLICT" });
    } else {
      expect(await loser).toMatchObject({ id: task.id, reviewResult: {
        disposition: mode === "same-key" ? "replayed" : "already_processed",
      } });
    }
    expect(await fixture.sql`SELECT id FROM opening_tasks`).toHaveLength(1);
    if (mode === "different-target") {
      const [row] = await fixture.sql`SELECT status, task_accept_client_key FROM opening_assistant_candidates WHERE id = ${other.id}`;
      expect(row).toMatchObject({ status: "pending", task_accept_client_key: null });
    }
  } finally {
    barrier.release();
    await Promise.allSettled(pending);
    await closeRace(b.sql);
    await closeRace(a.sql);
  }
}, 15_000);
