import IORedis from "ioredis";
import { Queue } from "bullmq";

export type RedisOptions = { url: string };
export type OpeningQueue = Queue;

export const jobQueueId = (workspaceId: string, jobId: string): string =>
  `opening-ws-${workspaceId}-job-${jobId}`;

export function createRedisConnection({ url }: RedisOptions): IORedis {
  return new IORedis(url, { maxRetriesPerRequest: null });
}

export function createQueue(kind: string, connection: IORedis): OpeningQueue {
  return new Queue(`opening-${kind}`, { connection });
}

export function createQueues(connection: IORedis): Record<string, OpeningQueue> {
  return Object.fromEntries(["parse", "tutor", "retest", "remind"].map((kind) => [kind, createQueue(kind, connection)]));
}
