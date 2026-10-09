import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createOpeningBudgetRepository } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let fixture: OpeningFixture;

beforeAll(async () => {
  fixture = await createOpeningFixture();
});
beforeEach(async () => {
  await fixture.reset();
});
afterAll(async () => {
  await fixture?.close();
});

describe("opening budget reconcile (DL7)", () => {
  it("turns 35-minute-old reserved into completed on next reserve; 5-minute-old stays reserved", async () => {
    const budget = createOpeningBudgetRepository(fixture.sql, {
      envCapCents: 100_000,
      unknownAgeMs: 30 * 60 * 1000,
      timeZone: "Asia/Shanghai",
    });
    const stale = await budget.reserve(fixture.scope, { purpose: "tutor", amountCents: 1_000, requestId: "age-35" });
    const fresh = await budget.reserve(fixture.scope, { purpose: "tutor", amountCents: 1_000, requestId: "age-5" });
    await fixture.sql`UPDATE opening_budget_reservations SET created_at = now() - interval '35 minutes' WHERE id = ${stale.id}`;
    await fixture.sql`UPDATE opening_budget_reservations SET created_at = now() - interval '5 minutes' WHERE id = ${fresh.id}`;
    await budget.reserve(fixture.scope, { purpose: "tutor", amountCents: 1, requestId: "tick" });
    const rows = await fixture.sql`SELECT id, state FROM opening_budget_reservations WHERE id IN (${stale.id}, ${fresh.id})`;
    const byId = Object.fromEntries(rows.map((r: { id: string; state: string }) => [r.id, r.state]));
    expect(byId[stale.id]).toBe("completed");
    expect(byId[fresh.id]).toBe("reserved");
  });

  it("counts completed spend only on the local created day, not by updated_at", async () => {
    const budget = createOpeningBudgetRepository(fixture.sql, {
      envCapCents: 10_000,
      timeZone: "Asia/Shanghai",
    });
    const row = await budget.reserve(fixture.scope, { purpose: "tutor", amountCents: 8_000, requestId: "local-day" });
    await budget.settle(row.id, 8_000);
    // Push created_at to yesterday but leave updated_at as now — must free today's cap.
    await fixture.sql`
      UPDATE opening_budget_reservations
      SET created_at = (now() AT TIME ZONE 'Asia/Shanghai' - interval '1 day') AT TIME ZONE 'Asia/Shanghai',
          updated_at = now()
      WHERE id = ${row.id}
    `;
    await expect(
      budget.reserve(fixture.scope, { purpose: "tutor", amountCents: 8_000, requestId: "local-day-2" }),
    ).resolves.toBeDefined();
  });
});
