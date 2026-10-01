import type { Queue } from "bullmq";
import {
  createOpeningJobRepository,
  createOpeningTutorJobsRepository,
  type OpeningOutboxRecord,
} from "@aistudy/database";
import { jobQueueId } from "./queue";

export type DispatchDependencies = {
  repository: ReturnType<typeof createOpeningJobRepository>;
  queues: Record<string, Queue>;
  limit?: number;
};

export async function dispatchPending(deps: DispatchDependencies): Promise<number> {
  return deps.repository.dispatchPending(async (outbox: OpeningOutboxRecord) => {
    const payload = outbox.payload as { kind?: string; jobId?: string; availableAt?: string };
    const kind = payload.kind ?? "";
    const queue = deps.queues[kind];
    if (!queue) throw new Error(`unknown opening job kind: ${kind}`);
    let delay = 0;
    if (kind === "remind" && payload.availableAt !== undefined) {
      const availableAt = Date.parse(payload.availableAt);
      if (!Number.isFinite(availableAt)) throw new Error("invalid reminder availability time");
      delay = Math.max(0, availableAt - Date.now());
    }
    await queue.add(outbox.jobId, outbox.payload, {
      jobId: payload.kind === "remind"
        ? `${jobQueueId(outbox.workspaceId, outbox.jobId)}-event-${outbox.id}`
        : jobQueueId(outbox.workspaceId, outbox.jobId),
      attempts: 2,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: false,
      removeOnFail: false,
      ...(kind === "remind" ? { delay } : {}),
    });
  }, deps.limit);
}

export type TutorDispatchDependencies = {
  tutorJobs: ReturnType<typeof createOpeningTutorJobsRepository>;
  queues: Record<string, Queue>;
  limit?: number;
};

/**
 * Enqueue queued opening_tutor_jobs onto the tutor queue. Deterministic
 * BullMQ job IDs dedupe repeated dispatches; the worker's CAS claim on the
 * tutor job row guards execution, so no dispatch-side state change is needed.
 */
export async function dispatchTutorTurns(deps: TutorDispatchDependencies): Promise<number> {
  const jobs = await deps.tutorJobs.listQueued(deps.limit ?? 100);
  const queue = deps.queues.tutor;
  if (!queue) throw new Error("tutor queue is not configured");
  for (const job of jobs) {
    await queue.add(job.id, { jobId: job.id }, {
      jobId: `tutor-${job.workspaceId}-${job.id}`,
      attempts: 2,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: false,
      removeOnFail: false,
    });
  }
  return jobs.length;
}
