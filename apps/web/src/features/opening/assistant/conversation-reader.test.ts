import type { ConversationResume, TurnRecord } from "@aistudy/contracts";
import { describe, expect, it, vi } from "vitest";
import type { JobStatusResponse, OpeningApi } from "../client/api";
import { createConversationReader } from "./conversation-reader";

function resume(conversationId: string): ConversationResume {
  return { conversationId, courseId: null, sourceIds: [], boundedHistory: [], historyTruncated: false };
}
function apiFixture() {
  return {
    resumeConversation: vi.fn(async (id: string, _signal?: AbortSignal) => resume(id)),
    listTurns: vi.fn(async (_id: string, _signal?: AbortSignal): Promise<TurnRecord[]> => []),
    getPendingJob: vi.fn(async (_id: string, _signal?: AbortSignal): Promise<JobStatusResponse | null> => null),
  } satisfies Pick<OpeningApi, "resumeConversation" | "listTurns" | "getPendingJob">;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const unknownJob: JobStatusResponse = {
  id: "33333333-3333-4333-8333-333333333333", status: "outcome_unknown",
  error: { message: "timeout" }, updatedAt: "2026-10-17T12:00:00.000Z",
};

describe("conversation recovery reads", () => {
  it("loads resume and turns concurrently, then discovers the active job", async () => {
    const api = apiFixture();
    const delayedResume = deferred<ConversationResume>();
    api.resumeConversation.mockReturnValueOnce(delayedResume.promise);
    const reading = createConversationReader(api).read("first");
    expect(api.listTurns).toHaveBeenCalledOnce();
    expect(api.getPendingJob).not.toHaveBeenCalled();
    delayedResume.resolve(resume("first"));
    await expect(reading).resolves.toEqual({ resume: resume("first"), turns: [], pending: { kind: "ready", job: null } });
  });

  it("discards a late initial read when a submitted turn starts a newer refresh", async () => {
    const api = apiFixture();
    const delayed = deferred<ConversationResume>();
    api.resumeConversation.mockReturnValueOnce(delayed.promise);
    const reader = createConversationReader(api);
    const first = reader.read("same-conversation");
    const firstSignal = api.resumeConversation.mock.calls[0]?.[1];
    await expect(reader.read("same-conversation")).resolves.toMatchObject({ pending: { kind: "ready" } });
    expect(firstSignal?.aborted).toBe(true);
    delayed.resolve(resume("same-conversation"));
    await expect(first).resolves.toBeNull();
    expect(api.getPendingJob).toHaveBeenCalledOnce();
  });

  it("discards reads when the component unmounts or polling becomes hidden", async () => {
    const api = apiFixture();
    const delayed = deferred<ConversationResume>();
    api.resumeConversation.mockReturnValueOnce(delayed.promise);
    const reader = createConversationReader(api);
    const controller = new AbortController();
    const reading = reader.read("first", controller.signal);
    controller.abort();
    expect(api.resumeConversation.mock.calls[0]?.[1]?.aborted).toBe(true);
    delayed.resolve(resume("first"));
    await expect(reading).resolves.toBeNull();
    expect(api.getPendingJob).not.toHaveBeenCalled();

    const next = reader.read("first");
    reader.cancel();
    await expect(next).resolves.toBeNull();
  });

  it("keeps a pending-job outage distinct from a completed conversation", async () => {
    const api = apiFixture();
    const error = new Error("offline");
    api.getPendingJob.mockRejectedValueOnce(error);
    await expect(createConversationReader(api).read("first")).resolves.toMatchObject({
      pending: { kind: "unavailable", error },
    });
  });

  it("refreshes stale pending turns when completion lands before job discovery", async () => {
    const api = apiFixture();
    const pending: TurnRecord = {
      id: "turn-1", conversationId: "first", role: "assistant", text: "", citations: [],
      createdAt: "2026-10-17T12:00:00.000Z", mode: "explain", status: "pending",
    };
    const complete: TurnRecord = { ...pending, status: "complete", text: "完成的回答" };
    api.listTurns.mockResolvedValueOnce([pending]).mockResolvedValueOnce([complete]);
    await expect(createConversationReader(api).read("first")).resolves.toMatchObject({
      turns: [complete], pending: { kind: "ready", job: null },
    });
    expect(api.listTurns).toHaveBeenCalledTimes(2);
  });

  it("confirms unknown outcomes against fresh turns before offering recovery", async () => {
    const api = apiFixture();
    api.getPendingJob.mockResolvedValue(unknownJob);
    await expect(createConversationReader(api).read("first")).resolves.toMatchObject({
      pending: { kind: "ready", job: unknownJob },
    });
    expect(api.listTurns).toHaveBeenCalledTimes(2);
    expect(api.getPendingJob).toHaveBeenCalledTimes(2);
  });

  it("requires another read if a different tab changes the unknown job", async () => {
    const api = apiFixture();
    api.getPendingJob.mockResolvedValueOnce(unknownJob).mockResolvedValueOnce(null);
    await expect(createConversationReader(api).read("first")).resolves.toMatchObject({ pending: { kind: "changed" } });
  });
});
