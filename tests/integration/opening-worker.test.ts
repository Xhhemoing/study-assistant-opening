import { randomUUID } from "node:crypto";
import IORedis from "ioredis";
import { Queue } from "bullmq";
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { createOpeningJobRepository } from "@aistudy/database";
import { createQueue, jobQueueId } from "../../apps/worker/src/runtime/queue";
import { dispatchPending } from "../../apps/worker/src/runtime/dispatch";
import { runJob } from "../../apps/worker/src/runtime/run-job";

describe("opening worker runtime", () => {
  let fixture: OpeningFixture;
  let redis: IORedis;
  let queue: Queue;

  beforeAll(async () => {
    fixture = await createOpeningFixture();
    redis = new IORedis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", { maxRetriesPerRequest: null });
    queue = createQueue("parse", redis);
  });
  beforeEach(async () => { await fixture.reset(); await queue.drain(true); });
  afterAll(async () => { await queue.close(); await redis.quit(); await fixture.close(); });

  it("publishes pending outbox rows once and deduplicates queue IDs", async () => {
    const jobId = randomUUID();
    await fixture.sql`INSERT INTO opening_jobs (id, workspace_id, owner_user_id, key, kind, payload, privacy_epoch)
      VALUES (${jobId}, ${fixture.scope.workspaceId}, ${fixture.scope.ownerUserId}, ${randomUUID()}, 'parse', ${fixture.sql.json({})}, 0)`;
    await fixture.sql`INSERT INTO opening_outbox (workspace_id, job_id, topic, payload)
      VALUES (${fixture.scope.workspaceId}, ${jobId}, 'opening.job.enqueue', ${fixture.sql.json({ jobId, kind: 'parse' })})`;
    const repository = createOpeningJobRepository(fixture.sql);
    expect(await Promise.all([dispatchPending({ repository, queues: { parse: queue } }), dispatchPending({ repository, queues: { parse: queue } })])).toEqual([1, 0]);
    expect(await queue.getJob(jobQueueId(fixture.scope.workspaceId, jobId))).not.toBeNull();
  });

  it("claims, completes once, and skips redelivery or cancellation", async () => {
    const jobId = randomUUID();
    await fixture.sql`INSERT INTO opening_jobs (id, workspace_id, owner_user_id, key, kind, payload, privacy_epoch, state)
      VALUES (${jobId}, ${fixture.scope.workspaceId}, ${fixture.scope.ownerUserId}, ${randomUUID()}, 'tutor', ${fixture.sql.json({})}, 0, 'queued')`;
    const repository = createOpeningJobRepository(fixture.sql);
    expect(await runJob(repository, jobId, async () => ({ ok: true }))).toBe(true);
    expect(await runJob(repository, jobId, async () => ({ ok: true }))).toBe(false);
    await fixture.sql`UPDATE opening_jobs SET state = 'cancelled' WHERE id = ${jobId}`;
    expect(await runJob(repository, jobId, async () => ({ ok: true }))).toBe(false);
  });

  it("rejects fresh running jobs and takes over stale jobs", async () => {
    const repository = createOpeningJobRepository(fixture.sql);
    const staleId = randomUUID();
    const freshId = randomUUID();
    for (const [jobId, age] of [[staleId, "10 minutes"], [freshId, "0 minutes"]]) {
      await fixture.sql`INSERT INTO opening_jobs (id, workspace_id, owner_user_id, key, kind, payload, privacy_epoch, state, updated_at)
        VALUES (${jobId}, ${fixture.scope.workspaceId}, ${fixture.scope.ownerUserId}, ${randomUUID()}, 'tutor', ${fixture.sql.json({})}, 0, 'running', now() - ${age}::interval)`;
    }
    expect(await runJob(repository, staleId, async () => ({ ok: true }))).toBe(true);
    expect(await runJob(repository, freshId, async () => ({ ok: true }))).toBe(false);
  });

  it("guards parse jobs against changed source privacy epochs", async () => {
    const repository = createOpeningJobRepository(fixture.sql);
    const sourceId = randomUUID();
    const jobId = randomUUID();
    await fixture.sql`INSERT INTO opening_sources (id, workspace_id, name, mime, bytes, sha256, version, upload_state, parse_state)
      VALUES (${sourceId}, ${fixture.scope.workspaceId}, 'source', 'text/plain', 1, ${"a".repeat(64)}, 1, 'uploaded', 'not_started')`;
    await fixture.sql`INSERT INTO opening_jobs (id, workspace_id, owner_user_id, key, kind, payload, privacy_epoch)
      VALUES (${jobId}, ${fixture.scope.workspaceId}, ${fixture.scope.ownerUserId}, ${randomUUID()}, 'parse', ${fixture.sql.json({ sourceId })}, 0)`;
    let called = false;
    expect(await runJob(repository, jobId, async () => { called = true; return {}; })).toBe(false);
    expect(called).toBe(false);
    expect((await fixture.sql`SELECT state, result FROM opening_jobs WHERE id = ${jobId}`)[0].state).toBe("failed");
  });

  it("keeps deterministic jobs visible across independent queue stacks", async () => {
    const redis2 = new IORedis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", { maxRetriesPerRequest: null });
    const queue2 = createQueue("parse", redis2);
    try {
      const jobId = randomUUID();
      await fixture.sql`INSERT INTO opening_jobs (id, workspace_id, owner_user_id, key, kind, payload, privacy_epoch)
        VALUES (${jobId}, ${fixture.scope.workspaceId}, ${fixture.scope.ownerUserId}, ${randomUUID()}, 'tutor', ${fixture.sql.json({})}, 0)`;
      await fixture.sql`INSERT INTO opening_outbox (workspace_id, job_id, topic, payload)
        VALUES (${fixture.scope.workspaceId}, ${jobId}, 'opening.job.enqueue', ${fixture.sql.json({ jobId, kind: 'parse' })})`;
      const firstRepository = createOpeningJobRepository(fixture.sql);
      await dispatchPending({ repository: firstRepository, queues: { parse: queue } });
      expect(await queue2.getJob(jobQueueId(fixture.scope.workspaceId, jobId))).not.toBeNull();

      const secondRepository = createOpeningJobRepository(fixture.sql);
      expect(await runJob(secondRepository, jobId, async () => ({ sent: true }))).toBe(true);
      expect((await fixture.sql`SELECT state, result FROM opening_jobs WHERE id = ${jobId}`)[0]).toMatchObject({
        state: "succeeded",
        result: { sent: true },
      });
      expect(await runJob(secondRepository, jobId, async () => ({ sent: false }))).toBe(false);
      expect((await fixture.sql`SELECT result FROM opening_jobs WHERE id = ${jobId}`)[0].result).toEqual({ sent: true });
    } finally {
      await queue2.close();
      await redis2.quit();
    }
  });
});
