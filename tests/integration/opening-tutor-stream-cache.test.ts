import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import { Redis } from "ioredis";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { advanceOpeningWorkspacePrivacyEpoch, createCourseMembershipRepository, createOpeningBudgetRepository,
  createOpeningConversationRepository, createOpeningCourseReadySourcesRepository, createOpeningPrivacyRepository,
  createOpeningSourceActionsRepository, createOpeningSourceChunksRepository, createOpeningTutorJobsRepository,
  tutorStreamEpochKey, tutorStreamKey } from "@aistudy/database";
import { fenceCancelledOpeningTutorStream } from "../../packages/database/src/repositories/opening-tutor-stream-fence";
import { createProducerRedisConnection } from "../../apps/worker/src/runtime/queue";
import { createTutorTurnHandler, type TutorTurnDeps } from "../../apps/worker/src/jobs/tutor-turn";
import { createOpeningMaterialRetriever } from "../../apps/worker/src/runtime/material-retrieval";
import { createTutorStreamReader, createTutorStreamWriter, createWorkerTutorStreamWriter,
  UnconfirmedStreamSealError, type TutorStreamDelta } from "../../apps/worker/src/runtime/tutor-stream";
import { getTutorJobService } from "../../apps/web/src/features/opening/server/data-services";
import { createJobStreamResponse } from "../../apps/web/src/features/opening/server/job-stream";
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
    expect(await writer.append(scope.workspaceId, jobId, "sealed", before?.executionId, 0)).toBe(0);
    resume.resolve();
    expect(await settled).toMatchObject({ code: "CONFLICT" });
    expect(await reader.read(scope.workspaceId, jobId)).toEqual(before);
    expect(await writer.append(scope.workspaceId, jobId, "sealed", before?.executionId, 0)).toBe(0);
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

