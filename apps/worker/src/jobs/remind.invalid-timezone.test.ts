import { describe, expect, it, vi } from "vitest";
import type { OpeningJobRecord } from "@aistudy/database";
import { runJob, type JobRepository } from "../runtime/run-job";
import { createRemindHandler, type ReminderSendResult } from "./remind";

/**
 * PR-B: an invalid stored/stamped workspace zone fails the remind job loudly
 * (RangeError -> job "failed" with the reason recorded), never silently falls
 * back to a default zone, and never takes down other workspaces' jobs.
 */
const jobFor = (id: string, workspaceId: string): OpeningJobRecord => ({
  id, workspaceId, ownerUserId: `owner-${workspaceId}`,
  key: `remind:task-1:v1:2026-09-14T11:00:00.000Z:feishu:${id}`, kind: "remind",
  payload: {}, result: null, state: "running", privacyEpoch: 0,
} as unknown as OpeningJobRecord);
const payload = (over: Record<string, unknown> = {}) => ({
  taskId: "11111111-1111-4111-8111-111111111111", taskVersion: 1, dueAt: "2026-09-14T11:00:00.000Z",
  channel: "feishu", title: "t", receiptId: null, outcome: null, clientKey: "remind-key-01", configured: true, ...over,
});

function handlerWith(zoneByWorkspace: Record<string, string>) {
  const send = vi.fn(async (): Promise<ReminderSendResult> => ({ receiptId: "r-1" }));
  const record = vi.fn(async () => true);
  const handler = createRemindHandler({
    record, send, isCurrent: async () => true,
    now: () => new Date("2026-09-14T12:00:00.000Z"),
    externalConfig: async (job) => ({ enabled: true, recipientId: job.ownerUserId, quietHours: { startMinute: 22 * 60, endMinute: 7 * 60 } }),
    resolveTimeZone: async (job) => zoneByWorkspace[job.workspaceId]!,
  });
  return { handler, send, record };
}

describe("remind job with invalid workspace time zone (PR-B)", () => {
  it("payload-stamped invalid zone throws RangeError and does not send", async () => {
    const { handler, send } = handlerWith({});
    await expect(handler(jobFor("j1", "ws-bad"), payload({ timeZone: "Mars/Olympus_Mons" }))).rejects.toBeInstanceOf(RangeError);
    expect(send).not.toHaveBeenCalled();
  });

  it("live planning zone invalid throws RangeError (no silent default)", async () => {
    const { handler, send } = handlerWith({ "ws-bad": "Not/AZone" });
    await expect(handler(jobFor("j1", "ws-bad"), payload())).rejects.toThrow(/invalid timeZone/);
    expect(send).not.toHaveBeenCalled();
  });

  it("runJob records the failure observably and other workspaces still run", async () => {
    const { handler } = handlerWith({ "ws-bad": "Not/AZone", "ws-ok": "Asia/Shanghai" });
    const jobs = new Map([["j-bad", jobFor("j-bad", "ws-bad")], ["j-ok", jobFor("j-ok", "ws-ok")]]);
    const finished: Array<{ id: string; state: string; value: unknown }> = [];
    const repo: JobRepository = {
      claim: async (id) => ({ ...jobs.get(id)!, payload: payload() } as OpeningJobRecord),
      finish: async (id, state, value) => { finished.push({ id, state, value }); return true; },
    };
    await runJob(repo, "j-bad", (job, p) => handler(job, p));
    await runJob(repo, "j-ok", (job, p) => handler(job, p));
    expect(finished[0]).toMatchObject({ id: "j-bad", state: "failed" });
    expect(String((finished[0]!.value as { error: string }).error)).toMatch(/invalid timeZone: Not\/AZone/);
    expect(finished[1]).toMatchObject({ id: "j-ok", state: "succeeded" });
  });
});
