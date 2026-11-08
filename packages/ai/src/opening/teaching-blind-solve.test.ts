import type { ProviderInput } from "@aistudy/contracts";
import type { BudgetedRepository } from "./budgeted-call";
import { describe, expect, it, vi } from "vitest";
import { createModelGateway } from "./model-gateway";
import { solveTeachingBlind, teachingBlindSolveMatchesCurrent, type TeachingBlindSolveConfig, type TeachingBlindSolveIdentity, type TeachingBlindSolveReceipt } from "./teaching-blind-solve";

const config: TeachingBlindSolveConfig = {
  solver: { providerId: "solver-provider", modelName: "solver-model", family: "family-b" },
  generator: { providerId: "generator-provider", modelName: "generator-model", family: "family-a" },
};
const identity: TeachingBlindSolveIdentity = {
  activityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", teachingRevisionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  blockId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", contentVersion: 2,
  sourceVersions: { "dddddddd-dddd-4ddd-8ddd-dddddddddddd": 1 }, generatorModelIdentity: config.generator,
};
const scope = { workspaceId: "workspace-a", ownerUserId: "owner-a" };
function fixture(answer: unknown = "4") {
  let state = "reserved";
  const complete = vi.fn(async (_input: ProviderInput) => ({ text: JSON.stringify({ answer, family: "model-self-report-ignored" }),
    inputTokens: 10, outputTokens: 10, citedChunkIds: [], candidates: [], requestId: "fake" }));
  const budget = {
    reserve: vi.fn(async (_input: Parameters<BudgetedRepository["reserve"]>[0]) => ({ id: "ledger-1", state, resultRef: "job:job-a:blind-solve:block-a" })),
    claimExecution: vi.fn(async () => true), release: vi.fn(async () => {}), markUnknown: vi.fn(async () => {}),
    settle: vi.fn(async () => { state = "completed"; }),
  };
  const resolve = vi.fn(async () => ({ provider: { complete },
    modelSnapshot: { id: "solver", providerId: config.solver.providerId, modelName: config.solver.modelName, inputCentsPerMillion: 1, outputCentsPerMillion: 1 },
    inputCentsPerMillion: 1, outputCentsPerMillion: 1,
  }));
  const gateway = createModelGateway({ resolve });
  let stored: TeachingBlindSolveReceipt | undefined;
  const persist = vi.fn(async (receipt: TeachingBlindSolveReceipt) => { stored = structuredClone(receipt); });
  const input = { scope, identity, config, question: "2 + 2 = ?", interaction: { kind: "numeric" as const }, pinnedKey: "4", gateway,
    options: { budget, operationId: "teaching-solve:job-a:block-a", resultRef: "job:job-a:blind-solve:block-a" }, persist };
  return { input, complete, budget, resolve, persist, stored: () => stored };
}

