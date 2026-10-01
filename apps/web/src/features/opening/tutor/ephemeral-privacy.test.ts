import { describe, expect, it, vi } from "vitest";
import { OpeningProviderError } from "@aistudy/ai";
import type { ProviderInput, ProviderOutput, SourceChunk } from "@aistudy/contracts";
import { createEphemeralTutorService } from "./ephemeral-service";

const scope = { workspaceId: "10000000-0000-4000-8000-000000000001", ownerUserId: "10000000-0000-4000-8000-000000000002" };
const privateId = "10000000-0000-4000-8000-000000000003";
const publicId = "10000000-0000-4000-8000-000000000004";
const output: ProviderOutput = { text: "answer", candidates: [], citedChunkIds: [], requestId: "provider-id", inputTokens: 2, outputTokens: 1 };
const input = { text: "allowed question", sourceIds: [], mode: "listen" as const, history: [] };
const oldHistory = [{ role: "assistant" as const, text: "OLD-PRIVATE-HISTORY", provenanceId: "20000000-0000-4000-8000-000000000009" }];
function fixture() {
  const state = { epoch: 2, excluded: [privateId] };
  const sourceChunks = [privateId, publicId].map((sourceId, index): SourceChunk => ({
    id: sourceId, sourceId, sourceVersion: 1, page: 1, slideLabel: null, startMs: null, endMs: null,
    text: index === 0 ? "EXCLUDED-PRIVATE-SOURCE" : "allowed source", imageObjectKey: null,
  }));
  const complete = vi.fn(async (_input: ProviderInput): Promise<ProviderOutput> => output);
  const budget = {
    reserve: vi.fn(async () => ({ id: "reservation" })), release: vi.fn(async () => undefined),
    settle: vi.fn(async () => undefined), markUnknown: vi.fn(async () => undefined),
  };
  const privacy = {
    snapshot: vi.fn(async () => ({ epoch: state.epoch, excludedSourceIds: [...state.excluded] })),
    currentEpoch: vi.fn(async () => state.epoch),
  };
  const provenance = {
    resolveHistory: vi.fn(async () => []),
    record: vi.fn(async () => "30000000-0000-4000-8000-000000000001"),
  };
  const service = createEphemeralTutorService({
    sources: { listOwnedIds: async (_scope, ids) => ids.filter(id => [privateId, publicId].includes(id.toLowerCase())) },
    chunks: { listForSources: async (_scope, ids) => sourceChunks.filter(chunk => ids.map(id => id.toLowerCase()).includes(chunk.sourceId)) },
    privacy, budget, provider: { complete }, requestKey: () => "ephemeral-request", provenance,
    config: { maxContextCharacters: 12_000, reservedCents: 10, maxOutputTokens: 128, inputCentsPerMillion: 1, outputCentsPerMillion: 1 },
  });
  return { state, complete, budget, service, privacy, provenance };
}

describe("ephemeral privacy admission", () => {
  it("omits an excluded source beside an allowed source from actual Provider input", async () => {
    const f = fixture();
    await f.service.replyEphemeral(scope, { ...input, sourceIds: [privateId, publicId] });
    const sent = f.complete.mock.calls[0]![0];
    expect(sent.chunks.map(chunk => chunk.sourceId)).toEqual([publicId]);
    expect(JSON.stringify(sent)).not.toContain("EXCLUDED-PRIVATE-SOURCE");
    expect(f.privacy.snapshot).toHaveBeenCalledWith(scope);
  });
  it("treats uppercase UUIDs as the same excluded source", async () => {
    const f = fixture();
    const excluded = "abcdefab-1234-4000-8000-000000000003";
    f.state.excluded = [excluded];
    const denied = createEphemeralTutorService({
      sources: { listOwnedIds: async (_scope, ids) => ids },
      chunks: { listForSources: async () => [] }, privacy: f.privacy, budget: f.budget, provider: { complete: f.complete },
      config: { maxContextCharacters: 12_000, reservedCents: 10, maxOutputTokens: 128, inputCentsPerMillion: 1, outputCentsPerMillion: 1 },
    });
    await expect(denied.replyEphemeral(scope, { ...input, sourceIds: [excluded.toUpperCase()] })).rejects.toMatchObject({ code: "SOURCE_EXCLUDED" });
    expect(f.complete).not.toHaveBeenCalled();
  });
  it("rejects a selection containing only excluded sources before reserving", async () => {
    const f = fixture();
    await expect(f.service.replyEphemeral(scope, { ...input, sourceIds: [privateId] })).rejects.toMatchObject({ code: "SOURCE_EXCLUDED", status: 409 });
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.budget.reserve).not.toHaveBeenCalled();
  });
  it.each([undefined, 1])("isolates nonempty history with missing or old epoch %s", async historyPrivacyEpoch => {
    const f = fixture();
    const reply = await f.service.replyEphemeral(scope, { ...input, history: oldHistory, ...(historyPrivacyEpoch === undefined ? {} : { historyPrivacyEpoch }) });
    expect(f.complete.mock.calls[0]![0].history).toEqual([]);
    expect(JSON.stringify(f.complete.mock.calls[0]![0])).not.toContain("OLD-PRIVATE-HISTORY");
    expect(reply).toMatchObject({ privacyEpoch: 2, historyDiscarded: true });
  });
  it("retains history from the unchanged server epoch", async () => {
    const f = fixture();
    f.provenance.resolveHistory.mockResolvedValue([{ sourceId: publicId, sourceVersion: 1 }]);
    const reply = await f.service.replyEphemeral(scope, { ...input, history: oldHistory, historyPrivacyEpoch: 2 });
    expect(f.complete.mock.calls[0]![0].history).toEqual([{ role: "assistant", text: "OLD-PRIVATE-HISTORY" }]);
    expect(reply).toMatchObject({ privacyEpoch: 2, historyDiscarded: false });
  });
  it("stops epoch drift during budget reservation before sending and releases the unused reservation", async () => {
    const f = fixture();
    f.budget.reserve.mockImplementation(async () => { f.state.epoch++; return { id: "reservation" }; });
    await expect(f.service.replyEphemeral(scope, input)).rejects.toMatchObject({ code: "PRIVACY_CHANGED", status: 409 });
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.privacy.currentEpoch).toHaveBeenCalledWith(scope);
    expect(f.budget.release).toHaveBeenCalledWith("ephemeral-request");
    expect(f.budget.markUnknown).not.toHaveBeenCalled();
  });
  it("releases when cancellation happens during reservation before sending", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.budget.reserve.mockImplementation(async () => { controller.abort(); return { id: "reservation" }; });
    await expect(f.service.replyEphemeral(scope, input, controller.signal)).rejects.toMatchObject({ code: "ABORTED" });
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.budget.release).toHaveBeenCalledWith("ephemeral-request");
    expect(f.budget.markUnknown).not.toHaveBeenCalled();
  });
  it.each(["PROVIDER_NETWORK", "PROVIDER_TIMEOUT", "PROVIDER_ABORTED"])("keeps already sent %s outcomes unknown after a concurrent privacy change", async code => {
    const f = fixture();
    f.complete.mockImplementation(async () => { f.state.epoch++; throw new OpeningProviderError(code, "unknown", true); });
    await expect(f.service.replyEphemeral(scope, input)).rejects.toMatchObject({ code });
    expect(f.budget.markUnknown).toHaveBeenCalledWith("reservation");
    expect(f.budget.release).not.toHaveBeenCalled();
  });
});
