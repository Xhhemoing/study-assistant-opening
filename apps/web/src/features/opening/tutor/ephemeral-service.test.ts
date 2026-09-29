import { format } from "node:util";
import type { EphemeralProvenanceRepository } from "@aistudy/database";
import { describe, expect, it, vi } from "vitest";
import type { ProviderInput, ProviderOutput, SourceChunk } from "@aistudy/contracts";
import { OpeningProviderError } from "@aistudy/ai";
import { createEphemeralTutorService } from "./ephemeral-service";

const workspaceId = "10000000-0000-4000-8000-000000000001";
const ownerUserId = "10000000-0000-4000-8000-000000000002";
const sourceId = "10000000-0000-4000-8000-000000000003";
const foreignSource = "10000000-0000-4000-8000-000000000099";
const chunkId = "10000000-0000-4000-8000-000000000004";
const scope = { workspaceId, ownerUserId };

const chunk: SourceChunk = {
  id: chunkId,
  sourceId,
  sourceVersion: 1,
  page: 2,
  slideLabel: null,
  startMs: null,
  endMs: null,
  text: "PRIVATE-QUOTE-DO-NOT-LOG",
  imageObjectKey: null,
};

const output: ProviderOutput = {
  text: "I hear you",
  citedChunkIds: [chunkId],
  requestId: "req-eph",
  candidates: [{ kind: "task", title: "nap", minutes: 20, dueText: null }],
  inputTokens: 8,
  outputTokens: 4,
};

function deps(overrides?: {
  complete?: (input: ProviderInput, signal?: AbortSignal) => Promise<ProviderOutput>;
  chunks?: SourceChunk[];
  sources?: string[];
  provenance?: EphemeralProvenanceRepository;
}) {
  const writes: string[] = [];
  const budget = {
    reserve: vi.fn(async () => {
      writes.push("budget:reserve");
      return { id: "res-1" };
    }),
    release: vi.fn(async () => writes.push("budget:release")),
    settle: vi.fn(async () => writes.push("budget:settle")),
    markUnknown: vi.fn(async () => writes.push("budget:unknown")),
  };
  const complete = vi.fn(
    overrides?.complete ?? (async () => output),
  );
  const service = createEphemeralTutorService({
    sources: {
      listOwnedIds: async () => overrides?.sources ?? [sourceId],
    },
    chunks: {
      listForSources: async () => overrides?.chunks ?? [chunk],
    },
    privacy: { snapshot: async () => ({ epoch: 0, excludedSourceIds: [] }), currentEpoch: async () => 0 },
    budget,
    provenance: overrides?.provenance,
    provider: { complete },
    config: {
      maxContextCharacters: 12_000,
      reservedCents: 10,
      maxOutputTokens: 256,
      inputCentsPerMillion: 100,
      outputCentsPerMillion: 200,
    },
    now: () => 1_700_000_000_000,
    requestKey: () => "eph-key",
  });
  return { service, budget, complete, writes };
}

