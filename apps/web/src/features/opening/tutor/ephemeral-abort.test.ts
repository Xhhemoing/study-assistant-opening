import { describe, expect, it, vi } from "vitest";
import type { ProviderOutput } from "@aistudy/contracts";
import { createEphemeralTutorService } from "./ephemeral-service";

const scope = {
  workspaceId: "10000000-0000-4000-8000-000000000001",
  ownerUserId: "10000000-0000-4000-8000-000000000002",
};

const output: ProviderOutput = {
  text: "stopped",
  citedChunkIds: [],
  requestId: "req-abort",
  candidates: [{ kind: "task", title: "must strip", minutes: 5, dueText: null }],
  inputTokens: 2,
  outputTokens: 1,
};

describe("ephemeral abort", () => {
  it("forwards the caller signal through complete(input, signal)", async () => {
    let seen: AbortSignal | undefined;
    const budget = {
      reserve: vi.fn(async (input: { purpose: string; amountCents: number; requestId: string }) => {
        expect(input.purpose).toBe("tutor");
        expect(input.amountCents).toBeGreaterThan(0);
        expect(input.requestId).toBe("eph-key");
        return { id: "res-1" };
      }),
      release: vi.fn(async () => undefined),
      settle: vi.fn(async () => undefined),
      markUnknown: vi.fn(async () => undefined),
    };
    const service = createEphemeralTutorService({
      sources: { listOwnedIds: async () => [] },
      chunks: { listForSources: async () => [] },
      privacy: { snapshot: async () => ({ epoch: 0, excludedSourceIds: [] }), currentEpoch: async () => 0 },
    budget,
      provider: {
        complete: async (value, signal) => {
          seen = signal;
          expect(value.mode).toBe("listen");
          return output;
        },
      },
      config: {
        maxContextCharacters: 12_000,
        reservedCents: 10,
        maxOutputTokens: 256,
        inputCentsPerMillion: 100,
        outputCentsPerMillion: 200,
      },
      requestKey: () => "eph-key",
    });
    const controller = new AbortController();
    const heard = await service.replyEphemeral(
      scope,
      { text: "stop", sourceIds: [], mode: "listen", history: [] },
      controller.signal,
    );
    expect(seen).toBe(controller.signal);
    expect(heard.candidates).toEqual([]);
    expect(budget.reserve).toHaveBeenCalledOnce();
  });

  it("rejects an already aborted request before reserving budget", async () => {
    const budget = {
      reserve: vi.fn(async () => ({ id: "res-1" })),
      release: vi.fn(async () => undefined),
      settle: vi.fn(async () => undefined),
      markUnknown: vi.fn(async () => undefined),
    };
    const complete = vi.fn(async () => output);
    const service = createEphemeralTutorService({
      sources: { listOwnedIds: async () => [] },
      chunks: { listForSources: async () => [] },
      privacy: { snapshot: async () => ({ epoch: 0, excludedSourceIds: [] }), currentEpoch: async () => 0 },
    budget,
      provider: { complete },
      config: {
        maxContextCharacters: 12_000,
        reservedCents: 10,
        maxOutputTokens: 256,
        inputCentsPerMillion: 100,
        outputCentsPerMillion: 200,
      },
    });
    const controller = new AbortController();
    controller.abort();
    await expect(service.replyEphemeral(
      scope,
      { text: "already stopped", sourceIds: [], mode: "listen", history: [] },
      controller.signal,
    )).rejects.toMatchObject({ code: "ABORTED", status: 499 });
    expect(budget.reserve).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });
});
