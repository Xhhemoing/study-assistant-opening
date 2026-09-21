import { describe, expect, it, vi } from "vitest";
import {
  createTutorService,
  exposureLevelForMode,
  mapPageSelectionToHttp,
} from "./tutor-service";
import { shouldCreateLearningSession } from "@aistudy/contracts";

const S = "22222222-2222-4222-8222-222222222222";
const OTHER_SOURCE = "33333333-3333-4333-8333-333333333333";
const C = "44444444-4444-4444-8444-444444444444";
const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const scope = { workspaceId: "55555555-5555-4555-8555-555555555555", ownerUserId: "66666666-6666-4666-8666-666666666666" };

function createService() {
  const conversations = {
    getOwned: vi.fn(async () => ({ id: CONVERSATION, title: "t", courseId: null, updatedAt: "2026-09-20T00:00:00.000Z" })),
    loadContinuityTurns: vi.fn(async () => []),
    appendSavedTurn: vi.fn(async () => ({ turnId: "77777777-7777-4777-8777-777777777777", jobId: "88888888-8888-4888-8888-888888888888", assistantTurnId: "99999999-9999-4999-8999-999999999999" })),
  };
  const sourceChunks = {
    listForSources: vi.fn(async () => [
      { id: C, sourceId: S, sourceVersion: 1, page: 4, slideLabel: null, startMs: null, endMs: null, text: "page four", imageObjectKey: null },
      { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sourceId: OTHER_SOURCE, sourceVersion: 1, page: 9, slideLabel: null, startMs: null, endMs: null, text: "other", imageObjectKey: null },
    ]),
  };
  return { service: createTutorService({ conversations, sourceChunks }), conversations, sourceChunks };
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
