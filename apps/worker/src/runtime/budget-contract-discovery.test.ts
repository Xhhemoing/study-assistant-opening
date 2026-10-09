/**
 * BC1 / P0 budget-cost contract families (post-patch positive asserts).
 * Run:
 *   node node_modules/vitest/vitest.mjs run --project unit \
 *     apps/worker/src/runtime/budget-contract-discovery.test.ts
 */
import { describe, expect, it, vi } from "vitest";
import { OpeningProviderError } from "@aistudy/ai";
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
