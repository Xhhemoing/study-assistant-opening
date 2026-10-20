import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createOpeningBudgetRepository, createOpeningTeachingActivitiesRepository, readOpeningTeachingParentBudget } from "@aistudy/database";
import { runBudgetedCall, type BudgetedRepository } from "@aistudy/ai";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { closeRace, openRaceSession, track, waitUntilBlocked, type RaceSession } from "./opening-race-helpers";

let fixture: OpeningFixture;
let a: RaceSession, b: RaceSession;
beforeAll(async () => { fixture = await createOpeningFixture(); a = await openRaceSession().ready; b = await openRaceSession().ready; });
beforeEach(async () => { await fixture.reset(); });
afterAll(async () => { await closeRace(a?.sql); await closeRace(b?.sql); await fixture?.close(); });

const modelSnapshot = { id: "free", providerId: "p", modelName: "f", inputCentsPerMillion: 0, outputCentsPerMillion: 0 };

describe("durable parent interaction budget", () => {
  it("serializes independent connections across query, answer and compile reservations", async () => {
    const parentBudget = { id: randomUUID(), budgetCents: 100 };
    const repoA = createOpeningBudgetRepository(a.sql, { envCapCents: 100_000 });
    const repoB = createOpeningBudgetRepository(b.sql, { envCapCents: 100_000 });
    const first = await repoA.reserve(fixture.scope, { purpose: "query", amountCents: 40, requestId: randomUUID(), parentBudget });
    await repoA.settle(fixture.scope, first.id, 30);
    const observer = await openRaceSession().ready;
    let unlock = () => {}, locked = () => {};
    const gate = new Promise<void>(resolve => { unlock = resolve; });
    const opened = new Promise<void>(resolve => { locked = resolve; });
    const hold = track(observer.sql.begin(async tx => {
      await tx`SELECT id FROM workspaces WHERE id=${fixture.scope.workspaceId} FOR UPDATE`;
      locked(); await gate;
    }));
    await opened;
    const answer = track(repoA.reserve(fixture.scope, { purpose: "tutor", amountCents: 50, requestId: randomUUID(), parentBudget }));
    let compile: ReturnType<typeof repoB.reserve> | undefined;
    try {
      await waitUntilBlocked(fixture.sql, a.pid, observer.pid, "answer parent reserve", /SELECT id FROM workspaces/);
      compile = track(repoB.reserve(fixture.scope, { purpose: "compile-teaching-unit", amountCents: 50, requestId: randomUUID(), parentBudget }));
      // PostgreSQL queues the second tuple locker behind the first waiter.
      // Prove both links, rather than assuming both wait directly on the holder.
      await waitUntilBlocked(fixture.sql, b.pid, a.pid, "compile parent reserve", /SELECT id FROM workspaces/);
    } finally { unlock(); await hold; await closeRace(observer.sql); }
    const results = await Promise.allSettled([answer, compile]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find(r => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "PARENT_BUDGET_EXCEEDED" });
    const [row] = await fixture.sql`SELECT sum(amount_cents)::int AS total FROM opening_budget_reservations WHERE parent_interaction_id=${parentBudget.id}`;
    expect(row!.total).toBe(80);
  }, 20_000);

  it("retains unknown billing through TTL and blocks new attempts until an actual receipt", async () => {
    const repo = createOpeningBudgetRepository(fixture.sql, { envCapCents: 100_000, unknownAgeMs: 1 });
    const parentBudget = { id: randomUUID(), budgetCents: 100 };
    const reserve = (requestId: string) => repo.reserve(fixture.scope, { purpose: "tutor", amountCents: 40, requestId, parentBudget });
    const requestId = randomUUID();
    const row = await reserve(requestId);
    await repo.claimExecution(fixture.scope, row.id);
    await repo.markUnknown(fixture.scope, row.id);
    await fixture.sql`UPDATE opening_budget_reservations SET created_at=now()-interval '1 hour' WHERE id=${row.id}`;
    await expect(reserve(randomUUID())).rejects.toMatchObject({ code: "PARENT_BUDGET_OUTCOME_UNKNOWN" });
    // A rejected reserve rolls its TTL reconcile back; replay commits the pessimistic reconciliation.
    expect((await reserve(requestId)).amountCents).toBe(40);
    await expect(reserve(randomUUID())).rejects.toMatchObject({ code: "PARENT_BUDGET_OUTCOME_UNKNOWN" });
    await repo.settle(fixture.scope, row.id, 20);
    expect((await reserve(randomUUID())).amountCents).toBe(40);
    expect((await reserve(requestId)).replayed).toBe(true);
    expect(await repo.claimExecution(fixture.scope, row.id)).toBe(false);
  });

  it("limits free attempts including released primary/fallback and persists original limits", async () => {
    const repo = createOpeningBudgetRepository(fixture.sql, { envCapCents: 100_000 });
    const parentBudget = { id: randomUUID(), budgetCents: 0, maxProviderCalls: 2 };
    const reserve = (requestId: string, parent = parentBudget) => repo.reserve(fixture.scope, {
      purpose: "query", amountCents: 0, requestId, parentBudget: parent, requestCapPerDay: 1000, modelSnapshot,
    });
    const first = randomUUID();
    await reserve(first);
    await repo.release(fixture.scope, first);
    const second = randomUUID();
    await reserve(second);
    await repo.release(fixture.scope, second);
    await expect(reserve(randomUUID())).rejects.toMatchObject({ code: "PARENT_BUDGET_CALL_LIMIT" });
    await expect(reserve(randomUUID(), { ...parentBudget, maxProviderCalls: 3 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await reserve(second)).replayed).toBe(true);
  });

  it("keeps zero-priced unknown billing blocked even after pessimistic reconciliation", async () => {
    const repo = createOpeningBudgetRepository(fixture.sql, { envCapCents: 0, unknownAgeMs: 1 });
    const parentBudget = { id: randomUUID(), budgetCents: 0 };
    const input = { purpose: "query", amountCents: 0, requestId: randomUUID(), parentBudget, requestCapPerDay: 1000, modelSnapshot };
    const first = await repo.reserve(fixture.scope, input);
    await repo.markUnknown(fixture.scope, first.id);
    await fixture.sql`UPDATE opening_budget_reservations SET created_at=now()-interval '1 hour' WHERE id=${first.id}`;
    await repo.reserve(fixture.scope, input);
    await expect(repo.reserve(fixture.scope, { ...input, requestId: randomUUID() })).rejects.toMatchObject({ code: "PARENT_BUDGET_OUTCOME_UNKNOWN" });
  });

  it("records actual overage rather than truncating it and freezes the parent durably", async () => {
    const repo = createOpeningBudgetRepository(fixture.sql, { envCapCents: 100_000 });
    const budget: BudgetedRepository = {
      reserve: input => repo.reserve(fixture.scope, input),
      release: (...args) => repo.release(fixture.scope, ...args),
      claimExecution: id => repo.claimExecution(fixture.scope, id),
      settle: (...args) => repo.settle(fixture.scope, ...args),
      markUnknown: id => repo.markUnknown(fixture.scope, id),
    };
    const parentBudget = { id: randomUUID(), budgetCents: 100 };
    const requestId = randomUUID();
    await runBudgetedCall({ parentBudget, budget, provider: { complete: async () => ({ text: "ok", citedChunkIds: [], candidates: [], requestId: null, inputTokens: 1, outputTokens: 1 }) },
      input: { instruction: "test", text: "test", mode: "explain", chunks: [], imageParts: [], mediaCapability: "text_only", maxOutputTokens: 1 },
      requestId, reservedCents: 20, actualCents: () => 35 });
    const replay = await budget.reserve({ parentBudget, purpose: "tutor", amountCents: 20, requestId });
    expect(replay).toMatchObject({ state: "completed", amountCents: 35 });
    expect(await repo.listReconcileEvents(fixture.scope, { kind: "cap_overrun" })).toHaveLength(1);
    await expect(budget.reserve({ parentBudget, purpose: "query", amountCents: 1, requestId: randomUUID() })).rejects.toMatchObject({ code: "PARENT_BUDGET_BLOCKED" });
  });

  it("rejects foreign ownership and moving a request into a different parent", async () => {
    const repo = createOpeningBudgetRepository(fixture.sql, { envCapCents: 100_000 });
    const input = { purpose: "query", amountCents: 10, requestId: randomUUID(), parentBudget: { id: randomUUID(), budgetCents: 100 } };
    await repo.reserve(fixture.scope, input);
    await expect(repo.reserve({ ...fixture.scope, ownerUserId: fixture.otherScope.ownerUserId }, { ...input, requestId: randomUUID() })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(repo.reserve(fixture.scope, { ...input, parentBudget: { ...input.parentBudget, id: randomUUID() } })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("validates user-turn lineage before sharing the answer budget with teaching compilation", async () => {
    const conversationId = randomUUID(), userTurnId = randomUUID(), assistantTurnId = randomUUID();
    await fixture.sql`INSERT INTO opening_conversations (id,workspace_id,owner_user_id,title)
      VALUES (${conversationId},${fixture.scope.workspaceId},${fixture.scope.ownerUserId},'parent budget')`;
    await fixture.sql`INSERT INTO opening_turns (id,workspace_id,conversation_id,role,text,mode,status) VALUES
      (${userTurnId},${fixture.scope.workspaceId},${conversationId},'user','question','explain','complete'),
      (${assistantTurnId},${fixture.scope.workspaceId},${conversationId},'assistant','answer','explain','complete')`;
    const activities = createOpeningTeachingActivitiesRepository(fixture.sql);
    const input = { clientKey: randomUUID(), intentKind: "question" as const, intentSummary: "explain", createIntent: { source: "chat" }, sourceTurnId: userTurnId };
    const activity = await activities.create(fixture.scope, input);
    expect(await readOpeningTeachingParentBudget(fixture.sql, fixture.scope, activity.id)).toEqual({ id: `study-turn:${userTurnId}` });
    expect((await activities.create(fixture.scope, input)).id).toBe(activity.id);
    await expect(activities.create(fixture.scope, { ...input, clientKey: randomUUID(), sourceTurnId: assistantTurnId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(activities.create(fixture.otherScope, { ...input, clientKey: randomUUID() })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(activities.create(fixture.scope, { ...input, clientKey: randomUUID(), sourceTurnId: undefined,
      createIntent: { parentInteractionId: "fresh-parent" } })).rejects.toMatchObject({ code: "CONFLICT" });
    await fixture.sql`DELETE FROM opening_turns WHERE id=${userTurnId}`;
    await expect(readOpeningTeachingParentBudget(fixture.sql, fixture.scope, activity.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("adopts legacy settled reservations on replay without losing their spend", async () => {
    const repo = createOpeningBudgetRepository(fixture.sql, { envCapCents: 100_000 });
    const input = { purpose: "tutor", amountCents: 50, requestId: randomUUID() };
    const old = await repo.reserve(fixture.scope, input);
    await repo.claimExecution(fixture.scope, old.id);
    await repo.settle(fixture.scope, old.id, 30);
    const parentBudget = { id: randomUUID(), budgetCents: 50 };
    const adopted = await repo.reserve(fixture.scope, { ...input, parentBudget });
    expect(adopted).toMatchObject({ replayed: true, parentInteractionId: parentBudget.id, amountCents: 30 });
    expect(await repo.claimExecution(fixture.scope, old.id)).toBe(false);
    await expect(repo.reserve(fixture.scope, { ...input, requestId: randomUUID(), amountCents: 25, parentBudget })).rejects.toMatchObject({ code: "PARENT_BUDGET_EXCEEDED" });
  });
  it("retains media usage-price provenance until one actual vendor receipt reconciles it", async () => {
    const repo = createOpeningBudgetRepository(fixture.sql, { envCapCents: 100_000 });
    const input = { purpose: "tutor", amountCents: 50, requestId: randomUUID(), parentBudget: { id: randomUUID(), budgetCents: 100 } };
    const reserved = await repo.reserve(fixture.scope, input);
    await repo.settle(fixture.scope, reserved.id, 30, { costBasis: "media_usage_upper_bound", resultRef: "known-response" });
    expect(await repo.listPendingReconcile(fixture.scope)).toEqual([expect.objectContaining({ id: reserved.id, settlementCostBasis: "media_usage_upper_bound" })]);
    const final = await repo.settle(fixture.scope, reserved.id, 25, { costBasis: "vendor_receipt" });
    expect(final).toMatchObject({ amountCents: 25, settlementCostBasis: "vendor_receipt", resultRef: "known-response" });
    expect(await repo.listPendingReconcile(fixture.scope)).toHaveLength(0);
    await expect(repo.settle(fixture.scope, reserved.id, 25, { costBasis: "vendor_receipt" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
