import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import { Redis } from "ioredis";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { advanceOpeningWorkspacePrivacyEpoch, createOpeningBudgetRepository, createOpeningConversationRepository,
  createOpeningPrivacyRepository, createOpeningSourceActionsRepository, createOpeningSourceChunksRepository, createOpeningTutorJobsRepository,
  tutorStreamEpochKey, tutorStreamKey } from "@aistudy/database";
import { fenceCancelledOpeningTutorStream } from "../../packages/database/src/repositories/opening-tutor-stream-fence";
import { createProducerRedisConnection } from "../../apps/worker/src/runtime/queue";
import { createTutorTurnHandler, type TutorTurnDeps } from "../../apps/worker/src/jobs/tutor-turn";
import { createTutorStreamReader, createTutorStreamWriter, createWorkerTutorStreamWriter,
  type TutorStreamDelta } from "../../apps/worker/src/runtime/tutor-stream";
import { getTutorJobService } from "../../apps/web/src/features/opening/server/data-services";
import { deleteOwnedMemory } from "../../packages/database/src/repositories/opening-memory-delete";
import { backupRows } from "./opening-backup-records-fixture";
import { createOpeningFixture } from "./opening-fixture";
import { closeRace, deferred, openRaceSession, openRedisTransport, track, waitUntilBlocked } from "./opening-race-helpers";

const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const redis = new Redis(redisUrl, {
  lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0, connectTimeout: 3_000, commandTimeout: 3_000,
  retryStrategy: () => null,
});

it("publishes only into the expected execution and confirms missing/old writes as zero", async () => {
  const workspaceId = randomUUID(), jobId = randomUUID(), executionId = randomUUID();
  const key = `opening:tutor-stream:${workspaceId}:${jobId}`; keys.push(key, tutorStreamEpochKey(workspaceId));
  const writer = createTutorStreamWriter(redis), reader = createTutorStreamReader(redis);
  expect(await writer.append(workspaceId, jobId, "missing", executionId, 0)).toBe(0);
  await writer.begin(workspaceId, jobId, { privacyEpoch: 0, contextSourceRefs: [], exposureReceiptId: null, executionId });
  expect(await writer.append(workspaceId, jobId, "wrong", randomUUID(), 0)).toBe(0);
  expect(await writer.append(workspaceId, jobId, "wrong epoch", executionId, 1)).toBe(0);
  expect(await writer.append(workspaceId, jobId, "legacy", undefined, 0)).toBe(0);
  expect(await writer.append(workspaceId, jobId, "first", executionId, 0)).toBe(1);
  expect(await writer.append(workspaceId, jobId, " second", executionId, 0)).toBe(2);
  expect(await reader.read(workspaceId, jobId)).toMatchObject({ text: "first second", sequence: 2, executionId });
});

it("keeps an execution sealed if cancellation beats cache initialization", async () => {
  const workspaceId = randomUUID(), jobId = randomUUID(), executionId = randomUUID();
  keys.push(`opening:tutor-stream:${workspaceId}:${jobId}`);
  const writer = createTutorStreamWriter(redis), reader = createTutorStreamReader(redis);
  const context = { privacyEpoch: 0, contextSourceRefs: [], exposureReceiptId: null, executionId };
  await writer.seal(workspaceId, jobId, executionId);
  await writer.begin(workspaceId, jobId, context);
  expect(await writer.append(workspaceId, jobId, "sealed", executionId, 0)).toBe(0);
  expect(await reader.read(workspaceId, jobId)).toBeNull();
});
redis.on("error", () => undefined);
const keys: string[] = [];
beforeAll(async () => { vi.stubEnv("REDIS_URL", redisUrl); await redis.connect(); });
afterAll(async () => {
  try { if (keys.length && redis.status === "ready") await redis.del(...keys); }
  finally { redis.disconnect(); vi.unstubAllEnvs(); }
});