describe("teaching blind solve protocol", () => {
  it.each([null, { ...config, solver: { ...config.solver, family: "FAMILY-A" } },
    { ...config, generator: { ...config.generator, providerId: "" } },
    { ...config, solver: { ...config.generator, family: "claimed-other-family" } }])("does not resolve, reserve or send without independent trusted config", async configured => {
    const f = fixture();
    const result = await solveTeachingBlind({ ...f.input, config: configured });
    expect(result.decision).toBe("unknown");
    expect(f.resolve).not.toHaveBeenCalled(); expect(f.complete).not.toHaveBeenCalled(); expect(f.budget.reserve).not.toHaveBeenCalled();
  });
  it("sends only the question, persists before settlement, and binds matching metadata", async () => {
    const f = fixture();
    const result = await solveTeachingBlind(f.input);
    expect(result).toMatchObject({ decision: "match", solverAnswer: "4", family: "family-b", costLedgerRef: "ledger-1", identity });
    expect(f.resolve).toHaveBeenCalledWith(scope, "teaching.solve");
    const request = f.complete.mock.calls[0]![0];
    expect(request).toMatchObject({ text: "2 + 2 = ?", chunks: [], imageParts: [] });
    expect(JSON.stringify(request)).not.toContain('"4"');
    expect(JSON.stringify(request)).not.toMatch(/pinnedKey|sourceVersions|generator|learner|rubric|receipt/);
    expect(f.budget.reserve).toHaveBeenCalledWith(expect.objectContaining({ purpose: "teaching-solve", requestId: f.input.options.operationId }));
    expect(f.persist.mock.invocationCallOrder[0]).toBeLessThan(f.budget.settle.mock.invocationCallOrder[0]!);
    expect(teachingBlindSolveMatchesCurrent(result, structuredClone(identity))).toBe(true);
    for (const changed of [{ ...identity, blockId: "other" }, { ...identity, teachingRevisionId: "other" },
      { ...identity, contentVersion: 3 }, { ...identity, itemVersionId: "new" }, { ...identity, sourceVersions: {} },
      { ...identity, generatorModelIdentity: { ...config.generator, modelName: "new" } }]) {
      expect(teachingBlindSolveMatchesCurrent(result, changed)).toBe(false);
    }
  });
  it.each([["5", "disagree"], [null, "unknown"], ["I abstain", "unknown"]] as const)("keeps %s as %s without repairing key", async (answer, decision) => {
    const f = fixture(answer);
    expect((await solveTeachingBlind(f.input)).decision).toBe(decision);
    expect(f.input.pinnedKey).toBe("4");
  });
  it("does not invent authority for non-deterministic questions", async () => {
    const f = fixture("a proof");
    const result = await solveTeachingBlind({ ...f.input, question: "Prove the theorem", pinnedKey: "a proof" });
    expect(result).toMatchObject({ decision: "unknown", reasonCodes: ["comparison_unsupported"] });
  });
  it("compares supported choices without sending the pinned choice", async () => {
    const f = fixture("B. 4");
    const result = await solveTeachingBlind({ ...f.input, pinnedKey: "B", interaction: { kind: "choice", options: [{ id: "A", label: "3" }, { id: "B", label: "4" }] } });
    expect(result.decision).toBe("match");
    expect(f.complete.mock.calls[0]![0]).toMatchObject({ text: "2 + 2 = ?\nA. 3\nB. 4" });
  });
  it("rejects a wrong actual route before reservation, ignoring model-reported family", async () => {
    const f = fixture();
    const result = await solveTeachingBlind({ ...f.input, config: { ...config, solver: { ...config.solver, modelName: "different" } } });
    expect(result.decision).toBe("unknown"); expect(f.budget.reserve).not.toHaveBeenCalled(); expect(f.complete).not.toHaveBeenCalled();
  });
  it("retries reuse the operation, never send or settle again, and do not replace the stored match", async () => {
    const f = fixture();
    await solveTeachingBlind(f.input);
    expect((await solveTeachingBlind(f.input)).decision).toBe("unknown");
    expect(f.complete).toHaveBeenCalledTimes(1); expect(f.budget.settle).toHaveBeenCalledTimes(1);
    expect(f.budget.reserve.mock.calls.map(([reservation]) => reservation.requestId)).toEqual([f.input.options.operationId, f.input.options.operationId]);
    expect(f.stored()?.decision).toBe("match");
  });
  it("a send fence failure releases without calling the provider", async () => {
    const f = fixture();
    const result = await solveTeachingBlind({ ...f.input, options: { ...f.input.options, beforeSend: async () => { throw new Error("privacy changed"); } } });
    expect(result.decision).toBe("unknown"); expect(f.complete).not.toHaveBeenCalled(); expect(f.budget.release).toHaveBeenCalledTimes(1);
  });
  it("never retains a match when durable result storage fails", async () => {
    const f = fixture();
    f.persist.mockRejectedValue(new Error("job claim changed"));
    await expect(solveTeachingBlind(f.input)).rejects.toThrow("job claim changed");
    expect(f.budget.settle).not.toHaveBeenCalled(); expect(f.budget.markUnknown).toHaveBeenCalledTimes(1);
    expect(f.complete).toHaveBeenCalledTimes(1);
  });
  it("provider errors remain unknown and never retry", async () => {
    const f = fixture(); f.complete.mockRejectedValue(new Error("fake provider error"));
    expect((await solveTeachingBlind(f.input)).decision).toBe("unknown");
    expect(f.complete).toHaveBeenCalledTimes(1); expect(f.budget.markUnknown).toHaveBeenCalledTimes(1);
  });
});
