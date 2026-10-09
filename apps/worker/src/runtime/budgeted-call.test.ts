import { describe, expect, it } from "vitest";
import {
  ledgerActionForProviderError,
  runBudgetedCall,
  settleCentsForActual,
} from "./budgeted-call";
import { OpeningProviderError } from "@aistudy/ai";
import type { ProviderOutput } from "@aistudy/contracts";

const output: ProviderOutput = {
  text: "ok",
  citedChunkIds: [],
  requestId: null,
  candidates: [],
  inputTokens: 1,
  outputTokens: 1,
};

type FakeRepo = {
  reserved: { requestId: string; amountCents: number }[];
  released: string[];
  settled: { reservationId: string; actualCents: number }[];
  unknowns: string[];
  overages: { reservationId: string; reservedCents: number; actualCents: number; settledCents: number }[];
};

function fakeBudget() {
  const repo: FakeRepo = { reserved: [], released: [], settled: [], unknowns: [], overages: [] };
  return {
    repo,
    api: {
      reserve: async (input: { requestId: string; amountCents: number }) => {
        const existing = repo.reserved.find((r) => r.requestId === input.requestId);
        if (existing) {
          return { id: `res-${repo.reserved.indexOf(existing) + 1}` };
        }
        repo.reserved.push(input);
        return { id: `res-${repo.reserved.length}` };
      },
      release: async (requestId: string) => {
        repo.released.push(requestId);
      },
      settle: async (reservationId: string, actualCents: number) => {
        repo.settled.push({ reservationId, actualCents });
      },
      markUnknown: async (reservationId: string) => {
        repo.unknowns.push(reservationId);
      },
      noteOverage: async (audit: FakeRepo["overages"][number]) => {
        repo.overages.push(audit);
      },
    },
  };
}

const options = {
  requestId: "req-1",
  reservedCents: 500,
  actualCents: () => 120,
  input: {
    instruction: "You are a tutor.",
    text: "2+2?",
    maxOutputTokens: 64,
    citedChunkIds: [],
  },
};

describe("ledgerActionForProviderError", () => {
  it("locks the BC1 v1 code→ledger action table", () => {
    expect(ledgerActionForProviderError("PROVIDER_AUTH")).toBe("release");
    expect(ledgerActionForProviderError("PROVIDER_RATE_LIMIT")).toBe("release");
    expect(ledgerActionForProviderError("PROVIDER_REQUEST")).toBe("release");
    expect(ledgerActionForProviderError("PROVIDER_REQUEST", { requestSent: true })).toBe("markUnknown");
    expect(ledgerActionForProviderError("PROVIDER_UNAVAILABLE")).toBe("markUnknown");
    expect(ledgerActionForProviderError("PROVIDER_TIMEOUT")).toBe("markUnknown");
    expect(ledgerActionForProviderError("PROVIDER_MEDIA_UNSUPPORTED")).toBe("release");
  });
});

describe("settleCentsForActual", () => {
  it("caps overage to reserved and flags audit", () => {
    expect(settleCentsForActual(10, 999)).toEqual({ settledCents: 10, overage: true });
    expect(settleCentsForActual(500, 120)).toEqual({ settledCents: 120, overage: false });
  });
});