it("fences the publisher's query-selected Redis database without changing DB 0", async () => {
  const url = new URL(redisUrl);
  url.pathname = "";
  url.searchParams.set("db", "3");
  const producer = createProducerRedisConnection({ url: url.toString() });
  const defaultDb = new Redis(redisUrl, { db: 0 });
  const workspaceId = randomUUID(), jobId = randomUUID(), executionId = randomUUID();
  const context = { privacyEpoch: 0, contextSourceRefs: [], exposureReceiptId: null, executionId };
  const writer = createWorkerTutorStreamWriter(producer, () => undefined);
  const db0Writer = createTutorStreamWriter(defaultDb);
  try {
    if (producer.status !== "ready") await once(producer, "ready", { signal: AbortSignal.timeout(3_000) });
    await writer.begin(workspaceId, jobId, context);
    await db0Writer.begin(workspaceId, jobId, context);
    expect(await writer.append(workspaceId, jobId, "in DB 3", executionId, 0)).toBe(1);
    await fenceCancelledOpeningTutorStream(workspaceId, jobId, executionId, url.toString());
    expect(await writer.append(workspaceId, jobId, "sealed", executionId, 0)).toBe(0);
    expect(await createTutorStreamReader(producer).read(workspaceId, jobId)).toMatchObject({ text: "in DB 3", sequence: 1 });
    expect(await db0Writer.append(workspaceId, jobId, "in DB 0", executionId, 0)).toBe(1);
  } finally {
    const streamKeys = [`opening:tutor-stream:${workspaceId}:${jobId}`, tutorStreamEpochKey(workspaceId)];
    try { await Promise.all([producer.del(...streamKeys), defaultDb.del(...streamKeys)]); }
    finally { writer.disconnect(); producer.disconnect(); defaultDb.disconnect(); }
  }
});

it("pushes real increments, restores the complete reconnect snapshot and isolates workspaces with an expiry", async () => {
  const workspaceId = randomUUID(), jobId = randomUUID();
  const key = `opening:tutor-stream:${workspaceId}:${jobId}`;
  keys.push(key, tutorStreamEpochKey(workspaceId));
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
    await writer.append(workspaceId, jobId, "先看矩阵", undefined, 2);
    await writer.append(workspaceId, jobId, "的第一行。", undefined, 2);
    await allDeltas;
    expect(received).toEqual([{ text: "先看矩阵", sequence: 1 }, { text: "的第一行。", sequence: 2 }]);
    expect(await reader.read(workspaceId, jobId)).toEqual({ ...context, text: "先看矩阵的第一行。", sequence: 2 });
    expect(await reader.read(randomUUID(), jobId)).toBeNull();
    expect(await redis.ttl(key)).toBeGreaterThan(0);
    expect(await redis.ttl(key)).toBeLessThanOrEqual(900);
  } finally { await unsubscribe(); }
});

async function streamFixture(historySourceId?: string) {
  const fixture = await createOpeningFixture();
  const { scope, sql } = fixture;
  const conversations = createOpeningConversationRepository(sql);
  const conversation = await conversations.create(scope, { title: "stream publication", courseId: null });
  const append = (text: string) => conversations.appendSavedTurn({ scope, conversationId: conversation.id,
    text, mode: "explain", clientKey: randomUUID(), sourceIds: [], learningSessionId: null, currentPage: null, chunkId: null });
  if (historySourceId) {
    const prior = await append("Previous question");
    const refs = [{ sourceId: historySourceId, sourceVersion: 0 }];
    await sql`INSERT INTO opening_sources (id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
      VALUES (${historySourceId},${scope.workspaceId},'history.txt','text/plain',1,${"0".repeat(64)},0,'uploaded','ready')`;
    await sql`INSERT INTO opening_source_versions (source_id,version,workspace_id,availability)
      VALUES (${historySourceId},0,${scope.workspaceId},'available')`;
    await sql`UPDATE opening_turns SET text='Previous answer',status='complete',context_source_refs=${sql.json(refs)},
      created_at=now()-interval '1 hour' WHERE id=${prior.assistantTurnId}`;
    await sql`UPDATE opening_turns SET created_at=now()-interval '1 hour' WHERE id=${prior.turnId}`;
    await sql`UPDATE opening_tutor_jobs SET status='succeeded' WHERE id=${prior.jobId}`;
  }
  const { jobId } = await append("Current question");
  const key = tutorStreamKey(scope.workspaceId, jobId);
  keys.push(key, tutorStreamEpochKey(scope.workspaceId));
  const writer = createTutorStreamWriter(redis), reader = createTutorStreamReader(redis);
  const jobs = createOpeningTutorJobsRepository(sql);
  const deps = { tutorJobs: jobs, stream: writer, chunks: createOpeningSourceChunksRepository(sql),
    budget: createOpeningBudgetRepository(sql, { envCapCents: 100_000 }),
    config: { maxContextCharacters: 1000, reservedCents: 100, maxOutputTokens: 100, inputCentsPerMillion: 100, outputCentsPerMillion: 200 } };
  return { fixture, scope, sql, jobId, key, writer, reader, jobs, deps };
}

