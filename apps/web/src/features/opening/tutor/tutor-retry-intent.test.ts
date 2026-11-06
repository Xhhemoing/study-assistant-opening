import { describe, expect, it, vi } from "vitest";
import type { SourceChunk } from "@aistudy/contracts";
import type {
  OpeningConversationRepository, OpeningSourceChunksRepository, readOpeningSavedTurnRetry,
} from "@aistudy/database";
import { createTutorService } from "./tutor-service";

type ServiceDeps = Parameters<typeof createTutorService>[0];
type RetryIntent = NonNullable<Awaited<ReturnType<typeof readOpeningSavedTurnRetry>>>;
const scope = { workspaceId: "11111111-1111-4111-8111-111111111111", ownerUserId: "22222222-2222-4222-8222-222222222222" };
const conversationId = "33333333-3333-4333-8333-333333333333";
const assistantTurnId = "44444444-4444-4444-8444-444444444444";
const sourceA = "55555555-5555-4555-8555-555555555555", sourceB = "66666666-6666-4666-8666-666666666666";
const chunkId = "77777777-7777-4777-8777-777777777777";
const sessionId = "88888888-8888-4888-8888-888888888888", attemptId = "99999999-9999-4999-8999-999999999999";
const courseId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const original: RetryIntent = {
  text: "原资料 A 第四页的问题", mode: "hint", sourceIds: [sourceA], sourceVersions: { [sourceA]: 2 },
  currentPage: 4, chunkId, learningSessionId: sessionId, attemptId,
  strategyTemplateId: "original-strategy", purpose: "answer",
  contextAnchor: { purpose: "learning_help", sourceId: sourceA, sourceVersion: 2, page: 4, chunkId, attemptId },
};
const chunk: SourceChunk = {
  id: chunkId, sourceId: sourceA, sourceVersion: 2, page: 4, text: "原资料内容",
  slideLabel: null, startMs: null, endMs: null, imageObjectKey: null,
};
const request = {
  conversationId, clientKey: `retry-${assistantTurnId}`, privacy: "saved" as const,
  text: "用户当前已编辑成针对 B 的问题", sourceIds: [sourceB], sourceSelection: "selected" as const,
  mode: "explain" as const, currentPage: 8,
};
function fixture(snapshot: RetryIntent | null = original) {
  const conversations = {
    create: vi.fn<OpeningConversationRepository["create"]>(),
    getOwned: vi.fn<OpeningConversationRepository["getOwned"]>().mockResolvedValue({ id: conversationId, title: "owned", courseId, updatedAt: "2026-11-03T00:00:00Z" }),
    listSummaries: vi.fn<OpeningConversationRepository["listSummaries"]>(),
    listTurns: vi.fn<OpeningConversationRepository["listTurns"]>(),
    releaseReturnedTurnIds: vi.fn<OpeningConversationRepository["releaseReturnedTurnIds"]>(),
    loadContinuityTurns: vi.fn<OpeningConversationRepository["loadContinuityTurns"]>().mockResolvedValue([]),
    findTurnByClientKey: vi.fn<OpeningConversationRepository["findTurnByClientKey"]>().mockResolvedValue(null),
    appendSavedTurn: vi.fn<OpeningConversationRepository["appendSavedTurn"]>().mockResolvedValue({ turnId: chunkId, jobId: sourceA, assistantTurnId }),
  } satisfies OpeningConversationRepository;
  const sourceChunks = {
    replaceChunks: vi.fn<OpeningSourceChunksRepository["replaceChunks"]>(),
    listChunks: vi.fn<OpeningSourceChunksRepository["listChunks"]>(),
    listChunksAtVersion: vi.fn<OpeningSourceChunksRepository["listChunksAtVersion"]>().mockResolvedValue([chunk]),
    listForSources: vi.fn<OpeningSourceChunksRepository["listForSources"]>().mockResolvedValue([chunk]),
  } satisfies OpeningSourceChunksRepository;
  const readFailedTurnRetry = vi.fn<NonNullable<ServiceDeps["readFailedTurnRetry"]>>()
    .mockResolvedValue(snapshot);
  const listReadySourceIdsForCourse = vi.fn(async () => [sourceB]);
  const assertAccess = vi.fn(async () => ({ id: attemptId, sessionId }));
  const tutorModelReady = vi.fn(async () => true);
  const service = createTutorService({ conversations, sourceChunks, readFailedTurnRetry,
    attempts: { assertAccess }, listReadySourceIdsForCourse, tutorModelReady,
    readSelection: async () => ({ sourceIds: [sourceB], currentPage: 8 }),
  });
  return { service, conversations, sourceChunks, readFailedTurnRetry, listReadySourceIdsForCourse, assertAccess, tutorModelReady };
}

