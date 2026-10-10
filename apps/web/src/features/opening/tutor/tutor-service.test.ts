import { describe, expect, it, vi } from "vitest";
import {
  createTutorService,
  exposureLevelForMode,
  mapPageSelectionToHttp,
} from "./tutor-service";
import { conversationResumeSchema, shouldCreateLearningSession } from "@aistudy/contracts";
import { messagesFromResume } from "../assistant/message-model";

const S = "22222222-2222-4222-8222-222222222222";
const OTHER_SOURCE = "33333333-3333-4333-8333-333333333333";
const C = "44444444-4444-4444-8444-444444444444";
const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const COURSE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const scope = { workspaceId: "55555555-5555-4555-8555-555555555555", ownerUserId: "66666666-6666-4666-8666-666666666666" };

function createService(opts?: {
  courseId?: string | null;
  listReadySourceIdsForCourse?: ReturnType<typeof vi.fn>;
}) {
  const conversations = {
    getOwned: vi.fn(async () => ({
      id: CONVERSATION,
      title: "t",
      courseId: opts?.courseId === undefined ? null : opts.courseId,
      updatedAt: "2026-09-20T00:00:00.000Z",
    })),
    loadContinuityTurns: vi.fn(async () => []),
    appendSavedTurn: vi.fn(async () => ({ turnId: "77777777-7777-4777-8777-777777777777", jobId: "88888888-8888-4888-8888-888888888888", assistantTurnId: "99999999-9999-4999-8999-999999999999" })),
    findTurnByClientKey: vi.fn(async () => null),
  };
  const sourceChunks = {
    listForSources: vi.fn(async () => [
      { id: C, sourceId: S, sourceVersion: 1, page: 4, slideLabel: null, startMs: null, endMs: null, text: "page four", imageObjectKey: null },
      { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sourceId: OTHER_SOURCE, sourceVersion: 1, page: 9, slideLabel: null, startMs: null, endMs: null, text: "other", imageObjectKey: null },
    ]),
  };
  const readSelection = vi.fn(async () => ({ sourceIds: [S], currentPage: 4, chunkId: C }));
  const listReadySourceIdsForCourse = opts?.listReadySourceIdsForCourse;
  return {
    service: createTutorService({
      conversations,
      sourceChunks,
      readSelection,
      ...(listReadySourceIdsForCourse ? { listReadySourceIdsForCourse } : {}),
    }),
    conversations,
    sourceChunks,
    readSelection,
    listReadySourceIdsForCourse,
  };
}