it("revokes the same Redis privacy epoch for upper- and lowercase workspace UUIDs", async () => {
  const { fixture, scope, sql, jobId, key, writer, reader, jobs } = await streamFixture();
  const mixedCase = { ...scope, workspaceId: scope.workspaceId.toUpperCase() };
  try {
    const job = (await jobs.claim(jobId))!;
    await writer.begin(scope.workspaceId, jobId, { privacyEpoch: 0, contextSourceRefs: [],
      exposureReceiptId: null, executionId: job.executionId });
    expect(await writer.append(scope.workspaceId, jobId, "before revocation", job.executionId, 0)).toBe(1);
    const before = await reader.read(scope.workspaceId, jobId);
    expect(before).toMatchObject({ text: "before revocation", sequence: 1, executionId: job.executionId });
    await expect(sql.begin(tx => advanceOpeningWorkspacePrivacyEpoch(tx, mixedCase))).resolves.toBe(1);
    expect(await redis.get(tutorStreamEpochKey(scope.workspaceId))).toBe("1");
    const mixedCaseJobId = jobId.toUpperCase();
    await writer.begin(mixedCase.workspaceId, mixedCaseJobId, { privacyEpoch: 0, contextSourceRefs: [],
      exposureReceiptId: null, executionId: job.executionId });
    expect(await writer.append(scope.workspaceId, jobId, "stale", job.executionId, 0)).toBe(0);
    expect(await writer.append(mixedCase.workspaceId, mixedCaseJobId, "stale", job.executionId, 0)).toBe(0);
    expect(await reader.read(mixedCase.workspaceId, mixedCaseJobId)).toEqual(before);
    expect(await redis.hget(key, "sequence")).toBe("1");
  } finally {
    await fixture.close();
  }
});

it("seals a recovered execution before committing outcome_unknown", async () => {
  const { fixture, scope, sql, jobId, writer, reader, jobs } = await streamFixture();
  try {
    const job = (await jobs.claim(jobId))!;
    const context = { privacyEpoch: 0, contextSourceRefs: [], exposureReceiptId: null,
      claimToken: job.claimToken, executionId: job.executionId };
    await writer.begin(scope.workspaceId, jobId, context);
    expect(await writer.append(scope.workspaceId, jobId, "before recovery", job.executionId, 0)).toBe(1);
    await sql`UPDATE opening_tutor_jobs SET updated_at=now()-interval '10 minutes' WHERE id=${jobId}`;

    expect(await jobs.recoverExpired()).toBe(1);
    expect(await writer.append(scope.workspaceId, jobId, "late bytes", job.executionId, 0)).toBe(0);
    expect(await reader.read(scope.workspaceId, jobId)).toMatchObject({ text: "before recovery", sequence: 1 });
  } finally {
    await fixture.close();
  }
});

const output = { text: "First unsafe tail", citedChunkIds: [], candidates: [], requestId: null, inputTokens: 10, outputTokens: 10 };

