import { describe, expect, it, vi } from "vitest";
import { OpeningProviderError, type BudgetedRepository } from "@aistudy/ai";
import type { ProviderOutput } from "@aistudy/contracts";
import { createEphemeralTutorService } from "./ephemeral-service";

const scope = { workspaceId: "10000000-0000-4000-8000-000000000001", ownerUserId: "10000000-0000-4000-8000-000000000002" };
const output: ProviderOutput = {
  text: "可以继续这个问题", citedChunkIds: [], candidates: [], requestId: "confirmed-reply",
  inputTokens: 2, outputTokens: 3,
};
function fixture(parentNotSent = true) {
  const reserve = vi.fn<BudgetedRepository["reserve"]>().mockResolvedValue({ id: "fresh" });
  const release = vi.fn<BudgetedRepository["release"]>().mockResolvedValue(undefined);
  const complete = vi.fn<(_input: unknown) => Promise<ProviderOutput>>().mockResolvedValue(output);
  const service = createEphemeralTutorService({
    sources: { listOwnedIds: async (_scope, ids) => ids },
    chunks: { listForSources: async () => [] },
    privacy: { snapshot: async () => ({ epoch: 0, excludedSourceIds: [] }), currentEpoch: async () => 0 },
    provider: { complete },
    budget: { reserve, release, isParentNotSent: async () => parentNotSent,
      claimExecution: async () => true, settle: async () => undefined, markUnknown: async () => undefined },
    config: { maxContextCharacters: 1000, maxOutputTokens: 32, reservedCents: 10, inputCentsPerMillion: 1, outputCentsPerMillion: 1 },
  });
  return { service, reserve, release, complete };
}
const input = (clientKey: string) => ({ text: "解释同一个问题", sourceIds: [], history: [], clientKey });

describe("ephemeral explicit not-sent retry", () => {
  it("exposes a confirmed auth release, blocks the old send, and accepts the user's explicit fresh attempt", async () => {
    const f = fixture();
    f.reserve.mockReset().mockResolvedValueOnce({ id: "first" })
      .mockResolvedValueOnce({ id: "first", state: "released", releaseReason: "not_sent" })
      .mockResolvedValueOnce({ id: "next" });
    f.complete.mockRejectedValueOnce(new OpeningProviderError("PROVIDER_AUTH", "bad credentials"));
    await expect(f.service.replyEphemeral(scope, input("original"))).rejects.toMatchObject({
      code: "EPHEMERAL_REQUEST_NOT_SENT", status: 409,
    });
    expect(f.release).toHaveBeenCalledExactlyOnceWith("eph:original", "not_sent");
    await expect(f.service.replyEphemeral(scope, input("original"))).rejects.toMatchObject({ code: "EPHEMERAL_REQUEST_NOT_SENT" });
    expect(f.complete).toHaveBeenCalledOnce();
    const result = await f.service.replyEphemeral(scope, input("explicit-next"));
    expect(result.text).toBe(output.text);
    expect(f.complete).toHaveBeenCalledTimes(2);
    expect(f.reserve.mock.calls.map(([request]) => request.requestId)).toEqual(["eph:original", "eph:original", "eph:explicit-next"]);
  });

  it.each(["not_sent", "cancelled"])("identifies only confirmed released/%s as eligible for a later explicit attempt", async releaseReason => {
    const f = fixture();
    f.reserve.mockResolvedValue({ id: "released", state: "released", releaseReason });
    await expect(f.service.replyEphemeral(scope, input("original"))).rejects.toMatchObject({ code: "EPHEMERAL_REQUEST_NOT_SENT" });
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.reserve).toHaveBeenCalledOnce();
  });

  it.each([
    { id: "unknown", state: "reserved", outcomeUnknownAt: new Date("2026-11-03T00:00:00Z") },
    { id: "done", state: "settled", resultRef: "ephemeral:original" },
    { id: "released-without-proof", state: "released", releaseReason: null },
  ])("does not send or grant retry for unresolved/completed ledger $id", async reservation => {
    const f = fixture();
    f.reserve.mockResolvedValue(reservation);
    const error = await f.service.replyEphemeral(scope, input("original")).catch((failure: unknown) => failure);
    expect(error).not.toMatchObject({ code: "EPHEMERAL_REQUEST_NOT_SENT" });
    expect(error).toBeInstanceOf(Error);
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.reserve).toHaveBeenCalledOnce();
  });

  it("does not promote a released child when the persisted parent cannot prove not-sent", async () => {
    const f = fixture(false);
    f.reserve.mockResolvedValue({ id: "released", state: "released", releaseReason: "not_sent" });
    await expect(f.service.replyEphemeral(scope, input("original"))).rejects.toMatchObject({ code: "BUDGET_REPLAY_RELEASED" });
    expect(f.complete).not.toHaveBeenCalled();
  });

  it("does not turn a provider timeout into a known-not-sent response", async () => {
    const f = fixture();
    const failure = new OpeningProviderError("PROVIDER_TIMEOUT", "reply unknown");
    f.complete.mockRejectedValueOnce(failure);
    await expect(f.service.replyEphemeral(scope, input("original"))).rejects.toBe(failure);
    expect(f.release).not.toHaveBeenCalled();
    expect(f.complete).toHaveBeenCalledOnce();
  });

  it("does not claim a release succeeded when the ledger release itself failed", async () => {
    const f = fixture(), ledgerError = new Error("release acknowledgement lost");
    f.complete.mockRejectedValueOnce(new OpeningProviderError("PROVIDER_AUTH", "bad credentials"));
    f.release.mockRejectedValueOnce(ledgerError);
    await expect(f.service.replyEphemeral(scope, input("original"))).rejects.toBe(ledgerError);
  });
});
