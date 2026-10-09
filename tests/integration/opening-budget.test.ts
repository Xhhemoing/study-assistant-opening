import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createOpeningBudgetRepository } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let fixture: OpeningFixture;
let budget: ReturnType<typeof createOpeningBudgetRepository>;

beforeAll(async () => {
  fixture = await createOpeningFixture();
  budget = createOpeningBudgetRepository(fixture.sql, { envCapCents: 100_000 });
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

  it("defaults to disabled and rejects invalid caps", async () => {
    await expect(createOpeningBudgetRepository(fixture.sql).reserve(fixture.scope, { purpose: "tutor", amountCents: 1, requestId: "disabled" })).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(() => createOpeningBudgetRepository(fixture.sql, { envCapCents: NaN })).toThrow();
  });

  it("counts today's completed spend by local created day and reconciles stale reserved rows", async () => {
    const reserve = (requestId: string, amountCents: number) => budget.reserve(fixture.scope, { purpose: "tutor", amountCents, requestId });
    const old = await reserve("old", 40_000);
    await fixture.sql`UPDATE opening_budget_reservations SET created_at=now()-interval '2 days' WHERE id=${old.id}`;
    // Next reserve reconciles the 2-day-old reserved row to completed on its created day,
    // so it no longer blocks today's cap.
    const today = await reserve("today", 50_000);
    await budget.settle(today.id, 50_000);
    await expect(reserve("over", 50_001)).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    await fixture.sql`UPDATE opening_budget_reservations SET created_at=now()-interval '2 days', updated_at=now()-interval '2 days' WHERE id=${today.id}`;
    await expect(reserve("next-day", 50_000)).resolves.toBeDefined();
    const stale = await fixture.sql`SELECT state FROM opening_budget_reservations WHERE id=${old.id}`;
    expect(stale[0].state).toBe("completed");
  });

  it("rejects changed or cross-workspace replay and cannot release completed spend", async () => {
    const input = { purpose: "tutor", amountCents: 10, requestId: "replay" };
    const first = await budget.reserve(fixture.scope, input);
    expect((await budget.reserve(fixture.scope, input)).id).toBe(first.id);
    await expect(budget.reserve(fixture.otherScope, input)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(budget.reserve(fixture.scope, { ...input, amountCents: 11 })).rejects.toMatchObject({ code: "CONFLICT" });
    await budget.settle(first.id, 8);
    await expect(budget.release(input.requestId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(budget.reserve(fixture.scope, input)).rejects.toMatchObject({ code: "CONFLICT" });
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

describe("model attribution within the shared workspace ledger", () => {
  const firstModel = { id: "one", providerId: "first", modelName: "model-one", inputCentsPerMillion: 10, outputCentsPerMillion: 20 };
  const secondModel = { ...firstModel, id: "two", providerId: "second", modelName: "model-two" };
  it("retains model and price attribution and rejects a replay with another model", async () => {
    const input = { purpose: "tutor", requestId: "same-model", amountCents: 10, modelSnapshot: firstModel };
    const reservation = await budget.reserve(fixture.scope, input);
    expect(reservation.modelSnapshot).toEqual(firstModel);
    expect((await budget.reserve(fixture.scope, input)).id).toBe(reservation.id);
    await expect(budget.reserve(fixture.scope, { ...input, modelSnapshot: secondModel })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(budget.reserve(fixture.scope, { ...input, modelSnapshot: { ...firstModel, outputCentsPerMillion: 30 } })).rejects.toMatchObject({ code: "CONFLICT" });
    const settled = await budget.settle(reservation.id, 7);
    expect(settled.modelSnapshot).toEqual(firstModel);
  });
  it("does not reset workspace usage when the chosen model or supplier changes", async () => {
    const first = await budget.reserve(fixture.scope, { purpose: "tutor", requestId: "first-provider", amountCents: 60_000, modelSnapshot: firstModel });
    await budget.settle(first.id, 60_000);
    await expect(budget.reserve(fixture.scope, { purpose: "tutor", requestId: "second-provider", amountCents: 40_001, modelSnapshot: secondModel })).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  });
});

describe("unknown reservation reconciliation (DL7)", () => {
  it("completes reserved rows older than the unknown age and leaves recent ones reserved", async () => {
    const local = createOpeningBudgetRepository(fixture.sql, {
      envCapCents: 100_000,
      unknownAgeMs: 30 * 60 * 1000,
      timeZone: "Asia/Shanghai",
    });
    const stale = await local.reserve(fixture.scope, { purpose: "tutor", amountCents: 10_000, requestId: "stale-unknown" });
    const fresh = await local.reserve(fixture.scope, { purpose: "tutor", amountCents: 10_000, requestId: "fresh-unknown" });
    await fixture.sql`UPDATE opening_budget_reservations SET created_at=now()-interval '35 minutes' WHERE id=${stale.id}`;
    await fixture.sql`UPDATE opening_budget_reservations SET created_at=now()-interval '5 minutes' WHERE id=${fresh.id}`;
    await local.reserve(fixture.scope, { purpose: "tutor", amountCents: 1, requestId: "trigger-reconcile" });
    const rows = await fixture.sql`
      SELECT id, state FROM opening_budget_reservations WHERE id IN (${stale.id}, ${fresh.id}) ORDER BY id
    `;
    const byId = Object.fromEntries(rows.map((r: { id: string; state: string }) => [r.id, r.state]));
    expect(byId[stale.id]).toBe("completed");
    expect(byId[fresh.id]).toBe("reserved");
  });
});
