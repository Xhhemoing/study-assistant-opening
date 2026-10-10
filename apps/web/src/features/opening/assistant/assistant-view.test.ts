import type { ConversationResume, LearningAttempt } from "@aistudy/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendEphemeralResponseIfActive,
  assistantContextHint,
  EMPTY_COURSE_SOURCES_CONFIRM,
  mergeChatMessages,
  createJobPoller,
  jobStatusHint,
  pendingJobDiscoveryState,
  learningAttemptTurnContext,
  canReuseAssistantConversation,
  shouldConfirmEmptyCourseSources,
  shouldRefreshCurrentConversation,
  shouldLoadConversationList,
  conversationForAssistant,
  selectionForResumedConversation,
  presetPromptForMode,
} from "./assistant-view";

const JOB_ID = "33333333-3333-4333-8333-333333333333";
const ISO = "2026-09-13T12:00:00.000Z";

describe("AssistantView pending job discovery", () => {
  it("restores polling state for a discovered queued job", () => {
    expect(pendingJobDiscoveryState({
      ok: true,
      job: { id: JOB_ID, status: "queued", error: null, updatedAt: ISO },
    })).toEqual({
      kind: "active",
      activeJobId: JOB_ID,
      pending: true,
      hint: "回答任务已排队。",
    });
  });

  it("does not create polling state for an empty discovery result", () => {
    expect(pendingJobDiscoveryState({ ok: true, job: null })).toEqual({ kind: "none" });
  });

  it("does not treat a pending-job service failure as no job", () => {
    expect(pendingJobDiscoveryState({
      ok: false,
      error: new Error("database unavailable"),
    })).toEqual({ kind: "unavailable", message: "database unavailable" });
  });

  it("shows a recovered unknown outcome without auto-polling", () => {
    expect(pendingJobDiscoveryState({
      ok: true,
      job: {
        id: JOB_ID,
        status: "outcome_unknown",
        error: { message: "provider timeout" },
        updatedAt: ISO,
      },
    })).toEqual({
      kind: "unknown",
      pending: false,
      hint: "回答结果状态未知：provider timeout。请勿重复提交。",
    });
  });
});

describe("AssistantView ephemeral cancellation", () => {
  it("does not append a late provider response after cancellation", () => {
    const controller = new AbortController();
    controller.abort();
    const current = [{
      id: "existing",
      role: "user" as const,
      text: "之前的问题",
      citations: [],
      citationLabels: [],
    }];

    expect(appendEphemeralResponseIfActive(current, {
      clientKey: "ck-late-response",
      text: "新问题",
      output: { requestId: "req-1", text: "迟到的回答" },
    }, controller.signal)).toBe(current);
  });
});

describe("AssistantView message visibility", () => {
  it("keeps saved history visible while retaining ephemeral tab history", () => {
    const saved = [{ id: "saved", role: "assistant" as const, text: "已保存", citations: [], citationLabels: [] }];
    const ephemeral = [{ id: "ephemeral", role: "user" as const, text: "本标签页", citations: [], citationLabels: [] }];
    expect(mergeChatMessages(saved, ephemeral)).toEqual([...saved, ...ephemeral]);
  });
});

describe("AssistantView context", () => {
  it("allows free conversation without selected materials", () => {
    expect(assistantContextHint([])).toBe("自由交流");
  });

  it("labels selected materials without making them mandatory", () => {
    expect(assistantContextHint(["source-1", "source-2"])).toBe("已选材料：2 份");
  });
});

describe("AssistantView job polling", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["succeeded", "failed", "cancelled", "outcome_unknown"] as const)(
    "stops after terminal status %s and ignores duplicate starts",
    async (status) => {
      vi.useFakeTimers();
      const getJob = vi.fn(async () => ({
        id: JOB_ID,
        status,
        error: status === "failed" || status === "outcome_unknown" ? { message: "provider result" } : null,
        updatedAt: ISO,
      }));
      const onStatus = vi.fn();
      const poller = createJobPoller({ getJob, onStatus, intervalMs: 100 });

      poller.start();
      poller.start();
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();

      expect(getJob).toHaveBeenCalledTimes(1);
      expect(onStatus).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      poller.cancel();
    },
  );

  it("cleans up a scheduled poll when cancelled", async () => {
    vi.useFakeTimers();
    const getJob = vi.fn(async () => ({
      id: JOB_ID,
      status: "running" as const,
      error: null,
      updatedAt: ISO,
    }));
    const poller = createJobPoller({ getJob, onStatus: vi.fn(), intervalMs: 100 });

    poller.start();
    await Promise.resolve();
    await Promise.resolve();
    poller.cancel();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(getJob).toHaveBeenCalledTimes(1);
  });

  it("does not overlap a slow request", async () => {
    vi.useFakeTimers();
    let resolveJob!: () => void;
    const getJob = vi.fn(
      () =>
        new Promise<{
          id: string;
          status: "running";
          error: null;
          updatedAt: string;
        }>((resolve) => {
          resolveJob = () =>
            resolve({ id: JOB_ID, status: "running", error: null, updatedAt: ISO });
        }),
    );
    const poller = createJobPoller({ getJob, onStatus: vi.fn(), intervalMs: 100 });

    poller.start();
    poller.start();
    await vi.advanceTimersByTimeAsync(1_000);
      expect(getJob).toHaveBeenCalledTimes(1);

    resolveJob();
    await Promise.resolve();
    await Promise.resolve();
    poller.cancel();
  });

  it("keeps outcome_unknown distinct from an ordinary failure", () => {
    expect(
      jobStatusHint({
        id: JOB_ID,
        status: "outcome_unknown",
        error: { message: "provider timeout" },
        updatedAt: ISO,
      }),
    ).toContain("请勿重复提交");
    expect(
      jobStatusHint({
        id: JOB_ID,
        status: "failed",
        error: { message: "provider rejected" },
        updatedAt: ISO,
      }),
    ).toContain("失败");
  });
});