describe("service consumes the original persisted failed-turn intent", () => {
  it("restores literal A/version/page/chunk/session/attempt/context/purpose rather than the current B editor", async () => {
    const f = fixture();
    await f.service.submitTurn(scope, request);
    expect(f.readFailedTurnRetry).toHaveBeenCalledExactlyOnceWith(scope, conversationId, assistantTurnId);
    expect(f.sourceChunks.listForSources).toHaveBeenCalledWith(scope, [sourceA]);
    expect(f.sourceChunks.listChunksAtVersion).toHaveBeenCalledWith(scope, sourceA, 2);
    expect(f.assertAccess).toHaveBeenCalledWith(scope, attemptId);
    expect(f.listReadySourceIdsForCourse).not.toHaveBeenCalled();
    expect(f.conversations.appendSavedTurn).toHaveBeenCalledExactlyOnceWith({
      scope, conversationId, clientKey: request.clientKey, privacy: "saved", text: original.text,
      mode: "hint", sourceIds: [sourceA], learningSessionId: sessionId, attemptId,
      currentPage: 4, chunkId, strategyTemplateId: "original-strategy",
      contextAnchor: original.contextAnchor, purpose: "answer",
    });
    expect(request.sourceIds).toEqual([sourceB]);
    expect(request.currentPage).toBe(8);
  });

  it("preserves an originally empty selection instead of filling it from the current course pool", async () => {
    const empty: RetryIntent = { ...original, sourceIds: [], sourceVersions: {}, currentPage: null, chunkId: null,
      learningSessionId: null, attemptId: null, strategyTemplateId: null, contextAnchor: null, purpose: null };
    const f = fixture(empty);
    await f.service.submitTurn(scope, request);
    expect(f.listReadySourceIdsForCourse).not.toHaveBeenCalled();
    expect(f.sourceChunks.listForSources).not.toHaveBeenCalled();
    expect(f.assertAccess).not.toHaveBeenCalled();
    expect(f.conversations.appendSavedTurn).toHaveBeenCalledWith(expect.objectContaining({
      text: original.text, sourceIds: [], currentPage: null, chunkId: null,
      learningSessionId: null, attemptId: null, strategyTemplateId: null,
    }));
  });

  it("does not invent a retry intent when the owned terminal snapshot is unavailable", async () => {
    const f = fixture(null);
    await expect(f.service.submitTurn(scope, request)).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    expect(f.conversations.appendSavedTurn).not.toHaveBeenCalled();
    expect(f.sourceChunks.listForSources).not.toHaveBeenCalled();
    expect(f.tutorModelReady).not.toHaveBeenCalled();
  });

  it("replays the same resolved retry even if today's editor changes again", async () => {
    const f = fixture();
    f.conversations.findTurnByClientKey.mockResolvedValue({ userTurnId: chunkId, jobId: sourceA,
      assistantTurnId, learningSessionId: sessionId, mode: "hint", purpose: "answer", querySystem: false });
    const result = await f.service.submitTurn(scope, { ...request, text: "再次编辑过的 B", currentPage: 9 });
    expect(result.replayed).toBe(true);
    expect(f.tutorModelReady).not.toHaveBeenCalled();
    expect(f.conversations.appendSavedTurn).toHaveBeenCalledWith(expect.objectContaining({
      clientKey: request.clientKey, text: original.text, sourceIds: [sourceA], currentPage: 4,
    }));
  });
});
