import { randomUUID } from "node:crypto";
import { Queue, QueueEvents, Worker } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";

const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

async function cleanQueue(worker: Worker, events: QueueEvents, queue: Queue) {
  const closed = await Promise.allSettled([worker.close(), events.close()]);
  try {
    await queue.obliterate({ force: true });
  } finally {
    await queue.close();
  }
  const failures = closed.filter(result => result.status === "rejected");
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Queue cleanup failed");
}

describe("BullMQ idempotent job id", () => {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const queueName = `spike-idempotency-${randomUUID()}`;

  afterAll(async () => {
    await connection.quit();
  });

  it("runs a job once when the same jobId is enqueued twice", async () => {
    let executions = 0;
    const jobId = `assessment-recompute-${Date.now()}`;

    const worker = new Worker(
      queueName,
      async () => {
        executions += 1;
        return { ok: true };
      },
      { connection, concurrency: 1 },
    );

    const queue = new Queue(queueName, { connection });
    // QueueEvents duplicates this client for its independent blocking stream.
    const events = new QueueEvents(queueName, { connection });

    try {
      await Promise.all([queue.waitUntilReady(), worker.waitUntilReady(), events.waitUntilReady()]);
      const job = await queue.add("recompute", { userId: "u1" }, { jobId });
      const duplicate = await queue.add("recompute", { userId: "u1" }, { jobId });
      expect(duplicate.id).toBe(job.id);
      // This also reads the persisted result if completion preceded the waiter.
      expect(await job.waitUntilFinished(events, 10000)).toEqual({ ok: true });
      await worker.pause(); // Wait for active work to finish before checking all states.
      expect(await duplicate.waitUntilFinished(events, 10000)).toEqual({ ok: true });
      expect(executions).toBe(1);

      const counts = await queue.getJobCounts("completed", "waiting", "active");
      expect(counts.completed).toBe(1);
      expect(counts.waiting).toBe(0);
      expect(counts.active).toBe(0);
    } finally {
      await cleanQueue(worker, events, queue);
    }
  });
});
