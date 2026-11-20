import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createModelGateway, createOpeningProvider, OpeningModelRoutingError, OpeningProviderError, type ModelGateway } from "@aistudy/ai";
import type { ProviderInput, ProviderOutput } from "@aistudy/contracts";
import { createOpeningBudgetRepository, readOpeningDailyBudgetUsage } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import type { Sql } from "postgres";
import { closeRace, openRaceSession, track, waitUntilBlocked, type RaceSession } from "./opening-race-helpers";
import { createEphemeralTutorService } from "../../apps/web/src/features/opening/tutor/ephemeral-service";

/** Deterministic condition (not elapsed time): pid has an ungranted lock request. */
async function waitUntilWaiting(observer: Sql, pid: number, label: string): Promise<void> {
  await vi.waitFor(async () => {
    const rows = await observer<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_locks WHERE pid=${pid} AND NOT granted`;
    if ((rows[0]?.n ?? 0) < 1) throw new Error(`${label} not waiting yet`);
  }, { timeout: 5_000, interval: 40 });
}

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

function latch() {
  let open!: () => void;
  const wait = new Promise<void>(resolve => { open = resolve; });
  return { open, wait };
}

function gatewayBudget(repo: ReturnType<typeof createOpeningBudgetRepository>): Parameters<ModelGateway["call"]>[2]["budget"] {
  const scope = fixture.scope;
  return {
    reserve: input => repo.reserve(scope, input),
    claimExecution: id => repo.claimExecution(scope, id),
    settle: (id, cents, options) => repo.settle(scope, id, cents, options),
    markUnknown: id => repo.markUnknown(scope, id),
    release: (key, reason) => repo.release(scope, key, reason),
  };
}

const input: ProviderInput = { instruction: "derive", text: "question", chunks: [], mode: "explain",
  maxOutputTokens: 100, mediaCapability: "text_only", imageParts: [], outputFormat: "json" };
const output: ProviderOutput = { text: "answer", citedChunkIds: [], candidates: [], requestId: null, inputTokens: 40, outputTokens: 10 };
function model(id: string, rate: number, complete: () => Promise<ProviderOutput>) {
  return { provider: { complete }, inputCentsPerMillion: rate, outputCentsPerMillion: rate,
    modelSnapshot: { id, providerId: "p", modelName: id, inputCentsPerMillion: rate, outputCentsPerMillion: rate } };
}

describe("opening budget races (two independent connections, deterministic barriers)", () => {
  it("blocks a primary retry while its budget-degraded fallback is in flight, then replays the fallback receipt", async () => {
    const scope = fixture.scope;
    const budgetA = createOpeningBudgetRepository(a.sql, { envCapCents: 100 });
    const budgetB = createOpeningBudgetRepository(b.sql, { envCapCents: 100 });
    await budgetA.reserve(scope, { purpose: "tutor", requestId: "unrelated-hold", amountCents: 90 });
    const fallbackStarted = latch();
    const finishFallback = latch();
    const primarySend = vi.fn(async () => output);
    const fallbackSend = vi.fn(async () => { fallbackStarted.open(); await finishFallback.wait; return output; });
    const gateway = createModelGateway({
      resolve: async () => model("primary", 10_000, primarySend),
      resolveFallback: async () => model("backup", 1_000, fallbackSend),
    });
    const settings = { input, operationId: "exam:race", resultRef: "exam:ready" };
    const first = track(gateway.call(scope, "practice.exam", { ...settings, budget: gatewayBudget(budgetA) }));
    try {
      await Promise.race([fallbackStarted.wait, first]);
      await budgetB.release(scope, "unrelated-hold", "not_sent");
      await expect(gateway.call(scope, "practice.exam", { ...settings, budget: gatewayBudget(budgetB) }))
        .rejects.toMatchObject({ code: "BUDGET_EXECUTION_CLAIMED" });
    } finally {
      finishFallback.open();
      await first;
    }
    await expect(gateway.call(scope, "practice.exam", { ...settings, budget: gatewayBudget(budgetB) }))
      .rejects.toMatchObject({ code: "BUDGET_REPLAY_COMPLETED", disposition: { resultRef: "exam:ready" } });
    expect(primarySend).not.toHaveBeenCalled();
    expect(fallbackSend).toHaveBeenCalledOnce();
    const rows = await fixture.sql`SELECT request_id,state,amount_cents FROM opening_budget_reservations
      WHERE workspace_id=${scope.workspaceId} AND state='completed'`;
    expect(rows).toEqual([{ request_id: "exam:race:fallback", state: "completed", amount_cents: 1 }]);
  });

  it("allows fallback after a confirmed primary release and blocks sibling retries after settlement", async () => {
    const scope = fixture.scope;
    const repo = createOpeningBudgetRepository(a.sql, { envCapCents: 100 });
    const complete = vi.fn(async () => output);
    const gateway = createModelGateway({
      resolve: async () => model("primary", 10_000, async () => { throw new OpeningProviderError("PROVIDER_RATE_LIMIT", "429"); }),
      resolveFallback: async () => model("backup", 1_000, complete),
    });
    const settings = { input, operationId: "exam:not-sent", budget: gatewayBudget(repo) };
    await expect(gateway.call(scope, "practice.exam", settings)).resolves.toEqual(output);
    await expect(gateway.call(scope, "practice.exam", { ...settings, operationId: "exam:not-sent:retry:released-id", requestFamily: settings.operationId }))
      .rejects.toMatchObject({ code: "BUDGET_REPLAY_COMPLETED" });
    expect(complete).toHaveBeenCalledOnce();
    const rows = await fixture.sql`SELECT request_id,state,release_reason FROM opening_budget_reservations
      WHERE workspace_id=${scope.workspaceId} ORDER BY request_id`;
    expect(rows).toEqual([
      { request_id: "exam:not-sent", state: "released", release_reason: "not_sent" },
      { request_id: "exam:not-sent:fallback", state: "completed", release_reason: null },
    ]);
  });

  it("blocks an unclaimed primary's fallback and keeps an unknown primary frozen across retry variants", async () => {
    const scope = fixture.scope;
    const budgetA = createOpeningBudgetRepository(a.sql, { envCapCents: 100 });
    const budgetB = createOpeningBudgetRepository(b.sql, { envCapCents: 100 });
    const primary = { purpose: "tutor", requestId: "family", amountCents: 1 };
    const reservation = await budgetA.reserve(scope, primary);
    await expect(budgetB.reserve(scope, { ...primary, requestId: "family:fallback" }))
      .rejects.toMatchObject({ code: "BUDGET_EXECUTION_CLAIMED", disposition: { reservationId: reservation.id } });
    expect(await budgetA.claimExecution(scope, reservation.id)).toBe(true);
    await budgetA.markUnknown(scope, reservation.id);
    await expect(budgetB.reserve(scope, { ...primary, requestId: "family:retry:prior:fallback" }))
      .rejects.toMatchObject({ code: "BUDGET_OUTCOME_UNKNOWN", disposition: { reservationId: reservation.id } });
    await expect(budgetB.reserve(scope, { ...primary, requestId: "family:independent:1" })).resolves.toMatchObject({ state: "reserved" });
  });

  it.each([
    { clientKey: "lesson-123:retry", reason: "not_sent" },
    { clientKey: "lesson-123:fallback", reason: "cancelled" },
  ] as const)("serializes fallback and retry against the primary for $clientKey", async ({ clientKey, reason }) => {
    const scope = fixture.scope;
    const budgetA = createOpeningBudgetRepository(a.sql, { envCapCents: 100 });
    const budgetB = createOpeningBudgetRepository(b.sql, { envCapCents: 100 });
    const requestFamily = `eph:${clientKey}`;
    const terms = { purpose: "tutor", amountCents: 1, requestFamily };
    const primary = await budgetA.reserve(scope, { ...terms, requestId: requestFamily });
    const fallback = { ...terms, requestId: `${requestFamily}:fallback` };
    const retry = { ...terms, requestId: `${requestFamily}:retry:${primary.id}:fallback` };
    const locked = latch(), unlock = latch();
    const hold = track(a.sql.begin(async tx => {
      await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} FOR UPDATE`;
      locked.open();
      await unlock.wait;
    }));
    await locked.wait;
    const pending = track(budgetB.reserve(scope, fallback));
    try {
      await waitUntilBlocked(fixture.sql, b.pid, a.pid, "fallback reserve", /FOR UPDATE/);
    } finally {
      unlock.open();
      await hold;
    }
    await expect(pending).rejects.toMatchObject({ code: "BUDGET_EXECUTION_CLAIMED", disposition: { reservationId: primary.id } });
    expect(await budgetA.claimExecution(scope, primary.id)).toBe(true);
    await budgetA.markUnknown(scope, primary.id);
    for (const attempt of [fallback, retry]) {
      await expect(budgetB.reserve(scope, attempt))
        .rejects.toMatchObject({ code: "BUDGET_OUTCOME_UNKNOWN", disposition: { reservationId: primary.id } });
    }
    // Unknown charges cannot be released. Use a fresh operation with the same suffix
    // to verify the separate path where the primary is confirmed unsent.
    const releasedFamily = `fresh-${requestFamily}`;
    await budgetA.reserve(scope, { ...terms, requestFamily: releasedFamily, requestId: releasedFamily });
    await budgetA.release(scope, releasedFamily, reason);
    await expect(budgetB.reserve(scope, { ...terms, requestFamily: releasedFamily, requestId: `${releasedFamily}:fallback` }))
      .resolves.toMatchObject({ state: "reserved" });
  });

  it("uses one ephemeral family across connections and keeps suffix-shaped client keys independent", async () => {
    const scope = fixture.scope;
    const budgetA = createOpeningBudgetRepository(a.sql, { envCapCents: 100 });
    const budgetB = createOpeningBudgetRepository(b.sql, { envCapCents: 100 });
    const primaryStarted = latch(), finishPrimary = latch();
    const primary = vi.fn(async () => { primaryStarted.open(); await finishPrimary.wait; return output; });
    const fallback = vi.fn(async () => output);
    const otherPrimary = vi.fn(async () => output);
    let primaryAvailable = false;
    const defaults = {
      sources: { listOwnedIds: async () => [] },
      chunks: { listForSources: async () => [] },
      privacy: { snapshot: async () => ({ epoch: 0, excludedSourceIds: [] }), currentEpoch: async () => 0 },
      config: { maxContextCharacters: 1000, maxOutputTokens: 32, reservedCents: 1, inputCentsPerMillion: 1, outputCentsPerMillion: 1 },
    };
    const serviceA = createEphemeralTutorService({ ...defaults, budget: gatewayBudget(budgetA), provider: { complete: primary } });
    const serviceB = createEphemeralTutorService({ ...defaults, budget: gatewayBudget(budgetB), provider: null,
      resolveModel: async () => {
        if (!primaryAvailable) throw new OpeningModelRoutingError("primary unavailable");
        return model("other-primary", 1, otherPrimary);
      },
      resolveFallbackModel: async () => model("fallback", 1, fallback),
    });
    const turn = (clientKey: string) => ({ text: "Explain the derivation", sourceIds: [], history: [], clientKey });
    const inFlight = track(serviceA.replyEphemeral(scope, turn("lesson-123:retry")));
    try {
      await Promise.race([primaryStarted.wait, inFlight]);
      await expect(serviceB.replyEphemeral(scope, turn("lesson-123:retry"))).rejects.toMatchObject({ code: "BUDGET_EXECUTION_CLAIMED" });
      expect(fallback).not.toHaveBeenCalled();
      await expect(serviceB.replyEphemeral(scope, turn("lesson-123"))).resolves.toMatchObject({ text: "answer" });
      primaryAvailable = true;
      for (const other of ["lesson-123:fallback", "lesson-123:retry:bar"]) {
        await expect(serviceB.replyEphemeral(scope, turn(other))).resolves.toMatchObject({ text: "answer" });
      }
    } finally {
      finishPrimary.open();
      await inFlight;
    }
    // A completed fallback replays when the primary route returns.
    await expect(serviceA.replyEphemeral(scope, turn("lesson-123"))).rejects.toMatchObject({ code: "BUDGET_REPLAY_COMPLETED" });
    expect(primary).toHaveBeenCalledOnce();
    expect(fallback).toHaveBeenCalledOnce();
    expect(otherPrimary).toHaveBeenCalledTimes(2);
    const rows = await fixture.sql`SELECT DISTINCT request_id FROM opening_budget_reservations WHERE workspace_id=${scope.workspaceId}`;
    expect(rows).toHaveLength(4);
  });

  it("replays a legacy exact key for its parent even when it looks like another client's fallback", async () => {
    const scope = fixture.scope;
    const budgetA = createOpeningBudgetRepository(a.sql, { envCapCents: 100 });
    const budgetB = createOpeningBudgetRepository(b.sql, { envCapCents: 100 });
    const base = "eph:lesson-123";
    const legacyFallback = `${base}:fallback`;
    const parentBudget = { id: `study-ephemeral:${scope.workspaceId}:lesson-123` };
    const legacy = await budgetA.reserve(scope, { purpose: "tutor", requestId: legacyFallback, amountCents: 1, parentBudget });
    await budgetA.settle(scope, legacy.id, 1, { resultRef: "ephemeral:old" });
    const family = "eph-v2:original";
    const terms = { purpose: "tutor", amountCents: 1, parentBudget, requestFamily: family, legacyRequestFamily: base };
    await expect(budgetB.reserve(scope, { ...terms, requestId: `${family}:fallback` }))
      .resolves.toMatchObject({ id: legacy.id, requestId: legacyFallback, state: "completed", resultRef: "ephemeral:old" });
    await expect(budgetB.reserve(scope, { ...terms, requestId: family }))
      .rejects.toMatchObject({ code: "BUDGET_REPLAY_COMPLETED", disposition: { reservationId: legacy.id } });
    await expect(budgetB.reserve(scope, { ...terms, requestId: "eph-v2:distinct", requestFamily: "eph-v2:distinct",
      legacyRequestFamily: legacyFallback, parentBudget: { id: `${parentBudget.id}:fallback` },
    })).resolves.toMatchObject({ state: "reserved" });
  });

  it("records actual cost for an interrupted SSE response without persisting or replaying partial text", async () => {
    const scope = fixture.scope;
    const repo = createOpeningBudgetRepository(a.sql, { envCapCents: 100 });
    const frames = 'data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":"stop"}]}\n\n'
      + 'data: {"choices":[],"usage":{"prompt_tokens":1400,"completion_tokens":200}}\n\n';
    const fetchImpl = vi.fn(async () => new Response(frames));
    const provider = createOpeningProvider({ baseUrl: "https://model.example", apiKey: "key", model: "model", fetchImpl });
    const gateway = createModelGateway({ resolve: async () => ({ ...model("stream", 1000, provider.complete), provider }) });
    const persistResult = vi.fn();
    const settings = { input: { ...input, outputFormat: "markdown" as const }, operationId: "stream-eof",
      budget: gatewayBudget(repo), persistResult, resultRef: "turn:incomplete" };
    await expect(gateway.call(scope, "tutor.explain", settings)).rejects.toMatchObject({ code: "PROVIDER_RESPONSE" });
    await expect(gateway.call(scope, "tutor.explain", settings))
      .rejects.toMatchObject({ code: "BUDGET_REPLAY_COMPLETED", disposition: { resultRef: null } });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(persistResult).not.toHaveBeenCalled();
    const rows = await fixture.sql`SELECT state, amount_cents, outcome_unknown_at, result_ref FROM opening_budget_reservations
      WHERE workspace_id=${scope.workspaceId}`;
    expect(rows).toEqual([{ state: "completed", amount_cents: 2, outcome_unknown_at: null, result_ref: null }]);
  });

  it("uses the post-lock clock for today's admission and both inserted timestamps across midnight", async () => {
    const scope = fixture.scope;
    await fixture.sql`INSERT INTO workspace_preferences (workspace_id, planning_settings)
      VALUES (${scope.workspaceId}, '{"timeZone":"UTC"}'::jsonb)`;
    // Shift only B's wall clock across UTC midnight under a real PostgreSQL row lock.
    // Transaction-start now() and the schema's timestamp defaults still use the real clock.
    await fixture.sql`CREATE SCHEMA budget_clock_test`;
    try {
      await fixture.sql`CREATE TABLE budget_clock_test.sample (instant timestamptz NOT NULL)`;
      await fixture.sql`INSERT INTO budget_clock_test.sample VALUES (pg_catalog.clock_timestamp())`;
      await fixture.sql`CREATE FUNCTION budget_clock_test.clock_timestamp() RETURNS timestamptz
        LANGUAGE sql VOLATILE AS $$ SELECT instant FROM budget_clock_test.sample $$`;
      await b.sql`SET search_path TO budget_clock_test, pg_catalog, public`;
      const unlock = latch(), locked = latch();
      const hold = track(a.sql.begin(async tx => {
        await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} FOR UPDATE`;
        locked.open();
        await unlock.wait;
      }));
      const budget = createOpeningBudgetRepository(b.sql, { envCapCents: 30 });
      await locked.wait;
      const pending = track(budget.reserve(scope, { purpose: "tutor", requestId: "cross-midnight", amountCents: 30 }));
      try {
        await waitUntilBlocked(fixture.sql, b.pid, a.pid, "midnight reserve", /FOR UPDATE/);
        const [clock] = await fixture.sql<{ before: Date; instant: Date }[]>`
          UPDATE budget_clock_test.sample
          SET instant = (date_trunc('day', (SELECT xact_start FROM pg_stat_activity WHERE pid=${b.pid}) AT TIME ZONE 'UTC')
            + interval '1 day') AT TIME ZONE 'UTC'
          RETURNING (SELECT xact_start FROM pg_stat_activity WHERE pid=${b.pid}) AS before, instant`;
        expect(clock!.before.getTime()).toBeLessThan(clock!.instant.getTime());
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(clock!.instant);
        unlock.open();
        const reservation = await pending;
        const [row] = await fixture.sql`SELECT created_at,updated_at FROM opening_budget_reservations WHERE id=${reservation.id}`;
        await budget.settle(scope, reservation.id, 30);
        // Skew the application clock so a JS-based admission window would allow another charge.
        vi.setSystemTime(clock!.instant.getTime() + 86_400_000);
        await expect(budget.reserve(scope, { purpose: "tutor", requestId: "second-same-day", amountCents: 30 }))
          .rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
        expect(row).toEqual({ created_at: clock!.instant, updated_at: clock!.instant });
        vi.useRealTimers();
        expect(await readOpeningDailyBudgetUsage(b.sql, scope)).toMatchObject({
          localDate: clock!.instant.toISOString().slice(0, 10), spentCents: 30, reservedCents: 0,
        });
      } finally {
        vi.useRealTimers();
        unlock.open();
        await Promise.allSettled([hold, pending]);
        await b.sql`RESET search_path`;
      }
    } finally {
      await fixture.sql`DROP SCHEMA budget_clock_test CASCADE`;
    }
  }, 20_000);

  it("same key in two workspaces racing on the global UNIQUE maps 23505 to CONFLICT", async () => {
    const budgetB = createOpeningBudgetRepository(b.sql, { envCapCents: 100_000 });
    // Barrier: connection A holds an uncommitted row for the key in workspace 1.
    let commitA: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { commitA = resolve; });
    let inserted: () => void = () => undefined;
    const insertedP = new Promise<void>((resolve) => { inserted = resolve; });
    const holder = track(a.sql.begin(async (tx) => {
      await tx`INSERT INTO opening_budget_reservations (workspace_id, purpose, amount_cents, request_id)
               VALUES (${fixture.scope.workspaceId}, 'tutor', 10, 'xws-key')`;
      inserted();
      await gate;
    }));
    await insertedP;
    // Workspace 2 does not see the uncommitted row and blocks on the unique index.
    const contender = track(budgetB.reserve(fixture.otherScope, { purpose: "tutor", amountCents: 10, requestId: "xws-key" }));
    await waitUntilBlocked(fixture.sql, b.pid, a.pid, "cross-workspace reserve", /INSERT INTO opening_budget_reservations/);
    commitA();
    await holder;
    await expect(contender).rejects.toMatchObject({ name: "OpeningBudgetError", code: "CONFLICT" });
    const rows = await fixture.sql`SELECT workspace_id FROM opening_budget_reservations WHERE request_id='xws-key'`;
    expect(rows.map((r) => r.workspace_id)).toEqual([fixture.scope.workspaceId]);
  });

  it("concurrent balance race: workspace FOR UPDATE serializes two connections; only one fits the cap", async () => {
    const budgetA = createOpeningBudgetRepository(a.sql, { envCapCents: 100_000 });
    const budgetB = createOpeningBudgetRepository(b.sql, { envCapCents: 100_000 });
    // Barrier: observer holds the workspace row lock.
    let unlock: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { unlock = resolve; });
    let locked: () => void = () => undefined;
    const lockedP = new Promise<void>((resolve) => { locked = resolve; });
    const observer = openRaceSession();
    await observer.ready;
    const hold = track(observer.sql.begin(async (tx) => {
      await tx`SELECT id FROM workspaces WHERE id=${fixture.scope.workspaceId} FOR UPDATE`;
      locked();
      await gate;
    }));
    await lockedP;
    const first = track(budgetA.reserve(fixture.scope, { purpose: "tutor", amountCents: 60_000, requestId: "bal-a" }));
    const second = track(budgetB.reserve(fixture.scope, { purpose: "tutor", amountCents: 60_000, requestId: "bal-b" }));
    await waitUntilWaiting(fixture.sql, a.pid, "reserve A");
    await waitUntilWaiting(fixture.sql, b.pid, "reserve B");
    unlock();
    await hold;
    const results = await Promise.allSettled([first, second]);
    await closeRace(observer.sql);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "BUDGET_EXCEEDED" });
    const sum = await fixture.sql`SELECT COALESCE(sum(amount_cents),0)::int AS t FROM opening_budget_reservations WHERE workspace_id=${fixture.scope.workspaceId}`;
    expect(sum[0].t).toBe(60_000);
  }, 20_000);
});
