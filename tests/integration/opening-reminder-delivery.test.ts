import { randomUUID } from "node:crypto";
import IORedis from "ioredis";
import { Queue, Worker } from "bullmq";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpeningJobRepository, createOpeningPlansRepository, createOpeningReminderRepository } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { createRemindHandler, type ReminderSendResult } from "../../apps/worker/src/jobs/remind";
import { dispatchPending } from "../../apps/worker/src/runtime/dispatch";
import { runJob } from "../../apps/worker/src/runtime/run-job";
import { jobQueueId } from "../../apps/worker/src/runtime/queue";

describe("reminder database and Redis delivery", () => {
  let fixture: OpeningFixture;
  let redis: IORedis;
  let queue: Queue;
  let worker: Worker;
  let reminders: ReturnType<typeof createOpeningReminderRepository>;
  let jobs: ReturnType<typeof createOpeningJobRepository>;
  let now: Date;
  let result: ReminderSendResult;
  let sent: string[];

  beforeAll(async () => {
    fixture = await createOpeningFixture();
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) throw new Error("REDIS_URL is required for reminder delivery tests");
    redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    const name = `opening-reminder-delivery-${randomUUID()}`;
    queue = new Queue(name, { connection: redis });
    // No background processor: each test advances the actual Redis job explicitly.
    worker = new Worker(name, null, { connection: redis, autorun: false });
    reminders = createOpeningReminderRepository(fixture.sql);
    jobs = createOpeningJobRepository(fixture.sql);
    await worker.waitUntilReady();
  });

  beforeEach(async () => {
    await fixture.reset();
    await fixture.sql`DELETE FROM opening_tasks WHERE workspace_id=${fixture.scope.workspaceId}`;
    await queue.obliterate({ force: true });
    now = new Date();
    result = { receiptId: "test-receipt" };
    sent = [];
    await reminders.saveExternalConfig(fixture.scope, {
      enabled: true, recipientId: fixture.scope.ownerUserId, quietHours: null,
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await worker?.close();
    await queue?.obliterate({ force: true });
    await queue?.close();
    await redis?.quit();
    await fixture?.close();
  });

  async function enqueue() {
    const task = await createOpeningPlansRepository(fixture.sql).createTask(fixture.scope, {
      title: "Only the chosen due occurrence", minutes: 20, dueAt: "2020-01-01T00:00:00.000Z",
      priority: 1, candidateId: null, clientKey: randomUUID(),
    });
    const input = { taskId: task.id, expectedVersion: task.version!, channel: "feishu" as const, clientKey: randomUUID() };
    const [reminder] = await reminders.enqueue(fixture.scope, input, now);
    return { task, input, reminder: reminder! };
  }

  const dispatch = () => dispatchPending({ repository: jobs, queues: { remind: queue } });
  const events = (jobId: string) => fixture.sql`SELECT id,payload,state FROM opening_outbox
    WHERE job_id=${jobId} AND workspace_id=${fixture.scope.workspaceId} ORDER BY created_at,id`;

  async function consume(jobId: string) {
    const token = randomUUID();
    const transport = await worker.getNextJob(token, { block: false });
    expect(transport).toBeDefined();
    expect(transport.data.jobId).toBe(jobId);
    const handler = createRemindHandler({
      isCurrent: (id, at) => reminders.isCurrent(id, at),
      externalConfig: job => reminders.getExternalConfig({ workspaceId: job.workspaceId, ownerUserId: job.ownerUserId }),
      record: (id, input) => reminders.recordAttempt(id, input),
      now: () => now,
      timeZone: () => "UTC",
      send: async input => { sent.push(input.text); return result; },
    });
    await runJob(jobs, transport.data.jobId, handler);
    await transport.moveToCompleted({ handled: true }, token, false);
    return transport;
  }

  it("dispatches an actual repository event once even when that outbox row is republished", async () => {
    const f = await enqueue();
    const [event] = await events(f.reminder.id);
    expect(event).toBeDefined();
    expect(await dispatch()).toBe(1);
    await fixture.sql`UPDATE opening_outbox SET state='pending' WHERE id=${event!.id}`;
    expect(await dispatch()).toBe(1);
    expect(await queue.getWaitingCount()).toBe(1);
    const transport = await consume(f.reminder.id);
    expect(transport.id).toBe(`${jobQueueId(fixture.scope.workspaceId, f.reminder.id)}-event-${event!.id}`);
    expect(await transport.getState()).toBe("completed");
    expect(sent).toEqual([f.task.title]);
    expect(await jobs.get(fixture.scope, f.reminder.id)).toMatchObject({ state: "succeeded", payload: { receiptId: "test-receipt" } });
  });

  it.each(["enabled-string", "enabled-null", "quiet-string", "quiet-range", "quiet-fraction", "recipient-object", "null"] as const)(
    "does not send from persisted malformed %s external configuration", async invalid => {
      const f = await enqueue();
      const raw = invalid === "null" ? null : {
        config: true, enabled: invalid === "enabled-string" ? "false" : invalid === "enabled-null" ? null : true,
        recipientId: invalid === "recipient-object" ? { id: fixture.scope.ownerUserId } : fixture.scope.ownerUserId,
        quietHours: invalid === "quiet-string" ? { startMinute: 0, endMinute: "x" }
          : invalid === "quiet-range" ? { startMinute: -1, endMinute: 1440 }
            : invalid === "quiet-fraction" ? { startMinute: 0.5, endMinute: 60 } : null,
      };
      await fixture.sql`UPDATE opening_jobs SET payload=${JSON.stringify(raw)}::jsonb
        WHERE workspace_id=${fixture.scope.workspaceId} AND key='remind-external-config'`;
      await dispatch();
      await consume(f.reminder.id);
      expect(sent).toEqual([]);
      expect(await reminders.getExternalConfig(fixture.scope)).toBeNull();
      expect((await reminders.list(fixture.scope, now)).externalDelivery).toBe("disabled");
      expect(await jobs.get(fixture.scope, f.reminder.id)).toMatchObject({ state: "succeeded", payload: { suppressed: true, receiptId: null } });
      await expect(reminders.enqueue(fixture.scope, f.input, now)).rejects.toMatchObject({ code: "VALIDATION" });
    },
  );

  it("dispatches a new event after an explicit recovery even though the old Redis job is completed", async () => {
    const f = await enqueue();
    await reminders.saveExternalConfig(fixture.scope, { enabled: false, recipientId: fixture.scope.ownerUserId, quietHours: null });
    await dispatch();
    const oldTransport = await consume(f.reminder.id);
    expect(await oldTransport.getState()).toBe("completed");
    expect(await jobs.get(fixture.scope, f.reminder.id)).toMatchObject({ state: "succeeded", payload: { suppressed: true } });
    expect(sent).toEqual([]);
    await reminders.saveExternalConfig(fixture.scope, { enabled: true, recipientId: fixture.scope.ownerUserId, quietHours: null });
    expect(await reminders.enqueue(fixture.scope, { ...f.input, clientKey: randomUUID() }, now)).toMatchObject([{ id: f.reminder.id }]);
    await reminders.enqueue(fixture.scope, f.input, now);
    expect(await events(f.reminder.id)).toHaveLength(2);
    expect(await dispatch()).toBe(1);
    const nextTransport = await consume(f.reminder.id);
    expect(nextTransport.id).not.toBe(oldTransport.id);
    expect(await nextTransport.getState()).toBe("completed");
    expect(sent).toEqual([f.task.title]);
  });

  it("repairs a legacy queued job without an outbox once under concurrent explicit requests", async () => {
    const f = await enqueue();
    await fixture.sql`DELETE FROM opening_outbox WHERE job_id=${f.reminder.id}`;
    await fixture.sql`UPDATE opening_jobs SET payload=payload-'explicitDue' WHERE id=${f.reminder.id}`;
    const requested = await Promise.all([
      reminders.enqueue(fixture.scope, f.input, now),
      reminders.enqueue(fixture.scope, { ...f.input, clientKey: randomUUID() }, now),
    ]);
    expect(requested.map(items => items[0]!.id)).toEqual([f.reminder.id, f.reminder.id]);
    expect(await events(f.reminder.id)).toHaveLength(1);
    expect(await dispatch()).toBe(1);
    await consume(f.reminder.id);
    expect(sent).toEqual([f.task.title]);
    expect(await events(f.reminder.id)).toHaveLength(1);
  });

  it("reschedules quiet work using only the remaining absolute delay and sends after quiet ends", async () => {
    const f = await enqueue();
    const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
    await reminders.saveExternalConfig(fixture.scope, {
      enabled: true, recipientId: fixture.scope.ownerUserId,
      quietHours: { startMinute: minute, endMinute: (minute + 3) % 1440 },
    });
    await dispatch();
    await consume(f.reminder.id);
    expect(sent).toEqual([]);
    expect(await jobs.get(fixture.scope, f.reminder.id)).toMatchObject({ state: "queued", payload: { outcome: "quiet" } });
    const pending = (await events(f.reminder.id)).find(event => event.state === "pending")!;
    const availableAt = String(pending.payload.availableAt);
    expect(Date.parse(availableAt)).toBeGreaterThan(now.getTime());
    const laterDispatch = vi.spyOn(Date, "now").mockReturnValue(Date.parse(availableAt) - 1000);
    try { expect(await dispatch()).toBe(1); } finally { laterDispatch.mockRestore(); }
    const id = `${jobQueueId(fixture.scope.workspaceId, f.reminder.id)}-event-${pending.id}`;
    const delayed = await queue.getJob(id);
    expect(delayed?.opts.delay).toBe(1000);
    expect(await delayed!.getState()).toBe("delayed");
    await fixture.sql`UPDATE opening_outbox SET state='pending' WHERE id=${pending.id}`;
    expect(await dispatch()).toBe(1);
    expect(await queue.getDelayedCount()).toBe(1);
    expect(await reminders.recordAttempt(f.reminder.id, {
      state: "queued", receiptId: null, outcome: "quiet", availableAt,
    })).toBe(false);
    expect(await events(f.reminder.id)).toHaveLength(2);
    now = new Date(availableAt);
    await delayed!.promote();
    await consume(f.reminder.id);
    expect(sent).toEqual([f.task.title]);
    expect(await jobs.get(fixture.scope, f.reminder.id)).toMatchObject({ state: "succeeded", payload: { outcome: "acknowledged" } });
    expect(await events(f.reminder.id)).toHaveLength(2);
  });

  it.each(["acknowledged", "unknown", "rejected", "rate_limited"] as const)(
    "preserves a %s result without implicitly creating another delivery event", async outcome => {
      result = outcome === "acknowledged" ? { receiptId: "test-receipt" } : { error: outcome };
      const f = await enqueue();
      await dispatch();
      await consume(f.reminder.id);
      const before = await jobs.get(fixture.scope, f.reminder.id);
      expect(await reminders.enqueue(fixture.scope, f.input, now)).toMatchObject([{ id: f.reminder.id, outcome }]);
      expect(await reminders.recordAttempt(f.reminder.id, {
        receiptId: null, outcome: "quiet", state: "queued", availableAt: new Date(now.getTime() + 60_000).toISOString(),
      })).toBe(false);
      expect(await jobs.get(fixture.scope, f.reminder.id)).toEqual(before);
      expect(await events(f.reminder.id)).toHaveLength(1);
      expect(await dispatch()).toBe(0);
      expect(sent).toEqual([f.task.title]);
    },
  );
});