it.each(["cancellation", "privacy epoch"])("fences a timed-out append before %s commits even when Redis control stalls", async revocation => {
  const { fixture, scope, reader, writer, jobs, jobId, key } = await streamFixture();
  const publication = openRaceSession(), revocationSession = openRaceSession();
  const [appendTransport, controlTransport] = await Promise.all([openRedisTransport(redisUrl), openRedisTransport(redisUrl)]);
  const producer = redis.duplicate();
  const control = redis.duplicate({ host: "127.0.0.1", port: controlTransport.port, commandTimeout: 200 });
  const replacement = redis.duplicate();
  const allowReplacement = deferred();
  const connectReplacement = replacement.connect.bind(replacement);
  vi.spyOn(replacement, "connect").mockImplementationOnce(async () => {
    await allowReplacement.promise;
    return connectReplacement();
  });
  const duplicate = vi.spyOn(producer, "duplicate")
    .mockImplementationOnce(options => redis.duplicate({ ...options, host: "127.0.0.1", port: appendTransport.port, commandTimeout: 200 }))
    .mockReturnValueOnce(control).mockReturnValueOnce(replacement);
  const appendWriter = createWorkerTutorStreamWriter(producer, vi.fn());
  const observed: TutorStreamDelta[] = [];
  const checkpoint = deferred();
  const unsubscribe = await reader.subscribe(scope.workspaceId, jobId, delta => {
    if (delta.text === "checkpoint") checkpoint.resolve();
    else observed.push(delta);
  });
  try {
    await Promise.all([publication.ready, revocationSession.ready]);
    const job = (await jobs.claim(jobId))!;
    const context = { privacyEpoch: 0, contextSourceRefs: [], exposureReceiptId: null,
      claimToken: job.claimToken, executionId: job.executionId };
    await writer.begin(scope.workspaceId, jobId, context);
    expect(await appendWriter.append(scope.workspaceId, jobId, "First", job.executionId, 0)).toBe(1);
    const before = await reader.read(scope.workspaceId, jobId);
    expect(before).toMatchObject({ text: "First", sequence: 1 });
    const stalledAppend = appendTransport.holdWrites();
    // Open the first control socket without modifying the active execution.
    await appendWriter.seal(scope.workspaceId, jobId, randomUUID());
    const controlEval = vi.spyOn(control, "eval");
    const stalledControl = controlTransport.holdWrites();
    const publishing = track(createOpeningTutorJobsRepository(publication.sql).withStreamPublication(scope, jobId, context, async () => {
      await appendWriter.append(scope.workspaceId, jobId, " unsafe tail", job.executionId, 0);
    }));
    try {
      await Promise.race([stalledAppend.received, publishing.then(() => { throw new Error("append settled before reaching TCP"); })]);
      const revoking = revocation === "cancellation"
        ? track(createOpeningTutorJobsRepository(revocationSession.sql).cancel(scope, jobId))
        : track(revocationSession.sql.begin(tx => advanceOpeningWorkspacePrivacyEpoch(tx, scope, redisUrl)));
      const first = await Promise.race([
        stalledControl.received.then(async () => {
          await expect(controlEval.mock.results[0]?.value).rejects.toThrow("Command timed out");
          return "control timed out";
        }),
        revoking.then(() => "revoked"),
      ]);
      if (first === "control timed out") {
        await waitUntilBlocked(fixture.sql, revocationSession.pid, publication.pid, revocation);
      }
      const appendRedis = duplicate.mock.results[0]?.value as Redis;
      expect(appendRedis.stream.destroyed).toBe(true);
      expect(control.stream.destroyed).toBe(true);
      allowReplacement.resolve();
      await expect(publishing).rejects.toThrow("Command timed out");
      const result = await revoking;
      if (revocation === "cancellation") expect(result).toMatchObject({ status: "cancelled" });
      else expect(result).toBe(1);

      // Forward the original EVAL only after PostgreSQL commits. The reply
      // confirms Redis actually evaluated the stale bytes on the original connection.
      const reply = stalledAppend.nextReply();
      stalledAppend.release();
      expect(await reply).toBe(":0\r\n");
      expect(await reader.read(scope.workspaceId, jobId)).toEqual(before);
      await redis.publish(`${key}:events`, JSON.stringify({ text: "checkpoint", sequence: 3 }));
      await checkpoint.promise;
      expect(observed).toEqual([{ text: "First", sequence: 1 }]);
      expect(first).toBe("control timed out");
      const newExecutionId = randomUUID(), newJobId = randomUUID();
      keys.push(`opening:tutor-stream:${scope.workspaceId}:${newJobId}`);
      const privacyEpoch = revocation === "privacy epoch" ? 1 : 0;
      await appendWriter.begin(scope.workspaceId, newJobId, { ...context, privacyEpoch, executionId: newExecutionId });
      expect(await appendWriter.append(scope.workspaceId, newJobId, "New turn", newExecutionId, privacyEpoch)).toBe(1);
      expect(duplicate).toHaveBeenCalledTimes(4);
    } finally {
      allowReplacement.resolve();
      stalledControl.release();
      stalledAppend.release();
      await Promise.allSettled([publishing]);
    }
  } finally {
    await unsubscribe();
    appendWriter.disconnect();
    producer.disconnect();
    await Promise.all([appendTransport.close(), controlTransport.close(), closeRace(publication.sql),
      closeRace(revocationSession.sql), fixture.close()]);
  }
}, 15_000);

