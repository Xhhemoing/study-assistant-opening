import { describe, expect, it, vi } from "vitest";
import { OpeningProviderError } from "@aistudy/ai";
import type { OpeningMaterialPurposePin, ProviderInput, ProviderOutput, SourceChunk } from "@aistudy/contracts";
import { createOpeningMaterialRetriever } from "../../../../../worker/src/runtime/material-retrieval";
import { createEphemeralTutorService } from "./ephemeral-service";

const repositories = vi.hoisted(() => ({
  readMaterialPurposePin: vi.fn(), assertMaterialPurposePin: vi.fn(), authorizeChunks: vi.fn(),
}));
vi.mock("@aistudy/database", async importOriginal => ({
  ...await importOriginal<typeof import("@aistudy/database")>(),
  createOpeningCourseReadySourcesRepository: () => ({
    readMaterialPurposePin: repositories.readMaterialPurposePin,
    assertMaterialPurposePin: repositories.assertMaterialPurposePin,
  }),
  createOpeningSourceEmbeddingsRepository: () => ({ authorizeChunks: repositories.authorizeChunks }),
}));

const scope = { workspaceId: "10000000-0000-4000-8000-000000000001", ownerUserId: "10000000-0000-4000-8000-000000000002" };
const privateId = "10000000-0000-4000-8000-000000000003";
const publicId = "10000000-0000-4000-8000-000000000004";
const output: ProviderOutput = { text: "answer", candidates: [], citedChunkIds: [], requestId: "provider-id", inputTokens: 2, outputTokens: 1 };
const input = { text: "allowed question", sourceIds: [], mode: "listen" as const, history: [] };
const oldHistory = [{ role: "assistant" as const, text: "OLD-PRIVATE-HISTORY", provenanceId: "20000000-0000-4000-8000-000000000009" }];
function fixture() {
  const state = { epoch: 2, excluded: [privateId], versions: new Map([[privateId, 1], [publicId, 1]]) };
  const captures: OpeningMaterialPurposePin[] = [];
  const conflict = () => Object.assign(new Error("material version/privacy changed"), { code: "CONFLICT" });
  const assertScope = (actual: typeof scope) => expect(actual).toEqual(scope);
  const sourcePin = (sourceId: string): OpeningMaterialPurposePin["sources"][number] => {
    const sourceVersion = state.versions.get(sourceId);
    if (sourceVersion === undefined || state.excluded.includes(sourceId)) throw conflict();
    return { sourceId, sourceVersion, membershipId: null, purposeRevision: null, purpose: null };
  };
  repositories.readMaterialPurposePin.mockReset().mockImplementation(async (actualScope, selection) => {
    assertScope(actualScope);
    expect(selection).toMatchObject({ courseId: null, materialUse: "citation" });
    const capture: OpeningMaterialPurposePin = { courseId: selection.courseId, materialUse: selection.materialUse,
      sources: [...new Set<string>(selection.sourceIds)].sort().map(sourcePin) };
    captures.push(capture);
    return capture;
  });
  repositories.assertMaterialPurposePin.mockReset().mockImplementation(async (actualScope, capture: OpeningMaterialPurposePin) => {
    assertScope(actualScope);
    expect(captures).toContain(capture);
    expect(capture).toMatchObject({ courseId: null, materialUse: "citation" });
    if (capture.sources.some(source => source.sourceVersion !== sourcePin(source.sourceId).sourceVersion)) throw conflict();
  });
  repositories.authorizeChunks.mockReset().mockImplementation(async (actualScope, chunks: SourceChunk[]) => {
    assertScope(actualScope);
    return { privacyEpoch: state.epoch, chunks: chunks.filter(chunk =>
      state.versions.get(chunk.sourceId) === chunk.sourceVersion && !state.excluded.includes(chunk.sourceId)) };
  });
  const sourceChunks = [privateId, publicId].map((sourceId, index): SourceChunk => ({
    id: sourceId, sourceId, sourceVersion: 1, page: 1, slideLabel: null, startMs: null, endMs: null,
    text: index === 0 ? "EXCLUDED-PRIVATE-SOURCE" : "allowed source", imageObjectKey: null,
  }));
  const complete = vi.fn(async (_input: ProviderInput): Promise<ProviderOutput> => output);
  const budget = {
    reserve: vi.fn(async () => ({ id: "reservation" })), release: vi.fn(async () => undefined),
    settle: vi.fn(async () => undefined), claimExecution: async () => true, markUnknown: vi.fn(async () => undefined),
  };
  const privacy = {
    snapshot: vi.fn(async () => ({ epoch: state.epoch, excludedSourceIds: [...state.excluded] })),
    currentEpoch: vi.fn(async () => state.epoch),
  };
  const provenance = {
    resolveHistory: vi.fn(async () => []),
    record: vi.fn(async () => "30000000-0000-4000-8000-000000000001"),
  };
  // Real retriever orchestration; only its database factories are replaced. No PG claim.
  const retrieveContext = createOpeningMaterialRetriever(
    {} as Parameters<typeof createOpeningMaterialRetriever>[0],
    budget as unknown as Parameters<typeof createOpeningMaterialRetriever>[1], null,
  );
  const service = createEphemeralTutorService({
    retrieveContext,
    sources: { listOwnedIds: async (_scope, ids) => ids.filter(id => [privateId, publicId].includes(id.toLowerCase())) },
    chunks: { listForSources: async (_scope, ids) => sourceChunks.filter(chunk => ids.map(id => id.toLowerCase()).includes(chunk.sourceId)) },
    privacy, budget, provider: { complete }, requestKey: () => "ephemeral-request", provenance,
    config: { maxContextCharacters: 12_000, reservedCents: 10, maxOutputTokens: 128, inputCentsPerMillion: 1, outputCentsPerMillion: 1 },
  });
  return { state, captures, complete, budget, service, privacy, provenance };
}

