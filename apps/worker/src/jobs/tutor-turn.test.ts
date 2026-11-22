import { describe, expect, it, vi } from "vitest";
import { OpeningProviderError, OpeningModelRoutingError, onFailedResponseUsage, selectContext } from "@aistudy/ai";
import {
  markFallbackStreamSealAttempted, OpeningBudgetError, UnconfirmedStreamSealError,
  type OpeningTutorJobsRepository, type OpeningTutorTimingInput,
} from "@aistudy/database";
import type { ConversationPlanningContext, HelpInputSnapshot, SourceChunk, StudyIntentEvent, TutorMode } from "@aistudy/contracts";
import { PrivacyEpochError } from "../runtime/privacy-guard";
import { composerMessageText, studyIntentForMessage, DEFAULT_STRATEGY_TEMPLATE_ID, PAGE_CITATION_CLARIFY_MESSAGE, PageCitationClarifyError, TUTOR_FAILURE_MESSAGE } from "@aistudy/domain";
import { DEFAULT_SEAL_DEADLINE_MS, TutorStreamExpiredError } from "../runtime/tutor-stream";
import { createTutorTurnHandler, isImageOnlySourceChunks, makeTutorInstruction, VISION_REQUIRED_MESSAGE } from "./tutor-turn";
import type { TutorNextActionService } from "./tutor-next-action";
import { inferComposerIntent } from "@aistudy/domain";

describe("tutor mode policy", () => {
  it("keeps listening distinct from unsolicited planning", () => {
    expect(makeTutorInstruction("listen")).toContain("不要自动创建任务");
  });
  it("makes hints focus on the next step", () => {
    expect(makeTutorInstruction("hint")).toContain("下一步提示");
  });
  it("allows full answers only in explain mode", () => {
    expect(makeTutorInstruction("explain")).toContain("完整答案");
  });
  it("describes collaborative thinking", () => {
    expect(makeTutorInstruction("think_together")).toContain("共同思考");
  });
});

