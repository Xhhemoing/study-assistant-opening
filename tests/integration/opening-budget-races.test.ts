import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createOpeningBudgetRepository } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { vi } from "vitest";
import type { Sql } from "postgres";
import { closeRace, openRaceSession, track, waitUntilBlocked, type RaceSession } from "./opening-race-helpers";

/** Deterministic condition (not elapsed time): pid has an ungranted lock request. */
async function waitUntilWaiting(observer: Sql, pid: number, label: string): Promise<void> {
  await vi.waitFor(async () => {
    const rows = await observer<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_locks WHERE pid=${pid} AND NOT granted`;
    if ((rows[0]?.n ?? 0) < 1) throw new Error(`${label} not waiting yet`);
  }, { timeout: 5_000, interval: 40 });
}

let fixture: OpeningFixture;
let a: RaceSession;
let b: RaceSession;

beforeAll(async () => {
  fixture = await createOpeningFixture();
  a = await openRaceSession().ready;
  b = await openRaceSession().ready;
});
beforeEach(async () => {
  await fixture.reset();
});
afterAll(async () => {
  await closeRace(a?.sql);
  await closeRace(b?.sql);
  await fixture?.close();
});

describe("opening budget races (two independent connections, deterministic barriers)", () => {
  it("same key in two workspaces racing on the global UNIQUE maps 23505 to CONFLICT", async () => {
    const budgetB = createOpeningBudgetRepository(b.sql, { envCapCents: 100_000 });
    // Barrier: connection A holds an uncommitted row for the key in workspace 1.
    let commitA: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { commitA = resolve; });
    let inserted: () => void = () => undefined;
    const insertedP = new Promise<void>((resolve) => { inserted = resolve; });
    const holder = track(a.sql.begin(async (tx) => {
      await tx`INSERT INTO opening_budget_reservations (workspace_id, purpose, amount_cents, request_id)
               VALUES (${fixture.scope.workspaceId}, 'tutor', 10, 'xws-key')`;
      inserted();
      await gate;
    }));
    await insertedP;
    // Workspace 2 does not see the uncommitted row and blocks on the unique index.
    const contender = track(budgetB.reserve(fixture.otherScope, { purpose: "tutor", amountCents: 10, requestId: "xws-key" }));
    await waitUntilBlocked(fixture.sql, b.pid, a.pid, "cross-workspace reserve", /INSERT INTO opening_budget_reservations/);
    commitA();
    await holder;
    await expect(contender).rejects.toMatchObject({ name: "OpeningBudgetError", code: "CONFLICT" });
    const rows = await fixture.sql`SELECT workspace_id FROM opening_budget_reservations WHERE request_id='xws-key'`;
    expect(rows.map((r) => r.workspace_id)).toEqual([fixture.scope.workspaceId]);
  });

  it("concurrent balance race: workspace FOR UPDATE serializes two connections; only one fits the cap", async () => {
    const budgetA = createOpeningBudgetRepository(a.sql, { envCapCents: 100_000 });
    const budgetB = createOpeningBudgetRepository(b.sql, { envCapCents: 100_000 });
    // Barrier: observer holds the workspace row lock.
    let unlock: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { unlock = resolve; });
    let locked: () => void = () => undefined;
    const lockedP = new Promise<void>((resolve) => { locked = resolve; });
    const observer = openRaceSession();
    await observer.ready;
    const hold = track(observer.sql.begin(async (tx) => {
      await tx`SELECT id FROM workspaces WHERE id=${fixture.scope.workspaceId} FOR UPDATE`;
      locked();
      await gate;
    }));
    await lockedP;
    const first = track(budgetA.reserve(fixture.scope, { purpose: "tutor", amountCents: 60_000, requestId: "bal-a" }));
    const second = track(budgetB.reserve(fixture.scope, { purpose: "tutor", amountCents: 60_000, requestId: "bal-b" }));
    await waitUntilWaiting(fixture.sql, a.pid, "reserve A");
    await waitUntilWaiting(fixture.sql, b.pid, "reserve B");
    unlock();
    await hold;
    const results = await Promise.allSettled([first, second]);
    await closeRace(observer.sql);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "BUDGET_EXCEEDED" });
    const sum = await fixture.sql`SELECT COALESCE(sum(amount_cents),0)::int AS t FROM opening_budget_reservations WHERE workspace_id=${fixture.scope.workspaceId}`;
    expect(sum[0].t).toBe(60_000);
  }, 20_000);
});
