/**
 * BC1 / P0 budget-cost contract families (post-patch positive asserts).
 * Run:
 *   node node_modules/vitest/vitest.mjs run --project unit \
 *     apps/worker/src/runtime/budget-contract-discovery.test.ts
 */
import { describe, expect, it, vi } from "vitest";
import {
  OpeningProviderError,
  resolveEffectiveDailyCap,
  mergeOpeningCatalog,
} from "@aistudy/ai";
import {
  ledgerActionForProviderError,
  runBudgetedCall,
  settleCentsForActual,
} from "./budgeted-call";
import { tutorReservationCents } from "../jobs/tutor-cost";
import type { ProviderOutput } from "@aistudy/contracts";

const output: ProviderOutput = {
  text: "ok", citedChunkIds: [], requestId: null, candidates: [],
  inputTokens: 1, outputTokens: 1,
};

function fakeBudget(reserveImpl?: (input: { amountCents: number; requestId: string }) => Promise<{ id: string }>) {
  const repo = {
    reserved: [] as { amountCents: number; requestId: string }[],
    released: [] as string[],
    settled: [] as { reservationId: string; actualCents: number }[],
    unknowns: [] as string[],
    overages: [] as { reservationId: string; reservedCents: number; actualCents: number; settledCents: number }[],
    providerCalls: 0,
  };
  return {
    repo,
    api: {
      reserve: async (input: { amountCents: number; requestId: string }) => {
        if (reserveImpl) return reserveImpl(input);
        if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
          throw Object.assign(new Error("amount must be a positive integer"), { code: "BUDGET_INVALID_RESERVE" });
        }
        // Idempotent by requestId while still reserved (mirrors opening-budget).
        const existing = repo.reserved.find((r) => r.requestId === input.requestId);
        if (existing) {
          const idx = repo.reserved.indexOf(existing);
          return { id: `res-${idx + 1}` };
        }
        repo.reserved.push(input);
        return { id: `res-${repo.reserved.length}` };
      },
      release: async (requestId: string) => { repo.released.push(requestId); },
      settle: async (reservationId: string, actualCents: number) => { repo.settled.push({ reservationId, actualCents }); },
      markUnknown: async (reservationId: string) => { repo.unknowns.push(reservationId); },
      noteOverage: async (audit: { reservationId: string; reservedCents: number; actualCents: number; settledCents: number }) => {
        repo.overages.push(audit);
      },
    },
  };
}

const base = {
  reservedCents: 500,
  actualCents: () => 120,
  input: { instruction: "You are a tutor.", text: "2+2?", maxOutputTokens: 64, citedChunkIds: [] as string[] },
};

describe("P0 family 1 — missing per-request budget", () => {
  it("reservedCents<=0 never reaches provider and throws BUDGET_INVALID_RESERVE", async () => {
    const { repo, api } = fakeBudget();
    const complete = vi.fn(async () => output);
    await expect(runBudgetedCall({
      ...base, requestId: "req-zero", reservedCents: 0, provider: { complete }, budget: api,
    })).rejects.toMatchObject({ code: "BUDGET_INVALID_RESERVE" });
    expect(complete).not.toHaveBeenCalled();
    expect(repo.reserved).toHaveLength(0);
  });

  it("budgeted-call rejects reservedCents<=0 with stable BUDGET_* before reserve", async () => {
    const { api, repo } = fakeBudget();
    await expect(runBudgetedCall({
      ...base, requestId: "req-zero-code", reservedCents: 0,
      provider: { complete: async () => output }, budget: api,
    })).rejects.toMatchObject({ code: expect.stringMatching(/^BUDGET_/) });
    expect(repo.reserved).toHaveLength(0);
  });

  it("already: zero pricing yields zero reservation bound (caller must not treat as free)", () => {
    expect(tutorReservationCents("hi", 10, { inputCentsPerMillion: 0, outputCentsPerMillion: 0 })).toBe(0);
  });
});

