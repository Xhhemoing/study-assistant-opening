import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { checkOpeningBudgetAvailable, createOpeningBudgetRepository } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { loadOpeningModelCatalog } from "@aistudy/config";

let fixture: OpeningFixture;
const options = { envCapCents: 0, dailyQuotaMode: "unlimited" as const, parentCapCents: 100 };
beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => { await fixture.reset(); });
afterAll(async () => { await fixture?.close(); });

it("keeps charging the ledger while exceeding the old daily budget", async () => {
  const repo = createOpeningBudgetRepository(fixture.sql, options);
  for (let n = 0; n < 3; n++) {
    const reserved = await repo.reserve(fixture.scope, { purpose: "tutor", amountCents: 80, requestId: randomUUID(), parentBudget: { id: randomUUID() } });
    await repo.settle(fixture.scope, reserved.id, 70);
  }
  const availability = await checkOpeningBudgetAvailable(fixture.sql, fixture.scope, { amountCents: 80 }, options);
  expect(availability).toMatchObject({ allowed: true, availableCents: null, dailyQuotaMode: "unlimited" });
  expect(await checkOpeningBudgetAvailable(fixture.sql, fixture.scope, { amountCents: 101 }, options)).toMatchObject({ allowed: false, reason: "parent_budget" });
  const [usage] = await fixture.sql`SELECT sum(amount_cents)::int AS cents FROM opening_budget_reservations WHERE workspace_id=${fixture.scope.workspaceId}`;
  expect(usage!.cents).toBe(210);
  expect(await repo.listReconcileEvents(fixture.scope, { kind: "cap_overrun" })).toEqual([]);
});

it("retains finite parent limits and unknown-result freezes", async () => {
  const repo = createOpeningBudgetRepository(fixture.sql, options);
  const parentBudget = { id: randomUUID() };
  const reserve = () => repo.reserve(fixture.scope, { purpose: "tutor", amountCents: 60, requestId: randomUUID(), parentBudget });
  const first = await reserve();
  await expect(reserve()).rejects.toMatchObject({ code: "PARENT_BUDGET_EXCEEDED" });
  await repo.markUnknown(fixture.scope, first.id);
  await expect(reserve()).rejects.toMatchObject({ code: "PARENT_BUDGET_OUTCOME_UNKNOWN" });
  await expect(repo.reserve(fixture.scope, { purpose: "tutor", amountCents: 41, requestId: randomUUID(), parentBudget: { id: randomUUID(), budgetCents: 40 } }))
    .rejects.toMatchObject({ code: "PARENT_BUDGET_EXCEEDED" });
});

it("does not relax provider request counts, ownership or replay identity", async () => {
  const repo = createOpeningBudgetRepository(fixture.sql, options);
  const modelSnapshot = { id: "free", providerId: "provider", modelName: "model", inputCentsPerMillion: 0, outputCentsPerMillion: 0 };
  const requestId = randomUUID();
  const input = { purpose: "tutor", amountCents: 0, modelSnapshot, requestCapPerDay: 1, requestId };
  const first = await repo.reserve(fixture.scope, input);
  expect((await repo.reserve(fixture.scope, input)).id).toBe(first.id);
  await expect(repo.reserve(fixture.scope, { ...input, requestId: randomUUID() })).rejects.toMatchObject({ code: "REQUEST_CAP_EXCEEDED" });
  await expect(checkOpeningBudgetAvailable(fixture.sql, { ...fixture.scope, ownerUserId: fixture.otherScope.ownerUserId }, { amountCents: 1 }, options))
    .rejects.toMatchObject({ code: "NOT_FOUND" });
});

it("pins implicit parents, limits even zero-priced loops to 12 calls, and replays concurrent requests once", async () => {
  const repo = createOpeningBudgetRepository(fixture.sql, options);
  await expect(repo.reserve(fixture.scope, { purpose: "tutor", amountCents: 101, requestId: randomUUID() })).rejects.toMatchObject({ code: "PARENT_BUDGET_EXCEEDED" });
  const input = { purpose: "tutor", amountCents: 10, requestId: randomUUID() };
  const pair = await Promise.all([repo.reserve(fixture.scope, input), repo.reserve(fixture.scope, input)]);
  expect(pair[0]!.id).toBe(pair[1]!.id);
  expect(pair.map(row => row.replayed).sort()).toEqual([false, true]);
  const finite = createOpeningBudgetRepository(fixture.sql, { envCapCents: 0 });
  expect(await finite.reserve(fixture.scope, input)).toMatchObject({ id: pair[0]!.id, replayed: true });
  const parentBudget = { id: randomUUID() };
  const free = { purpose: "tutor", amountCents: 0, parentBudget, requestCapPerDay: 100,
    modelSnapshot: { id: "free-loop", providerId: "p", modelName: "m", inputCentsPerMillion: 0, outputCentsPerMillion: 0 } };
  for (let n = 0; n < 12; n++) await repo.reserve(fixture.scope, { ...free, requestId: randomUUID() });
  await expect(repo.reserve(fixture.scope, { ...free, requestId: randomUUID() })).rejects.toMatchObject({ code: "PARENT_BUDGET_CALL_LIMIT" });
});

it("does not overflow a 32-bit daily sum during settlement", async () => {
  for (let n = 0; n < 2; n++) await fixture.sql`INSERT INTO opening_budget_reservations (workspace_id, purpose, amount_cents, request_id, state)
    VALUES (${fixture.scope.workspaceId}, 'tutor', 2000000000, ${randomUUID()}, 'completed')`;
  const repo = createOpeningBudgetRepository(fixture.sql, options);
  const row = await repo.reserve(fixture.scope, { purpose: "tutor", amountCents: 1, requestId: randomUUID() });
  await expect(repo.settle(fixture.scope, row.id, 1)).resolves.toMatchObject({ state: "completed" });
  expect(await checkOpeningBudgetAvailable(fixture.sql, fixture.scope, { amountCents: 1 }, options)).toMatchObject({ allowed: true, availableCents: null });
});

it("fits the existing retrieval plus tutor reservation under the configured default parent ceiling", async () => {
  const config = loadOpeningModelCatalog({ OPENING_MODEL_DAILY_QUOTA_MODE: "unlimited" });
  const repo = createOpeningBudgetRepository(fixture.sql, { ...options, parentCapCents: config.parentCapCents });
  const parentBudget = { id: randomUUID() };
  const embedding = await repo.reserve(fixture.scope, { purpose: "embedding", amountCents: 1, requestId: randomUUID(), parentBudget });
  await repo.settle(fixture.scope, embedding.id, 1);
  await expect(repo.reserve(fixture.scope, { purpose: "tutor", amountCents: 100, requestId: randomUUID(), parentBudget })).resolves.toMatchObject({ state: "reserved" });
});

it("keeps old requests replayable but applies a lowered parent ceiling to new requests", async () => {
  const parentBudget = { id: randomUUID() };
  const legacy = createOpeningBudgetRepository(fixture.sql, { envCapCents: 2000 });
  const input = { purpose: "tutor", amountCents: 10, requestId: randomUUID(), parentBudget };
  const old = await legacy.reserve(fixture.scope, input);
  await legacy.settle(fixture.scope, old.id, 10);
  const unlimited = createOpeningBudgetRepository(fixture.sql, options);
  expect(await unlimited.reserve(fixture.scope, input)).toMatchObject({ id: old.id, replayed: true });
  await expect(unlimited.reserve(fixture.scope, { ...input, amountCents: 91, requestId: randomUUID() })).rejects.toMatchObject({ code: "PARENT_BUDGET_EXCEEDED" });
});
