import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";

const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

describe("BullMQ idempotent job id", () => {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const queueName = `spike-idempotency-${Date.now()}`;

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

    try {
      await queue.add("recompute", { userId: "u1" }, { jobId });
      await queue.add("recompute", { userId: "u1" }, { jobId });

      const completed = await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("job did not complete in time")),
          10000,
        );
        worker.on("completed", async () => {
          // allow a short window for a potential duplicate run
          setTimeout(() => {
            clearTimeout(timer);
            resolve();
          }, 500);
        });
        worker.on("failed", (_job, err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      expect(completed).toBeUndefined();
      expect(executions).toBe(1);

      const counts = await queue.getJobCounts("completed", "waiting", "active");
      expect(counts.completed).toBe(1);
      expect(counts.waiting + counts.active).toBe(0);
    } finally {
      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });
});