describe("runBudgetedCall", () => {
  it("fails with PROVIDER_DISABLED and makes zero network or budget calls", async () => {
    const { repo, api } = fakeBudget();
    await expect(
      runBudgetedCall({ ...options, provider: null, budget: api }),
    ).rejects.toMatchObject({ code: "PROVIDER_DISABLED" });
    expect(repo.reserved).toHaveLength(0);
  });

  it("rejects reservedCents<=0 with BUDGET_INVALID_RESERVE before reserve", async () => {
    const { repo, api } = fakeBudget();
    await expect(
      runBudgetedCall({ ...options, reservedCents: 0, provider: { complete: async () => output }, budget: api }),
    ).rejects.toMatchObject({ code: "BUDGET_INVALID_RESERVE" });
    expect(repo.reserved).toHaveLength(0);
  });

  it("reserves pessimistically then settles to the actual cost", async () => {
    const { repo, api } = fakeBudget();
    const result = await runBudgetedCall({
      ...options,
      provider: { complete: async () => output },
      budget: api,
    });
    expect(result.text).toBe("ok");
    expect(repo.reserved[0]).toMatchObject({ requestId: "req-1", amountCents: 500 });
    expect(repo.settled).toEqual([{ reservationId: "res-1", actualCents: 120 }]);
    expect(repo.released).toHaveLength(0);
    expect(repo.unknowns).toHaveLength(0);
  });

  it("caps settle when actual exceeds reserved and notes overage audit", async () => {
    const { repo, api } = fakeBudget();
    await runBudgetedCall({
      ...options,
      reservedCents: 50,
      actualCents: () => 80,
      provider: { complete: async () => output },
      budget: api,
    });
    expect(repo.settled).toEqual([{ reservationId: "res-1", actualCents: 50 }]);
    expect(repo.overages).toEqual([{
      reservationId: "res-1",
      reservedCents: 50,
      actualCents: 80,
      settledCents: 50,
    }]);
    expect(repo.unknowns).toHaveLength(0);
  });

  it("releases the reservation by requestId on a definitive failure", async () => {
    const { repo, api } = fakeBudget();
    await expect(
      runBudgetedCall({
        ...options,
        provider: {
          complete: async () => {
            throw new OpeningProviderError("PROVIDER_AUTH", "bad key");
          },
        },
        budget: api,
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_AUTH" });
    expect(repo.released).toEqual(["req-1"]);
    expect(repo.unknowns).toHaveLength(0);
  });

  it("releases PROVIDER_REQUEST (client / not-sent path)", async () => {
    const { repo, api } = fakeBudget();
    await expect(
      runBudgetedCall({
        ...options,
        provider: {
          complete: async () => {
            throw new OpeningProviderError("PROVIDER_REQUEST", "bad req");
          },
        },
        budget: api,
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_REQUEST" });
    expect(repo.released).toEqual(["req-1"]);
    expect(repo.unknowns).toHaveLength(0);
  });

  it.each(["PROVIDER_RESPONSE", "PROVIDER_REFUSAL", "PROVIDER_UNAVAILABLE"])("retains potentially charged failures: %s", async (code) => {
    const { repo, api } = fakeBudget();
    await expect(runBudgetedCall({ ...options, budget: api, provider: { complete: async () => { throw new OpeningProviderError(code, "failed"); } } })).rejects.toThrow();
    expect(repo.unknowns).toEqual(["res-1"]);
    expect(repo.released).toEqual([]);
  });

  it("keeps missing usage reserved and returns the answer", async () => {
    const { repo, api } = fakeBudget();
    const answer = await runBudgetedCall({ ...options, budget: api, provider: { complete: async () => ({ ...output, inputTokens: null }) } });
    expect(answer.text).toBe("ok");
    expect(repo.unknowns).toEqual(["res-1"]);
    expect(repo.settled).toEqual([]);
  });

  it("never releases a charge when settlement fails", async () => {
    const { repo, api } = fakeBudget();
    await expect(runBudgetedCall({ ...options, budget: { ...api, settle: async () => { throw new Error("database failure"); } }, provider: { complete: async () => output } })).rejects.toThrow("database failure");
    expect(repo.released).toEqual([]);
  });

  it("retains the reservation on an unknown post-send outcome", async () => {
    const { repo, api } = fakeBudget();
    await expect(
      runBudgetedCall({
        ...options,
        provider: {
          complete: async () => {
            throw new OpeningProviderError("PROVIDER_TIMEOUT", "aborted", true);
          },
        },
        budget: api,
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
    expect(repo.unknowns).toEqual(["res-1"]);
    expect(repo.released).toHaveLength(0);
  });

  it("reuses ledger reservation when operationId is shared across attempts", async () => {
    const { repo, api } = fakeBudget();
    await expect(
      runBudgetedCall({
        ...options,
        requestId: "attempt-1",
        operationId: "op-shared",
        provider: {
          complete: async () => {
            throw new OpeningProviderError("PROVIDER_UNAVAILABLE", "down", true);
          },
        },
        budget: api,
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    await runBudgetedCall({
      ...options,
      requestId: "attempt-2",
      operationId: "op-shared",
      provider: { complete: async () => output },
      budget: api,
    });
    expect(repo.reserved).toHaveLength(1);
    expect(repo.reserved[0]?.requestId).toBe("op-shared");
    expect(repo.settled).toEqual([{ reservationId: "res-1", actualCents: 120 }]);
  });
});

it("runs beforeSend after reserving and releases a rejected pre-send request", async () => {
  const { repo, api } = fakeBudget();
  let sent = false;
  const failure = new Error("privacy changed before sending");
  await expect(runBudgetedCall({ ...options, budget: api,
    beforeSend: async () => { expect(repo.reserved).toHaveLength(1); throw failure; },
    provider: { complete: async () => { sent = true; return output; } },
  })).rejects.toBe(failure);
  expect(sent).toBe(false);
  expect(repo.released).toEqual(["req-1"]);
  expect(repo.unknowns).toEqual([]);
  expect(repo.settled).toEqual([]);
});
