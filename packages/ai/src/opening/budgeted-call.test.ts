import { describe, expect, it, vi } from "vitest";
import {
  ledgerActionForProviderError,
  runBudgetedCall,
  settleCentsForActual,
} from "./budgeted-call";
import { createOpeningProvider, OpeningProviderError } from "./provider";
import type { ProviderInput, ProviderOutput } from "@aistudy/contracts";

const output: ProviderOutput = {
  text: "ok",
  citedChunkIds: [],
  requestId: null,
  candidates: [],
  inputTokens: 1,
  outputTokens: 1,
};

type FakeRepo = {
  reserved: { requestId: string; amountCents: number; purpose?: string }[];
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
      reserve: async (input: { requestId: string; amountCents: number; purpose: string }) => {
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
      claimExecution: async () => true, markUnknown: async (reservationId: string) => {
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
    // 413: the provider refused the payload size before processing it.
    expect(ledgerActionForProviderError("PROVIDER_PAYLOAD_TOO_LARGE")).toBe("release");
  });
});

describe("durable provider receipts", () => {
  it.each(["interrupted", "aborted", "delivery failed"])("keeps a partial stream %s unknown and refuses the same ledger key on replay", async failure => {
    const b = fakeBudget(), persistResult = vi.fn();
    const caller = new AbortController(), deltas: string[] = [];
    const stream = 'data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n';
    const fetchImpl = vi.fn().mockResolvedValue(new Response(stream));
    const provider = createOpeningProvider({ baseUrl: "https://model.example", apiKey: "key", model: "model", fetchImpl });
    const input: ProviderInput = { instruction: "teach", text: "question", mode: "explain", chunks: [], maxOutputTokens: 100,
      mediaCapability: "text_only", imageParts: [], outputFormat: "markdown" };
    const budget = { ...b.api, reserve: async (entry: Parameters<typeof b.api.reserve>[0]) => {
      const reservation = await b.api.reserve(entry);
      return { ...reservation, ...(b.repo.unknowns.length ? { state: "reserved", outcomeUnknownAt: new Date() } : {}) };
    } };
    const call = () => runBudgetedCall({ ...options, input, provider, budget, signal: caller.signal, persistResult,
      onTextDelta: async text => { deltas.push(text); if (failure === "aborted") caller.abort(); if (failure === "delivery failed") throw new Error("delivery failed"); },
    });
    await expect(call()).rejects.toMatchObject({ requestSent: true });
    expect(deltas).toEqual(["partial"]);
    expect(b.repo.unknowns).toEqual(["res-1"]);
    expect(b.repo.released).toEqual([]); expect(b.repo.settled).toEqual([]); expect(persistResult).not.toHaveBeenCalled();
    await expect(call()).rejects.toMatchObject({ code: "BUDGET_OUTCOME_UNKNOWN" });
    expect(fetchImpl).toHaveBeenCalledOnce(); expect(b.repo.reserved).toHaveLength(1);
  });

  it("persists the response with its actual charge before settlement", async () => {
    const b = fakeBudget();
    const order: string[] = [];
    const budget = { ...b.api, settle: async (...args: Parameters<typeof b.api.settle>) => {
      order.push("settle"); return b.api.settle(...args);
    } };
    await runBudgetedCall({ ...options, input: options.input as never, provider: { complete: async () => output }, budget,
      persistResult: async (actualOutput, receipt) => {
        expect(actualOutput).toBe(output);
        expect(receipt).toEqual({ reservationId: "res-1", settledCents: 120 });
        order.push("persist");
      },
    });
    expect(order).toEqual(["persist", "settle"]);
  });

  it("keeps a failed persistence unknown and never releases or settles it", async () => {
    const b = fakeBudget();
    await expect(runBudgetedCall({ ...options, input: options.input as never, provider: { complete: async () => output }, budget: b.api,
      persistResult: async () => { throw new Error("storage failed"); },
    })).rejects.toThrow("storage failed");
    expect(b.repo.unknowns).toEqual(["res-1"]);
    expect(b.repo.released).toEqual([]);
    expect(b.repo.settled).toEqual([]);
  });

  it("persists usable output without inventing a price when usage is missing", async () => {
    const b = fakeBudget();
    await runBudgetedCall({ ...options, input: options.input as never,
      provider: { complete: async () => ({ ...output, inputTokens: null }) }, budget: b.api,
      persistResult: async (_, receipt) => { expect(receipt.settledCents).toBeNull(); },
    });
    expect(b.repo.unknowns).toEqual(["res-1"]);
    expect(b.repo.settled).toEqual([]);
  });
});

