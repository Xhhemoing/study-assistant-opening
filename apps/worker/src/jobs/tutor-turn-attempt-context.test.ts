import { describe, expect, it, vi } from "vitest";
import { createOpeningProvider } from "@aistudy/ai";
import { providerInputSchema, type HelpInputSnapshot } from "@aistudy/contracts";
import type { OpeningTutorJobsRepository, TutorAttemptContext } from "@aistudy/database";
import { TUTOR_FAILURE_MESSAGE } from "@aistudy/domain";
import { createTutorTurnHandler, type TutorTurnDeps } from "./tutor-turn";

// Typed contract fixture for the new attempt-context tests only. Unused repository
// operations fail loudly; the established broad legacy fixture is unchanged.
type SavedTurn = NonNullable<Awaited<ReturnType<OpeningTutorJobsRepository["getUserTurn"]>>>;
const claimedJob = { id: "00000000-0000-4000-8000-00000000000j", workspaceId: "00000000-0000-4000-8000-000000000002", ownerUserId: "00000000-0000-4000-8000-000000000003", conversationId: "00000000-0000-4000-8000-000000000004", userTurnId: "00000000-0000-4000-8000-000000000005", assistantTurnId: "00000000-0000-4000-8000-000000000006", status: "running" as const, mode: "explain", error: null, createdAt: "2026-11-10T00:00:00Z", updatedAt: "2026-11-10T00:00:00Z" };
const turn: SavedTurn = { text: "explain the laws of motion", mode: "explain", sourceIds: [], sourceVersions: {}, currentPage: 1, chunkId: null, learningSessionId: null, strategyTemplateId: null };
const chunkB = { id: "00000000-0000-4000-8000-00000000000b" };
const evaluationBase: Omit<NonNullable<NonNullable<TutorAttemptContext["effectiveGrading"]>["aiEvaluation"]>, "criteria"> = {
  outcome: "incorrect", confidence: 1, questionMatch: true, feedback: "saved feedback", observationId: claimedJob.userTurnId,
  attemptId: claimedJob.userTurnId, problemId: claimedJob.conversationId, itemVersionId: claimedJob.conversationId,
  requirementKey: null, evaluatorVersion: "ai-rubric-v1", modelLabel: null, evaluatedAt: "2026-11-10T00:00:00Z",
};
function unexpected(): never { throw new Error("Unexpected fixture repository call"); }
function setup(_input: { sourceIds: string[]; chunks: [] }) {
  const tutorJobs = {
    loadHistory: vi.fn<OpeningTutorJobsRepository["loadHistory"]>(unexpected),
    loadHistoryContext: vi.fn<OpeningTutorJobsRepository["loadHistoryContext"]>(async () => ({ history: [{ role: "user", text: "yesterday" }, { role: "assistant", text: "step two" }], sourceRefs: [] })),
    get: vi.fn<OpeningTutorJobsRepository["get"]>(async () => claimedJob),
    claim: vi.fn<OpeningTutorJobsRepository["claim"]>(async () => claimedJob),
    getUserTurn: vi.fn<OpeningTutorJobsRepository["getUserTurn"]>(async () => turn),
    readAttemptContext: vi.fn<OpeningTutorJobsRepository["readAttemptContext"]>(async (): Promise<TutorAttemptContext> => ({ privacyEpoch: 0,
      anchor: { purpose: "learning_help", attemptId: claimedJob.userTurnId, itemVersionId: claimedJob.conversationId }, originalQuestion: "saved question",
      originalAnswer: null, currentAnswer: null, rootObservationId: null, headObservationId: null, workSource: null, effectiveGrading: null, sourceRefs: [] })),
    assertAttemptContext: vi.fn<OpeningTutorJobsRepository["assertAttemptContext"]>(async () => {}),
    freezeHelpInputSnapshot: vi.fn<OpeningTutorJobsRepository["freezeHelpInputSnapshot"]>(async (): Promise<HelpInputSnapshot> => ({ userTurnId: claimedJob.userTurnId, assistantTurnId: claimedJob.assistantTurnId, tutorMode: "explain", studyIntent: null })),
    completeTurn: vi.fn<OpeningTutorJobsRepository["completeTurn"]>(async () => {}),
    canAppendCompletedTurnCandidates: vi.fn<OpeningTutorJobsRepository["canAppendCompletedTurnCandidates"]>(async () => true),
    appendCompletedTurnCandidates: vi.fn<OpeningTutorJobsRepository["appendCompletedTurnCandidates"]>(async () => true),
    loadReplayedTurn: vi.fn<OpeningTutorJobsRepository["loadReplayedTurn"]>(async () => null),
    completeFromReplay: vi.fn<OpeningTutorJobsRepository["completeFromReplay"]>(async () => false),
    fail: vi.fn<OpeningTutorJobsRepository["fail"]>(async () => {}),
    markUnknown: vi.fn<OpeningTutorJobsRepository["markUnknown"]>(async () => {}),
    heartbeat: vi.fn<OpeningTutorJobsRepository["heartbeat"]>(unexpected),
    recoverExpired: vi.fn<OpeningTutorJobsRepository["recoverExpired"]>(unexpected),
    expireStale: vi.fn<OpeningTutorJobsRepository["expireStale"]>(unexpected),
    findPendingForConversation: vi.fn<OpeningTutorJobsRepository["findPendingForConversation"]>(unexpected),
    cancel: vi.fn<OpeningTutorJobsRepository["cancel"]>(unexpected),
    readStream: vi.fn<OpeningTutorJobsRepository["readStream"]>(unexpected),
    listQueued: vi.fn<OpeningTutorJobsRepository["listQueued"]>(unexpected),
    loadCompletedTurnForMetadata: vi.fn<OpeningTutorJobsRepository["loadCompletedTurnForMetadata"]>(unexpected),
    applyUserTurnIntent: vi.fn<OpeningTutorJobsRepository["applyUserTurnIntent"]>(unexpected),
  } satisfies OpeningTutorJobsRepository;
  const reservation: Awaited<ReturnType<TutorTurnDeps["budget"]["reserve"]>> = {
    id: "res-1", workspaceId: claimedJob.workspaceId, parentInteractionId: null, settlementCostBasis: null, purpose: "explain", amountCents: 100, requestId: "req-1", state: "reserved", modelSnapshot: null,
    executionClaimedAt: null, outcomeUnknownAt: null, releaseReason: null, resultRef: null, reconciledAt: null, pendingReconcileCents: 0, reservedAmountCents: 100, replayed: false,
  };
  const budget = {
    reserve: vi.fn<TutorTurnDeps["budget"]["reserve"]>(async () => reservation),
    release: vi.fn<TutorTurnDeps["budget"]["release"]>(async () => reservation),
    settle: vi.fn<TutorTurnDeps["budget"]["settle"]>(async () => reservation),
    claimExecution: vi.fn<TutorTurnDeps["budget"]["claimExecution"]>(async () => true),
    markUnknown: vi.fn<TutorTurnDeps["budget"]["markUnknown"]>(async () => reservation),
  } satisfies TutorTurnDeps["budget"];
  const provider = { complete: vi.fn<NonNullable<TutorTurnDeps["provider"]>["complete"]>(async () => ({ text: "F = ma", citedChunkIds: [], requestId: null, candidates: [], inputTokens: 100, outputTokens: 50 })) };
  const deps = { tutorJobs, budget, provider, chunks: { listForSources: async () => [], listChunksAtVersion: async () => [] },
    retrieveContext: async () => ({ chunks: [], mode: "lexical" as const, purposePin: { courseId: null, materialUse: "citation" as const, sources: [] }, assertCurrent: async () => {} }),
    config: { maxContextCharacters: 5000, reservedCents: 100, maxOutputTokens: 2048, inputCentsPerMillion: 100, outputCentsPerMillion: 200 },
  } satisfies TutorTurnDeps;
  return { deps, tutorJobs, budget, provider };
}

