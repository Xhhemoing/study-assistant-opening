import IORedis from "ioredis";
import { Queue } from "bullmq";

export type RedisOptions = { url: string };
export type OpeningQueue = Queue;
export const OPENING_QUEUE_KINDS = [
  "parse", "tutor", "tutor-metadata", "retest", "remind", "build-course-knowledge",
  "parse-media", "extract-study-actions", "compile-teaching-unit", "index-source",
] as const;

export const jobQueueId = (workspaceId: string, jobId: string): string =>
  `opening-ws-${workspaceId}-job-${jobId}`;

export function createRedisConnection({ url }: RedisOptions): IORedis {
  return new IORedis(url, { maxRetriesPerRequest: null });
}

/** A producer must fail promptly; blocking-worker retry policy is unsuitable. */
export function createProducerRedisConnection({ url }: RedisOptions): IORedis {
  return new IORedis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false, commandTimeout: 5_000 });
}

export function createQueue(kind: string, connection: IORedis): OpeningQueue {
  return new Queue(`opening-${kind}`, { connection });
}

export function createQueues(connection: IORedis, onCreate?: (queue: OpeningQueue) => void): Record<string, OpeningQueue> {
  return Object.fromEntries(
    OPENING_QUEUE_KINDS.map((kind) => {
      const queue = createQueue(kind, connection);
      onCreate?.(queue);
      return [kind, queue];
    }),
  );
}