describe("tutor turn handler", () => {
  const chunkA: SourceChunk = { id: "00000000-0000-4000-8000-00000000000a", sourceId: "00000000-0000-4000-8000-000000000001", sourceVersion: 0, page: 1, slideLabel: null, startMs: null, endMs: null, text: "Newton wrote the laws of motion", imageObjectKey: null };
  const chunkB: SourceChunk = { ...chunkA, id: "00000000-0000-4000-8000-00000000000b", page: 2, text: "Einstein refined gravity" };
  const secondSourceId = "00000000-0000-4000-8000-000000000007";
  const chunkC: SourceChunk = { ...chunkA, id: "00000000-0000-4000-8000-00000000000c", sourceId: secondSourceId, text: "Momentum is conserved" };
  const turn = { text: "explain the laws of motion", mode: "explain", sourceIds: [chunkA.sourceId], currentPage: 1, chunkId: chunkA.id, learningSessionId: null as string | null, strategyTemplateId: null as string | null };
  const claimedJob = { id: "00000000-0000-4000-8000-00000000000j", workspaceId: "00000000-0000-4000-8000-000000000002", ownerUserId: "00000000-0000-4000-8000-000000000003", conversationId: "00000000-0000-4000-8000-000000000004", userTurnId: "00000000-0000-4000-8000-000000000005", assistantTurnId: "00000000-0000-4000-8000-000000000006", status: "running" as const, mode: "explain", error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };

  function setup(overrides: { claim?: unknown; chunks?: SourceChunk[]; provider?: unknown; sourceIds?: string[]; sourceVersions?: Record<string, number>; missingSourceIds?: string[] } = {}) {
    const tutorJobs = {
      get: vi.fn(async () => overrides.claim ?? claimedJob),
      withStreamPublication: vi.fn<OpeningTutorJobsRepository["withStreamPublication"]>(async (_scope, _job, _context, publish) => publish()),
      claim: vi.fn(async () => (overrides.claim !== undefined ? overrides.claim : claimedJob)),
      getUserTurn: vi.fn(async () => ({ ...turn, sourceIds: overrides.sourceIds ?? turn.sourceIds, sourceVersions: overrides.sourceVersions ?? { [chunkA.sourceId]: 0 } })),
      readAttemptContext: vi.fn(async () => ({ privacyEpoch: 0, anchor: { purpose: "learning_help" as const, attemptId: claimedJob.userTurnId, itemVersionId: claimedJob.conversationId },
        originalQuestion: "saved question", originalAnswer: null, currentAnswer: null, rootObservationId: null, headObservationId: null,
        workSource: null, effectiveGrading: null, sourceRefs: [] })),
      assertAttemptContext: vi.fn(async () => {}),
      loadHistoryContext: vi.fn(async () => ({ history: [{ role: "user" as const, text: "yesterday" }, { role: "assistant" as const, text: "step two" }], sourceRefs: [] as Array<{ sourceId: string; sourceVersion: number }> })),
      completeTurn: vi.fn(async () => undefined),
      canAppendCompletedTurnCandidates: vi.fn(async () => true),
      appendCompletedTurnCandidates: vi.fn(async () => true),
      loadReplayedTurn: vi.fn(async (_scope: unknown, _ref: string): Promise<{ id: string; status: string; text: string } | null> => null),
      completeFromReplay: vi.fn(async () => false),
      fail: vi.fn(async () => undefined),
      claimExecution: async () => true, markUnknown: vi.fn(async () => undefined),
    };
    const chunks = {
      listForSources: vi.fn(async () => overrides.chunks ?? [chunkA, chunkB]),
      listChunksAtVersion: vi.fn(async (_scope, sourceId) => overrides.missingSourceIds?.includes(sourceId)
        ? []
        : overrides.chunks ?? (sourceId === secondSourceId ? [chunkC] : [chunkA, chunkB])),
    };
    const budget = {
      reserve: vi.fn(async (): Promise<{ id: string; state?: string; resultRef?: string | null }> => ({ id: "res-1" })),
      release: vi.fn(async () => ({})),
      settle: vi.fn(async () => ({})),
      claimExecution: vi.fn(async () => true), markUnknown: vi.fn(async () => ({})),
    };
    const provider = { complete: vi.fn(overrides.provider ?? (async () => ({ text: "F = ma", citedChunkIds: [chunkA.id], requestId: null, candidates: [{ kind: "memory", text: "Learner asked about Newton", temporary: false }], inputTokens: 100, outputTokens: 50 }))) };
    // Unit adapter only; real admission and pin persistence are covered by purpose PG.
    const retrieveContext = vi.fn(async (_scope, input) => ({ chunks: selectContext(input), mode: "lexical" as const, purposePin: { courseId: null, materialUse: "citation" as const, sources: [] }, assertCurrent: async () => {} }));
    const deps = { tutorJobs, chunks, budget, provider, retrieveContext, config: { maxContextCharacters: 5000, reservedCents: 100, maxOutputTokens: 2048, inputCentsPerMillion: 100, outputCentsPerMillion: 200 } };
    const freezeHelpInputSnapshot = vi.fn(async (): Promise<HelpInputSnapshot> => {
      const selected = jobs.getUserTurn.mock.results.at(-1)?.value;
      const saved = await selected as typeof turn & { studyIntent?: StudyIntentEvent };
      const claimed = await jobs.claim.mock.results.at(-1)?.value as typeof claimedJob;
      return { userTurnId: claimedJob.userTurnId, assistantTurnId: claimedJob.assistantTurnId, tutorMode: claimed.mode as TutorMode,
        studyIntent: studyIntentForMessage(saved?.studyIntent, composerMessageText(saved?.text ?? turn.text)) };
    });
    const jobs = { ...tutorJobs, freezeHelpInputSnapshot };
    return { deps: { ...deps, tutorJobs: jobs }, tutorJobs: jobs, chunks, budget, provider };
  }

  it("passes the persisted course and server-selected use, retaining the original pre-send assertion", async () => {
    const { deps, tutorJobs, provider } = setup();
    const assertCurrent = vi.fn(async () => {});
    const purposePin = { courseId: claimedJob.conversationId, materialUse: "citation" as const, sources: [] };
    const retrieveContext = vi.fn(async (_scope, input) => ({ chunks: input.chunks, mode: "lexical" as const, purposePin, assertCurrent }));
    tutorJobs.getUserTurn.mockResolvedValueOnce({ ...turn, courseId: claimedJob.conversationId, sourceVersions: { [chunkA.sourceId]: 0 } });
    await createTutorTurnHandler({ ...deps, retrieveContext })(claimedJob.id);
    expect(retrieveContext).toHaveBeenCalledWith({ workspaceId: claimedJob.workspaceId, ownerUserId: claimedJob.ownerUserId },
      expect.objectContaining({ courseContext: { courseId: claimedJob.conversationId, materialUse: "citation" }, sourceIds: [chunkA.sourceId] }));
    expect(assertCurrent).toHaveBeenCalledTimes(4);
    expect(tutorJobs.completeTurn).toHaveBeenCalledWith(expect.anything(), { materialPurposePin: purposePin });
    expect(provider.complete).toHaveBeenCalledOnce();
  });

  it("blocks the real provider send after the captured admission changes without retrying retrieval", async () => {
    const { deps, provider, tutorJobs } = setup();
    const assertCurrent = vi.fn(async () => { throw Object.assign(new Error("purpose changed"), { code: "CONFLICT" }); });
    const retrieveContext = vi.fn(async (_scope, input) => ({ chunks: input.chunks, mode: "lexical" as const,
      purposePin: { courseId: null, materialUse: "citation" as const, sources: [] }, assertCurrent }));
    await expect(createTutorTurnHandler({ ...deps, retrieveContext })(claimedJob.id)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(retrieveContext).toHaveBeenCalledOnce();
    expect(provider.complete).not.toHaveBeenCalled();
    expect(tutorJobs.completeTurn).not.toHaveBeenCalled();
  });

  it("fails closed rather than using the old lexical path when material admission is absent", async () => {
    const { deps, provider } = setup();
    await expect(createTutorTurnHandler({ ...deps, retrieveContext: undefined })(claimedJob.id)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it.each(["继续学习", "继续", "下一步", "再来一道题", "带我继续学", "我们继续吧", "开始学习", "从哪里开始", "出一道题"])("opens a real course-scoped span action for %s before the proposal/model path", async text => {
    const { deps, tutorJobs, provider, budget } = setup();
    const courseId = claimedJob.conversationId;
    tutorJobs.getUserTurn.mockResolvedValueOnce({ ...turn, ...inferComposerIntent({ text }), text, courseId, sourceVersions: { [chunkA.sourceId]: 0 } });
    const nextAction: TutorNextActionService = {
      read: async () => ({ courseId, privacyEpoch: 0, sourceRefs: [{ sourceId: chunkA.sourceId, sourceVersion: 0 }],
        decisionInput: { status: "unobserved", observations: [], wantsFullExplanation: false } }),
      assertCurrent: async () => {},
      execute: async (_scope, input) => {
        expect(input.decision.activityKind).toBe("diagnose");
        expect(input.operationId).toBe(`tutor-next:${claimedJob.userTurnId}`);
        return { activityId: "actual-activity", sessionId: "actual-session", href: `/opening/courses/${courseId}/study/span?activity=actual-activity` };
      },
    };
    await createTutorTurnHandler({ ...deps, nextAction })(claimedJob.id);
    expect(tutorJobs.completeTurn).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining(`/study/span?activity=actual-activity`), candidates: [],
      contextSourceRefs: [{ sourceId: chunkA.sourceId, sourceVersion: 0 }], expectedPrivacyEpoch: 0,
    }));
    expect(provider.complete).not.toHaveBeenCalled();
    expect(budget.reserve).not.toHaveBeenCalled();
  });

  it.each([null, "course-without-grant"].flatMap(courseId =>
    ["继续", "下一步", "我们继续", "继续学习"].map(text => ({ courseId, text })),
  ))("continues an actual assistant answer through model history: $courseId / $text", async ({ courseId, text }) => {
    const { deps, tutorJobs, provider } = setup();
    const history = [
      { role: "user" as const, text: "解释牛顿第二定律，并举个例子" },
      { role: "assistant" as const, text: "牛顿第二定律是 F = ma，接下来可以用一个例子说明。" },
    ];
    tutorJobs.loadHistoryContext.mockResolvedValue({ history, sourceRefs: [{ sourceId: chunkA.sourceId, sourceVersion: 0 }] });
    tutorJobs.getUserTurn.mockResolvedValueOnce({ ...turn, ...inferComposerIntent({ text }), text, courseId,
      sourceVersions: { [chunkA.sourceId]: 0 } });
    const read = vi.fn(async () => null), reply = vi.fn();
    await createTutorTurnHandler({ ...deps,
      nextAction: { read, assertCurrent: vi.fn(), execute: vi.fn() }, proposals: { reply },
    })(claimedJob.id);
    expect(provider.complete).toHaveBeenCalledOnce();
    expect(provider.complete.mock.calls[0][0]).toMatchObject({ history, text });
    expect(tutorJobs.completeTurn.mock.calls.map(call => call[0])).toContainEqual(expect.objectContaining({
      text: "F = ma", contextSourceRefs: [{ sourceId: chunkA.sourceId, sourceVersion: 0 }],
    }));
    expect(tutorJobs.loadHistoryContext).toHaveBeenCalledTimes(1);
    expect(reply).not.toHaveBeenCalled();
  });

  it.each([null, "course-without-grant"])("keeps repeated continuations after its own course entry reply deterministic: %s", async courseId => {
    const { deps, tutorJobs, provider, budget } = setup();
    const text = "继续学习";
    const history: Array<{ role: "user" | "assistant"; text: string }> = [];
    tutorJobs.loadHistoryContext.mockImplementation(async () => ({ history: [...history], sourceRefs: [] }));
    tutorJobs.getUserTurn.mockResolvedValue({ ...turn, ...inferComposerIntent({ text }), text, courseId, sourceVersions: {} });
    const reply = vi.fn();
    const handler = createTutorTurnHandler({ ...deps,
      nextAction: { read: async () => null, assertCurrent: vi.fn(), execute: vi.fn() }, proposals: { reply },
    });
    for (let index = 0; index < 3; index++) {
      await handler(claimedJob.id);
      const completed = tutorJobs.completeTurn.mock.calls[index][0];
      expect(completed).toMatchObject({ text: courseId
        ? `当前课程尚未开启导师试用，或不在 span 导师范围内。请到课程学习页继续。\n\n[打开课程学习](/opening/courses/${courseId}/study)`
        : "请先选择一门课程，再开始学习或创建教学计划。\n\n[先选择一门课程](/opening/courses)", candidates: [] });
      // loadTutorHistoryContext returns completed user/assistant exchanges, including fixed replies.
      history.push({ role: "user", text }, { role: "assistant", text: completed.text });
    }
    expect(tutorJobs.completeTurn).toHaveBeenCalledTimes(3);
    expect(provider.complete).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    expect(budget.reserve).not.toHaveBeenCalled();
    expect(budget.settle).not.toHaveBeenCalled();
  });

  it("preserves continuation after a completed teaching proposal draft", async () => {
    const { deps, tutorJobs, provider } = setup();
    const history = [
      { role: "user" as const, text: "请帮我创建课程" },
      { role: "assistant" as const, text: "已准备教学活动草稿。请在提案卡中核对并明确接受；当前尚未应用。这不是掌握结论。" },
    ];
    const text = "继续学习";
    tutorJobs.loadHistoryContext.mockResolvedValue({ history, sourceRefs: [] });
    tutorJobs.getUserTurn.mockResolvedValueOnce({ ...turn, ...inferComposerIntent({ text }), text,
      courseId: "course-without-grant", sourceVersions: { [chunkA.sourceId]: 0 } });
    const reply = vi.fn();
    await createTutorTurnHandler({ ...deps,
      nextAction: { read: async () => null, assertCurrent: vi.fn(), execute: vi.fn() }, proposals: { reply },
    })(claimedJob.id);
    expect(provider.complete).toHaveBeenCalledOnce();
    expect(provider.complete.mock.calls[0][0]).toMatchObject({ history, text });
    expect(reply).not.toHaveBeenCalled();
  });

  it.each(["继续学习", "继续", "下一步", "再来一道题", "带我继续学", "我们继续吧", "开始学习", "从哪里开始", "出一道题"])("returns a course link without model or proposals when %s is unavailable", async text => {
    const { deps, tutorJobs, provider, budget } = setup();
    tutorJobs.loadHistoryContext.mockResolvedValue({ history: [], sourceRefs: [] });
    const courseId = claimedJob.conversationId;
    tutorJobs.getUserTurn.mockResolvedValueOnce({ ...turn, ...inferComposerIntent({ text }), text, courseId, sourceVersions: {} });
    const reply = vi.fn();
    await createTutorTurnHandler({ ...deps, privacy: { getWorkspaceEpoch: async () => 7 },
      nextAction: { read: async () => null, assertCurrent: vi.fn(), execute: vi.fn() }, proposals: { reply },
    })(claimedJob.id);
    expect(tutorJobs.completeTurn).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining(`[打开课程学习](/opening/courses/${courseId}/study)`), expectedPrivacyEpoch: 7, candidates: [] }));
    expect(reply).not.toHaveBeenCalled();
    expect(provider.complete).not.toHaveBeenCalled();
    expect(budget.reserve).not.toHaveBeenCalled();
  });

  it.each(["带我学习", "继续学习", "创建一节 span 课", "安排计划"])("asks for a course without a model for %s", async text => {
    const { deps, tutorJobs, provider, budget } = setup();
    if (text === "继续学习") tutorJobs.loadHistoryContext.mockResolvedValue({ history: [], sourceRefs: [] });
    tutorJobs.getUserTurn.mockResolvedValueOnce({ ...turn, ...inferComposerIntent({ text }), text, sourceVersions: {} });
    const reply = vi.fn();
    await createTutorTurnHandler({ ...deps, proposals: { reply } })(claimedJob.id);
    expect(tutorJobs.completeTurn).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("先选择一门课程"), candidates: [] }));
    expect(tutorJobs.completeTurn.mock.calls[0][0].text).toContain("/opening/courses");
    expect(provider.complete).not.toHaveBeenCalled();
    expect(budget.reserve).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });

  it("keeps an unbound practice starter in ordinary question answering", async () => {
    const { deps, tutorJobs, provider } = setup();
    tutorJobs.getUserTurn.mockResolvedValueOnce({ ...turn, ...inferComposerIntent({ text: "出一道题", purpose: "answer" }), text: "出一道题", sourceIds: [], sourceVersions: {} });
    await createTutorTurnHandler(deps)(claimedJob.id);
    expect(provider.complete).toHaveBeenCalledOnce();
  });

  it("keeps a bound concept explanation out of next-action and proposals", async () => {
    const { deps, tutorJobs, provider } = setup();
    const text = "我想理解一个概念。请先问我已经知道什么，再一步步解释。";
    tutorJobs.getUserTurn.mockResolvedValueOnce({ ...turn, ...inferComposerIntent({ text, purpose: "answer" }), text,
      courseId: claimedJob.conversationId, sourceVersions: { [chunkA.sourceId]: 0 } });
    const read = vi.fn(), reply = vi.fn();
    await createTutorTurnHandler({ ...deps, nextAction: { read, assertCurrent: vi.fn(), execute: vi.fn() }, proposals: { reply } })(claimedJob.id);
    expect(read).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    expect(provider.complete).toHaveBeenCalledOnce();
  });

  it.each(["创建一节 span 课", "创建课程", "请帮我创建课程", "可以替我创建课程", "create a course", "安排计划"])("preserves explicit proposals for %s with a bound course", async text => {
    const { deps, tutorJobs } = setup();
    tutorJobs.getUserTurn.mockResolvedValueOnce({ ...turn, ...inferComposerIntent({ text }), text, courseId: claimedJob.conversationId, sourceVersions: {} });
    const read = vi.fn(), reply = vi.fn(async () => ({ text: "教学草稿", proposal: {}, privacyEpoch: 0, contextSourceRefs: [] }));
    await createTutorTurnHandler({ ...deps, nextAction: { read, assertCurrent: vi.fn(), execute: vi.fn() }, proposals: { reply } })(claimedJob.id);
    expect(read).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledOnce();
  });

  it("rejects the prepared action when authorization changes before publication", async () => {
    const { deps, tutorJobs } = setup();
    tutorJobs.getUserTurn.mockResolvedValueOnce({ ...turn, purpose: "teach", courseId: claimedJob.conversationId, sourceVersions: { [chunkA.sourceId]: 0 } });
    let checks = 0;
    const nextAction: TutorNextActionService = {
      read: async () => ({ courseId: claimedJob.conversationId, privacyEpoch: 0, sourceRefs: [],
        decisionInput: { status: "unobserved", observations: [], wantsFullExplanation: false } }),
      assertCurrent: async () => { if (++checks === 2) throw new Error("grant disabled"); },
      execute: async () => ({ activityId: "activity", sessionId: "session", href: "/opening/courses/course/study/span" }),
    };
    await expect(createTutorTurnHandler({ ...deps, nextAction })(claimedJob.id)).rejects.toThrow("grant disabled");
    expect(tutorJobs.completeTurn).not.toHaveBeenCalled();
    expect(tutorJobs.fail).toHaveBeenCalled();
  });

  it("preserves the proposal path when the course has no eligible tutor grant", async () => {
    const { deps, tutorJobs, provider } = setup();
    tutorJobs.getUserTurn.mockResolvedValueOnce({ ...turn, purpose: "teach", courseId: claimedJob.conversationId, sourceVersions: { [chunkA.sourceId]: 0 } });
    await createTutorTurnHandler({ ...deps,
      nextAction: { read: async () => null, assertCurrent: async () => { throw new Error("ineligible"); }, execute: async () => { throw new Error("ineligible"); } },
      proposals: { reply: async () => ({ text: "待确认的原教学建议", proposal: {}, privacyEpoch: 0, contextSourceRefs: [] }) },
    })(claimedJob.id);
    expect(tutorJobs.completeTurn).toHaveBeenCalledWith(expect.objectContaining({ text: "待确认的原教学建议" }));
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it("keeps an attempt-bound teaching question in the original help delivery path", async () => {
    const { deps, tutorJobs, provider } = setup();
    tutorJobs.getUserTurn.mockResolvedValueOnce({ ...turn, purpose: "teach", courseId: claimedJob.conversationId, attemptId: chunkA.id,
      contextAnchor: { courseId: claimedJob.conversationId, activityId: claimedJob.conversationId, purpose: "learning_help" }, sourceVersions: { [chunkA.sourceId]: 0 } });
    await createTutorTurnHandler({ ...deps,
      nextAction: { read: async () => { throw new Error("must not replace an active attempt"); }, assertCurrent: async () => {}, execute: async () => { throw new Error("must not execute"); } },
    })(claimedJob.id);
    expect(tutorJobs.completeTurn.mock.calls.map(call => call[0])).toContainEqual(expect.objectContaining({ text: "F = ma" }));
    expect(provider.complete).toHaveBeenCalledOnce();
  });

  it("batches 200 rapid 50-byte deltas into 35 authorized appends with no text loss", async () => {
    vi.useFakeTimers();
    try {
      const { deps, provider, tutorJobs } = setup();
      const assertCurrent = vi.fn(async () => {});
      const purposePin = { courseId: claimedJob.conversationId, materialUse: "citation" as const, sources: [{
        sourceId: chunkA.sourceId, sourceVersion: 0, membershipId: claimedJob.userTurnId,
        purposeRevision: "2026-11-20T00:00:00.000000Z", purpose: "teaching" as const,
      }] };
      const retrieveContext: typeof deps.retrieveContext = async (...args) =>
        ({ ...await deps.retrieveContext(...args), purposePin, assertCurrent });
      const stream = { begin: vi.fn(async () => {}), append: vi.fn(async (_workspace: string, _job: string, _text: string) => {}) };
      const deltas = Array.from({ length: 200 }, (_, index) => String(index).padStart(50, "0"));
      const text = deltas.join("");
      provider.complete.mockImplementationOnce(async (_input, _signal, delta) => {
        const beforeStreaming = tutorJobs.withStreamPublication.mock.calls.length;
        await delta("");
        expect(stream.append).not.toHaveBeenCalled();
        await delta(deltas[0]);
        expect(stream.append.mock.calls.map(call => call[2])).toEqual([deltas[0]]);
        expect(tutorJobs.withStreamPublication.mock.calls.length - beforeStreaming).toBe(1);
        for (const part of deltas.slice(1)) await delta(part);
        expect(tutorJobs.withStreamPublication.mock.calls.length - beforeStreaming).toBe(stream.append.mock.calls.length);
        return { text, citedChunkIds: [], candidates: [], requestId: null, inputTokens: 10, outputTokens: 10 };
      });
      await createTutorTurnHandler({ ...deps, stream, retrieveContext })(claimedJob.id);
      expect(Buffer.byteLength(text)).toBe(10_000);
      expect(stream.begin).toHaveBeenCalledWith(claimedJob.workspaceId, claimedJob.id,
        expect.objectContaining({ materialPurposePin: purposePin }));
      expect(stream.append).toHaveBeenCalledTimes(35);
      expect(stream.append.mock.calls.map(call => call[2]).join("")).toBe(text);
      expect(tutorJobs.withStreamPublication).toHaveBeenCalledTimes(36);
      for (const [, , publicationContext] of tutorJobs.withStreamPublication.mock.calls) {
        expect(publicationContext.materialPurposePin).toEqual(purposePin);
      }
      // Stream publication checks material admission inside withStreamPublication; only the four non-publication checks call assertCurrent.
      expect(assertCurrent).toHaveBeenCalledTimes(4);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("flushes at 40ms from the first buffered delta even though the provider is paused", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
    try {
      const { deps, provider } = setup();
      const stream = { begin: async () => {}, append: vi.fn(async (_workspace: string, _job: string, _text: string) => {}) };
      provider.complete.mockImplementationOnce(async (_input, _signal, delta) => {
        await delta("First");
        await delta(" second");
        await new Promise(resolve => setTimeout(resolve, 20));
        await delta(" third");
        await new Promise(resolve => setTimeout(resolve, 80));
        return { text: "First second third", citedChunkIds: [], candidates: [], requestId: null, inputTokens: 10, outputTokens: 10 };
      });
      const run = createTutorTurnHandler({ ...deps, stream })(claimedJob.id);
      await vi.advanceTimersByTimeAsync(39);
      expect(stream.append.mock.calls.map(call => call[2])).toEqual(["First"]);
      await vi.advanceTimersByTimeAsync(1);
      expect(stream.append.mock.calls.map(call => call[2])).toEqual(["First", " second third"]);
      await vi.advanceTimersByTimeAsync(60);
      await run;
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("uses UTF-8 bytes for the size threshold", async () => {
    const { deps, provider } = setup();
    const stream = { begin: async () => {}, append: vi.fn(async (_workspace: string, _job: string, _text: string) => {}) };
    const part = "学".repeat(43);
    provider.complete.mockImplementationOnce(async (_input, _signal, delta) => {
      await delta("First");
      await delta(part);
      expect(stream.append).toHaveBeenCalledTimes(1);
      await delta(part);
      expect(stream.append.mock.calls.map(call => call[2])).toEqual(["First", part + part]);
      return { text: "First" + part + part, citedChunkIds: [], candidates: [], requestId: null, inputTokens: 10, outputTokens: 10 };
    });
    await createTutorTurnHandler({ ...deps, stream })(claimedJob.id);
  });

  it.each(["material", "privacy", "claim"] as const)("aborts a paused provider on %s drift and drops the pending batch", async fence => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
    try {
      const { deps, provider, tutorJobs, budget } = setup();
      const drift = new Error("source revoked");
      let revoked = false;
      const purposePin = { courseId: claimedJob.conversationId, materialUse: "citation" as const, sources: [{
        sourceId: chunkA.sourceId, sourceVersion: 0, membershipId: claimedJob.userTurnId,
        purposeRevision: "2026-11-20T00:00:00.000000Z", purpose: "teaching" as const,
      }] };
      const retrieveContext: typeof deps.retrieveContext = async (...args) => ({
        ...await deps.retrieveContext(...args),
        purposePin,
        assertCurrent: async () => { if (revoked && fence === "material") throw drift; },
      });
      const privacy = {
        getWorkspaceEpoch: async () => revoked && fence === "privacy" ? 1 : 0,
        listExcludedSourceIds: async () => [],
      };
      tutorJobs.withStreamPublication.mockImplementation(async (_scope, _job, context, publish) => {
        expect(context.materialPurposePin).toEqual(purposePin);
        if (revoked && fence === "material") throw drift;
        if (revoked && fence === "claim") throw Object.assign(new Error("claim changed"), { code: "CONFLICT" });
        if (revoked && fence === "privacy") throw new PrivacyEpochError("privacy changed");
        await publish();
      });
      const stream = { begin: async () => {}, append: vi.fn(async (_workspace: string, _job: string, _text: string) => {}) };
      const providerAborted = vi.fn();
      provider.complete.mockImplementationOnce(async (_input, signal, delta) => {
        await delta("First");
        await delta(" never publish");
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => { providerAborted(); reject(signal.reason); }, { once: true });
        });
      });
      const run = createTutorTurnHandler({ ...deps, stream, retrieveContext, privacy })(claimedJob.id);
      const result = run.catch(error => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(stream.append.mock.calls.map(call => call[2])).toEqual(["First"]);
      revoked = true;
      await vi.advanceTimersByTimeAsync(40);
      expect(providerAborted).toHaveBeenCalledOnce();
      const error = await result;
      if (fence === "material") expect(error).toBe(drift);
      else if (fence === "privacy") expect(error).toBeInstanceOf(PrivacyEpochError);
      else expect(error).toMatchObject({ code: "CONFLICT" });
      expect(tutorJobs.fail).toHaveBeenCalledOnce();
      expect(tutorJobs.completeTurn).not.toHaveBeenCalled();
      expect(budget.markUnknown).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(100);
      expect(vi.getTimerCount()).toBe(0);
      expect(stream.append.mock.calls.map(call => call[2])).toEqual(["First"]);
    } finally { vi.useRealTimers(); }
  });

  it("propagates a publication claim rejection before reserving tutor budget", async () => {
    const { deps, tutorJobs, budget, provider } = setup();
    const cancelled = Object.assign(new Error("tutor job cancelled"), { code: "CONFLICT" });
    tutorJobs.withStreamPublication.mockRejectedValueOnce(cancelled);
    const stream = { begin: vi.fn(), append: vi.fn() };

    await expect(createTutorTurnHandler({ ...deps, stream })(claimedJob.id)).rejects.toBe(cancelled);
    expect(stream.begin).not.toHaveBeenCalled();
    expect(budget.reserve).not.toHaveBeenCalled();
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it.each([new TypeError("invalid stream context"), Object.assign(new Error("stream forbidden"), { code: "FORBIDDEN" })])(
    "propagates an unexpected stream begin error before reserving budget: %s", async failure => {
      const { deps, budget, provider } = setup();
      const stream = { begin: vi.fn().mockRejectedValue(failure), append: vi.fn() };
      const onStreamUnavailable = vi.fn();
      await expect(createTutorTurnHandler({ ...deps, stream, onStreamUnavailable })(claimedJob.id)).rejects.toBe(failure);
      expect(onStreamUnavailable).not.toHaveBeenCalled();
      expect(budget.reserve).not.toHaveBeenCalled();
      expect(provider.complete).not.toHaveBeenCalled();
    });

  it.each(["without streaming", "after Redis begin fails"])("rechecks an unbound claim before sending %s", async mode => {
    const { deps, tutorJobs, budget, provider } = setup();
    const stream = mode === "after Redis begin fails"
      ? { begin: vi.fn().mockRejectedValue(new Error("Command timed out")), append: vi.fn() }
      : undefined;
    budget.claimExecution.mockImplementationOnce(async () => {
      tutorJobs.get.mockResolvedValue({ ...claimedJob, status: "cancelled" });
      return true;
    });

    await expect(createTutorTurnHandler({ ...deps, stream })(claimedJob.id)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(budget.release).toHaveBeenCalledWith(expect.anything(), `tutor:${claimedJob.id}`, "not_sent");
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it("settles confirmed provider usage when cancellation blocks only the final buffered batch", async () => {
    const { deps, provider, tutorJobs, budget } = setup();
    const cancelled = Object.assign(new Error("tutor job cancelled"), { code: "CONFLICT" });
    const stream = { begin: async () => {}, append: vi.fn(async (_workspace: string, _job: string, _text: string) => 1) };
    tutorJobs.withStreamPublication.mockImplementationOnce(async (_scope, _job, _context, publish) => publish())
      .mockImplementationOnce(async (_scope, _job, _context, publish) => publish())
      .mockRejectedValueOnce(cancelled);
    provider.complete.mockImplementationOnce(async (_input, _signal, delta) => {
      await delta("First");
      await delta(" tail");
      expect(stream.append).toHaveBeenCalledOnce();
      return { text: "First tail", citedChunkIds: [], candidates: [], requestId: null, inputTokens: 10, outputTokens: 10 };
    });

    await expect(createTutorTurnHandler({ ...deps, stream })(claimedJob.id)).rejects.toBe(cancelled);

    expect(stream.append.mock.calls.map(call => call[2])).toEqual(["First"]);
    expect(budget.settle).toHaveBeenCalledOnce();
    expect(budget.markUnknown).not.toHaveBeenCalled();
    expect(tutorJobs.completeTurn).not.toHaveBeenCalled();
  });

  it("drains a timer flush racing provider completion before settling or completing the turn", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
    try {
      const { deps, provider, tutorJobs, budget } = setup();
      let authorize!: () => void;
      const authorization = new Promise<void>(resolve => { authorize = resolve; });
      let hold = false;
      tutorJobs.withStreamPublication.mockImplementation(async (_scope, _job, _context, publish) => {
        if (hold) await authorization;
        await publish();
      });
      const stream = { begin: async () => {}, append: vi.fn(async (_workspace: string, _job: string, _text: string) => {}) };
      provider.complete.mockImplementationOnce(async (_input, _signal, delta) => {
        await delta("First");
        hold = true;
        await delta(" tail");
        await new Promise(resolve => setTimeout(resolve, 41));
        return { text: "First tail", citedChunkIds: [], candidates: [], requestId: null, inputTokens: 10, outputTokens: 10 };
      });
      const run = createTutorTurnHandler({ ...deps, stream })(claimedJob.id);
      await vi.advanceTimersByTimeAsync(40);
      expect(tutorJobs.withStreamPublication).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(budget.settle).not.toHaveBeenCalled();
      expect(tutorJobs.completeTurn).not.toHaveBeenCalled();
      expect(stream.append.mock.calls.map(call => call[2])).toEqual(["First"]);
      authorize();
      await run;
      expect(stream.append.mock.calls.map(call => call[2])).toEqual(["First", " tail"]);
      expect(tutorJobs.completeTurn).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("flushes authorized trailing text before recording a provider error and ignores late callbacks", async () => {
    const { deps, provider, tutorJobs } = setup();
    const stream = { begin: async () => {}, append: vi.fn(async (_workspace: string, _job: string, _text: string) => {}) };
    const interrupted = new Error("provider closed prematurely");
    let late!: (text: string) => Promise<void>;
    provider.complete.mockImplementationOnce(async (_input, _signal, delta) => {
      late = delta;
      await delta("First");
      await delta(" tail");
      expect(stream.append.mock.calls.map(call => call[2])).toEqual(["First"]);
      throw interrupted;
    });
    tutorJobs.fail.mockImplementationOnce(async () => {
      expect(stream.append.mock.calls.map(call => call[2])).toEqual(["First", " tail"]);
    });
    await expect(createTutorTurnHandler({ ...deps, stream })(claimedJob.id)).rejects.toBe(interrupted);
    await late(" after close");
    expect(stream.append.mock.calls.map(call => call[2])).toEqual(["First", " tail"]);
    expect(tutorJobs.completeTurn).not.toHaveBeenCalled();
  });


  it("records one model/Redis observation per execution without blocking first publication", async () => {
    vi.useFakeTimers();
    try {
    const executionId = "10000000-0000-4000-8000-000000000001", claimToken = "10000000-0000-4000-8000-000000000002";
    const { deps, provider, tutorJobs } = setup({ claim: { ...claimedJob, executionId, claimToken } });
    let finish!: () => void;
    const waiting = new Promise<void>(resolve => { finish = resolve; });
    const record = vi.fn((_scope: unknown, _input: OpeningTutorTimingInput) => waiting), unavailable = vi.fn();
    let sequence = 0;
    const stream = { begin: vi.fn(async () => {}), append: vi.fn(async (_workspace: string, _job: string, _text: string, _execution?: string) => ++sequence) };
    provider.complete.mockImplementationOnce(async (_input, _signal, delta) => {
      await delta(""); await delta("First"); await delta(" text");
      return { text: "First text", citedChunkIds: [], candidates: [], requestId: null, inputTokens: 10, outputTokens: 10 };
    });
    const run = createTutorTurnHandler({ ...deps, stream, timing: { record }, onTimingUnavailable: unavailable })(claimedJob.id);
    await vi.advanceTimersByTimeAsync(0);
    expect(stream.append).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(99);
    expect(tutorJobs.completeTurn).not.toHaveBeenCalled();
    expect(record.mock.calls.map(call => call[1].kind)).toEqual(["tutor_first_text", "tutor_first_chunk"]);
    expect(record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ executionId, claimToken, observedAt: expect.any(Date), durationMs: expect.any(Number) }));
    expect(stream.append.mock.calls[0]).toEqual([claimedJob.workspaceId, claimedJob.id, "First", executionId, 0, undefined]);
    finish(); await run;
    expect(provider.complete).toHaveBeenCalledOnce(); expect(unavailable).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it.each([false, true])("bounds permanently pending timing writes before the business terminal (failure=%s)", async failure => {
    vi.useFakeTimers();
    try {
      const { deps, provider, tutorJobs } = setup({ claim: { ...claimedJob, executionId: "10000000-0000-4000-8000-000000000001", claimToken: "claim" } });
      const businessError = new Error("provider interrupted"), unavailable = vi.fn();
      provider.complete.mockImplementationOnce(async (_input, _signal, delta) => {
        await delta("Answer");
        if (failure) throw businessError;
        return { text: "Answer", citedChunkIds: [], candidates: [], requestId: null, inputTokens: 10, outputTokens: 10 };
      });
      const run = createTutorTurnHandler({ ...deps, stream: { begin: async () => {}, append: async () => 1 },
        timing: { record: () => new Promise(() => {}) }, onTimingUnavailable: unavailable })(claimedJob.id);
      const settled = vi.fn();
      const result = run.then(value => { settled(); return value; }, error => { settled(); return error; });
      await vi.advanceTimersByTimeAsync(99);
      expect(tutorJobs.completeTurn).not.toHaveBeenCalled(); expect(tutorJobs.fail).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toHaveBeenCalledOnce();
      expect(unavailable).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: expect.stringContaining("timing") }));
      if (failure) { expect(await result).toBe(businessError); expect(tutorJobs.fail).toHaveBeenCalledOnce(); }
      else { expect(await result).toEqual({ skipped: false }); expect(tutorJobs.completeTurn).toHaveBeenCalledOnce(); }
      expect(provider.complete).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it.each([0, "failure"])("does not claim Redis publication for %s", async result => {
    const { deps, provider } = setup({ claim: { ...claimedJob, executionId: "10000000-0000-4000-8000-000000000001", claimToken: "claim" } });
    const record = vi.fn(async (_scope: unknown, _input: OpeningTutorTimingInput) => {});
    const stream = { begin: vi.fn(async () => {}), append: vi.fn(async () => { if (result === "failure") throw new Error("redis unavailable"); return 0; }) };
    provider.complete.mockImplementationOnce(async (_input, _signal, delta) => {
      await delta("Answer"); return { text: "Answer", citedChunkIds: [], candidates: [], requestId: null, inputTokens: 10, outputTokens: 10 };
    });
    await createTutorTurnHandler({ ...deps, stream, timing: { record }, onStreamUnavailable: vi.fn() })(claimedJob.id);
    expect(record.mock.calls.map(call => call[1].kind)).toEqual(["tutor_first_text"]);
  });

  it("reports timing persistence failures without changing the successful answer or resending", async () => {
    const { deps, provider, tutorJobs } = setup({ claim: { ...claimedJob, executionId: "10000000-0000-4000-8000-000000000001", claimToken: "claim" } });
    const error = new Error("timing write failed"), unavailable = vi.fn();
    provider.complete.mockImplementationOnce(async (_input, _signal, delta) => {
      await delta("Answer"); return { text: "Answer", citedChunkIds: [], candidates: [], requestId: null, inputTokens: 10, outputTokens: 10 };
    });
    await createTutorTurnHandler({ ...deps, stream: { begin: async () => {}, append: async () => 1 }, timing: { record: async () => { throw error; } }, onTimingUnavailable: unavailable })(claimedJob.id);
    expect(unavailable).toHaveBeenCalledWith(error); expect(provider.complete).toHaveBeenCalledOnce();
    expect(tutorJobs.completeTurn).toHaveBeenCalledOnce(); expect(tutorJobs.fail).not.toHaveBeenCalled();
  });

  it.each([
    ["这题答案是什么", "hint", "两个简短的起步方向"],
    ["我算出来 x=2，对吗", "hint", "第一个出错步骤"],
    ["完全不会，好烦", "listen", "换一道简单题"],
    ["跳过这道题", "listen", "不要声称已修改学习记录"],
  ])("carries the learning response for %s into the actual provider call", async (text, mode, instruction) => {
    const { deps, tutorJobs, provider } = setup({ claim: { ...claimedJob, mode } });
    tutorJobs.getUserTurn.mockResolvedValue({ ...turn, text, mode, sourceIds: [], sourceVersions: {} });
    await createTutorTurnHandler(deps)(claimedJob.id);
    expect(provider.complete).toHaveBeenCalledOnce();
    expect(provider.complete.mock.calls[0]![0]).toMatchObject({ mode, instruction: expect.stringContaining(instruction) });
  });

  it("publishes actual Markdown deltas, settles the answer, and returns with optional metadata queued separately", async () => {
    const { deps, tutorJobs, budget, provider } = setup();
    const stream = { begin: vi.fn(async () => {}), append: vi.fn(async () => {}) };
    provider.complete.mockImplementationOnce(async (input, _signal, onTextDelta) => {
      expect(input.outputFormat).toBe("markdown");
      expect(tutorJobs.completeTurn).not.toHaveBeenCalled();
      await onTextDelta("F = ");
      await onTextDelta("ma [1]");
      expect(stream.append.mock.calls.map(call => call[2])).toEqual(["F = "]);
      return { text: "F = ma [1]", citedChunkIds: [], requestId: null, candidates: [], inputTokens: 100, outputTokens: 50 };
    });
    tutorJobs.completeTurn.mockImplementationOnce(async () => {
      expect(budget.settle).toHaveBeenCalledOnce();
      expect(stream.append.mock.calls.map(call => call[2])).toEqual(["F = ", "ma [1]"]);
    });
    await createTutorTurnHandler({ ...deps, stream })(claimedJob.id);
    expect(tutorJobs.completeTurn.mock.calls.map(call => call[0])).toContainEqual(expect.objectContaining({
      text: "F = ma [1]", citations: [expect.objectContaining({ chunkId: chunkA.id })], candidates: [], enqueueMetadata: true,
    }));
    expect(provider.complete).toHaveBeenCalledOnce();
    expect(budget.reserve.mock.calls.map(call => call[1].requestId)).toEqual([`tutor:${claimedJob.id}`]);
    expect(tutorJobs.markUnknown).not.toHaveBeenCalled();
    expect(tutorJobs.fail).not.toHaveBeenCalled();
    expect(tutorJobs.appendCompletedTurnCandidates).not.toHaveBeenCalled();
  });

  it("does not enqueue another metadata extraction for legacy structured answers", async () => {
    const { deps, tutorJobs } = setup();
    await createTutorTurnHandler(deps)(claimedJob.id);
    expect(tutorJobs.completeTurn.mock.calls.map(call => call[0])).toContainEqual(expect.objectContaining({
      enqueueMetadata: false, candidates: [expect.objectContaining({ payload: expect.objectContaining({ kind: "memory" }) })],
    }));
  });

  it("generates one inert help receipt before streaming and reuses it at durable completion", async () => {
    const { deps, tutorJobs, provider } = setup();
    const anchor = { purpose: "learning_help" as const, attemptId: chunkA.id };
    tutorJobs.getUserTurn.mockResolvedValueOnce({ ...turn, learningSessionId: claimedJob.conversationId,
      sourceVersions: { [chunkA.sourceId]: 0 }, contextAnchor: anchor });
    const stream = { begin: vi.fn(async () => {}), append: vi.fn(async () => {}) };
    const streamExposures = { generate: vi.fn(async () => ({ id: chunkB.id })) };
    provider.complete.mockImplementationOnce(async (_input, _signal, onTextDelta) => {
      expect(streamExposures.generate).toHaveBeenCalledOnce();
      expect(stream.begin).toHaveBeenCalledWith(claimedJob.workspaceId, claimedJob.id, expect.objectContaining({ exposureReceiptId: chunkB.id }));
      await onTextDelta("提示");
      return { text: "提示", citedChunkIds: [], candidates: [], requestId: null, inputTokens: 10, outputTokens: 10 };
    });
    await createTutorTurnHandler({ ...deps, stream, streamExposures })(claimedJob.id);
    const generated = streamExposures.generate.mock.calls[0][1];
    expect(generated).toMatchObject({ hintStage: null, initiatedBy: "user" });
    expect(tutorJobs.getUserTurn).toHaveBeenCalledWith(claimedJob.userTurnId, claimedJob.workspaceId, claimedJob.id);
    expect(tutorJobs.completeTurn.mock.calls.map(call => call[0])).toContainEqual(expect.objectContaining({ generatedExposure: generated }));
    expect(tutorJobs.completeTurn.mock.calls[0][0]).not.toHaveProperty("helpExposure");
  });

  it("keeps ordinary session listening free of item-help exposure", async () => {
    const { deps, tutorJobs } = setup({ claim: { ...claimedJob, mode: "listen" } });
    tutorJobs.getUserTurn.mockResolvedValueOnce({ ...turn, mode: "listen", learningSessionId: claimedJob.conversationId,
      sourceVersions: { [chunkA.sourceId]: 0 } });
    const stream = { begin: vi.fn(async () => {}), append: vi.fn(async () => {}) };
    const streamExposures = { generate: vi.fn(async () => ({ id: chunkB.id })) };
    await createTutorTurnHandler({ ...deps, stream, streamExposures })(claimedJob.id);
    expect(streamExposures.generate).not.toHaveBeenCalled();
    expect(tutorJobs.completeTurn.mock.calls[0][0]).not.toHaveProperty("generatedExposure");
  });

  it("continues saving a completed answer when the temporary Redis stream is unavailable", async () => {
    const { deps, tutorJobs, provider } = setup();
    const stream = { begin: vi.fn(async () => {}), append: vi.fn(async () => { throw new Error("Redis offline"); }) };
    const onStreamUnavailable = vi.fn();
    provider.complete.mockImplementationOnce(async (_input, _signal, onTextDelta) => {
      await onTextDelta("first"); await onTextDelta(" second");
      return { text: "first second", citedChunkIds: [], candidates: [], requestId: null, inputTokens: 10, outputTokens: 10 };
    });
    await createTutorTurnHandler({ ...deps, stream, onStreamUnavailable })(claimedJob.id);
    expect(stream.append).toHaveBeenCalledOnce();
    expect(onStreamUnavailable).toHaveBeenCalledOnce();
    expect(tutorJobs.completeTurn.mock.calls.map(call => call[0])).toContainEqual(expect.objectContaining({ text: "first second" }));
  });

  it.each(["hint", "explain", "listen", "think_together"])("generates a context-only receipt in %s mode without claiming delivery", async mode => {
    const { deps, tutorJobs } = setup({ claim: { ...claimedJob, mode } });
    const selected = { ...turn, mode, sourceVersions: { [chunkA.sourceId]: 0 },
      contextAnchor: { purpose: "material_read" as const, sourceId: chunkA.sourceId, sourceVersion: 0, chunkId: chunkA.id, page: 1 } };
    tutorJobs.getUserTurn.mockResolvedValueOnce(selected);
    await createTutorTurnHandler(deps)(claimedJob.id);
    expect(tutorJobs.completeTurn.mock.calls.map(call => call[0])).toContainEqual(expect.objectContaining({
      generatedExposure: expect.objectContaining({ releaseKey: `assistant:${claimedJob.assistantTurnId}`, contextAnchor: selected.contextAnchor,
        origin: "assistant", kind: mode === "explain" ? "solution" : "hint" }),
    }));
    expect(tutorJobs.completeTurn.mock.calls[0]?.[0]).not.toHaveProperty("helpExposure");
  });

  it("serves deterministic language help without sending a model request", async () => {
    const { deps, tutorJobs, provider, budget } = setup();
    const selected = { ...turn, sourceVersions: { [chunkA.sourceId]: 0 }, languageSupportQuestion: "判断 u 是否属于 span{v,w}。",
      contextAnchor: { purpose: "language_support" as const, sourceId: chunkA.sourceId, sourceVersion: 0 } };
    tutorJobs.getUserTurn.mockResolvedValueOnce(selected);
    await createTutorTurnHandler(deps)(claimedJob.id);
    expect(provider.complete).not.toHaveBeenCalled();
    expect(budget.reserve).not.toHaveBeenCalled();
    expect(tutorJobs.completeTurn).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining(selected.languageSupportQuestion),
      generatedExposure: expect.objectContaining({ supportDomain: "language", kind: "hint" }) }));
  });

  it("applies the server session's latest explicit presentation preferences to the actual model input", async () => {
    const { deps, tutorJobs, provider } = setup();
    const studyIntent: StudyIntentEvent = { id: chunkA.id, sessionId: claimedJob.conversationId, activityId: claimedJob.conversationId, attemptId: null,
      version: 3, change: { kind: "explicit_request", text: "用英文，只给关键步骤，每步等我" }, signals: [], action: "continue", createdAt: "2026-10-19T00:00:00.000Z",
      intent: { purpose: "review", timeBudgetMinutes: 10, language: "en", pace: "fast", continuous: false, selfReportedFatigue: "unknown", explanationStyle: "key_steps" } };
    const selected = { ...turn, sourceVersions: { [chunkA.sourceId]: 0 }, studyIntent };
    tutorJobs.getUserTurn.mockResolvedValueOnce(selected);
    await createTutorTurnHandler(deps)(claimedJob.id);
    const input = provider.complete.mock.calls[0]?.[0];
    expect(input.instruction).toContain("Use English");
    expect(input.instruction).toContain("只给关键步骤");
    expect(input.instruction).toContain("每次一小步后停下");
    expect(input.instruction.indexOf("本轮已确认的会话呈现偏好")).toBeGreaterThan(input.instruction.indexOf("完整答案"));
  });

  it("uses the lease-checked typed intent result before constructing the provider instruction", async () => {
    const { deps, tutorJobs, provider } = setup();
    const freezeHelpInputSnapshot = vi.fn(async (): Promise<HelpInputSnapshot> => ({ userTurnId: claimedJob.userTurnId, assistantTurnId: claimedJob.assistantTurnId, tutorMode: "hint",
      studyIntent: { intent: { purpose: "confused", timeBudgetMinutes: 10,
      language: "zh", pace: "slow", continuous: false, selfReportedFatigue: "unknown" }, action: "diagnose" } }));
    await createTutorTurnHandler({ ...deps, tutorJobs: { ...tutorJobs, freezeHelpInputSnapshot } })(claimedJob.id);
    expect(freezeHelpInputSnapshot).toHaveBeenCalledWith({ workspaceId: claimedJob.workspaceId, ownerUserId: claimedJob.ownerUserId },
      { userTurnId: claimedJob.userTurnId, jobId: claimedJob.id, claimToken: undefined });
    expect(provider.complete.mock.calls[0]?.[0].instruction).toContain("放慢节奏");
    expect(provider.complete.mock.calls[0]?.[0].instruction).toContain("先定位不懂之处");
    expect(provider.complete.mock.calls[0]?.[0].mode).toBe("hint");
  });

  it("applies the actual request's style without treating carried material as an instruction", async () => {
    const { deps, tutorJobs, provider } = setup();
    tutorJobs.getUserTurn.mockResolvedValueOnce({ ...turn, sourceVersions: { [chunkA.sourceId]: 0 },
      text: "【从学习界面带入的提问背景；尚未作为资料证据核验，也不表示我已掌握】\n用中文，完整讲解\n\n我的问题：\n用英文，只给关键步骤" });
    await createTutorTurnHandler(deps)(claimedJob.id);
    const input = provider.complete.mock.calls[0]?.[0];
    expect(input.instruction).toContain("Use English");
    expect(input.instruction).toContain("只给关键步骤");
  });

  it.each(["query", "explain_state", "plan", "language_support"] as const)("does not parse %s content as a learning intent mutation", async purpose => {
    const { deps, tutorJobs } = setup();
    const applyUserTurnIntent = vi.fn(async () => null);
    tutorJobs.getUserTurn.mockResolvedValueOnce({ ...turn, text: "为什么刚才快速串讲", sourceVersions: { [chunkA.sourceId]: 0 },
      ...(purpose === "language_support" ? { contextAnchor: { purpose } } : { purpose }) });
    const authorization = { purpose: "system_record_lookup" as const, workspaceId: claimedJob.workspaceId,
      principalId: claimedJob.ownerUserId, role: "workspace_owner" as const, permissionRevision: "owner-fixture" };
    await createTutorTurnHandler({ ...deps, tutorJobs: { ...tutorJobs, applyUserTurnIntent },
      systemQuery: { enabled: () => true, reply: async () => ({ text: "Read-only reply", contextSourceRefs: [], privacyEpoch: 0,
        receipt: { authorization, version: "study-query-v1", asOf: "2026-10-19T00:00:00Z", privacyEpoch: 0,
          mode: "deterministic", status: "unknown", reason: "no record", results: [] } }) },
      proposals: { reply: async () => ({ text: "Draft only", proposal: {}, privacyEpoch: 0, contextSourceRefs: [] }) },
    })(claimedJob.id);
    expect(applyUserTurnIntent).not.toHaveBeenCalled();
  });

  // These doubles represent a claim already granted by the repository. They
  // cover the defensive settled-ledger branch, not a public retry/requeue API.
  it("reads a completed resultRef only after an authorized claim, without sending or settling again", async () => {
    const claimToken = "00000000-0000-4000-8000-000000000008";
    const { deps, tutorJobs, budget, provider } = setup({ claim: { ...claimedJob, claimToken } });
    const resultRef = `opening_turn:${claimedJob.assistantTurnId}`;
    budget.reserve.mockResolvedValueOnce({ id: "res-1", state: "completed", resultRef });
    tutorJobs.loadReplayedTurn.mockResolvedValueOnce({ id: claimedJob.assistantTurnId, status: "complete", text: "persisted answer" });
    tutorJobs.completeFromReplay.mockResolvedValueOnce(true);

    await expect(createTutorTurnHandler(deps)(claimedJob.id)).resolves.toEqual({ skipped: false, replayed: true });

    expect(tutorJobs.loadReplayedTurn).toHaveBeenCalledWith({ workspaceId: claimedJob.workspaceId, ownerUserId: claimedJob.ownerUserId }, resultRef);
    expect(tutorJobs.completeFromReplay).toHaveBeenCalledWith(expect.anything(), claimedJob.id, claimedJob.assistantTurnId, claimToken);
    expect(provider.complete).not.toHaveBeenCalled();
    expect(budget.settle).not.toHaveBeenCalled();
    expect(budget.release).not.toHaveBeenCalled();
    expect(tutorJobs.completeTurn).not.toHaveBeenCalled();
    expect(tutorJobs.markUnknown).not.toHaveBeenCalled();
  });

  it("marks an authorized claim unknown when its settled resultRef has no complete persisted answer", async () => {
    const claimToken = "00000000-0000-4000-8000-000000000008";
    const { deps, tutorJobs, budget, provider } = setup({ claim: { ...claimedJob, claimToken } });
    budget.reserve.mockResolvedValueOnce({ id: "res-1", state: "completed", resultRef: `opening_turn:${claimedJob.assistantTurnId}` });
    tutorJobs.loadReplayedTurn.mockResolvedValueOnce({ id: claimedJob.assistantTurnId, status: "pending", text: "" });

    await expect(createTutorTurnHandler(deps)(claimedJob.id)).resolves.toEqual({ skipped: false, replayed: true });

    expect(tutorJobs.markUnknown).toHaveBeenCalledWith(expect.anything(), claimedJob.id, expect.stringContaining("not re-sending"), claimToken);
    expect(tutorJobs.completeFromReplay).not.toHaveBeenCalled();
    expect(provider.complete).not.toHaveBeenCalled();
    expect(budget.settle).not.toHaveBeenCalled();
    expect(budget.release).not.toHaveBeenCalled();
    expect(tutorJobs.completeTurn).not.toHaveBeenCalled();
  });

  it("injects current course mistakes, preserves their provenance, and checks freshness before sending", async () => {
    const { deps, provider, tutorJobs } = setup();
    const context = { courseId: claimedJob.conversationId, title: "力学", asOf: "2026-10-21T00:00:00Z", privacyEpoch: 0,
      goal: { description: "期末", targetDate: "2026-10-31", weeklyMinutes: 420 }, weaknesses: [],
      goalPreferenceProfile: { version: 1 as const, goal: { source: "legacy" as const, revision: null, lifecycle: "unknown" as const,
        definition: { targetDate: null, weeklyMinutes: 75, learningMode: "understand" as const } },
      learningPreferences: { account: {}, course: { assessmentEnabled: false }, effective: {
        assessmentEnabled: false, retestSuggestionsEnabled: false, automaticRemindersEnabled: false, autoGradeOnSave: true,
      } } },
      recentMistakes: [{ observationId: chunkA.id, skillLabel: "合力", feedback: "先确定受力方向", unmetCriteria: ["方向"], assistance: "independent" as const }],
      observationIds: [chunkA.id], sourceRefs: [{ sourceId: secondSourceId, sourceVersion: 0 }] };
    tutorJobs.getUserTurn.mockResolvedValueOnce({ ...turn, courseId: context.courseId, sourceVersions: { [chunkA.sourceId]: 0 } });
    const read = vi.fn(async () => context), assertCurrent = vi.fn(async () => {});
    await createTutorTurnHandler({ ...deps, learnerContext: { read, assertCurrent } })(claimedJob.id);
    expect(read).toHaveBeenCalledWith(expect.anything(), { courseId: context.courseId, sourceIds: [chunkA.sourceId] });
    expect(assertCurrent).toHaveBeenCalledWith(expect.anything(), context);
    expect(provider.complete.mock.calls[0]![0].instruction).toContain("先确定受力方向");
    expect(provider.complete.mock.calls[0]![0].instruction).toContain('"weeklyMinutes":75');
    expect(provider.complete.mock.calls[0]![0].instruction).toContain('"course":{"assessmentEnabled":false}');
    expect(tutorJobs.completeTurn.mock.calls.map(call => call[0])).toContainEqual(expect.objectContaining({ contextSourceRefs: expect.arrayContaining(context.sourceRefs) }));
    const blocked = setup();
    await expect(createTutorTurnHandler({ ...blocked.deps, learnerContext: { read, assertCurrent: async () => { throw new Error("context changed"); } } })(claimedJob.id)).rejects.toThrow("context changed");
    expect(blocked.provider.complete).not.toHaveBeenCalled();
    expect(blocked.budget.release).toHaveBeenCalled();
  });

  it("adds a bounded owned planning summary to the same budgeted tutor request", async () => {
    const { deps, provider, budget } = setup();
    const context: ConversationPlanningContext = { version: "conversation-planning-v1", asOf: "2026-10-16T10:00:00.000Z",
      date: "2026-10-16", timeZone: "UTC", settings: "configured", acceptedVersion: 1,
      courses: [{ alias: "c1", name: "矩阵" }], tasks: [], acceptedSlots: [], hardSlots: [],
      learning: { status: "available", windowDays: 14, counts: { observations: 0, independentVerifiedCurrent: 0, unknownQualification: 0 } }, truncated: false };
    const read = vi.fn(async () => context);
    await createTutorTurnHandler({ ...deps, planningContext: { read } })(claimedJob.id);
    expect(read).toHaveBeenCalledWith({ workspaceId: claimedJob.workspaceId, ownerUserId: claimedJob.ownerUserId }, expect.any(Date));
    expect(provider.complete.mock.calls[0]![0].instruction).toContain("<planning_context>");
    expect(provider.complete.mock.calls[0]![0].instruction).toContain("矩阵");
    expect(budget.reserve).toHaveBeenCalledTimes(1); expect(provider.complete).toHaveBeenCalledTimes(1);
  });

  it("continues ordinary conversation with an explicit unavailable summary after an optional read failure", async () => {
    const { deps, provider, tutorJobs } = setup();
    await createTutorTurnHandler({ ...deps, planningContext: { read: vi.fn(async () => { throw new Error("read failed"); }) } })(claimedJob.id);
    expect(provider.complete.mock.calls[0]![0].instruction).toContain("当前学习与计划摘要暂时不可用");
    expect(provider.complete.mock.calls[0]![0].instruction).not.toContain('"tasks":[]');
    expect(tutorJobs.completeTurn).toHaveBeenCalled(); expect(tutorJobs.fail).not.toHaveBeenCalled();
  });

  it("passes authorized version-pinned page images to a visual model and keeps citations", async () => {
    const { deps, provider, tutorJobs } = setup();
    const image = { mediaType: "image/png" as const, data: "data:image/png;base64,aGVsbG8=", sourceId: chunkA.sourceId, physicalPage: 1 };
    const pageImages = vi.fn(async () => [image]);
    await createTutorTurnHandler({ ...deps, resolveModel: async () => ({ provider, supportsVision: true, modelSnapshot: { id: "visual", providerId: "p", modelName: "v", mediaInputTokenUpperBound: 8192, mediaMaxInputBytes: 1048576, mediaInputCentsPerMillion: 100, inputCentsPerMillion: 100, outputCentsPerMillion: 200 }, inputCentsPerMillion: 100, outputCentsPerMillion: 200 }), pageImages })(claimedJob.id);
    expect(pageImages).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: claimedJob.workspaceId }), expect.objectContaining({ sourceIds: [chunkA.sourceId], sourceVersions: { [chunkA.sourceId]: 0 }, physicalPage: 1 }));
    expect(provider.complete.mock.calls[0]![0]).toMatchObject({ mediaCapability: "text_plus_page_images", imageParts: [image] });
    expect(tutorJobs.completeTurn).toHaveBeenCalled();
  });

  it("rejects image-only sources when the model cannot see images without reserving budget", async () => {
    const imageChunk: SourceChunk = { ...chunkA, text: "", imageObjectKey: "sources/photo.png" };
    const { deps, provider, budget, tutorJobs } = setup({ chunks: [imageChunk] });
    const resolveModel = vi.fn(async () => ({
      provider, supportsVision: false,
      modelSnapshot: { id: "text", providerId: "p", modelName: "t", inputCentsPerMillion: 100, outputCentsPerMillion: 200 },
      inputCentsPerMillion: 100, outputCentsPerMillion: 200,
    }));
    await expect(createTutorTurnHandler({ ...deps, resolveModel })(claimedJob.id)).rejects.toThrow(VISION_REQUIRED_MESSAGE);
    expect(provider.complete).not.toHaveBeenCalled();
    expect(budget.reserve).not.toHaveBeenCalled();
    expect(tutorJobs.fail).toHaveBeenCalledWith(expect.anything(), claimedJob.id, VISION_REQUIRED_MESSAGE, { code: "VISION_INPUT_REQUIRED" }, undefined);
  });

  it("attaches page 1 for image-only sources on a vision model even without currentPage", async () => {
    const imageChunk: SourceChunk = { ...chunkA, text: "", imageObjectKey: "sources/photo.png" };
    const { deps, provider, tutorJobs } = setup({ chunks: [imageChunk] });
    tutorJobs.getUserTurn = vi.fn(async () => ({ ...turn, currentPage: null, sourceVersions: { [chunkA.sourceId]: 0 } }));
    const image = { mediaType: "image/png" as const, data: "data:image/png;base64,aGVsbG8=", sourceId: chunkA.sourceId, physicalPage: 1 };
    const pageImages = vi.fn(async () => [image]);
    await createTutorTurnHandler({
      ...deps,
      resolveModel: async () => ({
        provider, supportsVision: true,
        modelSnapshot: { id: "visual", providerId: "p", modelName: "v", mediaInputTokenUpperBound: 8192, mediaMaxInputBytes: 1048576, mediaInputCentsPerMillion: 100, inputCentsPerMillion: 100, outputCentsPerMillion: 200 },
        inputCentsPerMillion: 100, outputCentsPerMillion: 200,
      }),
      pageImages,
    })(claimedJob.id);
    expect(pageImages).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ physicalPage: 1 }));
    expect(provider.complete.mock.calls[0]![0]).toMatchObject({ mediaCapability: "text_plus_page_images", imageParts: [image] });
    expect(tutorJobs.completeTurn).toHaveBeenCalled();
  });

  it("isImageOnlySourceChunks requires image keys and empty text", () => {
    expect(isImageOnlySourceChunks([])).toBe(false);
    expect(isImageOnlySourceChunks([chunkA])).toBe(false);
    expect(isImageOnlySourceChunks([{ ...chunkA, text: "", imageObjectKey: "k" }])).toBe(true);
    expect(isImageOnlySourceChunks([{ ...chunkA, text: "  ", imageObjectKey: "k" }])).toBe(true);
    expect(isImageOnlySourceChunks([{ ...chunkA, text: "caption", imageObjectKey: "k" }])).toBe(false);
  });

    it("uses one resolved model for provider dispatch, prices and ledger attribution", async () => {
    const { deps, provider, budget } = setup();
    const selectedProvider = { complete: vi.fn(async () => ({ text: "selected answer", citedChunkIds: [chunkA.id], candidates: [], requestId: "selected-request", inputTokens: 100, outputTokens: 50 })) };
    const modelSnapshot = { id: "selected", providerId: "other", modelName: "other-model", inputCentsPerMillion: 10_000, outputCentsPerMillion: 20_000 };
    const resolveModel = vi.fn(async () => ({ provider: selectedProvider, modelSnapshot, ...modelSnapshot }));
    await createTutorTurnHandler({ ...deps, resolveModel })(claimedJob.id);
    expect(resolveModel).toHaveBeenCalledWith({ workspaceId: claimedJob.workspaceId, ownerUserId: claimedJob.ownerUserId }, "explain");
    expect(selectedProvider.complete).toHaveBeenCalledOnce();
    expect(provider.complete).not.toHaveBeenCalled();
    expect(budget.reserve).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ requestId: `tutor:${claimedJob.id}`, modelSnapshot }));
    expect(budget.settle).toHaveBeenCalledWith(expect.anything(), "res-1", 2, { resultRef: `opening_turn:${claimedJob.assistantTurnId}` });
  });

  it("BC1: the same tutor operation keeps one unknown reservation and never re-sends", async () => {
    // Fake ledger mirrors opening-budget idempotency by requestId (operationId key).
    const reservations: { requestId: string; id: string; state: "reserved"; outcomeUnknownAt: Date | null }[] = [];
    const budget = {
      reserve: vi.fn(async (_scope: unknown, input: { requestId: string }) => {
        const hit = reservations.find((r) => r.requestId === input.requestId);
        if (hit) return hit;
        const id = `res-${reservations.length + 1}`;
        const fresh = { requestId: input.requestId, id, state: "reserved" as const, outcomeUnknownAt: null };
        reservations.push(fresh);
        return fresh;
      }),
      release: vi.fn(async () => ({})),
      settle: vi.fn(async () => ({})),
      claimExecution: async () => true,
      markUnknown: vi.fn(async (_scope: unknown, reservationId: string) => {
        const reservation = reservations.find((r) => r.id === reservationId)!;
        reservation.outcomeUnknownAt = new Date();
        return {};
      }),
    };
    const { deps, tutorJobs } = setup({
      provider: async () => {
        throw new OpeningProviderError("PROVIDER_UNAVAILABLE", "down", true);
      },
    });
    deps.budget = budget;
    await expect(createTutorTurnHandler(deps)(claimedJob.id)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(budget.markUnknown).toHaveBeenCalledWith(expect.anything(), "res-1");
    expect(budget.reserve).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ requestId: `tutor:${claimedJob.id}` }),
    );
    // Even if a claim double grants another invocation, the real ledger's
    // unknown disposition must block a second send under the same key.
    tutorJobs.claim.mockResolvedValueOnce(claimedJob);
    budget.settle.mockClear();
    const okProvider = { complete: vi.fn(async () => ({ text: "retry ok", citedChunkIds: [chunkA.id], requestId: null, candidates: [], inputTokens: 10, outputTokens: 5 })) };
    deps.provider = okProvider;
    await expect(createTutorTurnHandler(deps)(claimedJob.id)).rejects.toMatchObject({ code: "BUDGET_OUTCOME_UNKNOWN" });
    expect(reservations).toHaveLength(1);
    expect(reservations[0]!.requestId).toBe(`tutor:${claimedJob.id}`);
    expect(budget.settle).not.toHaveBeenCalled();
    expect(budget.release).not.toHaveBeenCalled();
    expect(okProvider.complete).not.toHaveBeenCalled();
  });

  it("routes a page-citation Clarify refusal to fail(..., {code, nextAction}) (LAB-A01/U01)", async () => {
    const { deps, provider, budget, tutorJobs } = setup();
    const resolveModel = vi.fn(async () => { throw new PageCitationClarifyError(); });
    await expect(createTutorTurnHandler({ ...deps, resolveModel })(claimedJob.id)).rejects.toBeInstanceOf(PageCitationClarifyError);
    expect(provider.complete).not.toHaveBeenCalled();
    expect(budget.reserve).not.toHaveBeenCalled();
    expect(tutorJobs.fail).toHaveBeenCalledWith(expect.anything(), claimedJob.id, PAGE_CITATION_CLARIFY_MESSAGE, {
      code: "page_not_in_sources",
      nextAction: "clarify",
    }, undefined);
    expect(tutorJobs.markUnknown).not.toHaveBeenCalled();
  });

  it("does not dispatch or reserve when route resolution fails", async () => {
    const { deps, provider, budget, tutorJobs } = setup();
    const resolveModel = vi.fn(async () => { throw new Error("selected model removed"); });
    await expect(createTutorTurnHandler({ ...deps, resolveModel })(claimedJob.id)).rejects.toThrow("selected model removed");
    expect(provider.complete).not.toHaveBeenCalled();
    expect(budget.reserve).not.toHaveBeenCalled();
    expect(tutorJobs.fail).toHaveBeenCalledWith(expect.anything(), claimedJob.id, TUTOR_FAILURE_MESSAGE, undefined, undefined);
  });
  it.each([new Error("SQL SELECT secret FROM private /server/file"), Object.assign(new Error("secret"), { code: "BUDGET_EXCEEDED" })])("does not persist unknown exception text or trust an arbitrary error code", async error => {
    const { deps, tutorJobs, provider } = setup();
    const resolveModel = vi.fn(async () => { throw error; });
    await expect(createTutorTurnHandler({ ...deps, resolveModel })(claimedJob.id)).rejects.toBe(error);
    expect(tutorJobs.fail).toHaveBeenCalledWith(expect.anything(), claimedJob.id, TUTOR_FAILURE_MESSAGE, undefined, undefined);
    expect(provider.complete).not.toHaveBeenCalled();
  });
  it.each([
    [new OpeningBudgetError("BUDGET_EXCEEDED", "private diagnostic"), "BUDGET_EXCEEDED", "预算"],
    [new OpeningBudgetError("REQUEST_CAP_EXCEEDED", "private diagnostic"), "REQUEST_CAP_EXCEEDED", "请求次数"],
    [new OpeningModelRoutingError("private diagnostic"), "AI_ROUTE_UNAVAILABLE", "设置"],
  ] as const)("retains a controlled actionable failure by code", async (error, code, copy) => {
    const { deps, tutorJobs } = setup();
    const resolveModel = vi.fn(async () => { throw error; });
    await expect(createTutorTurnHandler({ ...deps, resolveModel })(claimedJob.id)).rejects.toBe(error);
    expect(tutorJobs.fail).toHaveBeenCalledWith(expect.anything(), claimedJob.id, expect.stringContaining(copy), { code }, undefined);
    expect(tutorJobs.fail.mock.calls[0]?.[2]).not.toContain("private diagnostic");
  });
  it("completes the turn once with program-assigned candidate provenance", async () => {
    const { deps, tutorJobs, budget, provider } = setup();
    const result = await createTutorTurnHandler(deps)(claimedJob.id);
    expect(result).toEqual({ skipped: false });
    expect(provider.complete).toHaveBeenCalledTimes(1);
    const input = provider.complete.mock.calls[0][0];
    expect(input.chunks[0].id).toBe(chunkA.id);
    expect(input.history).toEqual([{ role: "user", text: "yesterday" }, { role: "assistant", text: "step two" }]);
    expect(input.instruction).toContain("完整答案");
    expect(budget.settle).toHaveBeenCalledWith(expect.anything(), "res-1", expect.any(Number), { resultRef: `opening_turn:${claimedJob.assistantTurnId}` });
    expect(tutorJobs.completeTurn.mock.calls.map(call => call[0])).toContainEqual(expect.objectContaining({ jobId: claimedJob.id, assistantTurnId: claimedJob.assistantTurnId, text: "F = ma", candidates: [expect.objectContaining({ sourceIds: [chunkA.sourceId] })] }));
    expect(tutorJobs.completeTurn.mock.calls[0][0]).not.toHaveProperty("helpExposure");
  });

  it("drops task candidates but keeps memory when listen cannot propose tasks", async () => {
    const task = { kind: "task" as const, title: "Review Newton", minutes: 10, dueText: null };
    const memory = { kind: "memory" as const, text: "Learner asked about Newton", temporary: false };
    const { deps, tutorJobs } = setup({
      claim: { ...claimedJob, mode: "listen" },
      provider: async () => ({
        text: "I hear you",
        citedChunkIds: [chunkA.id],
        requestId: null,
        candidates: [task, memory],
        inputTokens: 10,
        outputTokens: 5,
      }),
    });
    await createTutorTurnHandler(deps)(claimedJob.id);
    expect(tutorJobs.completeTurn.mock.calls.map(call => call[0])).toContainEqual(expect.objectContaining({
      candidates: [{ payload: memory, sourceIds: [chunkA.sourceId] }],
    }));
  });

  it("keeps task and memory candidates when think_together can propose tasks", async () => {
    const task = { kind: "task" as const, title: "Review Newton", minutes: 10, dueText: null };
    const memory = { kind: "memory" as const, text: "Learner asked about Newton", temporary: false };
    const { deps, tutorJobs } = setup({
      claim: { ...claimedJob, mode: "think_together" },
      provider: async () => ({
        text: "Let us think",
        citedChunkIds: [chunkA.id],
        requestId: null,
        candidates: [task, memory],
        inputTokens: 10,
        outputTokens: 5,
      }),
    });
    await createTutorTurnHandler(deps)(claimedJob.id);
    expect(tutorJobs.completeTurn.mock.calls.map(call => call[0])).toContainEqual(expect.objectContaining({
      candidates: [
        { payload: task, sourceIds: [chunkA.sourceId] },
        { payload: memory, sourceIds: [chunkA.sourceId] },
      ],
    }));
  });

  it("keeps task and memory candidates in the default explain mode", async () => {
    const task = { kind: "task" as const, title: "Review Newton", minutes: 10, dueText: null };
    const memory = { kind: "memory" as const, text: "Learner asked about Newton", temporary: false };
    const { deps, tutorJobs } = setup({
      provider: async () => ({
        text: "F = ma",
        citedChunkIds: [chunkA.id],
        requestId: null,
        candidates: [task, memory],
        inputTokens: 10,
        outputTokens: 5,
      }),
    });
    await createTutorTurnHandler(deps)(claimedJob.id);
    expect(tutorJobs.completeTurn.mock.calls.map(call => call[0])).toContainEqual(expect.objectContaining({
      candidates: [
        { payload: task, sourceIds: [chunkA.sourceId] },
        { payload: memory, sourceIds: [chunkA.sourceId] },
      ],
    }));
  });

  it("renumbers inline [n] markers to the citations that survive the page filter", async () => {
    // Model cites page 2 first, then page 1; the current-page guard keeps only page 1.
    const { deps, tutorJobs } = setup({ provider: async () => ({ text: "引力[1]，运动定律[2]。", citedChunkIds: [chunkB.id, chunkA.id], requestId: null, candidates: [], inputTokens: 10, outputTokens: 5 }) });
    await createTutorTurnHandler(deps)(claimedJob.id);
    const saved = tutorJobs.completeTurn.mock.calls[0][0] as { text: string; citations: Array<{ chunkId: string }> };
    expect(saved.citations.map((citation) => citation.chunkId)).toEqual([chunkA.id]);
    expect(saved.text).toBe("引力，运动定律[1]。");
  });

  it("retrieves chunks at each turn's saved source version instead of the current source version", async () => {
    const snapshotChunk = { ...chunkA, sourceVersion: 4, text: "Newton's laws from the saved source version" };
    const { deps, chunks, provider } = setup({
      chunks: [snapshotChunk],
      sourceVersions: { [chunkA.sourceId]: 4 },
    });

    await createTutorTurnHandler(deps)(claimedJob.id);

    expect(chunks.listChunksAtVersion).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: claimedJob.workspaceId, ownerUserId: claimedJob.ownerUserId }),
      chunkA.sourceId,
      4,
    );
    expect(chunks.listForSources).not.toHaveBeenCalled();
    expect(provider.complete.mock.calls[0][0].chunks).toEqual([snapshotChunk]);
  });

  it("retrieves and merges each selected source at its saved version", async () => {
    const { deps, chunks, provider } = setup({
      sourceIds: [chunkA.sourceId, secondSourceId],
      sourceVersions: { [chunkA.sourceId]: 3, [secondSourceId]: 9 },
    });

    await createTutorTurnHandler(deps)(claimedJob.id);

    expect(chunks.listChunksAtVersion).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: claimedJob.workspaceId, ownerUserId: claimedJob.ownerUserId }),
      chunkA.sourceId,
      3,
    );
    expect(chunks.listChunksAtVersion).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: claimedJob.workspaceId, ownerUserId: claimedJob.ownerUserId }),
      secondSourceId,
      9,
    );
    expect(provider.complete.mock.calls[0][0].chunks.map((chunk: SourceChunk) => chunk.id)).toEqual([
      chunkA.id,
      chunkC.id,
    ]);
  });

  it("does not fall back to the current source version when a turn has no snapshot", async () => {
    const { deps, chunks, provider, tutorJobs } = setup({ sourceVersions: {} });

    await expect(createTutorTurnHandler(deps)(claimedJob.id)).rejects.toThrow(/unavailable/);

    expect(chunks.listChunksAtVersion).not.toHaveBeenCalled();
    expect(chunks.listForSources).not.toHaveBeenCalled();
    expect(provider.complete).not.toHaveBeenCalled();
    expect(tutorJobs.fail).toHaveBeenCalled();
  });

  it("fails the whole mixed snapshot when one selected source has no saved version", async () => {
    const { deps, provider, tutorJobs, chunks } = setup({
      sourceIds: [chunkA.sourceId, secondSourceId],
      sourceVersions: { [chunkA.sourceId]: 3 },
    });

    await expect(createTutorTurnHandler(deps)(claimedJob.id)).rejects.toThrow(/missing snapshot/);

    expect(chunks.listChunksAtVersion).toHaveBeenCalledTimes(1);
    expect(provider.complete).not.toHaveBeenCalled();
    expect(tutorJobs.fail).toHaveBeenCalled();
  });

  it("does not call the provider when one selected source snapshot is missing", async () => {
    const { deps, provider, tutorJobs } = setup({
      sourceIds: [chunkA.sourceId, secondSourceId],
      sourceVersions: { [chunkA.sourceId]: 3, [secondSourceId]: 9 },
      missingSourceIds: [secondSourceId],
    });

    await expect(createTutorTurnHandler(deps)(claimedJob.id)).rejects.toThrow(/unavailable/);

    expect(provider.complete).not.toHaveBeenCalled();
    expect(tutorJobs.fail).toHaveBeenCalled();
  });

  it("does not require a snapshot for a privacy-excluded source", async () => {
    const { deps, chunks, provider } = setup({
      sourceIds: [chunkA.sourceId, secondSourceId],
      sourceVersions: { [chunkA.sourceId]: 3 },
    });
    deps.privacy = {
      getWorkspaceEpoch: vi.fn(async () => 1),
      listExcludedSourceIds: vi.fn(async () => [secondSourceId]),
    };

    await createTutorTurnHandler(deps)(claimedJob.id);

    expect(chunks.listChunksAtVersion).toHaveBeenCalledTimes(1);
    expect(chunks.listChunksAtVersion).toHaveBeenCalledWith(
      expect.anything(),
      chunkA.sourceId,
      3,
    );
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });

  it("keeps empty sourceIds as a provider-backed free exchange", async () => {
    const { deps, chunks, provider } = setup({ sourceIds: [], sourceVersions: {}, provider: async () => ({ text: "F = ma", citedChunkIds: [], requestId: null, candidates: [], inputTokens: 100, outputTokens: 50 }) });

    await createTutorTurnHandler(deps)(claimedJob.id);

    expect(chunks.listChunksAtVersion).not.toHaveBeenCalled();
    expect(chunks.listForSources).not.toHaveBeenCalled();
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });

  it("Package C: explicit large sourceIds are not top-K narrowed on the worker", async () => {
    // Seven sources all match the query. If pick ran, only 6 would reach selectContext.
    const sources = Array.from({ length: 7 }, (_, i) => {
      const sourceId = `00000000-0000-4000-8000-0000000001${i}0`;
      const chunk: SourceChunk = {
        id: `00000000-0000-4000-8000-0000000002${i}0`,
        sourceId,
        sourceVersion: 0,
        page: 1,
        slideLabel: null,
        startMs: null,
        endMs: null,
        text: `shared keyword alpha for source ${i}`,
        imageObjectKey: null,
      };
      return { sourceId, chunk };
    });
    const { deps, provider } = setup({
      chunks: sources.map((row) => row.chunk),
      sourceIds: sources.map((row) => row.sourceId),
      sourceVersions: Object.fromEntries(sources.map((row) => [row.sourceId, 0])),
      provider: async () => ({
        text: "ok",
        citedChunkIds: [],
        requestId: null,
        candidates: [],
        inputTokens: 10,
        outputTokens: 5,
      }),
    });
    deps.config.maxContextCharacters = 50_000;
    deps.tutorJobs.getUserTurn = vi.fn(async () => ({
      ...turn,
      text: "alpha",
      currentPage: null,
      chunkId: null,
      sourceIds: sources.map((row) => row.sourceId),
      sourceVersions: Object.fromEntries(sources.map((row) => [row.sourceId, 0])),
    }));
    await createTutorTurnHandler(deps)(claimedJob.id);
    const sent = provider.complete.mock.calls[0]![0]!;
    const sourceIdsInContext = new Set(sent.chunks.map((row: { sourceId: string }) => row.sourceId));
    expect(sourceIdsInContext.size).toBe(7);
  });

  it("Package C: vague query still passes non-empty context to the provider when chunks exist", async () => {
    const vagueChunk: SourceChunk = {
      ...chunkA,
      text: "课程绪论：本周学习目标与练习安排",
    };
    const { deps, provider } = setup({
      chunks: [vagueChunk],
      provider: async () => ({
        text: "一般说明",
        citedChunkIds: [],
        requestId: null,
        candidates: [],
        inputTokens: 10,
        outputTokens: 5,
      }),
    });
    deps.tutorJobs.getUserTurn = vi.fn(async () => ({
      ...turn,
      text: "这道题怎么做？",
      currentPage: null,
      chunkId: null,
      sourceIds: [vagueChunk.sourceId],
      sourceVersions: { [vagueChunk.sourceId]: 0 },
    }));
    await createTutorTurnHandler(deps)(claimedJob.id);
    const sent = provider.complete.mock.calls[0]![0]!;
    expect(sent.chunks.length).toBeGreaterThan(0);
    expect(sent.chunks[0]?.id).toBe(vagueChunk.id);
  });

  it("reserves for actual input size and output limit, not only the fixed floor", async () => {
    const { deps, budget } = setup();
    deps.config.reservedCents = 1;
    deps.config.inputCentsPerMillion = 1_000_000;
    deps.config.outputCentsPerMillion = 1_000_000;
    await createTutorTurnHandler(deps)(claimedJob.id);
    expect(budget.reserve.mock.calls[0][1].amountCents).toBeGreaterThan(2048);
  });

  it("skips a redelivered job without calling the provider", async () => {
    const { deps, provider, budget } = setup({ claim: null });
    await expect(createTutorTurnHandler(deps)(claimedJob.id)).resolves.toEqual({ skipped: true });
    expect(provider.complete).not.toHaveBeenCalled();
    expect(budget.reserve).not.toHaveBeenCalled();
  });

  it("marks the job unknown and retains the reservation on provider timeouts", async () => {
    const { deps, tutorJobs, budget } = setup({ provider: async () => { throw new OpeningProviderError("PROVIDER_TIMEOUT", "timed out", 0); } });
    await expect(createTutorTurnHandler(deps)(claimedJob.id)).rejects.toThrow();
    expect(budget.markUnknown).toHaveBeenCalledWith(expect.anything(), "res-1");
    expect(tutorJobs.markUnknown).toHaveBeenCalled();
    expect(tutorJobs.fail).not.toHaveBeenCalled();
    expect(tutorJobs.completeTurn).not.toHaveBeenCalled();
  });

  it("fails definitively and releases on provider auth errors", async () => {
    const { deps, tutorJobs, budget } = setup({ provider: async () => { throw new OpeningProviderError("PROVIDER_AUTH", "bad key", 401); } });
    await expect(createTutorTurnHandler(deps)(claimedJob.id)).rejects.toThrow();
    expect(budget.release).toHaveBeenCalledWith(expect.anything(), `tutor:${claimedJob.id}`, "not_sent");
    expect(tutorJobs.fail).toHaveBeenCalled();
    expect(tutorJobs.markUnknown).not.toHaveBeenCalled();
  });

  it("fails honestly when every requested source vanished", async () => {
    const { deps, tutorJobs, provider, budget } = setup({ chunks: [] });
    await expect(createTutorTurnHandler(deps)(claimedJob.id)).rejects.toThrow(/unavailable/);
    expect(provider.complete).not.toHaveBeenCalled();
    expect(budget.reserve).not.toHaveBeenCalled();
    expect(tutorJobs.fail).toHaveBeenCalled();
  });

  it("fails content-free when the budget cap rejects the reservation", async () => {
    const { deps, tutorJobs, provider, budget } = setup();
    budget.reserve.mockRejectedValueOnce(new Error("BUDGET_EXCEEDED"));
    await expect(createTutorTurnHandler(deps)(claimedJob.id)).rejects.toThrow(/BUDGET_EXCEEDED/);
    expect(provider.complete).not.toHaveBeenCalled();
    expect(tutorJobs.fail).toHaveBeenCalled();
  });

  it("rejects writeback when workspace privacy epoch changes mid-job", async () => {
    const { deps, tutorJobs } = setup();
    let calls = 0;
    const privacy = {
      getWorkspaceEpoch: vi.fn(async () => {
        calls += 1;
        return calls <= 2 ? 1 : 2;
      }),
      listExcludedSourceIds: vi.fn(async () => []),
    };
    await expect(createTutorTurnHandler({ ...deps, privacy })(claimedJob.id)).rejects.toBeInstanceOf(PrivacyEpochError);
    expect(tutorJobs.completeTurn).not.toHaveBeenCalled();
    expect(tutorJobs.fail).toHaveBeenCalled();
  });

  it("does not send stale context and releases the reservation when privacy changes before send", async () => {
    const { deps, budget, provider, tutorJobs } = setup();
    let epoch = 1;
    budget.reserve.mockImplementation(async () => { epoch = 2; return { id: "res-1" }; });
    const privacy = {
      getWorkspaceEpoch: vi.fn(async () => epoch),
      listExcludedSourceIds: vi.fn(async () => []),
    };
    await expect(createTutorTurnHandler({ ...deps, privacy })(claimedJob.id)).rejects.toBeInstanceOf(PrivacyEpochError);
    expect(provider.complete).not.toHaveBeenCalled();
    expect(budget.release).toHaveBeenCalledWith(expect.anything(), `tutor:${claimedJob.id}`, "not_sent");
    expect(budget.settle).not.toHaveBeenCalled();
    expect(tutorJobs.completeTurn).not.toHaveBeenCalled();
  });

  it("carries uncited chunks, history and injected memory references with distinct versions", async () => {
    const { deps, tutorJobs } = setup({ provider: async () => ({ text: "mixed", citedChunkIds: [
      chunkA.id],
      requestId: null, candidates: [{ kind: "memory", text: "mixed memory", temporary: false }], inputTokens: 1, outputTokens: 1 }) });
    tutorJobs.loadHistoryContext.mockResolvedValue({ history: [], sourceRefs: [{ sourceId: secondSourceId, sourceVersion: 1 }] });
    const memories = { listContext: vi.fn(async () => ({ sourceRefs: [{ sourceId: secondSourceId, sourceVersion: 2 }], memories: [{
      id: "00000000-0000-4000-8000-0000000000a1", workspaceId: claimedJob.workspaceId, courseId: null,
      kind: "confirmed" as const, text: "Retained study preference", sourceTurnIds: [claimedJob.userTurnId], version: 0,
      expiresAt: null, status: "active" as const, createdAt: claimedJob.createdAt, updatedAt: claimedJob.updatedAt,
    }] })) };
    await createTutorTurnHandler({ ...deps, memories })(claimedJob.id);
    expect(tutorJobs.completeTurn.mock.calls.map(call => call[0])).toContainEqual(expect.objectContaining({
      contextSourceRefs: [
        { sourceId: chunkA.sourceId, sourceVersion: 0 },
        { sourceId: secondSourceId, sourceVersion: 1 },
        { sourceId: secondSourceId, sourceVersion: 2 },
      ],
      candidates: [{ payload: { kind: "memory", text: "mixed memory", temporary: false }, sourceIds: [chunkA.sourceId, secondSourceId] }],
    }));
  });
  it("passes the job privacy epoch into completeTurn on the success path", async () => {
    const { deps, tutorJobs } = setup();
    const privacy = {
      getWorkspaceEpoch: vi.fn(async () => 7),
      listExcludedSourceIds: vi.fn(async () => []),
    };

    await createTutorTurnHandler({ ...deps, privacy })(claimedJob.id);

    expect(tutorJobs.completeTurn.mock.calls.map(call => call[0])).toContainEqual(expect.objectContaining({
      expectedPrivacyEpoch: 7,
    }));
  });

  it("records a definitive failure (not unknown) when completeTurn rejects on privacy epoch drift", async () => {
    const { deps, tutorJobs, budget } = setup();
    const privacy = {
      getWorkspaceEpoch: vi.fn(async () => 7),
      listExcludedSourceIds: vi.fn(async () => []),
    };
    tutorJobs.completeTurn.mockRejectedValueOnce(
      Object.assign(new Error("privacy epoch drift: expected 7 current 8"), { code: "CONFLICT" }),
    );

    await expect(createTutorTurnHandler({ ...deps, privacy })(claimedJob.id)).rejects.toThrow(/privacy epoch drift/);

    expect(tutorJobs.completeTurn.mock.calls.map(call => call[0])).toContainEqual(expect.objectContaining({ expectedPrivacyEpoch: 7 }));
    expect(tutorJobs.fail).toHaveBeenCalledWith(expect.anything(), claimedJob.id, TUTOR_FAILURE_MESSAGE, undefined, undefined);
    expect(tutorJobs.markUnknown).not.toHaveBeenCalled();
    expect(budget.markUnknown).not.toHaveBeenCalled();
  });

  it("puts confirmed memory into the provider instruction and omits candidates", async () => {
    const { deps, provider } = setup();
    const memories = {
      listContext: vi.fn(async () => ({ sourceRefs: [], memories: [
        { id: "m1", workspaceId: "w", kind: "candidate" as const, text: "待确认偏好", sourceTurnIds: [], version: 1, expiresAt: null, status: "active" as const, createdAt: "2026-09-12T00:00:00Z" },
        { id: "m2", workspaceId: "w", kind: "confirmed" as const, text: "先看例题再问结论", sourceTurnIds: ["00000000-0000-4000-8000-000000000099"], version: 1, expiresAt: null, status: "active" as const, createdAt: "2026-09-12T00:00:00Z" },
      ] })),
    };
    await createTutorTurnHandler({ ...deps, memories })(claimedJob.id);
    const sent = provider.complete.mock.calls[0]?.[0] as { instruction: string };
    expect(sent.instruction).toContain("先看例题再问结论");
    expect(sent.instruction).not.toContain("待确认偏好");
  });

  it("passes delivered help exposure to completeTurn after assistant persistence", async () => {
    const sessionId = "00000000-0000-4000-8000-0000000000aa";
    const { deps, tutorJobs } = setup();
    deps.tutorJobs.getUserTurn = vi.fn(async () => ({
      ...turn,
      mode: "hint",
      learningSessionId: sessionId,
      sourceVersions: { [chunkA.sourceId]: 0 },
    }));
    const claimed = { ...claimedJob, mode: "hint" };
    deps.tutorJobs.claim = vi.fn(async () => claimed);
    await createTutorTurnHandler(deps)(claimed.id);
    expect(tutorJobs.completeTurn.mock.calls.map(call => call[0])).toContainEqual(expect.objectContaining({
      helpExposure: expect.objectContaining({
        sessionId,
        turnId: claimed.assistantTurnId,
        kind: "hint",
        level: "hinted",
        delivered: true, hintStage: null, initiatedBy: "user",
      }),
    }));
  });

  it("sets kind instruction for explain without attempt/problem (V2-13 T16)", async () => {
    const sessionId = "00000000-0000-4000-8000-0000000000aa";
    const { deps, tutorJobs } = setup();
    deps.tutorJobs.getUserTurn = vi.fn(async () => ({
      ...turn,
      mode: "explain",
      learningSessionId: sessionId,
      attemptId: null,
      sourceVersions: { [chunkA.sourceId]: 0 },
    }));
    const claimed = { ...claimedJob, mode: "explain" };
    deps.tutorJobs.claim = vi.fn(async () => claimed);
    await createTutorTurnHandler(deps)(claimed.id);
    expect(tutorJobs.completeTurn.mock.calls.map(call => call[0])).toContainEqual(expect.objectContaining({
      helpExposure: expect.objectContaining({
        sessionId,
        problemId: null,
        kind: "instruction",
        level: "revealed",
        delivered: true,
      }),
    }));
  });

  it("counts explain during an attempt as item help, not instruction", async () => {
    const sessionId = "00000000-0000-4000-8000-0000000000aa";
    const attemptId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
    const { deps, tutorJobs } = setup();
    deps.tutorJobs.getUserTurn = vi.fn(async () => ({
      ...turn,
      mode: "explain",
      learningSessionId: sessionId,
      attemptId,
      sourceVersions: { [chunkA.sourceId]: 0 },
    }));
    const claimed = { ...claimedJob, mode: "explain" };
    deps.tutorJobs.claim = vi.fn(async () => claimed);
    await createTutorTurnHandler(deps)(claimed.id);
    expect(tutorJobs.completeTurn.mock.calls.map(call => call[0])).toContainEqual(expect.objectContaining({
      helpExposure: expect.objectContaining({ attemptId, kind: "hint", level: "revealed" }),
    }));
  });

  it("does not expose help when completeTurn rejects before persistence", async () => {
    const sessionId = "00000000-0000-4000-8000-0000000000aa";
    const { deps, tutorJobs } = setup();
    deps.tutorJobs.getUserTurn = vi.fn(async () => ({
      ...turn,
      mode: "hint",
      learningSessionId: sessionId,
      sourceVersions: { [chunkA.sourceId]: 0 },
    }));
    const claimed = { ...claimedJob, mode: "hint" };
    deps.tutorJobs.claim = vi.fn(async () => claimed);
    tutorJobs.completeTurn.mockRejectedValueOnce(new Error("assistant persistence failed"));
    const learning = {
      insertHelpExposure: vi.fn(async () => undefined),
    };

    await expect(createTutorTurnHandler({ ...deps, learning })(claimed.id)).rejects.toThrow(
      "assistant persistence failed",
    );

    expect(learning.insertHelpExposure).not.toHaveBeenCalled();
    expect(tutorJobs.completeTurn.mock.calls.map(call => call[0])).toContainEqual(expect.objectContaining({
      helpExposure: expect.objectContaining({ sessionId }),
    }));
  });

  it("injects the selected strategy suffix without changing mode instruction", async () => {
    const { deps, provider } = setup();
    deps.tutorJobs.getUserTurn = vi.fn(async () => ({
      ...turn, sourceVersions: { [chunkA.sourceId]: 0 },
      strategyTemplateId: DEFAULT_STRATEGY_TEMPLATE_ID,
    }));

    await createTutorTurnHandler(deps)(claimedJob.id);
    const input = provider.complete.mock.calls[0]![0] as { instruction: string };
    expect(input.instruction).toContain(makeTutorInstruction("explain"));
    expect(input.instruction).toContain("材料内容论断必须锚定所选材料的具体物理页");
    expect(input.instruction).toContain("系统状态事实只依据本轮服务端结构化查询回执");
  });

  it("falls back to the default strategy for unknown template ids", async () => {
    const { deps, provider } = setup();
    deps.tutorJobs.getUserTurn = vi.fn(async () => ({
      ...turn, sourceVersions: { [chunkA.sourceId]: 0 },
      strategyTemplateId: "missing-template",
    }));

    await createTutorTurnHandler(deps)(claimedJob.id);
    const input = provider.complete.mock.calls[0]![0] as { instruction: string };
    expect(input.instruction).toContain(makeTutorInstruction("explain"));
    expect(input.instruction).toContain("不得编造页码");
  });

  it("completes a page-backed turn with empty cites as general (soft page guard)", async () => {
    const { deps, tutorJobs, provider } = setup({ provider: async () => ({ text: "F = ma", citedChunkIds: [], requestId: null, candidates: [], inputTokens: 1, outputTokens: 1 }) });

    await expect(createTutorTurnHandler(deps)(claimedJob.id)).resolves.toEqual({ skipped: false });
    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(tutorJobs.completeTurn.mock.calls.map(call => call[0])).toContainEqual(expect.objectContaining({
      text: "F = ma",
      citations: [],
    }));
    expect(tutorJobs.fail).not.toHaveBeenCalled();
  });

  it("soft-filters unknown citedChunkIds and prefers on-page cites", async () => {
    const invented = "00000000-0000-4000-8000-00000000dead";
    const { deps, tutorJobs } = setup({
      chunks: [chunkA, chunkB],
      provider: async () => ({
        text: "F = ma",
        citedChunkIds: [invented, chunkB.id, chunkA.id],
        requestId: null,
        candidates: [],
        inputTokens: 1,
        outputTokens: 1,
      }),
    });

    await expect(createTutorTurnHandler(deps)(claimedJob.id)).resolves.toEqual({ skipped: false });
    const completeArg = tutorJobs.completeTurn.mock.calls[0]![0] as {
      citations: Array<{ chunkId: string; page?: number }>;
    };
    // Unknown invented id dropped; currentPage=1 → prefer chunkA only.
    expect(completeArg.citations.map((c) => c.chunkId)).toEqual([chunkA.id]);
    expect(completeArg.citations[0]).toMatchObject({ page: 1 });
  });

  it("propagates UnconfirmedStreamSealError out of withStreamPublication, skips redundant seal, and fails the job with preserved claimToken", async () => {
    const claimedWithExecution = {
      ...claimedJob,
      claimToken: "00000000-0000-4000-8000-0000000000cc",
      executionId: "00000000-0000-4000-8000-0000000000ee",
    };
    const { deps, provider, tutorJobs, budget } = setup({ claim: claimedWithExecution });
    const sealError = new UnconfirmedStreamSealError(new Error("Command timed out"), new Error("connect ECONNREFUSED"));
    const onStreamUnavailable = vi.fn();
    let seenByPublication: unknown;
    tutorJobs.withStreamPublication.mockImplementation(async (_scope, _job, _context, publish) => {
      try {
        await publish();
      } catch (error) {
        seenByPublication = error;
        throw error;
      }
    });
    const stream = {
      begin: vi.fn(async () => {}),
      seal: vi.fn(async () => {}),
      append: vi.fn(async () => { throw sealError; }),
    };
    let capturedSignal: AbortSignal | undefined;
    provider.complete.mockImplementationOnce(async (_input, signal, delta) => {
      capturedSignal = signal;
      await delta("First");
      return { text: "First", citedChunkIds: [], candidates: [], requestId: null, inputTokens: 10, outputTokens: 10 };
    });

    await expect(createTutorTurnHandler({ ...deps, stream, onStreamUnavailable })(claimedJob.id)).rejects.toBe(sealError);
    expect(seenByPublication).toBe(sealError);
    expect(onStreamUnavailable).toHaveBeenCalledWith(sealError);
    expect(stream.seal).not.toHaveBeenCalled();
    expect(capturedSignal?.aborted).toBe(true);
    expect(capturedSignal?.reason).toBe(sealError);
    expect(budget.markUnknown).toHaveBeenCalledOnce();
    expect(tutorJobs.completeTurn).not.toHaveBeenCalled();
    expect(tutorJobs.fail).toHaveBeenCalledWith(
      { workspaceId: claimedJob.workspaceId, ownerUserId: claimedJob.ownerUserId },
      claimedJob.id,
      expect.any(String),
      undefined,
      claimedWithExecution.claimToken,
    );
  });

  it("bounds a hung fallback stream.seal on withStreamPublication failure so failure cleanup is never delayed", async () => {
    vi.useFakeTimers();
    try {
      const claimedWithExecution = {
        ...claimedJob,
        claimToken: "00000000-0000-4000-8000-0000000000cd",
        executionId: "00000000-0000-4000-8000-0000000000ef",
      };
      const { deps, provider, tutorJobs } = setup({ claim: claimedWithExecution });
      const pgDrop = Object.assign(new Error("connection dropped"), { code: "CONNECTION_CLOSED" });
      const onStreamUnavailable = vi.fn();
      tutorJobs.withStreamPublication
        .mockImplementationOnce(async (_scope, _job, _context, publish) => publish())
        .mockRejectedValueOnce(pgDrop);
      const stream = {
        begin: vi.fn(async () => {}),
        seal: vi.fn(() => new Promise<void>(() => undefined)),
        append: vi.fn(async () => 1),
      };
      provider.complete.mockImplementationOnce(async (_input, _signal, delta) => {
        await delta("First");
        return { text: "First", citedChunkIds: [], candidates: [], requestId: null, inputTokens: 10, outputTokens: 10 };
      });
      const result = createTutorTurnHandler({ ...deps, stream, onStreamUnavailable })(claimedJob.id)
        .then(() => undefined, error => error);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(await result).toBe(pgDrop);
      expect(stream.seal).toHaveBeenCalledWith(claimedJob.workspaceId, claimedJob.id, claimedWithExecution.executionId);
      expect(onStreamUnavailable).toHaveBeenCalledOnce();
      expect(tutorJobs.fail).toHaveBeenCalledWith(
        { workspaceId: claimedJob.workspaceId, ownerUserId: claimedJob.ownerUserId },
        claimedJob.id,
        expect.any(String),
        undefined,
        claimedWithExecution.claimToken,
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips duplicate fallback stream.seal when withStreamPublication already attempted bounded sealing", async () => {
    const claimedWithExecution = {
      ...claimedJob,
      claimToken: "00000000-0000-4000-8000-0000000000ce",
      executionId: "00000000-0000-4000-8000-0000000000f0",
    };
    const { deps, provider, tutorJobs } = setup({ claim: claimedWithExecution });
    const pgDrop = Object.assign(new Error("connection dropped"), { code: "CONNECTION_CLOSED" });
    markFallbackStreamSealAttempted(pgDrop);
    const onStreamUnavailable = vi.fn();
    tutorJobs.withStreamPublication
      .mockImplementationOnce(async (_scope, _job, _context, publish) => publish())
      .mockRejectedValueOnce(pgDrop);
    const stream = {
      begin: vi.fn(async () => {}),
      seal: vi.fn(() => new Promise<void>(() => undefined)),
      append: vi.fn(async () => 1),
    };
    provider.complete.mockImplementationOnce(async (_input, _signal, delta) => {
      await delta("First");
      return { text: "First", citedChunkIds: [], candidates: [], requestId: null, inputTokens: 10, outputTokens: 10 };
    });
    await expect(createTutorTurnHandler({ ...deps, stream, onStreamUnavailable })(claimedJob.id)).rejects.toBe(pgDrop);
    expect(stream.seal).not.toHaveBeenCalled();
    expect(onStreamUnavailable).not.toHaveBeenCalled();
    expect(tutorJobs.fail).toHaveBeenCalledOnce();
  });

  it("separates global memory lineage sources from explicit course material across stream publication and completeTurn", async () => {
    const memoryOnlySourceId = "00000000-0000-4000-8000-000000000099";
    const { deps, tutorJobs } = setup();
    const stream = {
      begin: vi.fn(async () => {}),
      seal: vi.fn(async () => {}),
      append: vi.fn(async () => 1),
    };
    const memories = {
      listContext: vi.fn(async () => ({
        memories: [{
          id: "00000000-0000-4000-8000-0000000000aa", workspaceId: claimedJob.workspaceId, courseId: null,
          kind: "confirmed" as const, text: "Learner prefers visual steps", sourceTurnIds: [claimedJob.userTurnId],
          version: 0, expiresAt: null, status: "active" as const, createdAt: claimedJob.createdAt, updatedAt: claimedJob.updatedAt,
        }],
        sourceRefs: [
          { sourceId: chunkA.sourceId, sourceVersion: 0 },
          { sourceId: memoryOnlySourceId, sourceVersion: 0 },
        ],
      })),
    };

    await expect(createTutorTurnHandler({ ...deps, stream, memories })(claimedJob.id)).resolves.toEqual({ skipped: false });
    // Full union stays in contextSourceRefs for provenance/privacy revocation, while memoryLineageSourceIds
    // carries ONLY non-explicit global memory lineage (excluding chunkA.sourceId which is explicitly selected).
    expect(stream.begin).toHaveBeenCalledWith(
      claimedJob.workspaceId,
      claimedJob.id,
      expect.objectContaining({
        contextSourceRefs: expect.arrayContaining([
          { sourceId: chunkA.sourceId, sourceVersion: 0 },
          { sourceId: memoryOnlySourceId, sourceVersion: 0, memoryOnly: true },
        ]),
        memoryLineageSourceIds: [memoryOnlySourceId],
        globalMemoryIds: ["00000000-0000-4000-8000-0000000000aa"],
      }),
    );
    expect(tutorJobs.withStreamPublication).toHaveBeenCalledWith(
      expect.anything(),
      claimedJob.id,
      expect.objectContaining({
        memoryLineageSourceIds: [memoryOnlySourceId],
        globalMemoryIds: ["00000000-0000-4000-8000-0000000000aa"],
      }),
      expect.any(Function),
    );
    expect(tutorJobs.completeTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        contextSourceRefs: expect.arrayContaining([
          { sourceId: chunkA.sourceId, sourceVersion: 0 },
          { sourceId: memoryOnlySourceId, sourceVersion: 0, memoryOnly: true },
        ]),
      }),
      expect.objectContaining({
        memoryLineageSourceIds: [memoryOnlySourceId],
        globalMemoryIds: ["00000000-0000-4000-8000-0000000000aa"],
      }),
    );
  });

  it.each(["conversation", "anchor", "unbound"] as const)("fences only admitted memories for a %s course binding", async binding => {
    const { deps, tutorJobs, provider } = setup();
    const courseA = "00000000-0000-4000-8000-0000000000ca";
    const courseB = "00000000-0000-4000-8000-0000000000cb";
    const anchor = binding === "anchor" ? { purpose: "learning_help" as const, courseId: courseA } : null;
    tutorJobs.getUserTurn.mockResolvedValueOnce({ ...turn, sourceVersions: { [chunkA.sourceId]: 0 },
      ...(binding === "conversation" ? { courseId: courseA } : {}), ...(anchor ? { contextAnchor: anchor } : {}) });
    const memory = (id: string, courseId: string | null, text: string) => ({
      id, workspaceId: claimedJob.workspaceId, courseId, text, kind: "confirmed" as const,
      version: 0, status: "active" as const, sourceTurnIds: [claimedJob.userTurnId], expiresAt: null,
      createdAt: claimedJob.createdAt, updatedAt: claimedJob.updatedAt,
    });
    const global = memory("00000000-0000-4000-8000-0000000000a1", null, "Global memory text");
    const matching = memory("00000000-0000-4000-8000-0000000000a2", courseA.toUpperCase(), "Matching course text");
    const foreign = memory("00000000-0000-4000-8000-0000000000a3", courseB, "Foreign course text");
    const sourceRefs = [{ sourceId: secondSourceId, sourceVersion: 0 },
      ...(binding === "unbound" ? [] : [{ sourceId: "00000000-0000-4000-8000-000000000098", sourceVersion: 0 }])];
    const listContext = vi.fn(async () => ({ memories: [global, matching, foreign], sourceRefs,
      dependencyMemoryIds: [matching.id.toUpperCase(), foreign.id] }));
    const assertGlobalMemoriesCurrent = vi.fn(async () => {});
    const stream = { begin: vi.fn(async () => {}), seal: vi.fn(async () => {}), append: vi.fn(async () => 1) };
    await createTutorTurnHandler({ ...deps, stream, memories: { listContext },
      streamExposures: { generate: vi.fn(async () => ({ id: claimedJob.assistantTurnId })) },
      tutorJobs: { ...tutorJobs, assertGlobalMemoriesCurrent } })(claimedJob.id);
    const scope = { workspaceId: claimedJob.workspaceId, ownerUserId: claimedJob.ownerUserId };
    const expectedIds = binding === "unbound" ? [global.id] : [global.id, matching.id];
    expect(listContext).toHaveBeenCalledWith(scope, expect.any(String), binding === "unbound" ? null : courseA);
    const instruction = provider.complete.mock.calls[0]?.[0].instruction;
    expect(instruction).toContain(global.text);
    expect(instruction).not.toContain(foreign.text);
    if (binding === "unbound") expect(instruction).not.toContain(matching.text);
    else expect(instruction).toContain(matching.text);
    expect(tutorJobs.withStreamPublication).toHaveBeenCalledWith(scope, claimedJob.id,
      expect.objectContaining({ globalMemoryIds: expectedIds }), expect.any(Function));
    expect(assertGlobalMemoriesCurrent).toHaveBeenCalledWith(scope, expectedIds, claimedJob.id);
    expect(tutorJobs.completeTurn).toHaveBeenCalledWith(expect.objectContaining({
      contextSourceRefs: expect.arrayContaining(sourceRefs.map(ref => ({ ...ref, memoryOnly: true }))),
    }), expect.objectContaining({ globalMemoryIds: expectedIds }));
  });

  it("discards a memory snapshot's refs, dependency IDs and expiry when none of its memories are eligible", async () => {
    const { deps, tutorJobs, provider } = setup();
    const memoryId = "00000000-0000-4000-8000-0000000000b1";
    const listContext = async () => ({
      memories: [{ id: memoryId, workspaceId: claimedJob.workspaceId, courseId: claimedJob.conversationId,
        kind: "confirmed" as const, text: "Foreign memory", sourceTurnIds: [claimedJob.userTurnId], version: 0,
        expiresAt: null, status: "active" as const, createdAt: claimedJob.createdAt, updatedAt: claimedJob.updatedAt }],
      sourceRefs: [{ sourceId: secondSourceId, sourceVersion: 0 }], dependencyMemoryIds: [memoryId],
      temporaryMemoryExpiresAt: "2000-01-01T00:00:00.000Z",
    });
    await expect(createTutorTurnHandler({ ...deps, memories: { listContext } })(claimedJob.id)).resolves.toEqual({ skipped: false });
    expect(provider.complete.mock.calls[0]?.[0].instruction).not.toContain("Foreign memory");
    const [completion, options] = tutorJobs.completeTurn.mock.calls[0]!;
    expect(completion.contextSourceRefs).toEqual([{ sourceId: chunkA.sourceId, sourceVersion: 0 }]);
    expect(options).not.toHaveProperty("globalMemoryIds");
  });

  it("blocks provider dispatch when an injected temporary memory expires before send or fails DB re-check", async () => {
    const tempMemoryId = "00000000-0000-4000-8000-0000000000bb";
    const courseId = "00000000-0000-4000-8000-0000000000ca";
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-21T00:00:00.000Z"));
      const { deps, provider, budget, tutorJobs } = setup();
      tutorJobs.getUserTurn.mockResolvedValueOnce({ ...turn, courseId, sourceVersions: { [chunkA.sourceId]: 0 } });
      const memories = {
        listContext: vi.fn(async () => ({
          memories: [{
            id: tempMemoryId, workspaceId: claimedJob.workspaceId, courseId,
            kind: "temporary" as const, text: "Short-lived preference", sourceTurnIds: [claimedJob.userTurnId],
            version: 0, expiresAt: "2026-11-21T00:00:01.000Z", status: "active" as const,
            createdAt: claimedJob.createdAt, updatedAt: claimedJob.updatedAt,
          }],
          sourceRefs: [],
        })),
      };
      // Advance clock past expiresAt right when resolveModel runs (between prompt assembly and beforeSend).
      const resolveModel = vi.fn(async () => {
        vi.advanceTimersByTime(2_000);
        return {
          provider,
          modelSnapshot: { id: "m1", providerId: "p", modelName: "m", inputCentsPerMillion: 100, outputCentsPerMillion: 200 },
          inputCentsPerMillion: 100, outputCentsPerMillion: 200,
        };
      });
      await expect(createTutorTurnHandler({ ...deps, memories, resolveModel })(claimedJob.id))
        .rejects.toMatchObject({ code: "CONFLICT" });
      expect(provider.complete).not.toHaveBeenCalled();
      expect(budget.release).toHaveBeenCalledWith(expect.anything(), `tutor:${claimedJob.id}`, "not_sent");
    } finally {
      vi.useRealTimers();
    }

    // DB-authoritative assertGlobalMemoriesCurrent rejection also prevents provider dispatch.
    const { deps: dbDeps, provider: dbProvider, budget: dbBudget, tutorJobs: dbJobs } = setup();
    dbJobs.getUserTurn.mockResolvedValueOnce({ ...turn, courseId, sourceVersions: { [chunkA.sourceId]: 0 } });
    const assertGlobalMemoriesCurrent = vi.fn(async () => {
      throw Object.assign(new Error("stream global memory is no longer active"), { code: "CONFLICT" });
    });
    const dbMemories = {
      listContext: vi.fn(async () => ({
        memories: [{
          id: tempMemoryId, workspaceId: claimedJob.workspaceId, courseId,
          kind: "temporary" as const, text: "Short-lived preference", sourceTurnIds: [claimedJob.userTurnId],
          version: 0, expiresAt: "2099-01-01T00:00:00.000Z", status: "active" as const,
          createdAt: claimedJob.createdAt, updatedAt: claimedJob.updatedAt,
        }],
        sourceRefs: [],
      })),
    };
    await expect(createTutorTurnHandler({
      ...dbDeps,
      tutorJobs: { ...dbJobs, assertGlobalMemoriesCurrent },
      memories: dbMemories,
    })(claimedJob.id)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(assertGlobalMemoriesCurrent).toHaveBeenCalledWith(
      { workspaceId: claimedJob.workspaceId, ownerUserId: claimedJob.ownerUserId },
      [tempMemoryId], claimedJob.id,
    );
    expect(dbProvider.complete).not.toHaveBeenCalled();
    expect(dbBudget.release).toHaveBeenCalledWith(expect.anything(), `tutor:${claimedJob.id}`, "not_sent");
  });

  it("seals the stream if a course memory expires between dispatch and the first delta", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-21T00:00:00.000Z"));
      const { deps, tutorJobs, provider } = setup({ claim: { ...claimedJob, executionId: claimedJob.assistantTurnId } });
      const courseId = "00000000-0000-4000-8000-0000000000ca";
      const memoryId = "00000000-0000-4000-8000-0000000000bb";
      tutorJobs.getUserTurn.mockResolvedValueOnce({ ...turn, courseId, sourceVersions: { [chunkA.sourceId]: 0 } });
      const stream = { begin: vi.fn(async () => {}), append: vi.fn(async () => 1), seal: vi.fn(async () => {}) };
      const memories = { listContext: async () => ({ sourceRefs: [], memories: [{
        id: memoryId, workspaceId: claimedJob.workspaceId, courseId, kind: "temporary" as const, text: "Course note",
        sourceTurnIds: [claimedJob.userTurnId], version: 0, expiresAt: "2026-11-21T00:00:01.000Z", status: "active" as const,
        createdAt: claimedJob.createdAt, updatedAt: claimedJob.updatedAt,
      }] }) };
      provider.complete.mockImplementationOnce(async (_input, _signal, delta) => {
        vi.setSystemTime(new Date("2026-11-21T00:00:02.000Z"));
        await delta("Never publish this");
        return { text: "Never publish this", citedChunkIds: [], candidates: [], requestId: null, inputTokens: 10, outputTokens: 10 };
      });
      await expect(createTutorTurnHandler({ ...deps, memories, stream })(claimedJob.id)).rejects.toMatchObject({ code: "CONFLICT" });
      expect(stream.begin).toHaveBeenCalledOnce();
      expect(stream.append).not.toHaveBeenCalled();
      expect(stream.seal).toHaveBeenCalledOnce();
      expect(tutorJobs.completeTurn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves onFailedResponseUsage across stream delta batching so refused streams settle confirmed usage instead of outcome_unknown", async () => {
    const { deps, provider, budget, tutorJobs } = setup();
    const stream = {
      begin: vi.fn(async () => {}),
      seal: vi.fn(async () => {}),
      append: vi.fn(async () => 1),
    };
    const refusal = new OpeningProviderError("PROVIDER_REFUSAL", "refused", true);
    provider.complete.mockImplementationOnce(async (_input, _signal, onTextDelta) => {
      expect(typeof onTextDelta?.[onFailedResponseUsage]).toBe("function");
      onTextDelta?.[onFailedResponseUsage]?.({
        requestId: "req-refused-usage",
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        cachedInputTokens: null,
      });
      throw refusal;
    });

    await expect(createTutorTurnHandler({ ...deps, stream })(claimedJob.id)).rejects.toBe(refusal);
    expect(budget.settle).toHaveBeenCalledWith(
      { workspaceId: claimedJob.workspaceId, ownerUserId: claimedJob.ownerUserId },
      "res-1",
      expect.any(Number),
    );
    expect(budget.markUnknown).not.toHaveBeenCalled();
    expect(tutorJobs.markUnknown).not.toHaveBeenCalled();
    expect(tutorJobs.fail).toHaveBeenCalledOnce();
  });

  it("aborts beforeSend when temporary memory expires during an earlier beforeSend await or when final send gate rejects execution/epoch", async () => {
    const tempMemoryId = "00000000-0000-4000-8000-0000000000cc";
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-21T00:00:00.000Z"));
      const { deps, provider, budget } = setup();
      const memories = {
        listContext: vi.fn(async () => ({
          memories: [{
            id: tempMemoryId, workspaceId: claimedJob.workspaceId, courseId: null,
            kind: "temporary" as const, text: "Expiring during beforeSend", sourceTurnIds: [claimedJob.userTurnId],
            version: 0, expiresAt: "2026-11-21T00:00:01.000Z", status: "active" as const,
            createdAt: claimedJob.createdAt, updatedAt: claimedJob.updatedAt,
          }],
          sourceRefs: [],
        })),
      };
      // Advance wall clock INSIDE beforeSend's privacy epoch check (after earlier checks already ran).
      let epochReads = 0;
      const privacy = {
        getWorkspaceEpoch: vi.fn(async () => {
          epochReads += 1;
          if (epochReads >= 2) vi.advanceTimersByTime(2_000);
          return 0;
        }),
        listExcludedSourceIds: vi.fn(async () => []),
      };
      await expect(createTutorTurnHandler({ ...deps, memories, privacy })(claimedJob.id))
        .rejects.toMatchObject({ code: "CONFLICT" });
      expect(provider.complete).not.toHaveBeenCalled();
      expect(budget.release).toHaveBeenCalledWith(expect.anything(), `tutor:${claimedJob.id}`, "not_sent");
    } finally {
      vi.useRealTimers();
    }

    // Final send gate (assertSendAuthorized) sees timing_execution_id cleared / privacy_epoch drift and blocks provider.complete.
    const claimedWithExecution = {
      ...claimedJob,
      claimToken: "00000000-0000-4000-8000-0000000000d1",
      executionId: "00000000-0000-4000-8000-0000000000d2",
    };
    const { deps: gateDeps, provider: gateProvider, budget: gateBudget, tutorJobs: gateJobs } = setup({ claim: claimedWithExecution });
    const assertSendAuthorized = vi.fn(async () => {
      throw Object.assign(new Error("tutor job claim is no longer current"), { code: "CONFLICT" });
    });
    await expect(createTutorTurnHandler({
      ...gateDeps,
      tutorJobs: { ...gateJobs, assertSendAuthorized },
    })(claimedJob.id)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(assertSendAuthorized).toHaveBeenCalledWith(
      { workspaceId: claimedJob.workspaceId, ownerUserId: claimedJob.ownerUserId },
      claimedJob.id,
      expect.objectContaining({
        claimToken: claimedWithExecution.claimToken,
        executionId: claimedWithExecution.executionId,
      }),
    );
    expect(gateProvider.complete).not.toHaveBeenCalled();
    expect(gateBudget.release).toHaveBeenCalledWith(expect.anything(), `tutor:${claimedJob.id}`, "not_sent");
  });

  it("never exempts conversation history or learner-context sources from course admission even when also cited by an active global memory", async () => {
    const historySharedSourceId = "00000000-0000-4000-8000-000000000091";
    const learnerSharedSourceId = "00000000-0000-4000-8000-000000000092";
    const memoryOnlySourceId = "00000000-0000-4000-8000-000000000093";
    const memoryId = "00000000-0000-4000-8000-000000000094";
    const { deps, tutorJobs } = setup();
    tutorJobs.loadHistoryContext.mockResolvedValueOnce({
      history: [{ role: "user", text: "yesterday" }, { role: "assistant", text: "used detached history source" }],
      sourceRefs: [{ sourceId: historySharedSourceId, sourceVersion: 0 }],
    });
    const learnerContext = {
      read: vi.fn(async () => ({
        courseId: claimedJob.conversationId,
        title: "力学",
        asOf: "2026-11-21T00:00:00Z",
        privacyEpoch: 0,
        goal: null,
        weaknesses: [],
        recentMistakes: [],
        observationIds: [],
        sourceRefs: [{ sourceId: learnerSharedSourceId, sourceVersion: 0 }],
      })),
      assertCurrent: vi.fn(async () => {}),
    };
    const memories = {
      listContext: vi.fn(async () => ({
        memories: [{
          id: memoryId, workspaceId: claimedJob.workspaceId, courseId: null,
          kind: "confirmed" as const, text: "Global memory sharing sources", sourceTurnIds: [claimedJob.userTurnId],
          version: 0, expiresAt: null, status: "active" as const, createdAt: claimedJob.createdAt, updatedAt: claimedJob.updatedAt,
        }],
        sourceRefs: [
          { sourceId: historySharedSourceId, sourceVersion: 0 },
          { sourceId: learnerSharedSourceId, sourceVersion: 0 },
          { sourceId: memoryOnlySourceId, sourceVersion: 0 },
        ],
      })),
    };
    const stream = { begin: vi.fn(async () => {}), seal: vi.fn(async () => {}), append: vi.fn(async () => 1) };
    const assertSendAuthorized = vi.fn(async () => {});

    await expect(createTutorTurnHandler({
      ...deps,
      tutorJobs: { ...tutorJobs, assertSendAuthorized },
      learnerContext,
      memories,
      stream,
    })(claimedJob.id)).resolves.toEqual({ skipped: false });

    // Only memoryOnlySourceId may enter memoryLineageSourceIds; historySharedSourceId and learnerSharedSourceId stay course-bound!
    for (const observed of [
      assertSendAuthorized.mock.calls[0]?.[2],
      stream.begin.mock.calls[0]?.[2],
      tutorJobs.withStreamPublication.mock.calls[0]?.[2],
      tutorJobs.completeTurn.mock.calls[0]?.[1],
    ]) {
      expect(observed).toMatchObject({
        memoryLineageSourceIds: [memoryOnlySourceId],
        globalMemoryIds: [memoryId],
      });
    }
  });

  it("preserves memoryOnly history provenance on follow-up course turns while keeping non-memory history course-bound", async () => {
    const priorMemoryOnlySourceId = "00000000-0000-4000-8000-000000000095";
    const priorCourseSourceId = "00000000-0000-4000-8000-000000000096";
    const memoryId = "00000000-0000-4000-8000-000000000097";
    const { deps, tutorJobs } = setup();
    tutorJobs.loadHistoryContext.mockResolvedValueOnce({
      history: [{ role: "user", text: "turn 1" }, { role: "assistant", text: "turn 1 answer" }],
      sourceRefs: [
        { sourceId: priorCourseSourceId, sourceVersion: 0 },
        { sourceId: priorMemoryOnlySourceId, sourceVersion: 0, memoryOnly: true },
      ],
    });
    const memories = {
      listContext: vi.fn(async () => ({
        memories: [{
          id: memoryId, workspaceId: claimedJob.workspaceId, courseId: null,
          kind: "confirmed" as const, text: "Global memory", sourceTurnIds: [claimedJob.userTurnId],
          version: 0, expiresAt: null, status: "active" as const, createdAt: claimedJob.createdAt, updatedAt: claimedJob.updatedAt,
        }],
        sourceRefs: [
          { sourceId: priorCourseSourceId, sourceVersion: 0 },
          { sourceId: priorMemoryOnlySourceId, sourceVersion: 0 },
        ],
      })),
    };
    const authorizeSend = vi.fn<OpeningTutorJobsRepository["authorizeSend"]>(async (_scope, _job, _ctx, startSend, beforeStartSend) => {
      beforeStartSend?.();
      return startSend();
    });

    await expect(createTutorTurnHandler({
      ...deps,
      tutorJobs: { ...tutorJobs, authorizeSend },
      memories,
    })(claimedJob.id)).resolves.toEqual({ skipped: false });

    expect(authorizeSend).toHaveBeenCalledWith(
      expect.anything(),
      claimedJob.id,
      expect.objectContaining({
        memoryLineageSourceIds: [priorMemoryOnlySourceId],
        globalMemoryIds: [memoryId],
      }),
      expect.any(Function),
      expect.any(Function),
    );
    expect(tutorJobs.completeTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        contextSourceRefs: expect.arrayContaining([
          { sourceId: priorCourseSourceId, sourceVersion: 0 },
          { sourceId: priorMemoryOnlySourceId, sourceVersion: 0, memoryOnly: true },
        ]),
      }),
      expect.objectContaining({
        memoryLineageSourceIds: [priorMemoryOnlySourceId],
        globalMemoryIds: [memoryId],
      }),
    );
  });

  it("propagates earliest temporaryMemoryExpiresAt to stream cache and invokes provider synchronously inside authorizeSend", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-21T00:00:00.000Z"));
      const tempEarlier = "00000000-0000-4000-8000-0000000000d5";
      const tempLater = "00000000-0000-4000-8000-0000000000d6";
      const { deps, provider, tutorJobs } = setup();
      const events: string[] = [];
      const stream = { begin: vi.fn(async () => {}), seal: vi.fn(async () => {}), append: vi.fn(async () => 1) };
      const memories = {
        listContext: vi.fn(async () => ({
          memories: [
            {
              id: tempLater, workspaceId: claimedJob.workspaceId, courseId: null,
              kind: "temporary" as const, text: "Later expiry", sourceTurnIds: [claimedJob.userTurnId],
              version: 0, expiresAt: "2026-11-21T02:00:00.000Z", status: "active" as const,
              createdAt: claimedJob.createdAt, updatedAt: claimedJob.updatedAt,
            },
            {
              id: tempEarlier, workspaceId: claimedJob.workspaceId, courseId: null,
              kind: "temporary" as const, text: "Earlier expiry", sourceTurnIds: [claimedJob.userTurnId],
              version: 0, expiresAt: "2026-11-21T00:30:00.000Z", status: "active" as const,
              createdAt: claimedJob.createdAt, updatedAt: claimedJob.updatedAt,
            },
          ],
          sourceRefs: [],
        })),
      };
      provider.complete.mockImplementationOnce((_input, _signal, onTextDelta) => {
        events.push("provider-invoked-sync");
        return Promise.resolve(onTextDelta?.("ok")).then(() => ({
          text: "ok", citedChunkIds: [], candidates: [], requestId: null, inputTokens: 10, outputTokens: 10,
        }));
      });
      const authorizeSend = vi.fn<OpeningTutorJobsRepository["authorizeSend"]>(async (_scope, _job, _ctx, startSend, beforeStartSend) => {
        events.push("db-lock-held");
        beforeStartSend?.();
        const inFlight = startSend();
        events.push("db-lock-released");
        return await inFlight;
      });
      await expect(createTutorTurnHandler({
        ...deps,
        tutorJobs: { ...tutorJobs, authorizeSend },
        memories,
        stream,
      })(claimedJob.id)).resolves.toEqual({ skipped: false });
      expect(events).toEqual(["db-lock-held", "provider-invoked-sync", "db-lock-released"]);
      expect(stream.begin).toHaveBeenCalledWith(
        claimedJob.workspaceId,
        claimedJob.id,
        expect.objectContaining({ temporaryMemoryExpiresAt: "2026-11-21T00:30:00.000Z" }),
      );
      expect(DEFAULT_SEAL_DEADLINE_MS).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates retained history memoryIds/temporaryMemoryExpiresAt and aborts fail-closed when Redis append throws TutorStreamExpiredError", async () => {
    const historyMemId = "00000000-0000-4000-8000-0000000000e1";
    const historyExpiresAt = "2099-01-01T00:05:00.000Z";
    const { deps, provider, tutorJobs } = setup();
    tutorJobs.loadHistoryContext.mockResolvedValueOnce({
      history: [{ role: "user", text: "prior" }, { role: "assistant", text: "prior answer using temp memory" }],
      sourceRefs: [],
      memoryIds: [historyMemId],
      temporaryMemoryExpiresAt: historyExpiresAt,
    });
    const onStreamUnavailable = vi.fn();
    const stream = {
      begin: vi.fn(async () => {}),
      seal: vi.fn(async () => {}),
      append: vi.fn(async () => { throw new TutorStreamExpiredError(); }),
    };
    provider.complete.mockImplementationOnce(async (_input, _signal, onTextDelta) => {
      await onTextDelta?.("expired delta");
      return { text: "expired delta", citedChunkIds: [], candidates: [], requestId: null, inputTokens: 10, outputTokens: 10 };
    });

    await expect(createTutorTurnHandler({
      ...deps, stream, onStreamUnavailable,
    })(claimedJob.id)).rejects.toBeInstanceOf(TutorStreamExpiredError);
    expect(stream.begin).toHaveBeenCalledWith(
      claimedJob.workspaceId,
      claimedJob.id,
      expect.objectContaining({
        globalMemoryIds: [historyMemId],
        temporaryMemoryExpiresAt: historyExpiresAt,
      }),
    );
    expect(stream.append).toHaveBeenCalledWith(
      claimedJob.workspaceId,
      claimedJob.id,
      "expired delta",
      undefined,
      0,
      undefined,
      historyExpiresAt,
    );
    expect(onStreamUnavailable).not.toHaveBeenCalled();
    expect(tutorJobs.completeTurn).not.toHaveBeenCalled();
    expect(tutorJobs.fail).toHaveBeenCalledOnce();
  });

  it("propagates ancestor temporaryMemoryExpiresAt and dependencyMemoryIds from a derived permanent memory into authorizeSend, stream, and completeTurn", async () => {
    const ancestorTempId = "00000000-0000-4000-8000-0000000000f1";
    const derivedPermId = "00000000-0000-4000-8000-0000000000f2";
    const ancestorExpiresAt = "2099-01-01T00:15:00.000Z";
    const { deps, provider, tutorJobs } = setup();
    const authorizeSend = vi.fn(async (_scope, _jobId, _context, startSend, beforeStartSend) => {
      beforeStartSend?.();
      return await startSend();
    });
    const stream = {
      begin: vi.fn(async () => {}),
      seal: vi.fn(async () => {}),
      append: vi.fn(async () => 1),
    };
    provider.complete.mockImplementationOnce(async (_input, _signal, onTextDelta) => {
      await onTextDelta?.("chunk");
      return { text: "chunk", citedChunkIds: [], candidates: [], requestId: null, inputTokens: 10, outputTokens: 10 };
    });
    const memories = {
      listContext: vi.fn(async () => ({
        memories: [{
          id: derivedPermId,
          workspaceId: claimedJob.workspaceId,
          courseId: null,
          kind: "confirmed" as const,
          text: "Derived permanent memory",
          sourceTurnIds: [claimedJob.userTurnId],
          version: 1,
          expiresAt: null,
          status: "active" as const,
          createdAt: "2026-11-21T00:00:00.000Z",
          updatedAt: "2026-11-21T00:00:00.000Z",
        }],
        sourceRefs: [],
        temporaryMemoryExpiresAt: ancestorExpiresAt,
        dependencyMemoryIds: [ancestorTempId],
      })),
    };

    await expect(createTutorTurnHandler({
      ...deps,
      tutorJobs: { ...tutorJobs, authorizeSend },
      memories,
      stream,
    })(claimedJob.id)).resolves.toEqual({ skipped: false });
    expect(authorizeSend).toHaveBeenCalledWith(
      expect.anything(),
      claimedJob.id,
      expect.objectContaining({ globalMemoryIds: [ancestorTempId, derivedPermId] }),
      expect.any(Function),
      expect.any(Function),
    );
    expect(stream.begin).toHaveBeenCalledWith(
      claimedJob.workspaceId,
      claimedJob.id,
      expect.objectContaining({
        globalMemoryIds: [ancestorTempId, derivedPermId],
        temporaryMemoryExpiresAt: ancestorExpiresAt,
      }),
    );
    expect(stream.append).toHaveBeenCalledWith(
      claimedJob.workspaceId,
      claimedJob.id,
      "chunk",
      undefined,
      0,
      undefined,
      ancestorExpiresAt,
    );
    expect(tutorJobs.completeTurn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ globalMemoryIds: [ancestorTempId, derivedPermId] }),
    );
  });
});