it("binds practice help to the server attempt and session rather than the conversation alone", () => {
  const attempt = {
    id: "attempt-1", workspaceId: "workspace-1", sessionId: "session-1", courseId: "course-1", skillLabel: "fractions",
    requirementKey: null, problemId: "problem-1", itemVersionId: "version-1", sourceIds: [], sourceVersions: {},
    startedAt: ISO, submittedAt: null, observationId: null, historyRevision: 1,
  };
  expect(learningAttemptTurnContext(attempt)).toEqual({ learningSessionId: "session-1", attemptId: "attempt-1" });
  expect(learningAttemptTurnContext()).toEqual({});
});

describe("practice conversation recovery", () => {  const courseA = { id: "conversation-a", courseId: "course-a", title: "A", updatedAt: ISO, lastTurnPreview: null };
  const courseB = { id: "conversation-b", courseId: "course-b", title: "B", updatedAt: ISO, lastTurnPreview: null };

  it("skips a newer conversation from another course", () => {
    expect(conversationForAssistant([courseB, courseA], null, "course-a")).toEqual(courseA);
  });

  it("ignores a foreign initial conversation and leaves no reusable id without a course match", () => {
    expect(conversationForAssistant([courseB, courseA], courseB.id, "course-a")).toEqual(courseA);
    expect(conversationForAssistant([courseB], courseB.id, "course-a")).toBeNull();
  });

  it("preserves ordinary assistant recovery and explicit conversation selection", () => {
    expect(conversationForAssistant([courseB, courseA], null)).toEqual(courseB);
    expect(conversationForAssistant([courseB, courseA], courseA.id)).toEqual(courseA);
  });

  it("never replaces attempt sources or page selection with a resumed conversation's selection", () => {
    const resume = { conversationId: courseA.id, courseId: courseA.courseId, sourceIds: ["unrelated-source"], currentPage: 99, boundedHistory: [], historyTruncated: false };
    const attempt = {
      id: "attempt-1", workspaceId: "workspace-1", sessionId: "session-1", courseId: courseA.courseId, skillLabel: "fractions",
      requirementKey: null, problemId: "problem-1", itemVersionId: "version-1", sourceIds: ["attempt-source"], sourceVersions: { "attempt-source": 1 },
      startedAt: ISO, submittedAt: null, observationId: null, historyRevision: 1,
    };
    expect(selectionForResumedConversation(resume, attempt)).toEqual({ sourceIds: ["attempt-source"], currentPage: null });
    expect(selectionForResumedConversation(resume)).toEqual({ sourceIds: ["unrelated-source"], currentPage: 99 });
  });
});

describe("practice conversation isolation", () => {
  it("does not list course conversations for an attempt without an explicit conversation association", () => {
    const attempt = { id: "attempt-1" } as LearningAttempt;
    expect(shouldLoadConversationList(attempt)).toBe(false);
    expect(shouldLoadConversationList()).toBe(true);
  });

  it("reuses the conversation created during the same attempt mount before resume arrives", () => {
    const attempt = { courseId: "course-a" } as LearningAttempt;
    expect(canReuseAssistantConversation("created", attempt, null)).toBe(true);
    expect(canReuseAssistantConversation(null, attempt, null)).toBe(false);
    expect(canReuseAssistantConversation("old", attempt, { courseId: "course-b" } as ConversationResume)).toBe(false);
  });

  it("refreshes the current attempt conversation without listing older course conversations", () => {
    expect(shouldRefreshCurrentConversation({ id: "attempt-1" } as LearningAttempt, "created")).toBe(true);
    expect(shouldRefreshCurrentConversation({ id: "attempt-1" } as LearningAttempt, null)).toBe(false);
    expect(shouldRefreshCurrentConversation(undefined, "created")).toBe(false);
  });
});

