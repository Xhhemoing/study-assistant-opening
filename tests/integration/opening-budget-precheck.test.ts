import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveBudgetLocalDay } from "@aistudy/ai";
import { checkOpeningBudgetAvailable, createOpeningBudgetRepository } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let fixture: OpeningFixture;
const options = { envCapCents: 100, timeZone: "America/New_York" };
const snapshot = { id: "free", providerId: "p", modelName: "m", inputCentsPerMillion: 0, outputCentsPerMillion: 0 };
const free = { amountCents: 0, modelSnapshot: snapshot, requestCapPerDay: 2 };

beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => {
  await fixture.reset();
  await fixture.sql`DELETE FROM workspace_preferences WHERE workspace_id=${fixture.scope.workspaceId}`;
});
afterAll(async () => { await fixture?.close(); });

async function seed(amount: number, state: string, createdAt: Date, unknown = false, modelId = snapshot.id) {
  await fixture.sql`INSERT INTO opening_budget_reservations
    (workspace_id, purpose, amount_cents, request_id, state, created_at, outcome_unknown_at, model_snapshot)
    VALUES (${fixture.scope.workspaceId}, 'tutor', ${amount}, ${randomUUID()}, ${state}, ${createdAt},
      ${unknown ? createdAt : null}, ${fixture.sql.json({ ...snapshot, id: modelId })})`;
}
const check = (amountCents: number) => checkOpeningBudgetAvailable(fixture.sql, fixture.scope, { amountCents }, options);

