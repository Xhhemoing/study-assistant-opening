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

async function rowState(id: string) {
  const rows = await fixture.sql`SELECT state, amount_cents FROM opening_budget_reservations WHERE id = ${id}`;
  return { state: rows[0].state as string, amountCents: Number(rows[0].amount_cents) };
}

describe("opening budget least-privilege scope (PR-D commit 1)", () => {
  const foreignScopes = () => [
    ["other workspace + other owner", fixture.otherScope],
    ["right workspace + wrong owner", { workspaceId: fixture.scope.workspaceId, ownerUserId: fixture.otherScope.ownerUserId }],
    ["wrong workspace + right owner", { workspaceId: fixture.otherScope.workspaceId, ownerUserId: fixture.scope.ownerUserId }],
  ] as const;

  it("release by a foreign scope fails and leaves the row reserved", async () => {
    const row = await budget.reserve(fixture.scope, { purpose: "tutor", amountCents: 500, requestId: "scope-release" });
    for (const [, foreign] of foreignScopes()) {
      await expect(budget.release(foreign, "scope-release")).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(await rowState(row.id)).toEqual({ state: "reserved", amountCents: 500 });
    await expect(budget.release(fixture.scope, "scope-release")).resolves.toMatchObject({ state: "released" });
  });

  it("complete by a foreign scope fails", async () => {
    const row = await budget.reserve(fixture.scope, { purpose: "tutor", amountCents: 500, requestId: "scope-complete" });
    for (const [, foreign] of foreignScopes()) {
      await expect(budget.complete(foreign, "scope-complete")).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(await rowState(row.id)).toEqual({ state: "reserved", amountCents: 500 });
    await expect(budget.complete(fixture.scope, "scope-complete")).resolves.toMatchObject({ state: "completed" });
  });

  it("settle by a foreign scope fails and does not change amount", async () => {
    const row = await budget.reserve(fixture.scope, { purpose: "tutor", amountCents: 500, requestId: "scope-settle" });
    for (const [, foreign] of foreignScopes()) {
      await expect(budget.settle(foreign, row.id, 1)).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(await rowState(row.id)).toEqual({ state: "reserved", amountCents: 500 });
    await expect(budget.settle(fixture.scope, row.id, 120)).resolves.toMatchObject({ state: "completed", amountCents: 120 });
  });

  it("markUnknown (byId) by a foreign scope cannot read the row", async () => {
    const row = await budget.reserve(fixture.scope, { purpose: "tutor", amountCents: 500, requestId: "scope-unknown" });
    for (const [, foreign] of foreignScopes()) {
      await expect(budget.markUnknown(foreign, row.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    await expect(budget.markUnknown(fixture.scope, row.id)).resolves.toMatchObject({ id: row.id });
  });
});
