import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createOpeningPlansRepository, createWorkspacePreferencesRepository, discardOpeningRetest } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { seedReviewRetest } from "./opening-review-fixture";
import { closeRace, openRaceSession, track, waitUntilBlocked } from "./opening-race-helpers";
let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => { await fixture.reset(); await fixture.sql`TRUNCATE opening_tasks RESTART IDENTITY CASCADE`; });
afterAll(async () => { await fixture?.close(); });
function beforeCommit(sql: Sql) {
  let release = () => undefined as void, entered = () => undefined as void;
  const opened = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const gated = new Proxy(sql, { get(target, property) {
    return property === "begin" ? (work: (tx: TransactionSql) => Promise<unknown>) => target.begin(async (tx) => {
      const result = await work(tx); entered(); await gate; return result;
    }) : Reflect.get(target, property);
  } });
  return { sql: gated, release, opened };
}
it.each(["accept", "discard"] as const)("serializes accept/discard with %s committing first", async (first) => {
  await createWorkspacePreferencesRepository(fixture.sql).setLearningPreferences(fixture.scope, {
    assessmentEnabled: true, retestSuggestionsEnabled: true, automaticRemindersEnabled: false,
  });
  const retest = await seedReviewRetest(fixture), a = await openRaceSession().ready, b = await openRaceSession().ready;
  const barrier = beforeCommit(a.sql), clientKey = randomUUID();
  const input = { title: retest.prompt, minutes: 20, dueAt: null, priority: 1, candidateId: retest.id, clientKey,
    inputSnapshot: { kind: "retest" as const, candidateId: retest.id, heuristic: true as const } };
  const accept = (sql: Sql) => createOpeningPlansRepository(sql).createTask(fixture.scope, input);
  const discard = (sql: Sql) => discardOpeningRetest(sql, fixture.scope, retest.id, randomUUID());
  const winner = track(first === "accept" ? accept(barrier.sql) : discard(barrier.sql));
  const pending: Promise<unknown>[] = [winner];
  try {
    await Promise.race([barrier.opened, winner.then(() => { throw new Error("commit barrier bypassed"); })]);
    const loser = track(first === "accept" ? discard(b.sql) : accept(b.sql)); pending.push(loser);
    await waitUntilBlocked(fixture.sql, b.pid, a.pid, "retest decision", /FOR UPDATE/);
    barrier.release(); await winner;
    await expect(loser).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await fixture.sql`SELECT id FROM opening_tasks`).toHaveLength(first === "accept" ? 1 : 0);
    if (first === "accept") expect((await accept(b.sql)).id).toBe((await accept(a.sql)).id);
  } finally { barrier.release(); await Promise.allSettled(pending); await closeRace(b.sql); await closeRace(a.sql); }
}, 15_000);
