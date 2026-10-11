import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  OPENING_BUDGET_UNKNOWN_RECONCILE_TTL_MS,
  createOpeningBudgetRepository,
} from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let fixture: OpeningFixture;
let budget: ReturnType<typeof createOpeningBudgetRepository>;

beforeAll(async () => {
  fixture = await createOpeningFixture();
  budget = createOpeningBudgetRepository(fixture.sql, { dailyCapCents: 100_000 });
});
beforeEach(async () => {
  await fixture.reset();
});
afterAll(async () => {
  await fixture?.close();
});

describe("opening budget unknown reconcile (DL7)", () => {
  it("documents the ~30 min reconcile TTL constant", () => {
    expect(OPENING_BUDGET_UNKNOWN_RECONCILE_TTL_MS).toBe(30 * 60 * 1000);
  });

  it("reconciles aged reserved (~35 min) to completed at reserved amount on next reserve", async () => {
    const aged = await budget.reserve(fixture.scope, {
      purpose: "tutor",
      amountCents: 7_500,
      requestId: "aged-unknown",
    });
    await budget.markUnknown(aged.id);
    await fixture.sql`
      UPDATE opening_budget_reservations
      SET created_at = now() - interval '35 minutes'
      WHERE id = ${aged.id}
    `;

    await budget.reserve(fixture.scope, {
      purpose: "tutor",
      amountCents: 1_000,
      requestId: "trigger-reconcile",
    });

    const rows = await fixture.sql`
      SELECT state, amount_cents::int AS amount_cents
      FROM opening_budget_reservations WHERE id = ${aged.id}
    `;
    expect(rows[0].state).toBe("completed");
    expect(rows[0].amount_cents).toBe(7_500);
  });

  it("leaves fresh reserved (~5 min) untouched by the sweep", async () => {
    const fresh = await budget.reserve(fixture.scope, {
      purpose: "tutor",
      amountCents: 3_000,
      requestId: "fresh-reserved",
    });
    await budget.markUnknown(fresh.id);
    await fixture.sql`
      UPDATE opening_budget_reservations
      SET created_at = now() - interval '5 minutes'
      WHERE id = ${fresh.id}
    `;

    await budget.reserve(fixture.scope, {
      purpose: "tutor",
      amountCents: 1_000,
      requestId: "trigger-fresh",
    });

    const rows = await fixture.sql`
      SELECT state FROM opening_budget_reservations WHERE id = ${fresh.id}
    `;
    expect(rows[0].state).toBe("reserved");
  });

  it("counts completed spend by created_at on the Asia/Shanghai local day", async () => {
    // Cap 100: two 40¢ completes at Shanghai 00:30 and 07:59 today must share one bucket.
    // Under UTC-only "today", both fall on the previous UTC calendar day when now is
    // after 08:00 Asia/Shanghai, so this assertion fails if counting uses UTC.
    const localBudget = createOpeningBudgetRepository(fixture.sql, {
      dailyCapCents: 100,
      timeZone: "Asia/Shanghai",
    });

    const morning = await localBudget.reserve(fixture.scope, {
      purpose: "tutor",
      amountCents: 40,
      requestId: "local-0030",
    });
    await localBudget.settle(morning.id, 40);
    await fixture.sql`
      UPDATE opening_budget_reservations
      SET created_at = (
        date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'
        + interval '30 minutes'
      ),
      updated_at = now()
      WHERE id = ${morning.id}
    `;

    const mid = await localBudget.reserve(fixture.scope, {
      purpose: "tutor",
      amountCents: 40,
      requestId: "local-0759",
    });
    await localBudget.settle(mid.id, 40);
    await fixture.sql`
      UPDATE opening_budget_reservations
      SET created_at = (
        date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'
        + interval '7 hours 59 minutes'
      ),
      updated_at = now()
      WHERE id = ${mid.id}
    `;

    await expect(localBudget.reserve(fixture.scope, {
      purpose: "tutor",
      amountCents: 30,
      requestId: "local-over",
    })).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  });

  it("markUnknown still retains reserved immediately; only aged rows reconcile", async () => {
    const reservation = await budget.reserve(fixture.scope, {
      purpose: "tutor",
      amountCents: 5_000,
      requestId: "immediate-unknown",
    });
    await budget.markUnknown(reservation.id);
    const rows = await fixture.sql`
      SELECT state FROM opening_budget_reservations WHERE id = ${reservation.id}
    `;
    expect(rows[0].state).toBe("reserved");
  });

  it("frees cap after reconciling aged unknown so a previously blocked reserve succeeds", async () => {
    const tight = createOpeningBudgetRepository(fixture.sql, { dailyCapCents: 10_000 });
    const aged = await tight.reserve(fixture.scope, {
      purpose: "tutor",
      amountCents: 8_000,
      requestId: "aged-block",
    });
    await tight.markUnknown(aged.id);
    await fixture.sql`
      UPDATE opening_budget_reservations
      SET created_at = now() - interval '35 minutes'
      WHERE id = ${aged.id}
    `;

    // Before reconcile trigger: still reserved, so 8k+3k > 10k
    // After: aged becomes completed on a prior instant; if created_at is 35min ago
    // still same local day, completed still counts. Backdate created_at to prior local day
    // so reconcile frees today's cap.
    await fixture.sql`
      UPDATE opening_budget_reservations
      SET created_at = now() - interval '2 days'
      WHERE id = ${aged.id}
    `;

    await expect(tight.reserve(fixture.scope, {
      purpose: "tutor",
      amountCents: 9_000,
      requestId: "after-reconcile",
    })).resolves.toMatchObject({ amountCents: 9_000, state: "reserved" });

    const rows = await fixture.sql`
      SELECT state, amount_cents::int AS amount_cents
      FROM opening_budget_reservations WHERE id = ${aged.id}
    `;
    expect(rows[0].state).toBe("completed");
    expect(rows[0].amount_cents).toBe(8_000);
  });
});