describe("opening budget read-only precheck", () => {
  it("allows exact balance, rejects one cent more, and shares spend across models", async () => {
    await seed(40, "completed", new Date(), false, "another-model");
    expect(await check(60)).toMatchObject({ allowed: true, reason: null, requiredCents: 60, availableCents: 60 });
    expect(await check(61)).toMatchObject({ allowed: false, reason: "budget", availableCents: 60 });
  });

  it("charges all reserved including old unknown; ignores released and completed outside the local day", async () => {
    const day = resolveBudgetLocalDay(new Date(), options.timeZone);
    const old = new Date(day.dayStart.getTime() - 1);
    await seed(10, "reserved", old);
    await seed(20, "reserved", old, true);
    await seed(30, "completed", day.dayStart);
    await seed(90, "completed", old);
    await seed(90, "completed", day.nextDayStart);
    await seed(90, "released", new Date());
    expect(await check(40)).toMatchObject({ allowed: true, availableCents: 40, localDay: day.localDate });
    expect(await check(41)).toMatchObject({ allowed: false, reason: "budget" });
    expect(await fixture.sql`SELECT count(*)::int AS n FROM opening_budget_reconcile_events`).toMatchObject([{ n: 0 }]);
  });

  it("free calls ignore exhausted money but count only same snapshot local-day nonreleased requests", async () => {
    const day = resolveBudgetLocalDay(new Date(), options.timeZone);
    await seed(120, "reserved", new Date());
    await seed(0, "completed", new Date());
    await seed(0, "released", new Date());
    await seed(0, "completed", new Date(day.dayStart.getTime() - 1));
    await seed(0, "completed", new Date(), false, "other-model");
    const run = () => checkOpeningBudgetAvailable(fixture.sql, fixture.scope, free, { ...options, envCapCents: 0 });
    expect(await run()).toMatchObject({ allowed: false, reason: "request_cap", availableCents: 0 });
    await fixture.sql`UPDATE opening_budget_reservations SET state='released' WHERE amount_cents=120`;
    expect(await run()).toMatchObject({ allowed: true, reason: null, availableCents: 0 });
    await seed(0, "reserved", new Date(), true);
    expect(await run()).toMatchObject({ allowed: false, reason: "request_cap" });
  });

  it("rejects a foreign owner before exposing balances", async () => {
    await expect(checkOpeningBudgetAvailable(fixture.sql, { ...fixture.scope, ownerUserId: fixture.otherScope.ownerUserId }, { amountCents: 1 }, options))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    await seed(90, "reserved", new Date());
    expect(await checkOpeningBudgetAvailable(fixture.sql, fixture.otherScope, { amountCents: 100 }, options))
      .toMatchObject({ allowed: true, availableCents: 100 });
  });

  it.each([{ amountCents: -1 }, { amountCents: 0 }, { amountCents: 1.5 }, { ...free, requestCapPerDay: 0 }])("validates reserve inputs: %j", async input => {
    await expect(checkOpeningBudgetAvailable(fixture.sql, fixture.scope, input, options)).rejects.toMatchObject({ code: "BUDGET_INVALID_RESERVE" });
  });

  it("uses workspace confirmation, ceiling, pricing and planning timezone rules", async () => {
    await fixture.sql`INSERT INTO workspace_preferences (workspace_id, ai_settings, planning_settings)
      VALUES (${fixture.scope.workspaceId}, ${fixture.sql.json({ dailyCapCents: 70, budgetConfirmedAt: new Date().toISOString() })},
        ${fixture.sql.json({ timeZone: "Pacific/Kiritimati" })})`;
    expect(await check(70)).toMatchObject({ allowed: true, availableCents: 70, localDay: resolveBudgetLocalDay(new Date(), "Pacific/Kiritimati").localDate });
    expect(await checkOpeningBudgetAvailable(fixture.sql, fixture.scope, { amountCents: 61 }, { ...options, envCapCents: 0, ceilingCents: 60 }))
      .toMatchObject({ allowed: false, availableCents: 60 });
    expect(await checkOpeningBudgetAvailable(fixture.sql, fixture.scope, { amountCents: 1 }, { ...options, envCapCents: 0, pricingConfigured: false }))
      .toMatchObject({ allowed: false, availableCents: 0 });
    await fixture.sql`UPDATE workspace_preferences SET ai_settings='{"dailyCapCents":70}'::jsonb WHERE workspace_id=${fixture.scope.workspaceId}`;
    expect(await checkOpeningBudgetAvailable(fixture.sql, fixture.scope, { amountCents: 1 }, { ...options, envCapCents: 0 }))
      .toMatchObject({ allowed: false, availableCents: 0 });
  });

  it("runs inside a max:1 READ ONLY transaction with zero writes and no TTL reconcile", async () => {
    await seed(100, "reserved", new Date(Date.now() - 3 * 86400000), true);
    const single = postgres(process.env.OPENING_TEST_DATABASE_URL!, { max: 1 });
    const before = await fixture.sql`SELECT to_jsonb(r) AS row FROM opening_budget_reservations r`;
    try {
      await single.begin("read only", async tx => {
        await tx`SET LOCAL statement_timeout='2000ms'`;
        expect(await checkOpeningBudgetAvailable(tx, fixture.scope, { amountCents: 1 }, options))
          .toMatchObject({ allowed: false, reason: "budget", availableCents: 0 });
        expect(await checkOpeningBudgetAvailable(tx, fixture.scope, free, options)).toMatchObject({ allowed: true });
      });
    } finally { await single.end({ timeout: 2 }); }
    expect(await fixture.sql`SELECT to_jsonb(r) AS row FROM opening_budget_reservations r`).toEqual(before);
    expect(await fixture.sql`SELECT count(*)::int AS n FROM opening_budget_reconcile_events`).toMatchObject([{ n: 0 }]);
    expect(await fixture.sql`SELECT count(*)::int AS n FROM opening_jobs`).toMatchObject([{ n: 0 }]);
    expect(await fixture.sql`SELECT count(*)::int AS n FROM opening_outbox`).toMatchObject([{ n: 0 }]);
  });

  it("precheck does not earmark money: concurrent final reserves still serialize and reject one", async () => {
    expect(await check(60)).toMatchObject({ allowed: true });
    const budget = createOpeningBudgetRepository(fixture.sql, options);
    const results = await Promise.allSettled(["a", "b"].map(requestId => budget.reserve(fixture.scope, { amountCents: 60, purpose: "tutor", requestId })));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find(r => r.status === "rejected")).toMatchObject({ reason: { code: "BUDGET_EXCEEDED" } });
    expect(await check(60)).toMatchObject({ allowed: false, availableCents: 40 });
  });
});