it.each(["web", "repository"] as const)("keeps Redis unchanged when %s cancellation commits after the initial job read", async path => {
  const { fixture, scope, sql, jobId, key, writer, reader, jobs, deps } = await streamFixture();
  const checked = deferred();
  const resume = deferred();
  const observed: TutorStreamDelta[] = [];
  const checkpoint = deferred();
  const unsubscribe = await reader.subscribe(scope.workspaceId, jobId, delta => {
    if (delta.text === "checkpoint") checkpoint.resolve();
    else observed.push(delta);
  });
  let tail = false;
  const provider: NonNullable<TutorTurnDeps["provider"]> = { complete: async (_input, _signal, emit) => {
    await emit!("First");
    tail = true;
    await emit!(" unsafe tail");
    return output;
  } };
  const tutorJobs = { ...jobs, withStreamPublication: (async (...args) => {
    // Pause after reading the original authorization state, before the final
    // locked check. The cancel paths must be able to commit at this point.
    if (tail) {
      const job = await jobs.get(scope, jobId);
      expect(job?.status).toBe("running");
      checked.resolve();
      await resume.promise;
    }
    return jobs.withStreamPublication(...args);
  }) satisfies typeof jobs.withStreamPublication };
  const run = createTutorTurnHandler({ ...deps, provider, tutorJobs })(jobId);
  const settled = run.catch(error => error);
  try {
    await Promise.race([checked.promise, settled.then(() => { throw new Error("job finished before the race"); })]);
    const before = await reader.read(scope.workspaceId, jobId);
    expect(before).toMatchObject({ sequence: 1, text: "First" });
    const cancelled = path === "web" ? (await getTutorJobService(sql).cancel(scope, jobId))?.job : await jobs.cancel(scope, jobId);
    expect(cancelled?.status).toBe("cancelled");
    expect(await writer.append(scope.workspaceId, jobId, "sealed", cancelled?.executionId, 0)).toBe(0);
    resume.resolve();
    expect(await settled).toMatchObject({ code: "CONFLICT" });
    expect(await reader.read(scope.workspaceId, jobId)).toEqual(before);
    expect(await writer.append(scope.workspaceId, jobId, "sealed", cancelled?.executionId, 0)).toBe(0);
    await redis.publish(`${key}:events`, JSON.stringify({ text: "checkpoint", sequence: 3 }));
    await checkpoint.promise;
    expect(observed).toEqual([{ text: "First", sequence: 1 }]);
  } finally {
    resume.resolve();
    await settled;
    await unsubscribe();
    await fixture.close();
  }
});