it.each(["missing configuration", "unreachable Redis"] as const)("rolls back privacy changes while still committing Stop cancellation in PostgreSQL with %s", async failure => {
  const { fixture, scope, sql, jobs, jobId } = await streamFixture();
  const server = createServer(socket => socket.destroy());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const claimed = (await jobs.claim(jobId))!;
    const port = (server.address() as AddressInfo).port;
    vi.stubEnv("REDIS_URL", failure === "missing configuration" ? undefined : `redis://127.0.0.1:${port}`);
    await expect(sql.begin(tx => advanceOpeningWorkspacePrivacyEpoch(tx, scope))).rejects.toThrow();
    expect(await sql`SELECT privacy_epoch FROM workspaces WHERE id=${scope.workspaceId}`).toMatchObject([{ privacy_epoch: 0 }]);

    // Stop (cancel) must commit status='cancelled' and timing_execution_id=NULL in PostgreSQL
    // even when Redis is unavailable so jobs never stay stuck running during an outage.
    expect(await jobs.cancel(scope, jobId)).toMatchObject({ status: "cancelled" });
    expect(await sql`SELECT status, timing_execution_id FROM opening_tutor_jobs WHERE id=${jobId}`)
      .toMatchObject([{ status: "cancelled", timing_execution_id: null }]);
    expect(await jobs.readStream(scope, jobId, {
      privacyEpoch: 0, contextSourceRefs: [], exposureReceiptId: null,
      claimToken: claimed.claimToken, executionId: claimed.executionId,
    })).toMatchObject({ status: "cancelled" });
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

it("blocks Redis append and HTTP SSE delivery when course membership is removed before withStreamPublication or SSE read", async () => {
  const fixture = await createOpeningFixture();
  const { scope, sql } = fixture;
  const courses = createCourseMembershipRepository(sql);
  const conversations = createOpeningConversationRepository(sql);
  const jobs = createOpeningTutorJobsRepository(sql);
  const chunks = createOpeningSourceChunksRepository(sql);
  const budget = createOpeningBudgetRepository(sql, { envCapCents: 100_000 });
  const writer = createTutorStreamWriter(redis), reader = createTutorStreamReader(redis);
  const course = await courses.createCourse({ workspaceId: scope.workspaceId, title: "Membership TOCTOU", slug: randomUUID() });
  const sourceId = randomUUID();
  await sql`INSERT INTO opening_sources (id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
    VALUES (${sourceId},${scope.workspaceId},'course.txt','text/plain',12,${"a".repeat(64)},0,'uploaded','ready')`;
  await sql`INSERT INTO opening_source_versions (source_id,version,workspace_id,availability)
    VALUES (${sourceId},0,${scope.workspaceId},'available')`;
  await chunks.replaceChunks(scope, { sourceId, sourceVersion: 0, chunks: [{
    page: 1, text: "Course-only material", slideLabel: null, startMs: null, endMs: null, imageObjectKey: null,
  }] });
  const membershipInput = { workspaceId: scope.workspaceId, courseId: course.id, assetType: "source" as const, assetId: sourceId };
  await courses.addAssetMembership({ ...membershipInput, role: "core", sortOrder: 0, visibility: "course", purpose: "teaching" });
  const conversation = await conversations.create(scope, { title: "Course stream", courseId: course.id });

  // Part 1: course membership removed in the gap right before withStreamPublication.
  const firstTurn = await conversations.appendSavedTurn({ scope, conversationId: conversation.id, text: "Explain",
    mode: "explain", clientKey: randomUUID(), sourceIds: [sourceId], learningSessionId: null, currentPage: 1, chunkId: null });
  const firstKey = tutorStreamKey(scope.workspaceId, firstTurn.jobId);
  keys.push(firstKey, tutorStreamEpochKey(scope.workspaceId));
  const checked = deferred(), resume = deferred(), checkpoint = deferred();
  const observed: TutorStreamDelta[] = [];
  const unsubscribe = await reader.subscribe(scope.workspaceId, firstTurn.jobId, delta => {
    if (delta.text === "checkpoint") checkpoint.resolve();
    else observed.push(delta);
  });
  let tail = false;
  const provider: NonNullable<TutorTurnDeps["provider"]> = { complete: async (_input, _signal, emit) => {
    await emit!("First");
    tail = true;
    await emit!(" unauthorized tail");
    return { text: "First unauthorized tail", citedChunkIds: [], candidates: [], requestId: null, inputTokens: 10, outputTokens: 10 };
  } };
  const retrieveContext = createOpeningMaterialRetriever(sql, budget, null);
  const tutorJobs = { ...jobs, withStreamPublication: (async (...args) => {
    if (tail) {
      // Simulate the pre-check gap: pin/job/source/epoch are still current before entering withStreamPublication.
      const [, , publicationContext] = args;
      expect(publicationContext.materialPurposePin?.courseId).toBe(course.id);
      await createOpeningCourseReadySourcesRepository(sql).assertMaterialPurposePin(scope, publicationContext.materialPurposePin!);
      checked.resolve();
      await resume.promise;
    }
    return jobs.withStreamPublication(...args);
  }) satisfies typeof jobs.withStreamPublication };
  const run = createTutorTurnHandler({
    tutorJobs, stream: writer, chunks, budget, provider, retrieveContext,
    privacy: createOpeningPrivacyRepository(sql),
    config: { maxContextCharacters: 1000, reservedCents: 100, maxOutputTokens: 100, inputCentsPerMillion: 100, outputCentsPerMillion: 200 },
  })(firstTurn.jobId);
  const settled = run.catch(error => error);
  try {
    await Promise.race([checked.promise, settled.then(() => { throw new Error("job finished before membership removal gap"); })]);
    const before = (await reader.read(scope.workspaceId, firstTurn.jobId))!;
    expect(before).toMatchObject({ sequence: 1, text: "First", materialPurposePin: { courseId: course.id, materialUse: "citation" } });
    // Remove course membership while privacy_epoch, source version, and running claim stay unchanged.
    await courses.removeAssetMembership(membershipInput);
    expect(await sql`SELECT privacy_epoch FROM workspaces WHERE id=${scope.workspaceId}`).toMatchObject([{ privacy_epoch: 0 }]);
    expect(await sql`SELECT version FROM opening_sources WHERE id=${sourceId}`).toMatchObject([{ version: 0 }]);
    expect(await jobs.get(scope, firstTurn.jobId)).toMatchObject({ status: "running" });
    resume.resolve();
    expect(await settled).toMatchObject({ code: "CONFLICT" });
    expect(await reader.read(scope.workspaceId, firstTurn.jobId)).toEqual(before);
    await redis.publish(`${firstKey}:events`, JSON.stringify({ text: "checkpoint", sequence: 3 }));
    await checkpoint.promise;
    expect(observed).toEqual([{ text: "First", sequence: 1 }]);
    expect((await sql`SELECT status FROM opening_turns WHERE id=${firstTurn.assistantTurnId}`)[0]?.status).toBe("failed");

    // Part 2: course membership removed AFTER a Redis batch was published, BEFORE HTTP SSE read / delayed flush.
    await courses.addAssetMembership({ ...membershipInput, role: "core", sortOrder: 0, visibility: "course", purpose: "teaching" });
    const secondTurn = await conversations.appendSavedTurn({ scope, conversationId: conversation.id, text: "Explain again",
      mode: "explain", clientKey: randomUUID(), sourceIds: [sourceId], learningSessionId: null, currentPage: 1, chunkId: null });
    keys.push(tutorStreamKey(scope.workspaceId, secondTurn.jobId));
    const claimed = (await jobs.claim(secondTurn.jobId))!;
    const materialPurposePin = await createOpeningCourseReadySourcesRepository(sql).readMaterialPurposePin(scope, {
      courseId: course.id, materialUse: "citation", sourceIds: [sourceId],
    });
    const context = { privacyEpoch: 0, contextSourceRefs: [{ sourceId, sourceVersion: 0 }], exposureReceiptId: null,
      claimToken: claimed.claimToken, executionId: claimed.executionId, materialPurposePin };
    await jobs.withStreamPublication(scope, secondTurn.jobId, context, async () => {
      await writer.begin(scope.workspaceId, secondTurn.jobId, context);
      expect(await writer.append(scope.workspaceId, secondTurn.jobId, "Published before removal", claimed.executionId, 0)).toBe(1);
    });
    const cached = (await reader.read(scope.workspaceId, secondTurn.jobId))!;
    expect(cached).toMatchObject({ text: "Published before removal", sequence: 1, materialPurposePin });
    const authorizedJob = (await jobs.readStream(scope, secondTurn.jobId, cached))!;
    expect(authorizedJob).toMatchObject({ status: "running" });
    await expect(jobs.readStream(scope, secondTurn.jobId, { ...cached, materialPurposePin: undefined }))
      .rejects.toMatchObject({ code: "CONFLICT" });

    const entered = deferred(), release = deferred();
    const delayed = await createJobStreamResponse({
      job: authorizedJob, signal: new AbortController().signal,
      reader: { read: async () => { entered.resolve(); await release.promise; return cached; }, subscribe: async () => async () => {} },
      getJob: () => jobs.get(scope, secondTurn.jobId),
      authorizeSnapshot: (snapshot, commitAuthorized) => jobs.readStream(scope, secondTurn.jobId, snapshot, commitAuthorized),
      close: () => {},
    });
    try {
      await entered.promise;
      await courses.removeAssetMembership(membershipInput);
      expect(await sql`SELECT privacy_epoch FROM workspaces WHERE id=${scope.workspaceId}`).toMatchObject([{ privacy_epoch: 0 }]);
      expect(await sql`SELECT version FROM opening_sources WHERE id=${sourceId}`).toMatchObject([{ version: 0 }]);
      expect(await jobs.get(scope, secondTurn.jobId)).toMatchObject({ status: "running" });
      release.resolve();
      expect(await delayed.text()).toBe("");
    } finally {
      release.resolve();
    }

    const reconnect = await createJobStreamResponse({
      job: authorizedJob, signal: new AbortController().signal,
      reader: { read: () => reader.read(scope.workspaceId, secondTurn.jobId), subscribe: async () => async () => {} },
      getJob: () => jobs.get(scope, secondTurn.jobId),
      authorizeSnapshot: (snapshot, commitAuthorized) => jobs.readStream(scope, secondTurn.jobId, snapshot, commitAuthorized),
      close: () => {},
    });
    expect(await reconnect.text()).toBe("");
    await expect(jobs.readStream(scope, secondTurn.jobId, cached)).rejects.toMatchObject({ code: "CONFLICT" });
  } finally {
    resume.resolve();
    await settled;
    await unsubscribe();
    await fixture.close();
  }
});

it.each(["cancel", "membership removal"] as const)(
  "serializes SSE controller.enqueue inside readStream transaction against concurrent %s",
  async revocation => {
    const fixture = await createOpeningFixture();
    const { scope, sql } = fixture;
    const courses = createCourseMembershipRepository(sql);
    const conversations = createOpeningConversationRepository(sql);
    const jobs = createOpeningTutorJobsRepository(sql);
    const writer = createTutorStreamWriter(redis), reader = createTutorStreamReader(redis);
    const deliverySession = openRaceSession(), revocationSession = openRaceSession();
    const course = await courses.createCourse({ workspaceId: scope.workspaceId, title: "ReadStream Barrier", slug: randomUUID() });
    const sourceId = randomUUID();
    await sql`INSERT INTO opening_sources (id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
      VALUES (${sourceId},${scope.workspaceId},'barrier.txt','text/plain',12,${"b".repeat(64)},0,'uploaded','ready')`;
    await sql`INSERT INTO opening_source_versions (source_id,version,workspace_id,availability)
      VALUES (${sourceId},0,${scope.workspaceId},'available')`;
    const membershipInput = { workspaceId: scope.workspaceId, courseId: course.id, assetType: "source" as const, assetId: sourceId };
    await courses.addAssetMembership({ ...membershipInput, role: "core", sortOrder: 0, visibility: "course", purpose: "teaching" });
    const conversation = await conversations.create(scope, { title: "SSE barrier", courseId: course.id });

    const prepareTurn = async (text: string) => {
      const turn = await conversations.appendSavedTurn({ scope, conversationId: conversation.id, text: "Explain",
        mode: "explain", clientKey: randomUUID(), sourceIds: [sourceId], learningSessionId: null, currentPage: null, chunkId: null });
      keys.push(tutorStreamKey(scope.workspaceId, turn.jobId), tutorStreamEpochKey(scope.workspaceId));
      const claimed = (await jobs.claim(turn.jobId))!;
      const materialPurposePin = await createOpeningCourseReadySourcesRepository(sql).readMaterialPurposePin(scope, {
        courseId: course.id, materialUse: "citation", sourceIds: [sourceId],
      });
      const context = { privacyEpoch: 0, contextSourceRefs: [{ sourceId, sourceVersion: 0 }], exposureReceiptId: null,
        claimToken: claimed.claimToken, executionId: claimed.executionId, materialPurposePin };
      await jobs.withStreamPublication(scope, turn.jobId, context, async () => {
        await writer.begin(scope.workspaceId, turn.jobId, context);
        expect(await writer.append(scope.workspaceId, turn.jobId, text, claimed.executionId, 0)).toBe(1);
      });
      return { turn, claimed, cached: (await reader.read(scope.workspaceId, turn.jobId))! };
    };

    const enqueued = deferred(), releaseCommit = deferred();
    try {
      await Promise.all([deliverySession.ready, revocationSession.ready]);
      // Order 1: readStream acquires locks first; controller.enqueue finishes BEFORE revocation can commit.
      const first = await prepareTurn("Delivered under lock");
      const proxiedDeliverySql = new Proxy(deliverySession.sql, {
        get(target, prop, receiver) {
          if (prop === "begin") {
            return (fn: (tx: unknown) => Promise<unknown>) => target.begin(async tx => {
              const result = await fn(tx);
              enqueued.resolve();
              await releaseCommit.promise;
              return result;
            });
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      const deliveryJobs = createOpeningTutorJobsRepository(proxiedDeliverySql);
      const response = await createJobStreamResponse({
        job: first.claimed, signal: new AbortController().signal,
        reader: { read: async () => first.cached, subscribe: async () => async () => {} },
        getJob: () => jobs.get(scope, first.turn.jobId),
        authorizeSnapshot: (snapshot, commitAuthorized, canDeliver) =>
          deliveryJobs.readStream(scope, first.turn.jobId, snapshot, commitAuthorized, canDeliver),
        close: () => {},
      });
      const streamReader = response.body!.getReader();
      await enqueued.promise;
      // Bytes were enqueued synchronously inside readStream BEFORE COMMIT released PG locks.
      const chunk = await streamReader.read();
      expect(new TextDecoder().decode(chunk.value)).toContain("Delivered under lock");

      const revoking = revocation === "cancel"
        ? track(createOpeningTutorJobsRepository(revocationSession.sql).cancel(scope, first.turn.jobId))
        : track(createCourseMembershipRepository(revocationSession.sql).removeAssetMembership(membershipInput));
      try {
        await waitUntilBlocked(sql, revocationSession.pid, deliverySession.pid, revocation);
      } finally {
        releaseCommit.resolve();
      }
      await revoking;
      await streamReader.cancel();

      // Order 2: revocation commits first; readStream sees revoked state and commitAuthorized NEVER fires.
      if (revocation === "membership removal") {
        await courses.addAssetMembership({ ...membershipInput, role: "core", sortOrder: 0, visibility: "course", purpose: "teaching" });
      }
      const second = await prepareTurn("Never emit after revocation");
      if (revocation === "cancel") await jobs.cancel(scope, second.turn.jobId);
      else await courses.removeAssetMembership(membershipInput);

      const commitSpy = vi.fn();
      const afterRevocation = await createJobStreamResponse({
        job: second.claimed, signal: new AbortController().signal,
        reader: { read: async () => second.cached, subscribe: async () => async () => {} },
        getJob: () => jobs.get(scope, second.turn.jobId),
        authorizeSnapshot: (snapshot, commitAuthorized, canDeliver) => jobs.readStream(scope, second.turn.jobId, snapshot, authorized => {
          commitSpy(authorized);
          commitAuthorized?.(authorized);
        }, canDeliver),
        close: () => {},
      });
      const body = await afterRevocation.text();
      expect(commitSpy).not.toHaveBeenCalled();
      expect(body).not.toContain("Never emit after revocation");
      if (revocation === "cancel") expect(body).toContain("event: terminal");
      else expect(body).toBe("");
    } finally {
      releaseCommit.resolve();
      await Promise.all([closeRace(deliverySession.sql), closeRace(revocationSession.sql), fixture.close()]);
    }
  },
  15_000,
);

it("bounds seal confirmation during a Redis outage, fences timing_execution_id in PostgreSQL, and unblocks Stop and failure cleanup", async () => {
  const { fixture, scope, sql, reader, writer, jobs, jobId } = await streamFixture();
  const publication = openRaceSession(), revocationSession = openRaceSession();
  const appendTransport = await openRedisTransport(redisUrl);
  const blackholeSockets = new Set<import("node:net").Socket>();
  const blackhole = createServer(socket => {
    blackholeSockets.add(socket);
    socket.on("close", () => blackholeSockets.delete(socket));
  });
  blackhole.listen(0, "127.0.0.1");
  await once(blackhole, "listening");
  const blackholePort = (blackhole.address() as AddressInfo).port;
  const blackholeUrl = `redis://127.0.0.1:${blackholePort}`;
  const producer = redis.duplicate();
  vi.spyOn(producer, "duplicate")
    .mockImplementationOnce(options => redis.duplicate({ ...options, host: "127.0.0.1", port: appendTransport.port, commandTimeout: 120 }))
    .mockImplementation(options => redis.duplicate({ ...options, host: "127.0.0.1", port: blackholePort, connectTimeout: 5_000, commandTimeout: 5_000 }));
  const appendWriter = createWorkerTutorStreamWriter(producer, vi.fn(), { sealDeadlineMs: 180, sealRetryIntervalMs: 40 });
  try {
    await Promise.all([publication.ready, revocationSession.ready]);
    const job = (await jobs.claim(jobId))!;
    const context = { privacyEpoch: 0, contextSourceRefs: [], exposureReceiptId: null,
      claimToken: job.claimToken, executionId: job.executionId };
    await writer.begin(scope.workspaceId, jobId, context);
    expect(await appendWriter.append(scope.workspaceId, jobId, "First", job.executionId, 0)).toBe(1);

    const stalledAppend = appendTransport.holdWrites();
    const startedAt = performance.now();
    const publishing = track(createOpeningTutorJobsRepository(publication.sql).withStreamPublication(scope, jobId, context, async () => {
      await appendWriter.append(scope.workspaceId, jobId, " unsealed tail", job.executionId, 0);
    }));
    try {
      await Promise.race([stalledAppend.received, publishing.then(() => { throw new Error("append settled before TCP hold"); })]);
      const err = await publishing.catch(error => error);
      expect(err).toBeInstanceOf(UnconfirmedStreamSealError);
      expect(performance.now() - startedAt).toBeLessThan(2_000);

      // PostgreSQL cleared timing_execution_id while preserving claim_token so cleanup still works.
      const [row] = await sql`SELECT status, claim_token, timing_execution_id FROM opening_tutor_jobs WHERE id=${jobId}`;
      expect(row).toMatchObject({ status: "running", claim_token: job.claimToken, timing_execution_id: null });

      // Even if Redis recovers later and accepts the in-flight unsealed append, readStream rejects it fail-closed.
      const reply = stalledAppend.nextReply();
      stalledAppend.release();
      expect(await reply).toBe(":2\r\n");
      const staleSnapshot = (await reader.read(scope.workspaceId, jobId))!;
      expect(staleSnapshot).toMatchObject({ text: "First unsealed tail", sequence: 2, executionId: job.executionId });
      await expect(jobs.readStream(scope, jobId, staleSnapshot)).rejects.toThrow("stream execution changed");
      const sse = await createJobStreamResponse({
        job, signal: new AbortController().signal,
        reader: { read: async () => staleSnapshot, subscribe: async () => async () => {} },
        getJob: () => jobs.get(scope, jobId),
        authorizeSnapshot: (snapshot, commitAuthorized) => jobs.readStream(scope, jobId, snapshot, commitAuthorized),
        close: () => {},
      });
      expect(await sse.text()).toBe("");

      // Stop (cancel) succeeds in PostgreSQL even while Redis remains blackholed.
      const cancelled = await createOpeningTutorJobsRepository(revocationSession.sql, { tutorStreamRedisUrl: blackholeUrl })
        .cancel(scope, jobId);
      expect(cancelled).toMatchObject({ status: "cancelled" });
    } finally {
      stalledAppend.release();
      await Promise.allSettled([publishing]);
    }
  } finally {
    appendWriter.disconnect();
    producer.disconnect();
    for (const socket of blackholeSockets) socket.destroy();
    await new Promise<void>(resolve => { blackhole.close(() => resolve()); });
    await Promise.all([appendTransport.close(), closeRace(publication.sql), closeRace(revocationSession.sql), fixture.close()]);
  }
}, 15_000);

it("revokes a course stream using derived historySourceRefs when the history source is detached from the course", async () => {
  const fixture = await createOpeningFixture();
  const { scope, sql } = fixture;
  const courses = createCourseMembershipRepository(sql);
  const conversations = createOpeningConversationRepository(sql);
  const jobs = createOpeningTutorJobsRepository(sql);
  const course = await courses.createCourse({ workspaceId: scope.workspaceId, title: "Derived Lineage", slug: randomUUID() });
  const sourceId = randomUUID();
  await sql`INSERT INTO opening_sources (id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
    VALUES (${sourceId},${scope.workspaceId},'derived.txt','text/plain',12,${"c".repeat(64)},0,'uploaded','ready')`;
  await sql`INSERT INTO opening_source_versions (source_id,version,workspace_id,availability)
    VALUES (${sourceId},0,${scope.workspaceId},'available')`;
  const membershipInput = { workspaceId: scope.workspaceId, courseId: course.id, assetType: "source" as const, assetId: sourceId };
  await courses.addAssetMembership({ ...membershipInput, role: "core", sortOrder: 0, visibility: "course", purpose: "teaching" });
  const conversation = await conversations.create(scope, { title: "Derived history stream", courseId: course.id });
  const turn = await conversations.appendSavedTurn({ scope, conversationId: conversation.id, text: "Follow-up",
    mode: "explain", clientKey: randomUUID(), sourceIds: [], learningSessionId: null, currentPage: null, chunkId: null });
  try {
    const claimed = (await jobs.claim(turn.jobId))!;
    const materialPurposePin = await createOpeningCourseReadySourcesRepository(sql).readMaterialPurposePin(scope, {
      courseId: course.id, materialUse: "citation", sourceIds: [],
    });
    const context = { privacyEpoch: 0, contextSourceRefs: [{ sourceId, sourceVersion: 0 }], exposureReceiptId: null,
      claimToken: claimed.claimToken, executionId: claimed.executionId, materialPurposePin };
    await jobs.withStreamPublication(scope, turn.jobId, context, async () => {});
    expect(await jobs.readStream(scope, turn.jobId, context)).toMatchObject({ status: "running" });

    await courses.removeAssetMembership(membershipInput);
    await expect(jobs.withStreamPublication(scope, turn.jobId, context, async () => {})).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(jobs.readStream(scope, turn.jobId, context)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(jobs.completeTurn({
      scope, jobId: turn.jobId, assistantTurnId: turn.assistantTurnId,
      text: "Should not persist after derived source detachment",
      citations: [], candidates: [], contextSourceRefs: [{ sourceId, sourceVersion: 0 }],
      expectedPrivacyEpoch: 0, claimToken: claimed.claimToken,
    }, { materialPurposePin })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await sql`SELECT status, text FROM opening_turns WHERE id=${turn.assistantTurnId}`)[0])
      .toMatchObject({ status: "pending" });
  } finally {
    await fixture.close();
  }
});