it("removes invalidated temporary history when the server isolates it", () => {
  const previous = [{ id: "old", role: "assistant" as const, text: "private old reply", citations: [], citationLabels: [] }];
  const updated = appendEphemeralResponseIfActive(previous, {
    clientKey: "new-question", text: "current question",
    output: { requestId: "new-reply", text: "current answer", historyDiscarded: true },
  }, new AbortController().signal);
  expect(updated.map(message => message.text)).toEqual(["current question", "current answer"]);
  expect(JSON.stringify(updated)).not.toContain("private old reply");
});

it("keeps server provenance on both messages from a temporary response", () => {
  const messages = appendEphemeralResponseIfActive([], {
    clientKey: "current-question", text: "selected source question",
    output: { requestId: "reply", text: "source-backed answer", provenanceId: JOB_ID },
  }, new AbortController().signal);
  expect(messages.map(({ role, origin, provenanceId }) => ({ role, origin, provenanceId }))).toEqual([
    { role: "user", origin: "ephemeral", provenanceId: JOB_ID },
    { role: "assistant", origin: "ephemeral", provenanceId: JOB_ID },
  ]);
});

it("maps ephemeral citations onto the assistant message and marks material context", () => {
  const citation = {
    chunkId: "44444444-4444-4444-8444-444444444444",
    sourceId: "22222222-2222-4222-8222-222222222222",
    sourceVersion: 1,
    label: "p.2",
  };
  const messages = appendEphemeralResponseIfActive([], {
    clientKey: "cite-q",
    text: "用材料解释",
    sourceIds: [citation.sourceId],
    output: { requestId: "cite-a", text: "见第 2 页", provenanceId: JOB_ID, citations: [citation] },
  }, new AbortController().signal);
  expect(messages[1]).toMatchObject({
    role: "assistant",
    citations: [citation],
    citationLabels: ["p.2"],
    hadMaterialContext: true,
  });
});

it("does not invent citations when the service returns none, but still flags material context", () => {
  const sourceId = "22222222-2222-4222-8222-222222222222";
  const messages = appendEphemeralResponseIfActive([], {
    clientKey: "empty-cite",
    text: "选了材料但模型未引用",
    sourceIds: [sourceId],
    output: { requestId: "general", text: "一般说明", citations: [] },
  }, new AbortController().signal);
  expect(messages[1]?.citations).toEqual([]);
  expect(messages[1]?.hadMaterialContext).toBe(true);
});

describe("empty course source soft confirm", () => {
  it("requires confirm when course-bound and no sourceIds", () => {
    expect(shouldConfirmEmptyCourseSources({
      sourceIds: [],
      courseId: "11111111-1111-4111-8111-111111111111",
    })).toBe(true);
    expect(EMPTY_COURSE_SOURCES_CONFIRM).toContain("当前课程有材料，尚未选入本轮");
  });

  it("allows free chat with empty sourceIds", () => {
    expect(shouldConfirmEmptyCourseSources({ sourceIds: [], courseId: null })).toBe(false);
    expect(shouldConfirmEmptyCourseSources({ sourceIds: [], courseId: undefined })).toBe(false);
  });

  it("skips confirm when materials are already selected", () => {
    expect(shouldConfirmEmptyCourseSources({
      sourceIds: ["22222222-2222-4222-8222-222222222222"],
      courseId: "11111111-1111-4111-8111-111111111111",
    })).toBe(false);
  });

  it("also warns when ready membership materials exist without courseId on the conversation", () => {
    expect(shouldConfirmEmptyCourseSources({
      sourceIds: [],
      courseId: null,
      hasReadyCourseMaterials: true,
    })).toBe(true);
  });
});

describe("LAB-U01 chip prefill prompts", () => {
  it("prefills guided with a hint-only prompt and worked_example with a full explanation prompt", () => {
    expect(presetPromptForMode("hint")).toContain("不要直接给完整答案");
    expect(presetPromptForMode("explain")).toContain("完整例题");
  });
});


describe("Package B courseId binding helpers", () => {
  it("reuses only when resume course matches bound query courseId", () => {
    const resume = { courseId: "course-a" } as ConversationResume;
    expect(canReuseAssistantConversation("c1", undefined, resume, "course-a")).toBe(true);
    expect(canReuseAssistantConversation("c1", undefined, resume, "course-b")).toBe(false);
    expect(canReuseAssistantConversation("c1", undefined, null, "course-a")).toBe(true);
  });

  it("filters listed conversations by initialCourseId like attempt course", () => {
    const courseA = { id: "conversation-a", courseId: "course-a", title: "A", updatedAt: ISO, lastTurnPreview: null };
    const courseB = { id: "conversation-b", courseId: "course-b", title: "B", updatedAt: ISO, lastTurnPreview: null };
    expect(conversationForAssistant([courseB, courseA], null, "course-a")).toEqual(courseA);
  });
});
