import type { JobsOptions, Queue } from "bullmq";
import {
  createOpeningJobRepository,
  createOpeningTutorJobsRepository,
  type OpeningOutboxRecord,
} from "@aistudy/database";
import { jobQueueId } from "./queue";

const retention = {
  removeOnComplete: { age: 86_400, count: 1_000 },
  removeOnFail: { age: 7 * 86_400, count: 5_000 },
};

/** A retained terminal transport entry must not strand a queued DB job. */
async function enqueue(queue: Queue, name: string, payload: unknown, options: JobsOptions & { jobId: string }): Promise<void> {
  const existing = await queue.getJob(options.jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === "failed" || state === "completed") await existing.retry(state);
    if (state !== "unknown") return;
  }
  await queue.add(name, payload, options);
}

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
    await enqueue(queue, outbox.jobId, outbox.payload, {
      jobId: `${jobQueueId(outbox.workspaceId, outbox.jobId)}-event-${outbox.id}`,
      attempts: 2,
      backoff: { type: "exponential", delay: 1000 },
      ...retention,
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
    await enqueue(queue, job.id, { jobId: job.id }, {
      jobId: `tutor-${job.workspaceId}-${job.id}`,
      attempts: 2,
      backoff: { type: "exponential", delay: 1000 },
      ...retention,
    });
  }
  return jobs.length;
}
