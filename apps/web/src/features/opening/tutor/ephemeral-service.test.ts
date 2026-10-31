import { format } from "node:util";
import type { EphemeralProvenanceRepository } from "@aistudy/database";
import { describe, expect, it, vi } from "vitest";
import type { ProviderInput, ProviderOutput, SourceChunk, StudyIntentEvent } from "@aistudy/contracts";
import { OpeningProviderError } from "@aistudy/ai";
import { createEphemeralTutorService, type EphemeralTutorDeps } from "./ephemeral-service";

const workspaceId = "10000000-0000-4000-8000-000000000001";
const ownerUserId = "10000000-0000-4000-8000-000000000002";
const sourceId = "10000000-0000-4000-8000-000000000003";
const foreignSource = "10000000-0000-4000-8000-000000000099";
const chunkId = "10000000-0000-4000-8000-000000000004";
const scope = { workspaceId, ownerUserId };

const chunk: SourceChunk = {
  id: chunkId,
  sourceId,
  sourceVersion: 1,
  page: 2,
  slideLabel: null,
  startMs: null,
  endMs: null,
  text: "PRIVATE-QUOTE-DO-NOT-LOG",
  imageObjectKey: null,
};

const output: ProviderOutput = {
  text: "I hear you",
  citedChunkIds: [chunkId],
  requestId: "req-eph",
  candidates: [{ kind: "task", title: "nap", minutes: 20, dueText: null }],
  inputTokens: 8,
  outputTokens: 4,
};

function deps(overrides?: {
  complete?: (input: ProviderInput, signal?: AbortSignal) => Promise<ProviderOutput>;
  chunks?: SourceChunk[];
  sources?: string[];
  provenance?: EphemeralProvenanceRepository;
  resolveModel?: EphemeralTutorDeps["resolveModel"];
  listReadySourceIdsForCourse?: EphemeralTutorDeps["listReadySourceIdsForCourse"];
  studyContext?: EphemeralTutorDeps["studyContext"];
  exposures?: EphemeralTutorDeps["exposures"];
  learnerContext?: EphemeralTutorDeps["learnerContext"];
}) {
  const writes: string[] = [];
  const budget = {
    reserve: vi.fn(async () => {
      writes.push("budget:reserve");
      return { id: "res-1" };
    }),
    release: vi.fn(async () => writes.push("budget:release")),
    settle: vi.fn(async () => writes.push("budget:settle")),
    claimExecution: async () => true, markUnknown: vi.fn(async () => writes.push("budget:unknown")),
  };
  const complete = vi.fn(
    overrides?.complete ?? (async () => output),
  );
  const service = createEphemeralTutorService({
    sources: {
      listOwnedIds: async (_scope, ids) => overrides?.sources ?? ids,
    },
    chunks: {
      listForSources: async (_scope, ids) => {
        const all = overrides?.chunks ?? [chunk];
        return all.filter((row) => ids.includes(row.sourceId));
      },
    },
    privacy: { snapshot: async () => ({ epoch: 0, excludedSourceIds: [] }), currentEpoch: async () => 0 },
    budget,
    provenance: overrides?.provenance,
    studyContext: overrides?.studyContext,
    learnerContext: overrides?.learnerContext,
    exposures: overrides?.exposures,
    provider: { complete },
    resolveModel: overrides?.resolveModel,
    listReadySourceIdsForCourse: overrides?.listReadySourceIdsForCourse,
    config: {
      maxContextCharacters: 12_000,
      reservedCents: 10,
      maxOutputTokens: 256,
      inputCentsPerMillion: 100,
      outputCentsPerMillion: 200,
    },
    now: () => 1_700_000_000_000,
    requestKey: () => "eph-key",
  });
  return { service, budget, complete, writes };
}

