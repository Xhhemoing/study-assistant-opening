import { describe, expect, it, vi } from "vitest";
import type { JobsOptions, Queue } from "bullmq";
import type { OpeningJobRepository, OpeningOutboxRecord } from "@aistudy/database";
import { dispatchPending } from "./dispatch";
import { jobQueueId } from "./queue";

function dispatcher(events: OpeningOutboxRecord[]) {
  const add = vi.fn(async (_name: string, _payload: unknown, _options: JobsOptions) => undefined);
  const repository = { dispatchPending: async (enqueue: (event: OpeningOutboxRecord) => Promise<void>) => {
    for (const event of events) await enqueue(event);
    return events.length;
  } } as OpeningJobRepository;
  const queue = { add, getJob: vi.fn(async () => undefined) } as unknown as Queue;
  return { add, run: () => dispatchPending({ repository, queues: { remind: queue, parse: queue } }) };
}

describe("retained queue transport recovery", () => {
  it.each(["completed", "failed"])("retries a retained %s entry instead of a no-op add", async (state) => {
    const retry = vi.fn(async () => undefined);
    const add = vi.fn();
    const repository = { dispatchPending: async (enqueue: (event: OpeningOutboxRecord) => Promise<void>) => {
      await enqueue({ id: "event", workspaceId: "ws", jobId: "job", payload: { kind: "parse", jobId: "job" } });
      return 1;
    } } as OpeningJobRepository;
    const queue = { add, getJob: vi.fn(async () => ({ getState: async () => state, retry })) } as unknown as Queue;
    await dispatchPending({ repository, queues: { parse: queue } });
    expect(retry).toHaveBeenCalledWith(state);
    expect(add).not.toHaveBeenCalled();
  });
});

describe("reminder transport dispatch", () => {
  it("delays a quiet retry only until its persisted absolute availability time", async () => {
    const now = Date.now();
    const event = { id: "event-1", workspaceId: "workspace", jobId: "reminder-1",
      payload: { kind: "remind", jobId: "reminder-1", availableAt: new Date(now + 60_000).toISOString() } };
    const { add, run } = dispatcher([event]);
    await run();
    expect(add.mock.calls[0]![2].delay).toBeGreaterThan(59_000);
    expect(add.mock.calls[0]![2].delay).toBeLessThanOrEqual(60_000);
    const expired = dispatcher([{ ...event, payload: { ...event.payload, availableAt: new Date(now - 60_000).toISOString() } }]);
    await expired.run();
    expect(expired.add.mock.calls[0]![2].delay).toBe(0);
  });

  it("deduplicates a single event but gives an explicit recovery a new queue identity", async () => {
    const event = { id: "event-1", workspaceId: "workspace", jobId: "reminder-1", payload: { kind: "remind", jobId: "reminder-1" } };
    const { add, run } = dispatcher([event, event, { ...event, id: "event-2" }]);
    await run();
    const options = add.mock.calls.map(call => call[2]);
    expect(options[0]!.jobId).toBe(options[1]!.jobId);
    expect(options[2]!.jobId).not.toBe(options[0]!.jobId);
  });

  it("uses the outbox identity for parse transport recovery", async () => {
    const event = { id: "event-1", workspaceId: "workspace", jobId: "parse-1", payload: { kind: "parse", jobId: "parse-1" } };
    const { add, run } = dispatcher([event]);
    await run();
    expect(add).toHaveBeenCalledWith("parse-1", event.payload, expect.objectContaining({ jobId: `${jobQueueId("workspace", "parse-1")}-event-event-1` }));
  });
});
