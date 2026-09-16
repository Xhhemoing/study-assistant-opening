import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createOpeningBudgetRepository } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let fixture: OpeningFixture;
let budget: ReturnType<typeof createOpeningBudgetRepository>;

beforeAll(async () => {
  fixture = await createOpeningFixture();
  budget = createOpeningBudgetRepository(fixture.sql);
});
beforeEach(async () => {
  await fixture.reset();
});
afterAll(async () => {
  await fixture?.close();
});

describe("opening budget ledger (guarded)", () => {
  it("two concurrent reservations cannot exceed the workspace cap", async () => {
    const first = budget.reserve(fixture.scope, {
      purpose: "tutor",
      amountCents: 80_000,
      requestId: "conc-1",
    });
    const second = budget.reserve(fixture.scope, {
      purpose: "tutor",
      amountCents: 80_000,
      requestId: "conc-2",
    });
    const results = await Promise.allSettled([first, second]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "BUDGET_EXCEEDED",
    });
    const rows = await fixture.sql`
      SELECT COALESCE(sum(amount_cents), 0)::int AS total FROM opening_budget_reservations
      WHERE workspace_id = ${fixture.scope.workspaceId} AND state = 'reserved'
    `;
    expect(rows[0].total).toBe(80_000);
  });

  it("a failed pre-send call releases the reservation by requestId", async () => {
    await budget.reserve(fixture.scope, {
      purpose: "tutor",
      amountCents: 5_000,
      requestId: "pre-send",
    });
    const released = await budget.release("pre-send");
    expect(released.state).toBe("released");
    const rows = await fixture.sql`
      SELECT COALESCE(sum(amount_cents), 0)::int AS total FROM opening_budget_reservations
      WHERE workspace_id = ${fixture.scope.workspaceId} AND state = 'reserved'
    `;
    expect(rows[0].total).toBe(0);
  });

  it("an unknown post-send outcome retains the reservation", async () => {
    const reservation = await budget.reserve(fixture.scope, {
      purpose: "tutor",
      amountCents: 5_000,
      requestId: "post-send",
    });
    await budget.markUnknown(reservation.id);
    const rows = await fixture.sql`
      SELECT state FROM opening_budget_reservations WHERE id = ${reservation.id}
    `;
    expect(rows[0].state).toBe("reserved");
  });

  it("settle reconciles the actual cost and frees the remaining cap", async () => {
    const reservation = await budget.reserve(fixture.scope, {
      purpose: "tutor",
      amountCents: 5_000,
      requestId: "settle",
    });
    const settled = await budget.settle(reservation.id, 1_200);
    expect(settled.amountCents).toBe(1_200);
    expect(settled.state).toBe("completed");
    await expect(budget.settle(reservation.id, 1_200)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
