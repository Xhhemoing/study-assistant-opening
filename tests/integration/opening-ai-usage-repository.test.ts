import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveBudgetLocalDay } from "@aistudy/ai";
import { createOpeningBudgetRepository, readOpeningDailyBudgetUsage } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => {
  await fixture.reset();
  await fixture.sql`DELETE FROM workspace_preferences WHERE workspace_id IN (${fixture.scope.workspaceId},${fixture.otherScope.workspaceId})`;
});
afterAll(async () => { await fixture?.close(); });

async function seed(amount: number, state: string, createdAt: Date, workspaceId = fixture.scope.workspaceId, unknown = false) {
  await fixture.sql`INSERT INTO opening_budget_reservations
    (workspace_id, purpose, amount_cents, request_id, state, created_at, outcome_unknown_at)
    VALUES (${workspaceId}, 'tutor', ${amount}, ${randomUUID()}, ${state}, ${createdAt}, ${unknown ? createdAt : null})`;
}

describe("read-only daily AI usage", () => {
  it.each(["Asia/Shanghai", "America/New_York"])("uses the workspace local day in %s and separates old holds from today's spend", async timeZone => {
    const now = new Date("2026-03-08T16:00:00.000Z");
    const day = resolveBudgetLocalDay(now, timeZone);
    await fixture.sql`INSERT INTO workspace_preferences (workspace_id,planning_settings) VALUES (${fixture.scope.workspaceId},${fixture.sql.json({ timeZone })})`;
    await seed(11, "completed", day.dayStart);
    await seed(13, "completed", new Date(day.nextDayStart.getTime() - 1));
    await seed(900, "completed", new Date(day.dayStart.getTime() - 1));
    await seed(900, "completed", day.nextDayStart);
    await seed(17, "reserved", now);
    await seed(19, "reserved", new Date(day.dayStart.getTime() - 1), fixture.scope.workspaceId, true);
    await seed(900, "released", now);
    await seed(900, "completed", now, fixture.otherScope.workspaceId);
    const before = await fixture.sql`SELECT id,state,amount_cents,updated_at,outcome_unknown_at FROM opening_budget_reservations ORDER BY id`;
    expect(await readOpeningDailyBudgetUsage(fixture.sql, fixture.scope, now)).toEqual({ localDate: day.localDate, timeZone, spentCents: 24, reservedCents: 36 });
    expect(await fixture.sql`SELECT id,state,amount_cents,updated_at,outcome_unknown_at FROM opening_budget_reservations ORDER BY id`).toEqual(before);
    expect(await fixture.sql`SELECT count(*)::int AS n FROM opening_budget_reconcile_events`).toMatchObject([{ n: 0 }]);
  });

  it("returns a real measured zero and the existing default time zone for an empty workspace", async () => {
    expect(await readOpeningDailyBudgetUsage(fixture.sql, fixture.scope, new Date("2026-10-25T16:00:00Z")))
      .toEqual({ localDate: "2026-10-26", timeZone: "Asia/Shanghai", spentCents: 0, reservedCents: 0 });
  });

  it.each(["ttl", "media"])("keeps today's and historical %s estimates pending until a real receipt", async kind => {
    const now = new Date("2026-03-08T16:00:00.000Z");
    const day = resolveBudgetLocalDay(now, "Asia/Shanghai");
    const ids: string[] = [];
    for (const createdAt of [now, new Date(day.dayStart.getTime() - 1)]) {
      const [row] = await fixture.sql`INSERT INTO opening_budget_reservations
        (workspace_id,purpose,amount_cents,reserved_amount_cents,request_id,state,created_at,
         pending_reconcile_cents,reconciled_at,settlement_cost_basis)
        VALUES (${fixture.scope.workspaceId},'tutor',100,100,${randomUUID()},'completed',${createdAt},
          ${kind === "ttl" ? 100 : 0},${kind === "ttl" ? now : null},${kind === "media" ? "media_usage_upper_bound" : null})
        RETURNING id`;
      ids.push(row!.id);
    }
    expect(await readOpeningDailyBudgetUsage(fixture.sql, fixture.scope, now))
      .toMatchObject({ spentCents: 0, reservedCents: 200 });
    const repository = createOpeningBudgetRepository(fixture.sql, { envCapCents: 1000 });
    for (const id of ids) await repository.settle(fixture.scope, id, 30, { costBasis: "vendor_receipt" });
    expect(await readOpeningDailyBudgetUsage(fixture.sql, fixture.scope, now))
      .toMatchObject({ spentCents: 30, reservedCents: 0 });
  });

  it("rejects a foreign owner without exposing the workspace's amounts", async () => {
    await seed(42, "reserved", new Date());
    await expect(readOpeningDailyBudgetUsage(fixture.sql, { ...fixture.scope, ownerUserId: fixture.otherScope.ownerUserId }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("does not reinterpret a corrupt stored time zone as zero usage", async () => {
    await fixture.sql`INSERT INTO workspace_preferences (workspace_id,planning_settings) VALUES (${fixture.scope.workspaceId},'{"timeZone":"Mars/Olympus_Mons"}'::jsonb)`;
    await expect(readOpeningDailyBudgetUsage(fixture.sql, fixture.scope)).rejects.toThrow(/invalid timeZone/);
  });
});