describe("settleCentsForActual", () => {
  it("preserves actual overage and flags audit", () => {
    expect(settleCentsForActual(10, 999)).toEqual({ settledCents: 999, overage: true });
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

  it("settles full actual cost when it exceeds reserved and notes overage audit", async () => {
    const { repo, api } = fakeBudget();
    await runBudgetedCall({
      ...options,
      reservedCents: 50,
      actualCents: () => 80,
      provider: { complete: async () => output },
      budget: api,
    });
    expect(repo.settled).toEqual([{ reservationId: "res-1", actualCents: 80 }]);
    expect(repo.overages).toEqual([{
      reservationId: "res-1",
      reservedCents: 50,
      actualCents: 80,
      settledCents: 80,
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

  it("defaults purpose to tutor when omitted", async () => {
    const { repo, api } = fakeBudget();
    await runBudgetedCall({
      ...options,
      provider: { complete: async () => output },
      budget: api,
    });
    expect(repo.reserved[0]?.purpose).toBe("tutor");
  });

  it("propagates compile-teaching-unit purpose to reserve", async () => {
    const { repo, api } = fakeBudget();
    await runBudgetedCall({
      ...options,
      purpose: "compile-teaching-unit",
      provider: { complete: async () => output },
      budget: api,
    });
    expect(repo.reserved[0]?.purpose).toBe("compile-teaching-unit");
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

describe("parent interaction budget boundary", () => {
  it("passes the same durable parent to the real ledger reservation and keeps actual overage", async () => {
    const { api, repo } = fakeBudget();
    const parentBudget = { id: "study-turn:1", budgetCents: 1000, maxProviderCalls: 4 };
    await runBudgetedCall({ ...options, budget: api, provider: { complete: async () => output }, parentBudget, reservedCents: 50, actualCents: () => 80 });
    expect(repo.reserved[0]).toMatchObject({ parentBudget });
    expect(repo.settled).toEqual([{ reservationId: "res-1", actualCents: 80 }]);
    expect(repo.overages[0]).toMatchObject({ actualCents: 80, settledCents: 80 });
  });

  it("never reserves or sends media without a verifiable model billing bound", async () => {
    const { api, repo } = fakeBudget();
    let sent = false;
    await expect(runBudgetedCall({ ...options, budget: api, parentBudget: { id: "study-turn:1" },
      provider: { complete: async () => { sent = true; return output; } },
      input: { ...options.input, imageParts: [{ data: "data:image/png;base64,AAA=", mediaType: "image/png" }] },
    })).rejects.toMatchObject({ code: "BUDGET_MEDIA_COST_UNBOUNDED" });
    expect(repo.reserved).toHaveLength(0);
    expect(sent).toBe(false);
  });

  it("retains the reservation when a sent request is rejected ambiguously", async () => {
    const { api, repo } = fakeBudget();
    await expect(runBudgetedCall({ ...options, budget: api, parentBudget: { id: "study-turn:1" },
      provider: { complete: async () => { throw new OpeningProviderError("PROVIDER_REQUEST", "ambiguous request", false, true); } },
    })).rejects.toMatchObject({ code: "PROVIDER_REQUEST" });
    expect(repo.unknowns).toEqual(["res-1"]);
    expect(repo.released).toHaveLength(0);
  });

  it("does not price invalid provider usage as a free paid-model result", async () => {
    const { api, repo } = fakeBudget();
    await expect(runBudgetedCall({ ...options, budget: api, provider: { complete: async () => output }, actualCents: () => Number.NaN,
      parentBudget: { id: "study-turn:1" },
    })).rejects.toMatchObject({ code: "BUDGET_INVALID_ACTUAL" });
    expect(repo.unknowns).toEqual(["res-1"]);
    expect(repo.settled).toHaveLength(0);
  });
});

it("sends configured media under its byte bound and identifies usage pricing as provisional", async () => {
  const { api } = fakeBudget();
  let sent = 0;
  let settlementMeta: unknown;
  const snapshot = { id: "visual", providerId: "p", modelName: "v", inputCentsPerMillion: 1, outputCentsPerMillion: 1,
    mediaInputTokenUpperBound: 8192, mediaMaxInputBytes: 10, mediaInputCentsPerMillion: 2 };
  await runBudgetedCall({ ...options, parentBudget: { id: "media-parent" }, modelSnapshot: snapshot,
    budget: { ...api, settle: async (_id: string, _cost: number, meta?: unknown) => { settlementMeta = meta; } },
    provider: { complete: async () => { sent++; return output; } },
    input: { ...options.input, imageParts: [{ data: "data:image/png;base64,aGVsbG8=", mediaType: "image/png" }] },
  });
  expect(sent).toBe(1);
  expect(settlementMeta).toEqual({ costBasis: "media_usage_upper_bound" });
  await expect(runBudgetedCall({ ...options, parentBudget: { id: "media-parent" }, modelSnapshot: { ...snapshot, mediaMaxInputBytes: 1 },
    budget: api, provider: { complete: async () => { sent++; return output; } },
    input: { ...options.input, imageParts: [{ data: "data:image/png;base64,aGVsbG8=", mediaType: "image/png" }] },
  })).rejects.toMatchObject({ code: "BUDGET_MEDIA_INPUT_TOO_LARGE" });
  expect(sent).toBe(1);
});
