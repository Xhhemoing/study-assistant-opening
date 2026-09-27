import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendEphemeralResponseIfActive,
  assistantContextHint,
  mergeChatMessages,
  createJobPoller,
  jobStatusHint,
  pendingJobDiscoveryState,
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

  it("does not auto-poll a terminal outcome_unknown discovery", () => {
    expect(pendingJobDiscoveryState({
      ok: true,
      job: {
        id: JOB_ID,
        status: "outcome_unknown",
        error: { message: "provider timeout" },
        updatedAt: ISO,
      },
    })).toEqual({ kind: "none" });
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
