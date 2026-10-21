import { describe, expect, it, vi } from "vitest";
import type { OpeningJobRecord, SourceIndexSnapshot } from "@aistudy/database";
import type { BudgetedRepository } from "@aistudy/ai";
import { createIndexSourceHandler, type IndexSourceDeps } from "./index-source";

const config = { modelKey: "test-model:3", baseUrl: "https://models.example.test/v1", modelName: "embedding", apiKey: "test",
  dimensions: 3, inputCentsPerMillion: 1, billing: "metered" as const, dailyRequestCap: null, requestDimensions: true };
const job = { id: "job", workspaceId: "workspace", ownerUserId: "owner", privacyEpoch: 1 } as OpeningJobRecord;
const snapshot: SourceIndexSnapshot = { sourceId: "source", sourceVersion: 2, privacyEpoch: 1, chunks: [{
  id: "chunk", sourceId: "source", sourceVersion: 2, page: 1, slideLabel: null, startMs: null, endMs: null,
  imageObjectKey: null, text: "汉".repeat(70_000) + "tail",
}] };
function fixture() {
  const repository: IndexSourceDeps["repository"] = { snapshot: vi.fn(async () => snapshot), assertCurrent: vi.fn(async () => {}),
    listIndexedKeys: vi.fn(async () => []), store: vi.fn(async () => {}) };
  const embed = vi.fn<NonNullable<IndexSourceDeps["embed"]>>(async input => {
    await input.beforeSend?.();
    const result = { vectors: input.inputs.map(() => [1, 0, 0]), inputTokens: 20, requestId: "request" };
    await input.persistResult?.(result, { reservationId: "budget", settledCents: 1 });
    return result;
  });
  return { repository, embed, handler: createIndexSourceHandler({ repository, embed, config, budget: () => ({} as BudgetedRepository) }) };
}
describe("source indexing", () => {
  it("embeds every long-page segment in bounded batches and persists after rechecking", async () => {
    const f = fixture();
    expect(await f.handler(job, { sourceId: "source", sourceVersion: 2 })).toMatchObject({ indexed: true, segments: 36 });
    expect(f.embed.mock.calls.map(([input]) => input.inputs.length)).toEqual([32, 4]);
    expect(f.embed.mock.calls.flatMap(([input]) => input.inputs).join("")).toBe(snapshot.chunks[0]!.text);
    expect(f.repository.assertCurrent).toHaveBeenCalledTimes(2);
    expect(f.repository.store).toHaveBeenCalledTimes(2);
    expect(f.embed.mock.calls[1]![0].operationId).toContain("chunk:32");
  });
  it("uses a stable remaining-batch key on recovery rather than reusing the first reservation", async () => {
    const f = fixture();
    vi.mocked(f.repository.listIndexedKeys).mockResolvedValue(Array.from({ length: 32 }, (_, index) => `chunk:${index}`));
    await f.handler(job, { sourceId: "source", sourceVersion: 2 });
    expect(f.embed).toHaveBeenCalledTimes(1);
    expect(f.embed.mock.calls[0]![0].operationId).toContain("chunk:32");
  });
  it("does not send when the parsed version or privacy snapshot is obsolete", async () => {
    const f = fixture();
    vi.mocked(f.repository.snapshot).mockResolvedValue({ ...snapshot, privacyEpoch: 2 });
    expect(await f.handler(job, { sourceId: "source", sourceVersion: 2 })).toMatchObject({ indexed: false });
    expect(f.embed).not.toHaveBeenCalled();
  });
  it("does not claim semantic indexing for an image with no extracted text", async () => {
    const f = fixture();
    vi.mocked(f.repository.snapshot).mockResolvedValue({ ...snapshot, chunks: [{ ...snapshot.chunks[0]!, text: "", imageObjectKey: "photo" }] });
    expect(await f.handler(job, { sourceId: "source", sourceVersion: 2 })).toEqual({ indexed: false, reason: "no_text" });
    expect(f.embed).not.toHaveBeenCalled();
  });
  it("does not persist after a source changed before sending", async () => {
    const f = fixture();
    vi.mocked(f.repository.assertCurrent).mockRejectedValue(new Error("source changed"));
    await expect(f.handler(job, { sourceId: "source", sourceVersion: 2 })).rejects.toThrow("source changed");
    expect(f.repository.store).not.toHaveBeenCalled();
  });
});