describe("tutor-service RU-04 / continuity hooks", () => {
  it("authorizes submitted pages from scope-owned source chunks", async () => {
    const { service, conversations, sourceChunks } = createService();
    await expect(service.submitTurn(scope, {
      conversationId: CONVERSATION,
      text: "explain page four",
      sourceIds: [S],
      mode: "explain",
      clientKey: "client-key-1",
      privacy: "saved",
      currentPage: 4,
    })).resolves.toMatchObject({ jobId: "88888888-8888-4888-8888-888888888888" });
    expect(sourceChunks.listForSources).toHaveBeenCalledWith(scope, [S]);
    expect(conversations.appendSavedTurn).toHaveBeenCalled();
  });

  it.each([{ chunks: [] }, { chunks: [{ id: C, sourceId: S, sourceVersion: 1, page: 4, slideLabel: null, startMs: null, endMs: null, text: " \t", imageObjectKey: null }] }])("refuses a missing selected material even without a requested page (%#)", async ({ chunks }) => {
    const { service, conversations, sourceChunks } = createService();
    sourceChunks.listForSources.mockResolvedValueOnce(chunks);
    await expect(service.submitTurn(scope, { conversationId: CONVERSATION, text: "read both", sourceIds: [S, OTHER_SOURCE], mode: "explain", clientKey: "missing-material", privacy: "saved" }))
      .rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE", status: 422 });
    expect(conversations.appendSavedTurn).not.toHaveBeenCalled();
  });
  it("replays a saved turn after its source version no longer has the selected page", async () => {
    const { service, conversations, sourceChunks } = createService();
    sourceChunks.listForSources.mockResolvedValueOnce([]);
    conversations.findTurnByClientKey.mockResolvedValueOnce({
      userTurnId: "77777777-7777-4777-8777-777777777777",
      jobId: "88888888-8888-4888-8888-888888888888",
      assistantTurnId: "99999999-9999-4999-8999-999999999999",
      learningSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });

    await expect(service.submitTurn(scope, {
      conversationId: CONVERSATION,
      text: "explain page four",
      sourceIds: [S],
      mode: "explain",
      clientKey: "client-replay-1",
      privacy: "saved",
      currentPage: 4,
      chunkId: C,
    })).resolves.toMatchObject({
      jobId: "88888888-8888-4888-8888-888888888888",
      learningSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    expect(conversations.appendSavedTurn).toHaveBeenCalledWith(expect.objectContaining({
      learningSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    }));
    expect(sourceChunks.listForSources).not.toHaveBeenCalled();
  });

  it("rejects a page or chunk outside the requested sources", async () => {
    const { service } = createService();
    await expect(service.submitTurn(scope, {
      conversationId: CONVERSATION,
      text: "explain",
      sourceIds: [S],
      mode: "explain",
      clientKey: "client-key-2",
      privacy: "saved",
      currentPage: 9,
    })).rejects.toMatchObject({ code: "page_not_in_sources", status: 422 });
    await expect(service.submitTurn(scope, {
      conversationId: CONVERSATION,
      text: "explain",
      sourceIds: [S],
      mode: "explain",
      clientKey: "client-key-3",
      privacy: "saved",
      chunkId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    })).rejects.toMatchObject({ code: "chunk_not_in_sources", status: 422 });
  });

  it("keeps citations on resume after schema parse into chat messages", async () => {
    const citation = {
      chunkId: C,
      sourceId: S,
      sourceVersion: 1,
      label: "p.4",
    };
    const { service, conversations } = createService();
    conversations.loadContinuityTurns.mockResolvedValueOnce([
      { role: "user", text: "q", citations: [] },
      { role: "assistant", text: "a", citations: [citation] },
    ]);
    const parsed = conversationResumeSchema.parse(
      await service.resumeConversation(scope, CONVERSATION),
    );
    const { messages } = messagesFromResume(parsed);
    expect(parsed.boundedHistory[1]?.citations).toEqual([citation]);
    expect(messages[1]?.citations).toEqual([citation]);
    expect(messages[1]?.citationLabels).toEqual(["p.4"]);
    expect(messages[0]?.citations).toEqual([]);
  });

  it("restores the last saved selection when refresh supplies no client hints", async () => {
    const { service } = createService();
    expect(await service.resumeConversation(scope, CONVERSATION)).toMatchObject({
      sourceIds: [S], currentPage: 4, chunkId: C,
    });
  });

  it("clears stale saved page and chunk while preserving readable history", async () => {
    const { service, sourceChunks } = createService();
    sourceChunks.listForSources.mockResolvedValueOnce([]);
    expect(await service.resumeConversation(scope, CONVERSATION)).toMatchObject({
      sourceIds: [], currentPage: null, chunkId: null, boundedHistory: [],
    });
  });
  it("revalidates a sticky resume page against source chunks", async () => {
    const { service, sourceChunks } = createService();
    await expect(service.resumeConversation(scope, CONVERSATION, {
      sticky: { sourceIds: [S], currentPage: 4, chunkId: null },
    })).resolves.toMatchObject({ currentPage: 4, sourceIds: [S] });
    expect(sourceChunks.listForSources).toHaveBeenCalledWith(scope, [S]);
  });

  it("maps page selection failures to HTTP 422 codes", () => {
    for (const code of [
      "page_not_in_sources",
      "chunk_not_in_sources",
      "page_chunk_mismatch",
    ] as const) {
      const err = mapPageSelectionToHttp(code);
      expect(err.status).toBe(422);
      expect(err.code).toBe(code);
    }
  });

  it("does not invent a learning session when the caller has not created one", async () => {
    const { service, conversations } = createService();
    await expect(service.submitTurn(scope, {
      conversationId: CONVERSATION,
      text: "explain without a session",
      sourceIds: [],
      mode: "explain",
      clientKey: "client-no-session",
      privacy: "saved",
    })).resolves.toMatchObject({ learningSessionId: null });
    expect(conversations.appendSavedTurn).toHaveBeenCalledWith(
      expect.objectContaining({ learningSessionId: null }),
    );
  });

  it("creates learning sessions only for hint/explain", () => {
    expect(shouldCreateLearningSession("hint")).toBe(true);
    expect(shouldCreateLearningSession("explain")).toBe(true);
    expect(shouldCreateLearningSession("listen")).toBe(false);
    expect(shouldCreateLearningSession("think_together")).toBe(false);
  });

  it("exposureLevelForMode only when delivered", () => {
    expect(exposureLevelForMode("explain", true)).toBe("revealed");
    expect(exposureLevelForMode("hint", true)).toBe("hinted");
    expect(exposureLevelForMode("explain", false)).toBeNull();
    expect(exposureLevelForMode("listen", true)).toBeNull();
  });
});

describe("tutor-service Package B course pool fill", () => {
  it("fills ready course sourceIds when client sends empty and conversation has courseId", async () => {
    const listReady = vi.fn(async () => [S, OTHER_SOURCE]);
    const { service, conversations, sourceChunks, listReadySourceIdsForCourse } = createService({
      courseId: COURSE,
      listReadySourceIdsForCourse: listReady,
    });
    sourceChunks.listForSources.mockResolvedValueOnce([
      { id: C, sourceId: S, sourceVersion: 1, page: 4, slideLabel: null, startMs: null, endMs: null, text: "page four", imageObjectKey: null },
      { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sourceId: OTHER_SOURCE, sourceVersion: 1, page: 9, slideLabel: null, startMs: null, endMs: null, text: "other", imageObjectKey: null },
    ]);
    await expect(service.submitTurn(scope, {
      conversationId: CONVERSATION,
      text: "explain from course pool",
      sourceIds: [],
      mode: "explain",
      clientKey: "course-fill-1",
      privacy: "saved",
    })).resolves.toMatchObject({ jobId: "88888888-8888-4888-8888-888888888888" });
    expect(listReadySourceIdsForCourse).toHaveBeenCalledWith(scope, COURSE);
    expect(sourceChunks.listForSources).toHaveBeenCalledWith(scope, [S, OTHER_SOURCE]);
    expect(conversations.appendSavedTurn).toHaveBeenCalledWith(
      expect.objectContaining({ sourceIds: [S, OTHER_SOURCE] }),
    );
  });

  it("keeps explicit client sourceIds and does not call the course pool helper", async () => {
    const listReady = vi.fn(async () => [OTHER_SOURCE]);
    const { service, conversations, listReadySourceIdsForCourse } = createService({
      courseId: COURSE,
      listReadySourceIdsForCourse: listReady,
    });
    await expect(service.submitTurn(scope, {
      conversationId: CONVERSATION,
      text: "explain selected only",
      sourceIds: [S],
      mode: "explain",
      clientKey: "course-fill-explicit",
      privacy: "saved",
      currentPage: 4,
    })).resolves.toMatchObject({ jobId: "88888888-8888-4888-8888-888888888888" });
    expect(listReadySourceIdsForCourse).not.toHaveBeenCalled();
    expect(conversations.appendSavedTurn).toHaveBeenCalledWith(
      expect.objectContaining({ sourceIds: [S] }),
    );
  });

  it("skips pool helper when courseId is null and client sourceIds are empty", async () => {
    const listReady = vi.fn(async () => [S]);
    const { service, conversations, listReadySourceIdsForCourse } = createService({
      courseId: null,
      listReadySourceIdsForCourse: listReady,
    });
    await expect(service.submitTurn(scope, {
      conversationId: CONVERSATION,
      text: "free chat",
      sourceIds: [],
      mode: "explain",
      clientKey: "course-fill-null",
      privacy: "saved",
    })).resolves.toMatchObject({ learningSessionId: null });
    expect(listReadySourceIdsForCourse).not.toHaveBeenCalled();
    expect(conversations.appendSavedTurn).toHaveBeenCalledWith(
      expect.objectContaining({ sourceIds: [] }),
    );
  });

  it("appends with empty sourceIds when course pool returns [] (no throw)", async () => {
    const listReady = vi.fn(async () => []);
    const { service, conversations, sourceChunks, listReadySourceIdsForCourse } = createService({
      courseId: COURSE,
      listReadySourceIdsForCourse: listReady,
    });
    await expect(service.submitTurn(scope, {
      conversationId: CONVERSATION,
      text: "course with empty pool",
      sourceIds: [],
      mode: "explain",
      clientKey: "course-fill-empty-pool",
      privacy: "saved",
    })).resolves.toMatchObject({ jobId: "88888888-8888-4888-8888-888888888888" });
    expect(listReadySourceIdsForCourse).toHaveBeenCalledWith(scope, COURSE);
    expect(sourceChunks.listForSources).not.toHaveBeenCalled();
    expect(conversations.appendSavedTurn).toHaveBeenCalledWith(
      expect.objectContaining({ sourceIds: [] }),
    );
  });
});