describe("P0 family 2 — cost / spend receipts", () => {
  it("already: missing usage tokens keep reservation unknown (no zero settle)", async () => {
    const { repo, api } = fakeBudget();
    await runBudgetedCall({
      ...base, requestId: "req-usage",
      provider: { complete: async () => ({ ...output, inputTokens: null }) },
      budget: api,
    });
    expect(repo.settled).toEqual([]);
    expect(repo.unknowns).toEqual(["res-1"]);
  });

  it("settle caps actualCents that exceed reserved and records overage audit", async () => {
    const { repo, api } = fakeBudget();
    await runBudgetedCall({
      ...base, requestId: "req-over", reservedCents: 10,
      actualCents: () => 999,
      provider: { complete: async () => output },
      budget: api,
    });
    expect(repo.settled[0]?.actualCents).toBeLessThanOrEqual(10);
    expect(repo.settled[0]?.actualCents).toBe(10);
    expect(repo.unknowns).toEqual([]);
    expect(repo.overages).toEqual([{
      reservationId: "res-1",
      reservedCents: 10,
      actualCents: 999,
      settledCents: 10,
    }]);
  });

  it("settleCentsForActual forbids unpolicied over-booking (cap policy)", () => {
    expect(settleCentsForActual(10, 999)).toEqual({ settledCents: 10, overage: true });
    expect(settleCentsForActual(500, 120)).toEqual({ settledCents: 120, overage: false });
  });
});