it.each([
  "web cancellation", "repository cancellation", "source exclusion", "source deletion", "recorded exclusion", "memory deletion",
] as const)("rejects delayed Redis bytes after the publishing PG backend dies and %s commits", async revocation => {
  const sourceId = randomUUID();
  const { fixture, scope, sql, reader, writer, jobs, jobId, key } = await streamFixture(sourceId);
  const publication = openRaceSession();
  const transport = await openRedisTransport(redisUrl);
  const appendRedis = redis.duplicate({ host: "127.0.0.1", port: transport.port });
  const appendWriter = createTutorStreamWriter(appendRedis);
  const observed: TutorStreamDelta[] = [];
  const checkpoint = deferred();
  const unsubscribe = await reader.subscribe(scope.workspaceId, jobId, delta => {
    if (delta.text === "checkpoint") checkpoint.resolve();
    else observed.push(delta);
  });
  try {
    await Promise.all([publication.ready, appendRedis.connect()]);
    const memoryId = revocation === "recorded exclusion" || revocation === "memory deletion"
      ? await backupRows(sql, scope).memory() : null;
    const job = (await jobs.claim(jobId))!;
    const context = { privacyEpoch: 0, contextSourceRefs: [], exposureReceiptId: null,
      claimToken: job.claimToken, executionId: job.executionId };
    await writer.begin(scope.workspaceId, jobId, context);
    expect(await appendWriter.append(scope.workspaceId, jobId, "First", job.executionId, 0)).toBe(1);
    const before = await reader.read(scope.workspaceId, jobId);
    expect(before).toMatchObject({ text: "First", sequence: 1 });
    const stalled = transport.holdWrites();
    let appendResult: Promise<number> | undefined;
    const publishing = track(createOpeningTutorJobsRepository(publication.sql).withStreamPublication(scope, jobId, context, async () => {
      appendResult = appendWriter.append(scope.workspaceId, jobId, " unsafe tail", job.executionId, 0);
      await appendResult;
    }));
    try {
      await Promise.race([stalled.received, publishing.then(() => { throw new Error("append settled before reaching TCP"); })]);
      const [terminated] = await sql`SELECT pg_terminate_backend(${publication.pid}) AS terminated`;
      expect(terminated?.terminated).toBe(true);
      await expect(publishing).rejects.toMatchObject({ code: "CONNECTION_CLOSED" });
      if (revocation === "web cancellation") {
        expect(await getTutorJobService(sql).cancel(scope, jobId)).toMatchObject({ job: { status: "cancelled" }, conflict: false });
      } else if (revocation === "repository cancellation") {
        expect(await jobs.cancel(scope, jobId)).toMatchObject({ status: "cancelled" });
      } else {
        if (revocation === "recorded exclusion") {
          await createOpeningPrivacyRepository(sql).recordExclusions(sql, scope, {
            sourceIds: [sourceId], memoryId: memoryId!, deletedAt: new Date(),
          });
        } else if (revocation === "memory deletion") {
          const [memory] = await sql`SELECT version FROM opening_memories WHERE id=${memoryId}`;
          await deleteOwnedMemory(sql, scope, { id: memoryId!, expectedVersion: Number(memory!.version),
            deleteSourceText: false, clientKey: randomUUID() });
        } else {
          const action = revocation === "source exclusion" ? "exclude" : "delete";
          const keys = { stagingKey: (id: string) => id, finalKey: (id: string) => id };
          await createOpeningSourceActionsRepository(sql).apply(scope, sourceId,
            { action, expectedVersion: 0, expectedMembershipIds: [] }, keys, new Date());
        }
        expect(await sql`SELECT privacy_epoch FROM workspaces WHERE id=${scope.workspaceId}`).toMatchObject([{ privacy_epoch: 1 }]);
      }

      const reply = stalled.nextReply();
      stalled.release();
      expect(await reply).toBe(":0\r\n");
      expect(await appendResult).toBe(0);
      expect(await reader.read(scope.workspaceId, jobId)).toEqual(before);
      await redis.publish(`${key}:events`, JSON.stringify({ text: "checkpoint", sequence: 3 }));
      await checkpoint.promise;
      expect(observed).toEqual([{ text: "First", sequence: 1 }]);
    } finally {
      stalled.release();
      await expect(publishing).rejects.toThrow();
    }
  } finally {
    await unsubscribe();
    appendRedis.disconnect();
    await Promise.all([transport.close(), closeRace(publication.sql), fixture.close()]);
  }
}, 15_000);

