import { describe, expect, it, vi } from "vitest";
import {
  PENDING_UPLOAD_SWEEP_INTERVAL_MS,
  createSweepPendingUploadsJob,
} from "./sweep-pending-uploads";

describe("sweep-pending-uploads job", () => {
  it("calls sweepAll once and returns swept ids", async () => {
    const swept = [
      { id: "src-1", workspaceId: "ws-a" },
      { id: "src-2", workspaceId: "ws-b" },
    ];
    const sweepAll = vi.fn(async () => swept);
    const run = createSweepPendingUploadsJob({ sweepAll });

    const result = await run();

    expect(sweepAll).toHaveBeenCalledTimes(1);
    expect(sweepAll).toHaveBeenCalledWith(undefined);
    expect(result).toEqual({ swept, count: 2 });
  });

  it("forwards options (limit / now) to sweepAll", async () => {
    const sweepAll = vi.fn(async () => [] as { id: string; workspaceId: string }[]);
    const run = createSweepPendingUploadsJob({ sweepAll });
    const now = new Date("2026-10-10T15:00:00.000Z");

    const result = await run({ now, limit: 25 });

    expect(sweepAll).toHaveBeenCalledTimes(1);
    expect(sweepAll).toHaveBeenCalledWith({ now, limit: 25 });
    expect(result).toEqual({ swept: [], count: 0 });
  });

  it("documents the 1-minute schedule interval constant", () => {
    expect(PENDING_UPLOAD_SWEEP_INTERVAL_MS).toBe(60_000);
  });
});
