import type { Queue } from "bullmq";
import { createOpeningJobRepository, type OpeningOutboxRecord } from "@aistudy/database";
import { jobQueueId } from "./queue";

export type DispatchDependencies = {
  repository: ReturnType<typeof createOpeningJobRepository>;
  queues: Record<string, Queue>;
  limit?: number;
};

export async function dispatchPending(deps: DispatchDependencies): Promise<number> {
  return deps.repository.dispatchPending(async (outbox: OpeningOutboxRecord) => {
    const payload = outbox.payload as { kind?: string; jobId?: string };
    const kind = payload.kind ?? "";
    const queue = deps.queues[kind];
    if (!queue) throw new Error(`unknown opening job kind: ${kind}`);
    await queue.add(outbox.jobId, outbox.payload, {
      jobId: jobQueueId(outbox.workspaceId, outbox.jobId),
      attempts: 2,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: false,
      removeOnFail: false,
    });
  }, deps.limit);
}
