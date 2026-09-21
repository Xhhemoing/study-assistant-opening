import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assistantContextHint,
  createJobPoller,
  jobStatusHint,
} from "./assistant-view";

const JOB_ID = "33333333-3333-4333-8333-333333333333";
const ISO = "2026-09-13T12:00:00.000Z";

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