describe("P0 family 3 — error mapping (ledgerActionForProviderError v1)", () => {
  it("locks code→ledger action table", () => {
    expect(ledgerActionForProviderError("PROVIDER_AUTH")).toBe("release");
    expect(ledgerActionForProviderError("PROVIDER_RATE_LIMIT")).toBe("release");
    expect(ledgerActionForProviderError("PROVIDER_REQUEST")).toBe("release");
    expect(ledgerActionForProviderError("PROVIDER_REQUEST", { requestSent: false })).toBe("release");
    expect(ledgerActionForProviderError("PROVIDER_REQUEST", { requestSent: true })).toBe("markUnknown");
    expect(ledgerActionForProviderError("PROVIDER_UNAVAILABLE")).toBe("markUnknown");
    expect(ledgerActionForProviderError("PROVIDER_TIMEOUT")).toBe("markUnknown");
    expect(ledgerActionForProviderError("PROVIDER_MEDIA_UNSUPPORTED")).toBe("release");
  });

  it("PROVIDER_AUTH releases (treated as unsent/definitive)", async () => {
    const { repo, api } = fakeBudget();
    await expect(runBudgetedCall({
      ...base, requestId: "req-auth",
      provider: { complete: async () => { throw new OpeningProviderError("PROVIDER_AUTH", "bad key"); } },
      budget: api,
    })).rejects.toMatchObject({ code: "PROVIDER_AUTH" });
    expect(repo.released).toEqual(["req-auth"]);
    expect(repo.unknowns).toEqual([]);
  });

  it("PROVIDER_RATE_LIMIT releases", async () => {
    const { repo, api } = fakeBudget();
    await expect(runBudgetedCall({
      ...base, requestId: "req-429",
      provider: { complete: async () => { throw new OpeningProviderError("PROVIDER_RATE_LIMIT", "slow", true); } },
      budget: api,
    })).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMIT", retryable: true });
    expect(repo.released).toEqual(["req-429"]);
    expect(repo.unknowns).toEqual([]);
  });

  it("PROVIDER_REQUEST (client / not-sent) releases", async () => {
    const { repo, api } = fakeBudget();
    await expect(runBudgetedCall({
      ...base, requestId: "req-400",
      provider: { complete: async () => { throw new OpeningProviderError("PROVIDER_REQUEST", "bad req"); } },
      budget: api,
    })).rejects.toMatchObject({ code: "PROVIDER_REQUEST" });
    expect(repo.released).toEqual(["req-400"]);
    expect(repo.unknowns).toEqual([]);
  });

  it("PROVIDER_UNAVAILABLE marks unknown", async () => {
    const { repo, api } = fakeBudget();
    await expect(runBudgetedCall({
      ...base, requestId: "req-5xx",
      provider: { complete: async () => { throw new OpeningProviderError("PROVIDER_UNAVAILABLE", "down", true); } },
      budget: api,
    })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(repo.unknowns).toEqual(["res-1"]);
    expect(repo.released).toEqual([]);
  });
});

describe("P0 family 4 — failed retries consuming budget", () => {
  it("short-term without operationId: distinct requestIds double-reserve (documented)", async () => {
    const { repo, api } = fakeBudget();
    await expect(runBudgetedCall({
      ...base, requestId: "req-a", reservedCents: 300,
      provider: { complete: async () => { throw new OpeningProviderError("PROVIDER_UNAVAILABLE", "down", true); } },
      budget: api,
    })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(repo.unknowns).toEqual(["res-1"]);

    await runBudgetedCall({
      ...base, requestId: "req-b", reservedCents: 300,
      provider: { complete: async () => output },
      budget: api,
    });
    // Two reservations exist against the same workspace cap in production ledger.
    expect(repo.reserved.map(r => r.requestId)).toEqual(["req-a", "req-b"]);
    expect(repo.reserved.reduce((sum, r) => sum + r.amountCents, 0)).toBe(600);
  });

  it("with operationId: retry reuses one reserve (no second full stack while unknown)", async () => {
    const { repo, api } = fakeBudget();
    await expect(runBudgetedCall({
      ...base, requestId: "op-1-attempt-1", operationId: "op-1", reservedCents: 300,
      provider: { complete: async () => { throw new OpeningProviderError("PROVIDER_UNAVAILABLE", "down", true); } },
      budget: api,
    })).rejects.toThrow();
    expect(repo.unknowns).toEqual(["res-1"]);

    await runBudgetedCall({
      ...base, requestId: "op-1-attempt-2", operationId: "op-1", reservedCents: 300,
      provider: { complete: async () => output },
      budget: api,
    });
    expect(repo.reserved).toHaveLength(1);
    expect(repo.reserved[0]?.requestId).toBe("op-1");
    expect(repo.settled).toEqual([{ reservationId: "res-1", actualCents: 120 }]);
  });
});


/**
 * BC1 remaining AC matrix (worker/ai/database paths).
 * Ephemeral caller operationId wiring lives in apps/web (Experience) — deferred
 * here by design; contract locked below without editing web.
 */
describe("BC1 concurrency / cancel / late-result matrix", () => {
  function casLedger(capCents: number) {
    type Row = {
      id: string;
      requestId: string;
      amountCents: number;
      state: "reserved" | "released" | "completed";
    };
    const rows: Row[] = [];
    let seq = 0;
    const occupied = () =>
      rows
        .filter((r) => r.state === "reserved" || r.state === "completed")
        .reduce((s, r) => s + r.amountCents, 0);
    return {
      rows,
      api: {
        reserve: async (input: { amountCents: number; requestId: string }) => {
          const existing = rows.find((r) => r.requestId === input.requestId);
          if (existing) {
            if (existing.state !== "reserved") {
              throw Object.assign(new Error("request already consumed"), { code: "CONFLICT" });
            }
            return { id: existing.id };
          }
          if (occupied() + input.amountCents > capCents) {
            throw Object.assign(new Error("daily workspace budget exceeded"), { code: "BUDGET_EXCEEDED" });
          }
          seq += 1;
          const id = `res-${seq}`;
          rows.push({ id, requestId: input.requestId, amountCents: input.amountCents, state: "reserved" });
          return { id };
        },
        release: async (requestId: string) => {
          const row = rows.find((r) => r.requestId === requestId && r.state === "reserved");
          if (!row) throw Object.assign(new Error("reservation not found"), { code: "NOT_FOUND" });
          row.state = "released";
        },
        settle: async (reservationId: string, actualCents: number) => {
          const row = rows.find((r) => r.id === reservationId && r.state === "reserved");
          if (!row) throw Object.assign(new Error("reservation not found or already settled"), { code: "NOT_FOUND" });
          row.amountCents = actualCents;
          row.state = "completed";
        },
        markUnknown: async (reservationId: string) => {
          const row = rows.find((r) => r.id === reservationId);
          if (!row) throw Object.assign(new Error("reservation not found"), { code: "NOT_FOUND" });
          // unknown retains reserved occupancy (opening-budget semantics)
          return row;
        },
      },
    };
  }

  it("two concurrent reserves cannot both consume the same remaining balance", async () => {
    const { rows, api } = casLedger(500);
    // Serialize the read-check-write behind a microtask turn so both callers
    // observe the empty ledger before either commits — classic lost-update race
    // unless reserve is atomic (casLedger is).
    let chain: Promise<unknown> = Promise.resolve();
    const atomicReserve = (input: { amountCents: number; requestId: string }) => {
      const run = chain.then(async () => api.reserve(input));
      // Keep the chain alive even when reserve rejects, so the sibling still runs.
      chain = run.catch(() => undefined);
      return run;
    };
    const settled = await Promise.allSettled([
      runBudgetedCall({
        ...base,
        requestId: "conc-a",
        reservedCents: 400,
        provider: { complete: async () => output },
        budget: { ...api, reserve: atomicReserve },
      }),
      runBudgetedCall({
        ...base,
        requestId: "conc-b",
        reservedCents: 400,
        provider: { complete: async () => output },
        budget: { ...api, reserve: atomicReserve },
      }),
    ]);
    const ok = settled.filter((r) => r.status === "fulfilled");
    const bad = settled.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect((bad[0] as PromiseRejectedResult).reason).toMatchObject({ code: "BUDGET_EXCEEDED" });
    const active = rows.filter((r) => r.state === "reserved" || r.state === "completed");
    expect(active).toHaveLength(1);
    expect(active.reduce((s, r) => s + r.amountCents, 0)).toBeLessThanOrEqual(500);
  });

  it("cancel before send releases and never settles or marks unknown", async () => {
    const { rows, api } = casLedger(10_000);
    const abortErr = Object.assign(new Error("ephemeral request aborted before sending"), { code: "ABORTED" });
    await expect(
      runBudgetedCall({
        ...base,
        requestId: "cancel-pre",
        provider: { complete: async () => output },
        budget: api,
        beforeSend: async () => {
          throw abortErr;
        },
      }),
    ).rejects.toBe(abortErr);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("released");
  });

  it("PROVIDER_ABORTED after send marks unknown (no release / no settle)", async () => {
    const { rows, api } = casLedger(10_000);
    await expect(
      runBudgetedCall({
        ...base,
        requestId: "cancel-post",
        provider: {
          complete: async () => {
            throw new OpeningProviderError("PROVIDER_ABORTED", "aborted after send");
          },
        },
        budget: api,
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_ABORTED" });
    expect(ledgerActionForProviderError("PROVIDER_ABORTED")).toBe("markUnknown");
    expect(rows[0]!.state).toBe("reserved");
  });

  it("late settle after release does not double-charge", async () => {
    const { rows, api } = casLedger(10_000);
    const reservation = await api.reserve({ amountCents: 300, requestId: "late-settle" });
    await api.release("late-settle");
    await expect(api.settle(reservation.id, 120)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(rows.filter((r) => r.state === "completed")).toHaveLength(0);
    expect(rows[0]!.state).toBe("released");
  });

  it("unknown fee confirmation converges only once (second settle rejected)", async () => {
    const { rows, api } = casLedger(10_000);
    await runBudgetedCall({
      ...base,
      requestId: "once-settle",
      provider: { complete: async () => output },
      budget: api,
    });
    expect(rows[0]!.state).toBe("completed");
    await expect(api.settle(rows[0]!.id, 99)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(rows.filter((r) => r.state === "completed")).toHaveLength(1);
    expect(rows[0]!.amountCents).toBe(120);
  });

  it("release vs late settle race yields a single terminal state", async () => {
    const { rows, api } = casLedger(10_000);
    const reservation = await api.reserve({ amountCents: 200, requestId: "race-term" });
    const results = await Promise.allSettled([
      api.release("race-term"),
      api.settle(reservation.id, 80),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "NOT_FOUND" });
    const terminal = rows[0]!.state;
    expect(["released", "completed"]).toContain(terminal);
    expect(rows.filter((r) => r.state === "reserved")).toHaveLength(0);
  });
});

describe("BC1 ephemeral operationId deferral (document + lock)", () => {
  it("without operationId, ephemeral-style unique requestIds double-reserve (web wiring deferred)", async () => {
    // apps/web ephemeral-service uses `eph:${uuid}` unless requestKey is set and
    // does not yet pass operationId. Experience is out of BC1 worker scope;
    // this locks the gap so a later web slice must pass operationId to close it.
    const { repo, api } = fakeBudget();
    await expect(
      runBudgetedCall({
        ...base,
        requestId: "eph:attempt-1",
        reservedCents: 300,
        provider: {
          complete: async () => {
            throw new OpeningProviderError("PROVIDER_UNAVAILABLE", "down", true);
          },
        },
        budget: api,
      }),
    ).rejects.toThrow();
    await runBudgetedCall({
      ...base,
      requestId: "eph:attempt-2",
      reservedCents: 300,
      provider: { complete: async () => output },
      budget: api,
    });
    expect(repo.reserved.map((r) => r.requestId)).toEqual(["eph:attempt-1", "eph:attempt-2"]);
    expect(repo.reserved.reduce((s, r) => s + r.amountCents, 0)).toBe(600);
  });

  it("ephemeral-style retries with shared operationId reuse one reserve (contract for future web wire)", async () => {
    const { repo, api } = fakeBudget();
    await expect(
      runBudgetedCall({
        ...base,
        requestId: "eph:attempt-1",
        operationId: "eph-op:client-key",
        reservedCents: 300,
        provider: {
          complete: async () => {
            throw new OpeningProviderError("PROVIDER_UNAVAILABLE", "down", true);
          },
        },
        budget: api,
      }),
    ).rejects.toThrow();
    await runBudgetedCall({
      ...base,
      requestId: "eph:attempt-2",
      operationId: "eph-op:client-key",
      reservedCents: 300,
      provider: { complete: async () => output },
      budget: api,
    });
    expect(repo.reserved).toHaveLength(1);
    expect(repo.reserved[0]?.requestId).toBe("eph-op:client-key");
  });
});

describe("BC1 settings/discovery vs ledger semantic alignment", () => {
  it("resolveEffectiveDailyCap disabled (0) aligns with catalog budget_disabled", () => {
    const effective = resolveEffectiveDailyCap({
      envCapCents: 0,
      workspaceCapCents: null,
      confirmed: false,
    });
    expect(effective).toEqual({ capCents: 0, source: "disabled" });
    const server = {
      id: "m1",
      providerId: "p",
      providerLabel: "P",
      label: "M",
      modelName: "n",
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      supportsVision: false,
      inputCentsPerMillion: 1,
      outputCentsPerMillion: 1,
      availability: "available" as const,
      source: "server" as const,
    };
    const merged = mergeOpeningCatalog([server], [], {
      defaultModelId: "m1",
      dailyCapCents: effective.capCents,
    });
    expect(merged.models[0]!.availability).toBe("budget_disabled");
  });

  it("PROVIDER_DISABLED and BUDGET_EXCEEDED stay stable business codes (not INTERNAL)", async () => {
    const { api } = fakeBudget();
    await expect(
      runBudgetedCall({ ...base, requestId: "dis", provider: null, budget: api }),
    ).rejects.toMatchObject({ code: "PROVIDER_DISABLED" });

    const { api: capped } = (() => {
      const ledger = {
        reserve: async () => {
          throw Object.assign(new Error("daily workspace budget exceeded"), { code: "BUDGET_EXCEEDED" });
        },
        release: async () => undefined,
        settle: async () => undefined,
        markUnknown: async () => undefined,
      };
      return { api: ledger };
    })();
    const complete = vi.fn(async () => output);
    await expect(
      runBudgetedCall({
        ...base,
        requestId: "cap",
        provider: { complete },
        budget: capped,
      }),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(complete).not.toHaveBeenCalled();
  });

  it("positive confirmed workspace cap is the ledger ceiling source", () => {
    const effective = resolveEffectiveDailyCap({
      envCapCents: 0,
      workspaceCapCents: 1500,
      confirmed: true,
      pricingConfigured: true,
    });
    expect(effective.source).toBe("workspace");
    expect(effective.capCents).toBe(1500);
    expect(effective.capCents).toBeGreaterThan(0);
  });
});