describe("ephemeral tutor service", () => {
  it.each(["继续学习", "继续", "下一步", "再来一道题", "带我继续学", "我们继续吧", "开始学习", "从哪里开始", "出一道题"])("keeps %s in temporary question answering", async text => {
    const f = deps();
    await f.service.replyEphemeral(scope, { text, sourceIds: [], history: [] });
    expect(f.complete).toHaveBeenCalledOnce();
  });
  it("infers a hint without a client mode and keeps an ordinary explanation temporary", async () => {
    const f = deps();
    await f.service.replyEphemeral(scope, { text: "先别给答案，只给提示", sourceIds: [], history: [] });
    expect(f.complete.mock.calls[0]?.[0].mode).toBe("hint");
    await f.service.replyEphemeral(scope, { text: "解释这个证明", sourceIds: [], history: [] });
    expect(f.complete.mock.calls[1]?.[0].mode).toBe("explain");
  });
  it("keeps inferred proposals and unavailable record queries out of temporary model calls", async () => {
    const f = deps();
    await expect(f.service.replyEphemeral(scope, { text: "帮我做学习计划", sourceIds: [], history: [] })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(f.service.replyEphemeral(scope, { text: "我的学习记录有哪些？", sourceIds: [], history: [] })).rejects.toMatchObject({ code: "SYSTEM_QUERY_DISABLED" });
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.budget.reserve).not.toHaveBeenCalled();
  });
  it("keeps temporary model dispatch, prices and attribution together", async () => {
    const modelSnapshot = { id: "selected", providerId: "other", modelName: "other-model", inputCentsPerMillion: 1_000_000, outputCentsPerMillion: 2_000_000 };
    const selected = { complete: vi.fn(async () => output) };
    const resolveModel = vi.fn(async () => ({ provider: selected, modelSnapshot, ...modelSnapshot }));
    const f = deps({ resolveModel });
    await f.service.replyEphemeral(scope, { text: "hello", sourceIds: [], mode: "listen", history: [] });
    expect(resolveModel).toHaveBeenCalledWith(scope, "listen");
    expect(f.complete).not.toHaveBeenCalled();
    expect(selected.complete).toHaveBeenCalledOnce();
    expect(f.budget.reserve).toHaveBeenCalledWith(expect.objectContaining({ requestId: "eph-key", modelSnapshot }));
    expect(f.budget.settle).toHaveBeenCalledWith("res-1", 16, { resultRef: "ephemeral:eph-key" });
  });

  it("does not silently ignore images on the temporary route", async () => {
    const complete = vi.fn(async () => output);
    const images = [{ mediaType: "image/png" as const, data: "data:image/png;base64,aGVsbG8=", sourceId, physicalPage: 2 }];
    const service = createEphemeralTutorService({ sources: { listOwnedIds: async () => [sourceId] }, chunks: { listForSources: async () => [chunk] },
      privacy: { snapshot: async () => ({ epoch: 0, excludedSourceIds: [] }), currentEpoch: async () => 0 },
      budget: { reserve: async () => ({ id: "r" }), settle: async () => {}, release: async () => {}, claimExecution: async () => true, markUnknown: async () => {} },
      provider: { complete }, resolveModel: async () => ({ provider: { complete }, supportsVision: true, modelSnapshot: { id: "v", providerId: "p", modelName: "v", mediaInputTokenUpperBound: 8192, mediaMaxInputBytes: 1048576, mediaInputCentsPerMillion: 100, inputCentsPerMillion: 1, outputCentsPerMillion: 1 }, inputCentsPerMillion: 1, outputCentsPerMillion: 1 }),
      pageImages: async () => images, config: { maxContextCharacters: 12000, maxOutputTokens: 256, reservedCents: 10, inputCentsPerMillion: 1, outputCentsPerMillion: 1 } });
    await service.replyEphemeral(scope, { text: "read page", sourceIds: [sourceId], currentPage: 2, mode: "explain", history: [] });
    expect(complete.mock.calls[0]?.[0]).toMatchObject({ mediaCapability: "text_plus_page_images", imageParts: images });
  });
  it("blocks an unavailable temporary route without a fallback provider or charge", async () => {
    const f = deps({ resolveModel: async () => { throw new Error("route unavailable"); } });
    await expect(f.service.replyEphemeral(scope, { text: "hello", sourceIds: [], mode: "listen", history: [] })).rejects.toThrow("route unavailable");
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.budget.reserve).not.toHaveBeenCalled();
  });

  it("strips listen and think_together candidates and never persists conversation rows", async () => {
    const listen = deps();
    const heard = await listen.service.replyEphemeral(scope, {
      text: "just listen",
      sourceIds: [sourceId],
      chunkId,
      mode: "listen",
      history: [{ role: "user", text: "earlier" }],
    });
    expect(heard.candidates).toEqual([]);
    expect(heard.text).toBe("I hear you");
    expect(heard.citedChunkIds).toEqual([chunkId]);
    expect(heard.citations).toEqual([
      expect.objectContaining({ chunkId, sourceId, sourceVersion: 1 }),
    ]);
    expect(listen.complete).toHaveBeenCalledOnce();
    const sent = listen.complete.mock.calls[0]![0];
    expect(sent.mode).toBe("listen");
    expect(sent.instruction).toMatch(/不要自动创建任务|do not (auto-)?create tasks/i);
    expect(listen.budget.reserve).toHaveBeenCalledOnce();
    expect(listen.writes.some((row) => /conversation|turn|job|candidate|memory|learning/.test(row))).toBe(false);

    const think = deps();
    const thought = await think.service.replyEphemeral(scope, {
      text: "think with me",
      sourceIds: [],
      mode: "think_together",
      history: [],
    });
    expect(thought.candidates).toEqual([]);
  });

  it("rejects over-limit history before any provider or budget call", async () => {
    const { service, complete, budget } = deps();
    const history = Array.from({ length: 17 }, () => ({
      role: "user" as const,
      text: "turn",
    }));
    await expect(
      service.replyEphemeral(scope, {
        text: "too much",
        sourceIds: [],
        mode: "listen",
        history,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(complete).not.toHaveBeenCalled();
    expect(budget.reserve).not.toHaveBeenCalled();
  });

  it("refuses a foreign source and an unauthorized page", async () => {
    const foreign = deps({ sources: [sourceId] });
    await expect(
      foreign.service.replyEphemeral(scope, {
        text: "show me",
        sourceIds: [foreignSource],
        mode: "listen",
        history: [],
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(foreign.complete).not.toHaveBeenCalled();

    const page = deps();
    await expect(
      page.service.replyEphemeral(scope, {
        text: "this page",
        sourceIds: [sourceId],
        mode: "explain",
        history: [],
        currentPage: 99,
      }),
    ).rejects.toMatchObject({ status: 422, code: "page_not_in_sources" });
    expect(page.complete).not.toHaveBeenCalled();
  });

  it.each([{ chunks: [] }, { chunks: [{ ...chunk, text: " \n\t" }] }, { chunks: [chunk] }])("refuses missing material in a selection before calling or charging the provider (%#)", async ({ chunks }) => {
    const f = deps({ chunks, sources: [sourceId, foreignSource] });
    await expect(f.service.replyEphemeral(scope, { text: "read both", sourceIds: [sourceId, foreignSource], mode: "explain", history: [] }))
      .rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE", status: 422 });
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.budget.reserve).not.toHaveBeenCalled();
  });
  it("keeps only citation ids that belong to the authorized context", async () => {
    const { service } = deps({
      complete: async () => ({
        ...output,
        citedChunkIds: [chunkId, "10000000-0000-4000-8000-000000000077"],
      }),
    });
    const heard = await service.replyEphemeral(scope, {
      text: "cite",
      sourceIds: [sourceId],
      chunkId,
      mode: "explain",
      history: [],
    });
    expect(heard.citedChunkIds).toEqual([chunkId]);
    expect(heard.citations).toEqual([
      expect.objectContaining({ chunkId, sourceId, sourceVersion: 1 }),
    ]);
    expect(heard.citations[0]?.label).toContain("page 2");
    expect(JSON.stringify(heard)).not.toContain("PRIVATE-QUOTE");
  });

  it("returns empty citations when the model cites nothing (no fabricated chips)", async () => {
    const { service } = deps({
      complete: async () => ({ ...output, citedChunkIds: [] }),
    });
    const heard = await service.replyEphemeral(scope, {
      text: "general",
      sourceIds: [sourceId],
      chunkId,
      mode: "explain",
      history: [],
    });
    expect(heard.citedChunkIds).toEqual([]);
    expect(heard.citations).toEqual([]);
  });

  it("does not fall back to a saved conversation when the provider fails", async () => {
    const { service, writes } = deps({
      complete: async () => {
        throw new OpeningProviderError("PROVIDER_UNAVAILABLE", "down", true);
      },
    });
    await expect(
      service.replyEphemeral(scope, {
        text: "hello",
        sourceIds: [],
        mode: "listen",
        history: [],
      }),
    ).rejects.toBeInstanceOf(OpeningProviderError);
    expect(writes.some((row) => /conversation|turn|job|saved/.test(row))).toBe(false);
  });
});

describe("ephemeral content-free provenance", () => {
  it.each([true, false])("only uses verified temporary history to recognize a repeat (verified=%s)", async verified => {
    const f = deps({ provenance: { resolveHistory: async () => verified ? [] : null, record: async () => chunkId } });
    await f.service.replyEphemeral(scope, { text: "这题答案是什么", sourceIds: [], historyPrivacyEpoch: 0,
      history: [{ role: "user", text: "这题答案是什么" }, { role: "assistant", text: "先想起步方向", provenanceId: chunkId }] });
    const call = f.complete.mock.calls[0]![0];
    expect(call.mode).toBe(verified ? "explain" : "hint");
    if (verified) expect(call.instruction).not.toContain("两个简短的起步方向");
    else expect(call.instruction).toContain("两个简短的起步方向");
  });
  it("uses server history lineage when the current selection has no sources", async () => {
    const historyRefs = [{ sourceId, sourceVersion: 1 }];
    const provenance = { resolveHistory: vi.fn(async () => historyRefs), record: vi.fn(async () => chunkId) };
    const f = deps({ sources: [], chunks: [], provenance });
    const history = [{ role: "assistant" as const, text: "prior answer", provenanceId: sourceId }];
    const reply = await f.service.replyEphemeral(scope, { text: "next", sourceIds: [], mode: "listen", history, historyPrivacyEpoch: 0 });
    expect(provenance.resolveHistory).toHaveBeenCalledWith(scope, history, 0);
    expect(provenance.record).toHaveBeenCalledWith(scope, { requestId: "eph-key", privacyEpoch: 0, contextSourceRefs: historyRefs });
    expect(reply.provenanceId).toBe(chunkId);
    expect(f.complete.mock.calls[0]![0]!.history).toEqual([{ role: "assistant", text: "prior answer" }]);
  });
  it.each([
    { label: "missing", provenanceId: undefined },
    { label: "unavailable or revoked", provenanceId: foreignSource },
  ])("discards $label history provenance before sending the current allowed material", async ({ provenanceId }) => {
    const provenance = { resolveHistory: vi.fn(async () => null), record: vi.fn(async () => chunkId) };
    const f = deps({ provenance });
    const reply = await f.service.replyEphemeral(scope, {
      text: "next", sourceIds: [sourceId], chunkId, mode: "listen", historyPrivacyEpoch: 0,
      history: [{ role: "assistant", text: "UNVERIFIED-OLD-HISTORY", ...(provenanceId ? { provenanceId } : {}) }],
    });
    const sent = f.complete.mock.calls[0]![0]!;
    expect(sent.history).toEqual([]);
    expect(sent.chunks).toEqual([chunk]);
    expect(JSON.stringify(sent)).not.toContain("UNVERIFIED-OLD-HISTORY");
    expect(provenance.record).toHaveBeenCalledWith(scope, {
      requestId: "eph-key", privacyEpoch: 0, contextSourceRefs: [{ sourceId, sourceVersion: 1 }],
    });
    expect(reply).toMatchObject({ historyDiscarded: true, provenanceId: chunkId });
  });

  it("discards history when its provenance repository is unavailable", async () => {
    const f = deps();
    const reply = await f.service.replyEphemeral(scope, {
      text: "next", sourceIds: [], mode: "listen", historyPrivacyEpoch: 0,
      history: [{ role: "assistant", text: "UNVERIFIED-OLD-HISTORY", provenanceId: foreignSource }],
    });
    expect(f.complete.mock.calls[0]![0]!.history).toEqual([]);
    expect(reply).toMatchObject({ historyDiscarded: true, provenanceId: null });
  });

  it("does not resolve or discard an empty history", async () => {
    const provenance = { resolveHistory: vi.fn(async () => null), record: vi.fn(async () => chunkId) };
    const f = deps({ provenance });
    const reply = await f.service.replyEphemeral(scope, { text: "next", sourceIds: [], mode: "listen", history: [] });
    expect(provenance.resolveHistory).not.toHaveBeenCalled();
    expect(f.complete.mock.calls[0]![0]!.history).toEqual([]);
    expect(provenance.record).toHaveBeenCalledWith(scope, { requestId: "eph-key", privacyEpoch: 0, contextSourceRefs: [] });
    expect(reply.historyDiscarded).toBe(false);
  });

  it("discards old-epoch history without resolving its receipts", async () => {
    const provenance = { resolveHistory: vi.fn(async () => [{ sourceId, sourceVersion: 1 }]), record: vi.fn(async () => chunkId) };
    const f = deps({ provenance });
    const reply = await f.service.replyEphemeral(scope, {
      text: "next", sourceIds: [], mode: "listen", historyPrivacyEpoch: 99,
      history: [{ role: "assistant", text: "OLD-EPOCH-HISTORY", provenanceId: sourceId }],
    });
    expect(provenance.resolveHistory).not.toHaveBeenCalled();
    expect(f.complete.mock.calls[0]![0]!.history).toEqual([]);
    expect(provenance.record).toHaveBeenCalledWith(scope, { requestId: "eph-key", privacyEpoch: 0, contextSourceRefs: [] });
    expect(reply.historyDiscarded).toBe(true);
  });
  it("Package C: vague query still sends non-empty context when selected chunks exist", async () => {
    const f = deps({
      chunks: [{ ...chunk, text: "课程绪论：本周学习目标" }],
    });
    await f.service.replyEphemeral(scope, {
      text: "这道题怎么做？",
      sourceIds: [sourceId],
      mode: "explain",
      history: [],
    });
    const sent = f.complete.mock.calls[0]![0]!;
    expect(sent.chunks.length).toBeGreaterThan(0);
    expect(sent.chunks[0]?.sourceId).toBe(sourceId);
  });

  it("empty client sourceIds keeps and echoes the whole readable course pool", async () => {
    const courseId = "10000000-0000-4000-8000-0000000000c0";
    const pool = Array.from({ length: 9 }, (_, i) => {
      const id = "10000000-0000-4000-8000-00000000001" + String(i);
      return {
        sourceId: id,
        chunk: {
          ...chunk,
          id: "10000000-0000-4000-8000-00000000002" + String(i),
          sourceId: id,
          text: i === 2 ? "贝叶斯模型用于知识追踪" : "无关材料 " + String(i),
        } satisfies SourceChunk,
      };
    });
    const listReady = vi.fn(async () => pool.map((row) => row.sourceId));
    const f = deps({
      chunks: pool.map((row) => row.chunk),
      listReadySourceIdsForCourse: listReady,
    });
    const reply = await f.service.replyEphemeral(scope, {
      text: "请解释贝叶斯模型",
      sourceIds: [],
      courseId,
      mode: "explain",
      history: [],
    });
    expect(listReady).toHaveBeenCalledWith(scope, courseId);
    expect(reply.effectiveSourceIds).toBeDefined();
    expect(reply.effectiveSourceIds).toEqual(pool.map(row => row.sourceId));
    const sent = f.complete.mock.calls[0]![0]!;
    expect(sent.chunks.length).toBeGreaterThan(0);
    expect(sent.chunks.every((row) => reply.effectiveSourceIds!.includes(row.sourceId))).toBe(true);
  });

  it("Package C: explicit non-empty sourceIds omit effectiveSourceIds", async () => {
    const f = deps();
    const reply = await f.service.replyEphemeral(scope, {
      text: "explain",
      sourceIds: [sourceId],
      mode: "explain",
      history: [],
    });
    expect(reply.effectiveSourceIds).toBeUndefined();
  });

  it.each([false, true])("never includes private bodies in budget calls, provenance rows, or console logs (provider failure=%s)", async fail => {
    const marker = "EPHEMERAL-PRIVATE-BODY-MARKER";
    const spies = (["log", "info", "warn", "error", "debug", "trace"] as const).map(method => vi.spyOn(console, method).mockImplementation(() => undefined));
    const provenance = { resolveHistory: vi.fn(async () => []), record: vi.fn(async () => chunkId) };
    try {
      const f = deps({ provenance, complete: async () => {
        if (fail) throw new OpeningProviderError("PROVIDER_NETWORK", `${marker}-provider-error`);
        return { ...output, text: `${marker}-answer`, candidates: [{ kind: "memory", text: `${marker}-candidate`, temporary: false }] };
      } });
      const pending = f.service.replyEphemeral(scope, { text: `${marker}-prompt`, sourceIds: [sourceId], mode: "listen", history: [{ role: "user", text: `${marker}-history`, provenanceId: sourceId }], historyPrivacyEpoch: 0 });
      if (fail) await expect(pending).rejects.toMatchObject({ code: "PROVIDER_NETWORK" });
      else expect((await pending).text).toBe(`${marker}-answer`);
      const persisted = [f.budget.reserve, f.budget.release, f.budget.settle, f.budget.markUnknown, provenance.record].flatMap(mock => mock.mock.calls);
      expect(JSON.stringify(persisted)).not.toContain(marker);
      expect(spies.flatMap(spy => spy.mock.calls.map(args => format(...args))).join("\n")).not.toContain(marker);
      if (fail) expect(provenance.record).not.toHaveBeenCalled();
    } finally { spies.forEach(spy => spy.mockRestore()); }
  });
});


it("returns scoped deterministic language support and a language receipt without provider spending", async () => {
  const contextAnchor = { purpose: "language_support" as const, sourceId, sourceVersion: 1 };
  const receipt = { id: chunkId, releaseKey: "ephemeral:language-key", contextAnchor, origin: "assistant" as const, supportDomain: "language" as const,
    generatedAt: "2026-10-19T00:00:00.000Z", releasedAt: "2026-10-19T00:00:00.000Z", acknowledgedAt: null, historyRevision: 1 };
  const deliver = vi.fn(async () => receipt);
  const f = deps({ studyContext: { resolve: async () => contextAnchor, languageSupport: async () => null }, exposures: { deliver } });
  const reply = await f.service.replyEphemeral(scope, { text: "Please translate", sourceIds: [sourceId], history: [], mode: "explain", clientKey: "language-key", contextAnchor });
  expect(reply.text).toContain("不是全文翻译");
  expect(reply.exposureReceipt?.supportDomain).toBe("language");
  expect(deliver).toHaveBeenCalledWith(scope, expect.objectContaining({ supportDomain: "language" }));
  expect(f.complete).not.toHaveBeenCalled();
  expect(f.budget.reserve).not.toHaveBeenCalled();
});

it("uses the same operation key for an ephemeral retry and refuses to resend a completed request", async () => {
  const f = deps();
  const input = { text: "Explain", sourceIds: [sourceId], history: [], mode: "explain" as const, clientKey: "stable-ephemeral-key" };
  await f.service.replyEphemeral(scope, input);
  const completed = { id: "res-1", state: "completed" };
  f.budget.reserve.mockResolvedValueOnce(completed);
  await expect(f.service.replyEphemeral(scope, input)).rejects.toMatchObject({ code: "BUDGET_REPLAY_COMPLETED", status: 409 });
  expect(f.complete).toHaveBeenCalledTimes(1);
  expect(f.budget.reserve.mock.calls.map(call => call[0].requestId)).toEqual(["eph:stable-ephemeral-key", "eph:stable-ephemeral-key"]);
});


it("uses only the owned context's latest server intent for ephemeral presentation", async () => {
  const contextAnchor = { purpose: "learning_help" as const, sourceId, sourceVersion: 1 };
  const event: StudyIntentEvent = { id: chunkId, sessionId: chunkId, activityId: chunkId, attemptId: null, version: 2,
    change: { kind: "explicit_request", text: "用英文，慢一点" }, signals: [], action: "continue", createdAt: "2026-10-19T00:00:00.000Z",
    intent: { purpose: "self_study", timeBudgetMinutes: 10, language: "en", pace: "slow", continuous: false, selfReportedFatigue: "unknown" } };
  const sessionIntent = vi.fn(async () => event);
  const f = deps({ studyContext: { resolve: async () => contextAnchor, sessionIntent } });
  await f.service.replyEphemeral(scope, { text: "Continue", sourceIds: [sourceId], history: [], mode: "hint", contextAnchor });
  expect(sessionIntent).toHaveBeenCalledWith(scope, contextAnchor);
  expect(f.complete.mock.calls[0]?.[0].instruction).toContain("Use English");
  expect(f.complete.mock.calls[0]?.[0].instruction).toContain("放慢节奏");
});

it.each(["用中文，直接给关键步骤", "串讲还是自学"])("merges the ephemeral current explicit request without persisting its text: %s", async text => {
  const contextAnchor = { purpose: "learning_help" as const, sourceId, sourceVersion: 1 };
  const event: StudyIntentEvent = { id: chunkId, sessionId: chunkId, activityId: chunkId, attemptId: null, version: 2,
    change: { kind: "explicit_request", text: "用英文，慢一点" }, signals: [], action: "continue", createdAt: "2026-10-19T00:00:00.000Z",
    intent: { purpose: "challenge", timeBudgetMinutes: 10, language: "en", pace: "slow", continuous: false, selfReportedFatigue: "unknown" } };
  const f = deps({ studyContext: { resolve: async () => contextAnchor, sessionIntent: async () => event } });
  await f.service.replyEphemeral(scope, { text, clientKey: "stable-intent-key", sourceIds: [sourceId], history: [], mode: "hint", contextAnchor });
  const instruction = f.complete.mock.calls[0]?.[0].instruction;
  if (text.startsWith("用中文")) {
    expect(instruction).toContain("使用中文讲解");
    expect(instruction).toContain("只给关键步骤");
    expect(instruction).not.toContain("Use English");
  } else {
    expect(instruction).toContain("Use English");
    expect(instruction).toContain("先澄清，不擅自换教学模式");
    expect(instruction).toContain("当前目的：提高挑战");
  }
});

it("keeps no-material temporary requests out of course retrieval and provider chunks", async () => {
  const listReady = vi.fn(async () => [sourceId]);
  const f = deps({ listReadySourceIdsForCourse: listReady, complete: async () => ({ ...output, citedChunkIds: [], candidates: [] }) });
  await f.service.replyEphemeral(scope, { courseId: workspaceId, text: "general", sourceIds: [], sourceSelection: "none", mode: "listen", history: [] });
  expect(listReady).not.toHaveBeenCalled();
  expect(f.complete).toHaveBeenCalledWith(expect.objectContaining({ chunks: [] }), undefined);
});

it("refuses an empty explicit selection before dispatching a temporary model request", async () => {
  const f = deps();
  await expect(f.service.replyEphemeral(scope, { text: "selected", sourceIds: [], sourceSelection: "selected", mode: "listen", history: [] })).rejects.toThrow();
  expect(f.complete).not.toHaveBeenCalled();
});


it("uses the same course context and provenance for temporary tutoring and rechecks before paying", async () => {
  const context = { courseId: chunkId, title: "力学", asOf: "2026-10-21T00:00:00Z", privacyEpoch: 0,
    goal: { description: "期末", targetDate: "2026-10-31", weeklyMinutes: 420 }, weaknesses: [],
    recentMistakes: [{ observationId: chunkId, skillLabel: "合力", feedback: "先确定受力方向", unmetCriteria: ["方向"], assistance: "independent" as const }],
    observationIds: [chunkId], sourceRefs: [{ sourceId, sourceVersion: 1 }] };
  const read = vi.fn(async () => context), assertCurrent = vi.fn(async () => {}), record = vi.fn(async () => chunkId);
  const f = deps({ learnerContext: { read, assertCurrent }, provenance: { record, resolveHistory: async () => [] } });
  await f.service.replyEphemeral(scope, { text: "讲讲这道题", courseId: chunkId, sourceIds: [sourceId], history: [] });
  expect(read).toHaveBeenCalledWith(scope, { courseId: chunkId, sourceIds: [sourceId] });
  expect(f.complete.mock.calls[0]![0].instruction).toContain("先确定受力方向");
  expect(assertCurrent).toHaveBeenCalledWith(scope, context);
  expect(record).toHaveBeenCalledWith(scope, expect.objectContaining({ contextSourceRefs: context.sourceRefs }));
  const blocked = deps({ learnerContext: { read, assertCurrent: async () => { throw Object.assign(new Error("context changed"), { code: "CONFLICT" }); } } });
  await expect(blocked.service.replyEphemeral(scope, { text: "讲讲这道题", courseId: chunkId, sourceIds: [sourceId], history: [] })).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
  expect(blocked.complete).not.toHaveBeenCalled();
  expect(blocked.budget.release).toHaveBeenCalled();
});