describe("ephemeral tutor service", () => {
  it("strips listen and think_together candidates and never persists conversation rows", async () => {
    const listen = deps();
    const heard = await listen.service.replyEphemeral(scope, {
      text: "just listen",
      sourceIds: [sourceId],
      mode: "listen",
      history: [{ role: "user", text: "earlier" }],
    });
    expect(heard.candidates).toEqual([]);
    expect(heard.text).toBe("I hear you");
    expect(heard.citedChunkIds).toEqual([chunkId]);
    expect(listen.complete).toHaveBeenCalledOnce();
    const sent = listen.complete.mock.calls[0]![0];
    expect(sent.mode).toBe("listen");
    expect(sent.instruction).toMatch(/不要自动创建任务|do not (auto-)?create tasks/i);
    expect(listen.budget.reserve).toHaveBeenCalledOnce();
    expect(listen.writes.some((row) => /conversation|turn|job|candidate|memory|learning/.test(row))).toBe(false);

    const think = deps();
    const thought = await think.service.replyEphemeral(scope, {
      text: "think with me",
      sourceIds: [],
      mode: "think_together",
      history: [],
    });
    expect(thought.candidates).toEqual([]);
  });

  it("rejects over-limit history before any provider or budget call", async () => {
    const { service, complete, budget } = deps();
    const history = Array.from({ length: 17 }, () => ({
      role: "user" as const,
      text: "turn",
    }));
    await expect(
      service.replyEphemeral(scope, {
        text: "too much",
        sourceIds: [],
        mode: "listen",
        history,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(complete).not.toHaveBeenCalled();
    expect(budget.reserve).not.toHaveBeenCalled();
  });

  it("refuses a foreign source and an unauthorized page", async () => {
    const foreign = deps({ sources: [sourceId] });
    await expect(
      foreign.service.replyEphemeral(scope, {
        text: "show me",
        sourceIds: [foreignSource],
        mode: "listen",
        history: [],
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(foreign.complete).not.toHaveBeenCalled();

    const page = deps();
    await expect(
      page.service.replyEphemeral(scope, {
        text: "this page",
        sourceIds: [sourceId],
        mode: "explain",
        history: [],
        currentPage: 99,
      }),
    ).rejects.toMatchObject({ status: 422, code: "page_not_in_sources" });
    expect(page.complete).not.toHaveBeenCalled();
  });

  it("keeps only citation ids that belong to the authorized context", async () => {
    const { service } = deps({
      complete: async () => ({
        ...output,
        citedChunkIds: [chunkId, "10000000-0000-4000-8000-000000000077"],
      }),
    });
    const heard = await service.replyEphemeral(scope, {
      text: "cite",
      sourceIds: [sourceId],
      mode: "explain",
      history: [],
    });
    expect(heard.citedChunkIds).toEqual([chunkId]);
    expect(JSON.stringify(heard)).not.toContain("PRIVATE-QUOTE");
  });

  it("does not fall back to a saved conversation when the provider fails", async () => {
    const { service, writes } = deps({
      complete: async () => {
        throw new OpeningProviderError("PROVIDER_UNAVAILABLE", "down", true);
      },
    });
    await expect(
      service.replyEphemeral(scope, {
        text: "hello",
        sourceIds: [],
        mode: "listen",
        history: [],
      }),
    ).rejects.toBeInstanceOf(OpeningProviderError);
    expect(writes.some((row) => /conversation|turn|job|saved/.test(row))).toBe(false);
  });
});

describe("ephemeral content-free provenance", () => {
  it("uses server history lineage when the current selection has no sources", async () => {
    const historyRefs = [{ sourceId, sourceVersion: 1 }];
    const provenance = { resolveHistory: vi.fn(async () => historyRefs), record: vi.fn(async () => chunkId) };
    const f = deps({ sources: [], chunks: [], provenance });
    const history = [{ role: "assistant" as const, text: "prior answer", provenanceId: sourceId }];
    const reply = await f.service.replyEphemeral(scope, { text: "next", sourceIds: [], mode: "listen", history, historyPrivacyEpoch: 0 });
    expect(provenance.resolveHistory).toHaveBeenCalledWith(scope, history, 0);
    expect(provenance.record).toHaveBeenCalledWith(scope, { requestId: "eph-key", privacyEpoch: 0, contextSourceRefs: historyRefs });
    expect(reply.provenanceId).toBe(chunkId);
    expect(f.complete.mock.calls[0]![0]!.history).toEqual([{ role: "assistant", text: "prior answer" }]);
  });
  it("keeps unknown history lineage unknown instead of replacing it with the current selection", async () => {
    const provenance = { resolveHistory: vi.fn(async () => null), record: vi.fn(async () => null) };
    const f = deps({ provenance });
    const reply = await f.service.replyEphemeral(scope, { text: "next", sourceIds: [sourceId], mode: "listen", history: [{ role: "assistant", text: "unproven history" }], historyPrivacyEpoch: 0 });
    expect(provenance.record.mock.calls[0]).toEqual([scope, { requestId: "eph-key", privacyEpoch: 0, contextSourceRefs: null }]);
    expect(reply.provenanceId).toBeNull();
  });
  it.each([false, true])("never includes private bodies in budget calls, provenance rows, or console logs (provider failure=%s)", async fail => {
    const marker = "EPHEMERAL-PRIVATE-BODY-MARKER";
    const spies = (["log", "info", "warn", "error", "debug", "trace"] as const).map(method => vi.spyOn(console, method).mockImplementation(() => undefined));
    const provenance = { resolveHistory: vi.fn(async () => []), record: vi.fn(async () => chunkId) };
    try {
      const f = deps({ provenance, complete: async () => {
        if (fail) throw new OpeningProviderError("PROVIDER_NETWORK", `${marker}-provider-error`);
        return { ...output, text: `${marker}-answer`, candidates: [{ kind: "memory", text: `${marker}-candidate`, temporary: false }] };
      } });
      const pending = f.service.replyEphemeral(scope, { text: `${marker}-prompt`, sourceIds: [sourceId], mode: "listen", history: [{ role: "user", text: `${marker}-history`, provenanceId: sourceId }], historyPrivacyEpoch: 0 });
      if (fail) await expect(pending).rejects.toMatchObject({ code: "PROVIDER_NETWORK" });
      else expect((await pending).text).toBe(`${marker}-answer`);
      const persisted = [f.budget.reserve, f.budget.release, f.budget.settle, f.budget.markUnknown, provenance.record].flatMap(mock => mock.mock.calls);
      expect(JSON.stringify(persisted)).not.toContain(marker);
      expect(spies.flatMap(spy => spy.mock.calls.map(args => format(...args))).join("\n")).not.toContain(marker);
      if (fail) expect(provenance.record).not.toHaveBeenCalled();
    } finally { spies.forEach(spy => spy.mockRestore()); }
  });
});
