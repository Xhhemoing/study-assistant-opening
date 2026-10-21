import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createTutorStreamReader, createTutorStreamWriter, type TutorStreamDelta } from "../../apps/worker/src/runtime/tutor-stream";

const redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", {
  lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0, connectTimeout: 3_000, commandTimeout: 3_000,
  retryStrategy: () => null,
});
redis.on("error", () => undefined);
const keys: string[] = [];
beforeAll(async () => { await redis.connect(); });
afterAll(async () => {
  try { if (keys.length && redis.status === "ready") await redis.del(...keys); }
  finally { redis.disconnect(); }
});

it("pushes real increments, restores the complete reconnect snapshot and isolates workspaces with an expiry", async () => {
  const workspaceId = randomUUID(), jobId = randomUUID();
  const key = `opening:tutor-stream:${workspaceId}:${jobId}`;
  keys.push(key);
  const writer = createTutorStreamWriter(redis), reader = createTutorStreamReader(redis);
  const received: TutorStreamDelta[] = [];
  let notify: (() => void) | undefined;
  const allDeltas = new Promise<void>(resolve => { notify = resolve; });
  const unsubscribe = await reader.subscribe(workspaceId, jobId, delta => {
    received.push(delta);
    if (received.length === 2) notify?.();
  });
  try {
    const context = { privacyEpoch: 2, contextSourceRefs: [], exposureReceiptId: null, claimToken: randomUUID() };
    await writer.begin(workspaceId, jobId, context);
    expect(await reader.read(workspaceId, jobId)).toEqual({ ...context, text: "", sequence: 0 });
    await writer.append(workspaceId, jobId, "先看矩阵");
    await writer.append(workspaceId, jobId, "的第一行。");
    await allDeltas;
    expect(received).toEqual([{ text: "先看矩阵", sequence: 1 }, { text: "的第一行。", sequence: 2 }]);
    expect(await reader.read(workspaceId, jobId)).toEqual({ ...context, text: "先看矩阵的第一行。", sequence: 2 });
    expect(await reader.read(randomUUID(), jobId)).toBeNull();
    expect(await redis.ttl(key)).toBeGreaterThan(0);
    expect(await redis.ttl(key)).toBeLessThanOrEqual(900);
  } finally { await unsubscribe(); }
});