describe("ephemeral privacy admission", () => {
  it("omits an excluded source beside an allowed source from actual Provider input", async () => {
    const f = fixture();
    await f.service.replyEphemeral(scope, { ...input, sourceIds: [privateId, publicId] });
    const sent = f.complete.mock.calls[0]![0];
    expect(sent.chunks.map(chunk => chunk.sourceId)).toEqual([publicId]);
    expect(JSON.stringify(sent)).not.toContain("EXCLUDED-PRIVATE-SOURCE");
    expect(f.privacy.snapshot).toHaveBeenCalledWith(scope);
    expect(repositories.readMaterialPurposePin).toHaveBeenCalledExactlyOnceWith(scope, {
      courseId: null, materialUse: "citation", sourceIds: [publicId],
    });
    expect(f.captures).toEqual([{ courseId: null, materialUse: "citation", sources: [
      { sourceId: publicId, sourceVersion: 1, membershipId: null, purposeRevision: null, purpose: null },
    ] }]);
    for (const [, capture] of repositories.assertMaterialPurposePin.mock.calls) expect(capture).toBe(f.captures[0]);
  });
  it("rejects a version change during the privacy await before sending and releases the reservation", async () => {
    const f = fixture();
    f.privacy.currentEpoch.mockImplementation(async () => {
      await Promise.resolve();
      f.state.versions.set(publicId, 2);
      return f.state.epoch;
    });
    await expect(f.service.replyEphemeral(scope, { ...input, sourceIds: [publicId] }))
      .rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.budget.release).toHaveBeenCalledWith("ephemeral-request", "not_sent");
    expect(f.budget.markUnknown).not.toHaveBeenCalled();
    expect(repositories.readMaterialPurposePin).toHaveBeenCalledTimes(1);
    expect(f.captures[0]?.sources[0]?.sourceVersion).toBe(1);
    for (const [, capture] of repositories.assertMaterialPurposePin.mock.calls) expect(capture).toBe(f.captures[0]);
  });
  it("refuses the final answer when a version changes during provenance recording", async () => {
    const f = fixture();
    f.provenance.record.mockImplementation(async () => {
      await Promise.resolve();
      f.state.versions.set(publicId, 2);
      return "30000000-0000-4000-8000-000000000001";
    });
    await expect(f.service.replyEphemeral(scope, { ...input, sourceIds: [publicId] }))
      .rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    expect(f.complete).toHaveBeenCalledTimes(1);
    expect(f.budget.settle).toHaveBeenCalledTimes(1);
    expect(f.budget.release).not.toHaveBeenCalled();
    expect(f.budget.markUnknown).not.toHaveBeenCalled();
    expect(f.provenance.record).toHaveBeenCalledWith(scope, {
      requestId: "ephemeral-request", privacyEpoch: 2, contextSourceRefs: [{ sourceId: publicId, sourceVersion: 1 }],
    });
    expect(repositories.readMaterialPurposePin).toHaveBeenCalledTimes(1);
    expect(f.captures[0]?.sources[0]?.sourceVersion).toBe(1);
    for (const [, capture] of repositories.assertMaterialPurposePin.mock.calls) expect(capture).toBe(f.captures[0]);
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
    expect(f.budget.release).toHaveBeenCalledWith("ephemeral-request", "not_sent");
    expect(f.budget.markUnknown).not.toHaveBeenCalled();
  });
  it("releases when cancellation happens during reservation before sending", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.budget.reserve.mockImplementation(async () => { controller.abort(); return { id: "reservation" }; });
    await expect(f.service.replyEphemeral(scope, input, controller.signal)).rejects.toMatchObject({ code: "ABORTED" });
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.budget.release).toHaveBeenCalledWith("ephemeral-request", "not_sent");
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