describe("sm95 typed attempt context", () => {
  it("sm95 binds saved question, original/current answer and effective grade without pasting them into the request", async () => {
    const { deps, tutorJobs, provider } = setup({ sourceIds: [], chunks: [] });
    const snapshot = { privacyEpoch: 0, anchor: { purpose: "learning_help" as const, attemptId: claimedJob.userTurnId },
      originalQuestion: "sm95 original integral question", originalAnswer: { observationId: "root", answer: "sm95 original wrong answer", answerRevision: 1 },
      currentAnswer: { observationId: "grade", answer: "sm95 original wrong answer", answerRevision: 1 },
      rootObservationId: "root", headObservationId: "grade", workSource: null,
      effectiveGrading: { observationId: "grade", answerRevision: 1, outcome: "incorrect", verdictSource: "ai_graded", aiEvaluation: null, serverEvaluation: null }, sourceRefs: [] };
    tutorJobs.getUserTurn.mockResolvedValueOnce({ ...turn, text: "请讲解本次作答", sourceIds: [], sourceVersions: {}, attemptId: claimedJob.userTurnId });
    const readAttemptContext = vi.fn(async () => snapshot), assertAttemptContext = vi.fn(async () => {});
    await createTutorTurnHandler({ ...deps, tutorJobs: { ...tutorJobs, readAttemptContext, assertAttemptContext } })(claimedJob.id);
    const [call] = provider.complete.mock.calls;
    if (!call) throw new Error("Expected provider call");
    const [input] = call;
    expect(input.text).toContain(snapshot.originalQuestion);
    expect(input.text).toContain(snapshot.originalAnswer.answer);
    expect(input.text).toContain('"effectiveGrading"');
    expect(input.text).toContain('"outcome":"incorrect"');
    expect(input.instruction).toContain("不可信数据");
    expect(assertAttemptContext).toHaveBeenCalled();
    expect(tutorJobs.completeTurn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ attemptContext: { snapshot, target: expect.objectContaining({ jobId: claimedJob.id }) } }));
  });

  it("sm95 P2 rejects an over-limit complete envelope before reserve/claim/provider contract", async () => {
    const { deps, tutorJobs, provider, budget } = setup({ sourceIds: [], chunks: [] });
    tutorJobs.getUserTurn.mockResolvedValueOnce({ ...turn, sourceIds: [], sourceVersions: {}, attemptId: claimedJob.userTurnId });
    const answer = "a".repeat(20000);
    tutorJobs.readAttemptContext.mockResolvedValueOnce({ privacyEpoch: 0, anchor: { purpose: "learning_help", attemptId: claimedJob.userTurnId },
      originalQuestion: "q".repeat(2000), originalAnswer: { observationId: "root", answer: "b".repeat(20000), answerRevision: 1 },
      currentAnswer: { observationId: "grade", answer, answerRevision: 2 }, rootObservationId: "root", headObservationId: "grade", workSource: null,
      effectiveGrading: { observationId: "grade", answerRevision: 2, outcome: "incorrect", verdictSource: "ai_graded",
        aiEvaluation: { ...evaluationBase, criteria: Array.from({ length: 10 }, () => ({ label: "criterion", verdict: "incorrect", feedback: "f".repeat(2000) })) }, serverEvaluation: null }, sourceRefs: [] });
    provider.complete.mockImplementationOnce(async input => { providerInputSchema.parse(input); return { text: "ok", citedChunkIds: [], candidates: [], requestId: null, inputTokens: 1, outputTokens: 1 }; });
    await expect(createTutorTurnHandler(deps)(claimedJob.id)).rejects.toMatchObject({ code: "CONFLICT", reasonCode: "TUTOR_INPUT_TOO_LARGE" });
    expect(budget.reserve).not.toHaveBeenCalled();
    expect(budget.claimExecution).not.toHaveBeenCalled();
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it("sm95 P2 deduplicates a 20k answer while preserving full provider-contract text and both identities", async () => {
    const { deps, tutorJobs, provider } = setup({ sourceIds: [], chunks: [] });
    tutorJobs.getUserTurn.mockResolvedValueOnce({ ...turn, sourceIds: [], sourceVersions: {}, attemptId: claimedJob.userTurnId });
    const answer = "a".repeat(20000);
    tutorJobs.readAttemptContext.mockResolvedValueOnce({ privacyEpoch: 0, anchor: { purpose: "learning_help", attemptId: claimedJob.userTurnId },
      originalQuestion: "original question", originalAnswer: { observationId: "root", answer, answerRevision: 1 },
      currentAnswer: { observationId: "grade", answer, answerRevision: 1 }, rootObservationId: "root", headObservationId: "grade", workSource: null,
      effectiveGrading: { observationId: "grade", answerRevision: 1, outcome: "incorrect", verdictSource: "ai_graded",
        aiEvaluation: { ...evaluationBase, criteria: Array.from({ length: 10 }, () => ({ label: "criterion", verdict: "incorrect", feedback: "f".repeat(2000) })) }, serverEvaluation: null }, sourceRefs: [] });
    provider.complete.mockImplementationOnce(async input => {
      const parsed = providerInputSchema.parse(input), context = JSON.parse(parsed.text).attemptContext;
      expect(context.originalAnswer.answer).toBe(answer);
      const legacyEnvelope = JSON.stringify({ request: turn.text, attemptContext: { ...context,
        currentAnswer: { observationId: "grade", answerRevision: 1, answer } } });
      expect(legacyEnvelope.length).toBeGreaterThan(50000);
      expect(providerInputSchema.safeParse({ ...input, text: legacyEnvelope }).success).toBe(false);
      expect(context.currentAnswer).toEqual({ observationId: "grade", answerRevision: 1, answerFrom: "originalAnswer" });
      expect(context.effectiveGrading.aiEvaluation.criteria).toHaveLength(10);
      expect(context.effectiveGrading.aiEvaluation.criteria[9].feedback).toHaveLength(2000);
      return createOpeningProvider({ baseUrl: "https://offline.invalid", apiKey: "fake", model: "sm95-fake",
        fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ text: "ok", citedChunkIds: [], candidates: [] }) } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 } })) }).complete(input);
    });
    await createTutorTurnHandler(deps)(claimedJob.id);
    expect(provider.complete).toHaveBeenCalledOnce();
  });

  it.each(["before send", "after send"])("sm95 fails closed on attempt drift %s without duplicate send or completion", async phase => {
    const { deps, tutorJobs, provider, budget } = setup({ sourceIds: [], chunks: [] });
    tutorJobs.getUserTurn.mockResolvedValueOnce({ ...turn, sourceIds: [], sourceVersions: {}, attemptId: claimedJob.userTurnId });
    const drift = Object.assign(new Error("bound attempt context is unavailable or changed"), { code: "CONFLICT" });
    if (phase === "before send") tutorJobs.assertAttemptContext.mockRejectedValueOnce(drift);
    else tutorJobs.assertAttemptContext.mockResolvedValueOnce(undefined).mockRejectedValueOnce(drift);
    await expect(createTutorTurnHandler(deps)(claimedJob.id)).rejects.toBe(drift);
    expect(provider.complete).toHaveBeenCalledTimes(phase === "before send" ? 0 : 1);
    expect(budget.release).toHaveBeenCalledTimes(phase === "before send" ? 1 : 0);
    expect(tutorJobs.completeTurn).not.toHaveBeenCalled();
  });

  it("sm95 blocks a stale stream delta before append without logging the saved context", async () => {
    const { deps, tutorJobs, provider } = setup({ sourceIds: [], chunks: [] });
    tutorJobs.getUserTurn.mockResolvedValueOnce({ ...turn, sourceIds: [], sourceVersions: {}, attemptId: claimedJob.userTurnId });
    const drift = Object.assign(new Error("bound attempt context is unavailable or changed"), { code: "CONFLICT" });
    tutorJobs.assertAttemptContext.mockResolvedValueOnce(undefined).mockRejectedValueOnce(drift);
    const stream = { begin: vi.fn(async () => {}), append: vi.fn(async () => {}) };
    const streamExposures = { generate: vi.fn(async () => ({ id: chunkB.id })) };
    provider.complete.mockImplementationOnce(async (_input, _signal, onTextDelta) => {
      if (!onTextDelta) throw new Error("Expected stream callback");
      await onTextDelta("must not be released");
      return { text: "must not be released", citedChunkIds: [], candidates: [], requestId: null, inputTokens: 1, outputTokens: 1 };
    });
    await expect(createTutorTurnHandler({ ...deps, stream, streamExposures })(claimedJob.id)).rejects.toBe(drift);
    expect(stream.append).not.toHaveBeenCalled();
    expect(tutorJobs.completeTurn).not.toHaveBeenCalled();
    expect(tutorJobs.fail).toHaveBeenCalledWith(expect.anything(), claimedJob.id, TUTOR_FAILURE_MESSAGE, undefined, undefined);
  });

});