it.each(["missing configuration", "unreachable Redis"] as const)("rolls back cancellation and privacy changes with %s", async failure => {
  const { fixture, scope, sql, jobs, jobId } = await streamFixture();
  const server = createServer(socket => socket.destroy());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await jobs.claim(jobId);
    const port = (server.address() as AddressInfo).port;
    vi.stubEnv("REDIS_URL", failure === "missing configuration" ? undefined : `redis://127.0.0.1:${port}`);
    await expect(jobs.cancel(scope, jobId)).rejects.toThrow();
    await expect(sql.begin(tx => advanceOpeningWorkspacePrivacyEpoch(tx, scope))).rejects.toThrow();
    expect(await jobs.get(scope, jobId)).toMatchObject({ status: "running" });
    expect(await sql`SELECT privacy_epoch FROM workspaces WHERE id=${scope.workspaceId}`).toMatchObject([{ privacy_epoch: 0 }]);
  } finally {
    vi.stubEnv("REDIS_URL", redisUrl);
    await new Promise<void>(resolve => { server.close(() => resolve()); });
    await fixture.close();
  }
});

it("holds cancellation behind an append already admitted by PostgreSQL", async () => {
  const { fixture, scope, reader, writer, jobs, jobId } = await streamFixture();
  const publication = openRaceSession(), cancellation = openRaceSession();
  const admitted = deferred(), append = deferred();
  try {
    await Promise.all([publication.ready, cancellation.ready]);
    const job = (await jobs.claim(jobId))!;
    const context = { privacyEpoch: 0, contextSourceRefs: [], exposureReceiptId: null,
      claimToken: job.claimToken, executionId: job.executionId };
    await writer.begin(scope.workspaceId, jobId, context);
    const publishing = track(createOpeningTutorJobsRepository(publication.sql).withStreamPublication(scope, jobId, context, async () => {
      admitted.resolve();
      await append.promise;
      expect(await writer.append(scope.workspaceId, jobId, "Published first", job.executionId, 0)).toBe(1);
    }));
    await Promise.race([admitted.promise, publishing]);
    const cancelling = track(createOpeningTutorJobsRepository(cancellation.sql).cancel(scope, jobId));
    try {
      await vi.waitFor(async () => {
        const [lock] = await fixture.sql`SELECT ${publication.pid} = ANY(pg_blocking_pids(${cancellation.pid})) AS waiting`;
        expect(lock?.waiting).toBe(true);
        expect(await reader.read(scope.workspaceId, jobId)).toMatchObject({ sequence: 0, text: "" });
      });
    } finally {
      append.resolve();
      await Promise.allSettled([publishing, cancelling]);
    }
    await publishing;
    expect(await cancelling).toMatchObject({ status: "cancelled" });
    expect(await reader.read(scope.workspaceId, jobId)).toMatchObject({ sequence: 1, text: "Published first" });
  } finally {
    append.resolve();
    await Promise.all([closeRace(publication.sql), closeRace(cancellation.sql), fixture.close()]);
  }
});

it("rejects a buffered batch when a history-only source version becomes unavailable", async () => {
  const sourceId = randomUUID();
  const { fixture, scope, sql, jobId, reader, deps } = await streamFixture(sourceId);
  const provider: NonNullable<TutorTurnDeps["provider"]> = { complete: async (input, _signal, emit) => {
    expect(input.chunks).toEqual([]);
    expect(input.history).toContainEqual({ role: "assistant", text: "Previous answer" });
    await emit!("First");
    expect(await reader.read(scope.workspaceId, jobId)).toMatchObject({ contextSourceRefs: [{ sourceId, sourceVersion: 0 }] });
    await emit!(" unsafe tail");
    await sql`UPDATE opening_source_versions SET availability='unavailable' WHERE source_id=${sourceId} AND version=0`;
    return output;
  } };
  try {
    const run = createTutorTurnHandler({ ...deps, provider })(jobId);
    const result = await run.catch(error => error);
    expect(await reader.read(scope.workspaceId, jobId)).toMatchObject({ text: "First", sequence: 1 });
    expect(result).toMatchObject({ code: "CONFLICT" });
  } finally { await fixture.close(); }
});
