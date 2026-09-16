import { describe, expect, it } from "vitest";
import { runBudgetedCall } from "./budgeted-call";
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
};

function fakeBudget() {
  const repo: FakeRepo = { reserved: [], released: [], settled: [], unknowns: [] };
  return {
    repo,
    api: {
      reserve: async (input: { requestId: string; amountCents: number }) => {
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

describe("runBudgetedCall", () => {
  it("fails with PROVIDER_DISABLED and makes zero network or budget calls", async () => {
    const { repo, api } = fakeBudget();
    await expect(
      runBudgetedCall({ ...options, provider: null, budget: api }),
    ).rejects.toMatchObject({ code: "PROVIDER_DISABLED" });
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
});
