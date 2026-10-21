import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createModelGateway, OpeningProviderError, tutorModelTask, type BudgetedRepository } from "@aistudy/ai";
import type { ProviderOutput } from "@aistudy/contracts";
import { createTutorMetadataHandler } from "./tutor-metadata";

const scope = { workspaceId: randomUUID(), ownerUserId: randomUUID() };
const payload = { tutorJobId: randomUUID(), assistantTurnId: randomUUID(), tutorClaimToken: randomUUID() };
const job = { id: randomUUID(), ...scope, key: `tutor-metadata:${payload.tutorJobId}`, kind: "tutor-metadata",
  state: "running", privacyEpoch: 3, claimToken: randomUUID(), payload, result: null };
const completed = { question: "What is momentum?", answer: "Momentum equals mass times velocity.", mode: "explain", userTurnId: randomUUID() };
const output: ProviderOutput = { text: "", citedChunkIds: [], requestId: null, inputTokens: 100, outputTokens: 20,
  candidates: [{ kind: "memory", text: "Learner is studying momentum", temporary: false }] };

function setup() {
  const tutorJobs = {
    loadCompletedTurnForMetadata: vi.fn(async () => completed),
    canAppendCompletedTurnCandidates: vi.fn(async () => true),
    appendCompletedTurnCandidates: vi.fn(async () => true),
  };
  const budget = { reserve: vi.fn(async () => ({ id: "reservation" })), claimExecution: vi.fn(async () => true),
    settle: vi.fn(async () => {}), release: vi.fn(async () => {}), markUnknown: vi.fn(async () => {}) } satisfies BudgetedRepository;
  const complete = vi.fn(async () => output);
  const model = { provider: { complete }, modelSnapshot: { id: "m1", providerId: "p1", modelName: "model", inputCentsPerMillion: 100, outputCentsPerMillion: 200 },
    inputCentsPerMillion: 100, outputCentsPerMillion: 200 };
  const fallback = vi.fn(async () => null);
  const gateway = createModelGateway({ resolve: async () => model, resolveFallback: fallback });
  const handler = createTutorMetadataHandler({ tutorJobs,
    callModel: (owner, mode, options) => gateway.call(owner, tutorModelTask(mode), { ...options, budget }),
  });
  return { handler, tutorJobs, budget, complete, fallback };
}

describe("tutor metadata worker", () => {
  it("loads only the owned completed answer and persists suggestions under the original operation and parent budget", async () => {
    const { handler, tutorJobs, budget, complete } = setup();
    tutorJobs.appendCompletedTurnCandidates.mockImplementationOnce(async () => {
      expect(budget.settle).not.toHaveBeenCalled();
      return true;
    });
    await expect(handler(job, payload)).resolves.toEqual({ skipped: false, appended: true });
    expect(tutorJobs.loadCompletedTurnForMetadata).toHaveBeenCalledWith({ scope, jobId: payload.tutorJobId,
      assistantTurnId: payload.assistantTurnId, claimToken: payload.tutorClaimToken, expectedPrivacyEpoch: 3,
      metadataLease: { id: job.id, claimToken: job.claimToken } });
    expect(complete.mock.calls[0][0]).toMatchObject({ text: JSON.stringify({ question: completed.question, completedAnswer: completed.answer }),
      chunks: [], history: [], outputFormat: "answer" });
    expect(budget.reserve).toHaveBeenCalledWith(expect.objectContaining({ requestId: `tutor:${payload.tutorJobId}:metadata`,
      parentBudget: { id: `study-turn:${completed.userTurnId}` } }));
    expect(tutorJobs.appendCompletedTurnCandidates).toHaveBeenCalledWith(expect.objectContaining({ candidates: output.candidates }));
    expect(budget.settle).toHaveBeenCalledOnce();
  });

  it("does not reserve or send after the saved answer or metadata job loses authorization", async () => {
    const { handler, tutorJobs, budget, complete } = setup();
    tutorJobs.loadCompletedTurnForMetadata.mockResolvedValueOnce(null);
    await expect(handler(job, payload)).resolves.toEqual({ skipped: true });
    expect(budget.reserve).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("rechecks authorization after reservation and releases without sending", async () => {
    const { handler, tutorJobs, budget, complete } = setup();
    tutorJobs.canAppendCompletedTurnCandidates.mockResolvedValueOnce(false);
    await expect(handler(job, payload)).rejects.toThrow("authorization changed");
    expect(budget.release).toHaveBeenCalledWith(`tutor:${payload.tutorJobId}:metadata`, "not_sent");
    expect(complete).not.toHaveBeenCalled();
    expect(tutorJobs.appendCompletedTurnCandidates).not.toHaveBeenCalled();
  });

  it("keeps a timed-out metadata call unknown and never falls back or resends its ledger key", async () => {
    const { handler, tutorJobs, budget, complete, fallback } = setup();
    complete.mockRejectedValueOnce(new OpeningProviderError("PROVIDER_TIMEOUT", "metadata timeout"));
    await expect(handler(job, payload)).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
    expect(budget.markUnknown).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();
    budget.reserve.mockResolvedValueOnce({ id: "reservation", state: "reserved", outcomeUnknownAt: new Date() });
    await expect(handler(job, payload)).rejects.toMatchObject({ code: "BUDGET_OUTCOME_UNKNOWN" });
    expect(complete).toHaveBeenCalledOnce();
    expect(tutorJobs.appendCompletedTurnCandidates).not.toHaveBeenCalled();
    expect(budget.release).not.toHaveBeenCalled();
  });

  it("settles a sent response when cancellation blocks its candidate writeback", async () => {
    const { handler, tutorJobs, budget } = setup();
    tutorJobs.appendCompletedTurnCandidates.mockResolvedValueOnce(false);
    await expect(handler(job, payload)).resolves.toEqual({ skipped: false, appended: false });
    expect(budget.settle).toHaveBeenCalledOnce();
    expect(budget.release).not.toHaveBeenCalled();
  });

  it("does not add task suggestions in listen mode", async () => {
    const { handler, tutorJobs, complete } = setup();
    tutorJobs.loadCompletedTurnForMetadata.mockResolvedValueOnce({ ...completed, mode: "listen" });
    complete.mockResolvedValueOnce({ ...output, candidates: [...output.candidates, { kind: "task", title: "Practice", minutes: 10, dueText: null }] });
    await handler(job, payload);
    expect(tutorJobs.appendCompletedTurnCandidates).toHaveBeenCalledWith(expect.objectContaining({ candidates: output.candidates }));
  });

  it("rejects malformed queued payloads before reading private turns or paying", async () => {
    const { handler, tutorJobs, budget } = setup();
    await expect(handler(job, { ...payload, tutorJobId: "forged" })).rejects.toThrow();
    expect(tutorJobs.loadCompletedTurnForMetadata).not.toHaveBeenCalled();
    expect(budget.reserve).not.toHaveBeenCalled();
  });
});
