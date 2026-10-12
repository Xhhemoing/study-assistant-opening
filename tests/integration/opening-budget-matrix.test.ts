/**
 * PR-D test matrix (rectification plan §5.3). Real Postgres, real
 * transactions/unique constraints; the provider is a counting stub.
 * Each case records logical ops, physical provider calls and
 * used / reserved / pending-reconcile cents (to $BUDGET_MATRIX_OUT if set).
 */
import { appendFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { OpeningProviderError } from "@aistudy/ai";
import type { ProviderOutput } from "@aistudy/contracts";
import { createOpeningBudgetRepository, type OpeningScope } from "@aistudy/database";
import { runBudgetedCall, type BudgetedRepository } from "../../apps/worker/src/runtime/budgeted-call";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { closeRace, openRaceSession, track, type RaceSession } from "./opening-race-helpers";

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

const OUTPUT: ProviderOutput = { text: "ok", citedChunkIds: [], requestId: null, candidates: [], inputTokens: 10, outputTokens: 10 };
const RESERVE = 100;
const ACTUAL = 40;
const model = { id: "m1", providerId: "p1", modelName: "model-1", inputCentsPerMillion: 1, outputCentsPerMillion: 2 };

type Counting = { calls: number; complete: (..._args: unknown[]) => Promise<ProviderOutput> };
function countingProvider(impl: () => Promise<ProviderOutput> = async () => OUTPUT): Counting {
  const p: Counting = { calls: 0, complete: async () => { p.calls += 1; return impl(); } };
  return p;
}

function ledger(sql: Sql, scope: OpeningScope) {
  const repo = createOpeningBudgetRepository(sql, { envCapCents: 100_000 });
  const api: BudgetedRepository = {
    reserve: (input) => repo.reserve(scope, input),
    release: (requestId, reason) => repo.release(scope, requestId, reason),
    claimExecution: (id) => repo.claimExecution(scope, id),
    settle: (...args) => repo.settle(scope, ...args),
    markUnknown: (id) => repo.markUnknown(scope, id),
  };
  return { repo, api };
}

function call(api: BudgetedRepository, provider: Counting, requestId: string, extra: Record<string, unknown> = {}) {
  return runBudgetedCall({
    provider, budget: api, requestId, operationId: requestId,
    input: { instruction: "x", text: "y", chunks: [], mode: "explain", maxOutputTokens: 8, mediaCapability: "text_only", imageParts: [] } as never,
    reservedCents: RESERVE, actualCents: () => ACTUAL, ...extra,
  });
}

async function amounts(workspaceId: string) {
  const rows = await fixture.sql`
    SELECT
      COALESCE(sum(amount_cents) FILTER (WHERE state='completed'),0)::int AS used,
      COALESCE(sum(amount_cents) FILTER (WHERE state='reserved'),0)::int AS reserved,
      COALESCE(sum(pending_reconcile_cents),0)::int AS pending
    FROM opening_budget_reservations WHERE workspace_id=${workspaceId}`;
  return rows[0] as unknown as { used: number; reserved: number; pending: number };
}

async function record(caseName: string, logicalOps: number, providerCalls: number, outcome: string) {
  const amt = await amounts(fixture.scope.workspaceId);
  const events = await fixture.sql`SELECT kind FROM opening_budget_reconcile_events WHERE workspace_id=${fixture.scope.workspaceId} ORDER BY created_at`;
  const row = { case: caseName, logicalOps, providerCalls, ...amt, reconcileEvents: events.map((e) => e.kind).join("+") || "-", outcome };
  if (process.env.BUDGET_MATRIX_OUT) appendFileSync(process.env.BUDGET_MATRIX_OUT, `${JSON.stringify(row)}\n`);
  return row;
}

async function ageAndReconcile(requestId: string) {
  await fixture.sql`UPDATE opening_budget_reservations SET created_at = now() - interval '31 minutes' WHERE request_id=${requestId}`;
  // Any reserve in the workspace runs the lazy TTL reconcile in its tx.
  const { repo } = ledger(fixture.sql, fixture.scope);
  const tick = await repo.reserve(fixture.scope, { purpose: "tick", amountCents: 1, requestId: `tick-${requestId}` });
  await repo.release(fixture.scope, tick.requestId, "cancelled");
}

describe("PR-D budget matrix (plan §5.3)", () => {
  it("reserve/retry: retry of an in-flight key returns the same reservation, never a second hold", async () => {
    const { repo } = ledger(fixture.sql, fixture.scope);
    const first = await repo.reserve(fixture.scope, { purpose: "tutor", amountCents: RESERVE, requestId: "k" });
    const retry = await repo.reserve(fixture.scope, { purpose: "tutor", amountCents: RESERVE, requestId: "k" });
    expect(retry).toMatchObject({ id: first.id, replayed: true, state: "reserved" });
    expect(await record("reserve/retry", 2, 0, "same reservation")).toMatchObject({ used: 0, reserved: RESERVE, pending: 0 });
  });

  it("completed/replay: returns the persisted result ref, no provider call, no extra charge", async () => {
    const { api } = ledger(fixture.sql, fixture.scope);
    const p = countingProvider();
    await call(api, p, "k", { resultRef: "turn:42" });
    await expect(call(api, p, "k", { resultRef: "turn:42" })).rejects.toMatchObject({
      code: "BUDGET_REPLAY_COMPLETED", disposition: { kind: "completed", resultRef: "turn:42" },
    });
    expect(p.calls).toBe(1);
    expect(await record("completed/replay", 2, p.calls, "BUDGET_REPLAY_COMPLETED(resultRef)")).toMatchObject({ used: ACTUAL, reserved: 0, pending: 0 });
  });

  it("released/replay: explicit not-sent failure is replayed, never faked as success", async () => {
    const { api } = ledger(fixture.sql, fixture.scope);
    const p = countingProvider(async () => { throw new OpeningProviderError("PROVIDER_AUTH", "auth"); });
    await expect(call(api, p, "k")).rejects.toMatchObject({ code: "PROVIDER_AUTH" });
    await expect(call(api, p, "k")).rejects.toMatchObject({
      code: "BUDGET_REPLAY_RELEASED", disposition: { kind: "released", reason: "not_sent" },
    });
    expect(p.calls).toBe(1);
    expect(await record("released/replay", 2, p.calls, "BUDGET_REPLAY_RELEASED(not_sent)")).toMatchObject({ used: 0, reserved: 0, pending: 0 });
  });

  it("same key different params: stable CONFLICT", async () => {
    const { api, repo } = ledger(fixture.sql, fixture.scope);
    const p = countingProvider();
    await call(api, p, "k", { modelSnapshot: model });
    await expect(call(api, p, "k", { modelSnapshot: { ...model, outputCentsPerMillion: 3 } })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repo.reserve(fixture.scope, { purpose: "other", amountCents: RESERVE, requestId: "k", modelSnapshot: model })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(p.calls).toBe(1);
    expect(await record("same key different params", 3, p.calls, "CONFLICT")).toMatchObject({ used: ACTUAL, reserved: 0 });
  });

  it("field order difference: reordered snapshot keys replay (no conflict, no re-send)", async () => {
    const { api } = ledger(fixture.sql, fixture.scope);
    const p = countingProvider();
    await call(api, p, "k", { modelSnapshot: model, resultRef: "r1" });
    const reordered = { outputCentsPerMillion: 2, inputCentsPerMillion: 1, modelName: "model-1", providerId: "p1", id: "m1" };
    await expect(call(api, p, "k", { modelSnapshot: reordered, resultRef: "r1" })).rejects.toMatchObject({ code: "BUDGET_REPLAY_COMPLETED" });
    expect(p.calls).toBe(1);
    expect(await record("field order difference", 2, p.calls, "BUDGET_REPLAY_COMPLETED")).toMatchObject({ used: ACTUAL, reserved: 0 });
  });

  it("same key cross-workspace: CONFLICT, nothing charged to the other workspace", async () => {
    const mine = ledger(fixture.sql, fixture.scope);
    const theirs = ledger(fixture.sql, fixture.otherScope);
    const p = countingProvider();
    await call(mine.api, p, "k");
    await expect(call(theirs.api, p, "k")).rejects.toMatchObject({ code: "CONFLICT" });
    expect(p.calls).toBe(1);
    expect(await amounts(fixture.otherScope.workspaceId)).toEqual({ used: 0, reserved: 0, pending: 0 });
    expect(await record("same key cross-workspace", 2, p.calls, "CONFLICT (+23505 race test)")).toMatchObject({ used: ACTUAL });
  });

  it("concurrent balance race: two connections, only one fits the cap", async () => {
    const A = createOpeningBudgetRepository(a.sql, { envCapCents: 150 });
    const B = createOpeningBudgetRepository(b.sql, { envCapCents: 150 });
    let unlock: () => void = () => undefined;
    const gate = new Promise<void>((r) => { unlock = r; });
    let locked: () => void = () => undefined;
    const lockedP = new Promise<void>((r) => { locked = r; });
    const hold = track(fixture.sql.begin(async (tx) => {
      await tx`SELECT id FROM workspaces WHERE id=${fixture.scope.workspaceId} FOR UPDATE`;
      locked();
      await gate;
    }));
    await lockedP;
    const ra = track(A.reserve(fixture.scope, { purpose: "tutor", amountCents: RESERVE, requestId: "ka" }));
    const rb = track(B.reserve(fixture.scope, { purpose: "tutor", amountCents: RESERVE, requestId: "kb" }));
    await waitWaiting(a.pid);
    await waitWaiting(b.pid);
    unlock();
    await hold;
    const results = await Promise.allSettled([ra, rb]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await record("concurrent balance race", 2, 0, "1 ok + BUDGET_EXCEEDED")).toMatchObject({ reserved: RESERVE });
  }, 20_000);

  it("settle before release: release after settle is NOT_FOUND, spend kept", async () => {
    const { api, repo } = ledger(fixture.sql, fixture.scope);
    const p = countingProvider();
    await call(api, p, "k");
    await expect(repo.release(fixture.scope, "k")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await record("settle before release", 2, p.calls, "release NOT_FOUND")).toMatchObject({ used: ACTUAL, reserved: 0, pending: 0 });
  });

  it("release before late receipt: receipt is applied once via audited compensation; no double release", async () => {
    const { api, repo } = ledger(fixture.sql, fixture.scope);
    const p = countingProvider(async () => { throw new OpeningProviderError("PROVIDER_RATE_LIMIT", "429"); });
    await expect(call(api, p, "k")).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMIT" });
    const row = (await fixture.sql`SELECT id FROM opening_budget_reservations WHERE request_id='k'`)[0]!;
    const late = await repo.settle(fixture.scope, row.id as string, 60);
    expect(late).toMatchObject({ state: "completed", amountCents: 60 });
    await expect(repo.release(fixture.scope, "k")).rejects.toMatchObject({ code: "NOT_FOUND" });
    const ev = await fixture.sql`SELECT state_before, amount_after_cents FROM opening_budget_reconcile_events WHERE reservation_id=${row.id}`;
    expect(ev).toEqual([{ state_before: "released", amount_after_cents: 60 }]);
    expect(await record("release before late receipt", 3, p.calls, "late_receipt applied, release NOT_FOUND")).toMatchObject({ used: 60, reserved: 0, pending: 0 });
  });

  it("duplicate receipt: second settle is rejected (normal and post-reconcile)", async () => {
    const { api, repo } = ledger(fixture.sql, fixture.scope);
    const p = countingProvider();
    await call(api, p, "k");
    const row = (await fixture.sql`SELECT id FROM opening_budget_reservations WHERE request_id='k'`)[0]!;
    await expect(repo.settle(fixture.scope, row.id as string, ACTUAL)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const unknown = await repo.reserve(fixture.scope, { purpose: "tutor", amountCents: RESERVE, requestId: "u" });
    await repo.markUnknown(fixture.scope, unknown.id);
    await ageAndReconcile("u");
    await repo.settle(fixture.scope, unknown.id, 30);
    await expect(repo.settle(fixture.scope, unknown.id, 30)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await record("duplicate receipt", 6, p.calls, "2nd settle NOT_FOUND x2")).toMatchObject({ used: ACTUAL + 30, reserved: 0, pending: 0 });
  });

  it("provider success but write-back fails: no re-send; TTL keeps full charge; late receipt reconciles", async () => {
    const { api, repo } = ledger(fixture.sql, fixture.scope);
    const failingWriteBack: BudgetedRepository = { ...api, settle: async () => { throw new Error("write-back failed"); } };
    const p = countingProvider();
    await expect(call(failingWriteBack, p, "k")).rejects.toThrow("write-back failed");
    await expect(call(api, p, "k")).rejects.toMatchObject({ code: "BUDGET_EXECUTION_CLAIMED" });
    expect(p.calls).toBe(1);
    await ageAndReconcile("k");
    const mid = await amounts(fixture.scope.workspaceId);
    expect(mid).toEqual({ used: RESERVE, reserved: 0, pending: RESERVE });
    await expect(call(api, p, "k")).rejects.toMatchObject({ code: "BUDGET_OUTCOME_UNKNOWN", disposition: { reconciled: true } });
    const row = (await fixture.sql`SELECT id FROM opening_budget_reservations WHERE request_id='k'`)[0]!;
    await repo.settle(fixture.scope, row.id as string, ACTUAL);
    expect(p.calls).toBe(1);
    expect(await record("provider success, write-back fails", 4, p.calls, `claimed→ttl(used ${mid.used},pending ${mid.pending})→late receipt`)).toMatchObject({ used: ACTUAL, reserved: 0, pending: 0 });
  });

  it("crash recovery: concurrent workers on one key — only the claimant calls the provider; crash → TTL retains cost", async () => {
    const wa = ledger(a.sql, fixture.scope);
    const wb = ledger(b.sql, fixture.scope);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    let entered: () => void = () => undefined;
    const inProvider = new Promise<void>((r) => { entered = r; });
    const p = countingProvider(async () => { entered(); await gate; throw new Error("worker crashed"); });
    const workerA = track(call(wa.api, p, "k"));
    await inProvider; // barrier: A owns the claim and is mid-provider
    await expect(call(wb.api, p, "k")).rejects.toMatchObject({ code: "BUDGET_EXECUTION_CLAIMED" });
    release();
    await expect(workerA).rejects.toThrow("worker crashed");
    expect(p.calls).toBe(1);
    // crashed worker left an unknown, still-held reservation; TTL keeps full amount observably.
    await ageAndReconcile("k");
    const ev = await fixture.sql`SELECT kind FROM opening_budget_reconcile_events`;
    expect(ev.map((e) => e.kind)).toEqual(["ttl_reconciled"]);
    expect(await record("crash recovery", 2, p.calls, "B=EXECUTION_CLAIMED; TTL pending")).toMatchObject({ used: RESERVE, reserved: 0, pending: RESERVE });
  });

  it("claimExecution DB race: two connections blocked on one row lock, exactly one wins", async () => {
    const { repo } = ledger(fixture.sql, fixture.scope);
    const row = await repo.reserve(fixture.scope, { purpose: "tutor", amountCents: RESERVE, requestId: "k" });
    let unlock: () => void = () => undefined;
    const gate = new Promise<void>((r) => { unlock = r; });
    let locked: () => void = () => undefined;
    const lockedP = new Promise<void>((r) => { locked = r; });
    const hold = track(fixture.sql.begin(async (tx) => {
      await tx`SELECT id FROM opening_budget_reservations WHERE id=${row.id} FOR UPDATE`;
      locked();
      await gate;
    }));
    await lockedP;
    const ca = track(ledger(a.sql, fixture.scope).repo.claimExecution(fixture.scope, row.id));
    const cb = track(ledger(b.sql, fixture.scope).repo.claimExecution(fixture.scope, row.id));
    await waitWaiting(a.pid);
    await waitWaiting(b.pid);
    unlock();
    await hold;
    expect((await Promise.all([ca, cb])).sort()).toEqual([false, true]);
    expect(await record("claimExecution DB race", 2, 0, "exactly one claim")).toMatchObject({ reserved: RESERVE });
  }, 20_000);

  it("unknown cost retained: never released at zero, never re-sent; TTL = full amount + pending reconcile", async () => {
    const { api, repo } = ledger(fixture.sql, fixture.scope);
    const p = countingProvider(async () => { throw new OpeningProviderError("PROVIDER_TIMEOUT", "timeout"); });
    await expect(call(api, p, "k")).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
    await expect(call(api, p, "k")).rejects.toMatchObject({ code: "BUDGET_OUTCOME_UNKNOWN", disposition: { reconciled: false } });
    await expect(repo.release(fixture.scope, "k")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await ageAndReconcile("k");
    await expect(call(api, p, "k")).rejects.toMatchObject({ code: "BUDGET_OUTCOME_UNKNOWN", disposition: { reconciled: true, pendingReconcileCents: RESERVE } });
    const r = (await fixture.sql`SELECT state, reconciled_at IS NOT NULL AS rec FROM opening_budget_reservations WHERE request_id='k'`)[0]!;
    expect(r).toEqual({ state: "completed", rec: true });
    expect(p.calls).toBe(1);
    expect(await record("unknown cost retained", 4, p.calls, "OUTCOME_UNKNOWN; TTL completed+pending")).toMatchObject({ used: RESERVE, reserved: 0, pending: RESERVE });
  });
});

async function waitWaiting(pid: number) {
  await vi.waitFor(async () => {
    const rows = await fixture.sql`SELECT count(*)::int AS n FROM pg_locks WHERE pid=${pid} AND NOT granted`;
    if ((rows[0]?.n ?? 0) < 1) throw new Error("not waiting yet");
  }, { timeout: 5_000, interval: 40 });
}
