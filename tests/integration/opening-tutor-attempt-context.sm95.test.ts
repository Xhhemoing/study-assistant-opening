import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import { Redis } from "ioredis";
import { createTutorStreamReader, createTutorStreamWriter, type TutorStreamDelta } from "../../apps/worker/src/runtime/tutor-stream";
import { createJobStreamResponse } from "../../apps/web/src/features/opening/server/job-stream";
import { createTutorService } from "../../apps/web/src/features/opening/tutor/tutor-service";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOpeningAiGradingRepository, createOpeningBudgetRepository, createOpeningConversationRepository,
  createOpeningPrivacyRepository, createOpeningSourceChunksRepository, createOpeningStudyExposureRepository, createOpeningTutorJobsRepository,
  tutorAttemptFence, tutorStreamAttemptHeadKey, tutorStreamEpochKey, tutorStreamKey, tutorStreamPreAnswerHeadKey,
} from "@aistudy/database";
import type { LearningAttempt, ProviderInput } from "@aistudy/contracts";
import { reviseOpeningLearningObservation } from "../../packages/database/src/repositories/opening-observation-revisions";
import { createTutorTurnHandler, type TutorTurnDeps } from "../../apps/worker/src/jobs/tutor-turn";
import { createOpeningMaterialRetriever } from "../../apps/worker/src/runtime/material-retrieval";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";
import { closeRace, deferred, openRaceSession, openRedisTransport, track } from "./opening-race-helpers";

let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => { await fixture.reset(); await fixture.sql`TRUNCATE opening_learning_sessions,opening_conversations CASCADE`; });
afterAll(async () => { await fixture?.close(); });

async function bindAttempt(f: Awaited<ReturnType<typeof learningAttemptFixture>>, attempt: LearningAttempt, mode: "hint" | "explain") {
  const conversations = createOpeningConversationRepository(fixture.sql);
  const conversation = await conversations.create(fixture.scope, { courseId: f.courseId, title: "sm95 native bound tutor" });
  const saved = await conversations.appendSavedTurn({ scope: fixture.scope, conversationId: conversation.id,
    text: mode === "hint" ? "请给一点提示" : "请讲解本次作答", mode, purpose: "answer", clientKey: randomUUID(), sourceIds: [],
    learningSessionId: f.sessionId, attemptId: attempt.id, contextAnchor: { purpose: "learning_help", courseId: f.courseId, attemptId: attempt.id },
    currentPage: null, chunkId: null });
  const jobs = createOpeningTutorJobsRepository(fixture.sql);
  const claim = async () => {
    const claimed = await jobs.claim(saved.jobId);
    return { userTurnId: saved.turnId, jobId: saved.jobId, claimToken: claimed!.claimToken, executionId: claimed!.executionId };
  };
  return { conversations, conversation, saved, jobs, claim };
}

async function seed(photo = false) {
  const f = await learningAttemptFixture(fixture), attempt = await f.start();
  const original = await f.submit(attempt, { answer: "sm95 wrong saved answer", outcome: "unverified" });
  let workSource: { id: string; version: number; physicalPage: number } | undefined;
  if (photo) {
    const id = randomUUID();
    await fixture.sql`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
      VALUES (${id},${fixture.scope.workspaceId},'sm95 sealed work','image/png',64,${"d".repeat(64)},0,'uploaded','ready')`;
    workSource = { id, version: 0, physicalPage: 1 };
  }
  const graded = await createOpeningAiGradingRepository(fixture.sql).apply(fixture.scope, {
    observationId: original.id, ...(workSource ? { workSourceId: workSource.id, workSourceVersion: 0, physicalPage: 1 } : {}),
  }, { outcome: "incorrect", questionMatch: true, confidence: 0.9, feedback: "sm95 feedback: the answer is wrong",
    criteria: [{ label: "sm95 criterion", verdict: "incorrect", feedback: "sm95 correction" }],
    ...(photo ? { transcription: "sm95 model transcription, not the question" } : {}) }, "sm95 fake grader");
  const binding = await bindAttempt(f, attempt, "explain");
  const correct = (rootObservationId = original.id) => reviseOpeningLearningObservation(fixture.sql, fixture.scope, {
    rootObservationId, revisesObservationId: graded.id, expectedHead: graded.id, revisionKind: "replace",
    reason: "sm95 changed answer", clientKey: randomUUID(),
    replacement: { answer: "sm95 revised answer", outcome: "unverified", assistance: graded.assistance },
  });
  return { ...f, ...binding, attempt, original, graded, correct, workSource };
}

function handler(f: Awaited<ReturnType<typeof seed>>, hook?: (onTextDelta?: (text: string) => Promise<void>) => Promise<void>,
  stream?: TutorTurnDeps["stream"]) {
  const inputs: ProviderInput[] = [];
  const provider = { complete: vi.fn(async (input: ProviderInput, _signal?: AbortSignal, onTextDelta?: (text: string) => Promise<void>) => {
    inputs.push(input);
    await hook?.(onTextDelta);
    return { text: "sm95 explanation", citedChunkIds: [], candidates: [], inputTokens: 10, outputTokens: 5, requestId: null };
  }) };
  const budget = createOpeningBudgetRepository(fixture.sql, { envCapCents: 100000 });
  const reserve = vi.spyOn(budget, "reserve"), claimExecution = vi.spyOn(budget, "claimExecution");
  return { inputs, provider, reserve, claimExecution, run: createTutorTurnHandler({ tutorJobs: f.jobs, chunks: createOpeningSourceChunksRepository(fixture.sql),
    budget, provider, stream, streamExposures: createOpeningStudyExposureRepository(fixture.sql),
    privacy: createOpeningPrivacyRepository(fixture.sql), retrieveContext: createOpeningMaterialRetriever(fixture.sql, budget, null),
    config: { maxContextCharacters: 5000, reservedCents: 1, maxOutputTokens: 256, inputCentsPerMillion: 100, outputCentsPerMillion: 200 } }) };
}

const completion = (f: Awaited<ReturnType<typeof seed>>, target: Awaited<ReturnType<typeof f.claim>>) => ({
  scope: fixture.scope, jobId: f.saved.jobId, assistantTurnId: f.saved.assistantTurnId, claimToken: target.claimToken,
  text: "must not persist stale answer", citations: [], candidates: [],
});

describe("sm95 same-attempt explain context", () => {
  it.each(["no grade", "unverified without transcription"])("sm95 P1a rejects photo-only %s before reserve/claim/send", async state => {
    const f = await seed(true);
    await fixture.sql`UPDATE opening_learning_observations SET answer='' WHERE id IN (${f.original.id},${f.graded.id})`;
    if (state === "no grade") await fixture.sql`UPDATE opening_learning_observations SET ai_evaluation=NULL,verdict_source='self_report' WHERE id=${f.graded.id}`;
    else await fixture.sql`UPDATE opening_learning_observations SET outcome='unverified',ai_evaluation=(ai_evaluation-'transcription') || '{"outcome":"unverified"}'::jsonb WHERE id=${f.graded.id}`;
    const h = handler(f);
    const before = await fixture.sql`SELECT * FROM opening_budget_reservations WHERE workspace_id=${fixture.scope.workspaceId} ORDER BY id`;
    await expect(h.run(f.saved.jobId)).rejects.toMatchObject({ code: "CONFLICT", reasonCode: "ATTEMPT_ANSWER_TEXT_UNAVAILABLE" });
    expect(h.provider.complete).not.toHaveBeenCalled();
    expect(h.reserve).not.toHaveBeenCalled();
    expect(h.claimExecution).not.toHaveBeenCalled();
    expect(await fixture.sql`SELECT * FROM opening_budget_reservations WHERE workspace_id=${fixture.scope.workspaceId} ORDER BY id`).toEqual(before);
  });

  it("sm95 P1a accepts only the corresponding photo transcription as content when saved answer is empty", async () => {
    const f = await seed(true);
    await fixture.sql`UPDATE opening_learning_observations SET answer='' WHERE id IN (${f.original.id},${f.graded.id})`;
    const h = handler(f);
    await h.run(f.saved.jobId);
    expect(h.inputs[0]!.text).toContain("sm95 model transcription, not the question");
    expect(h.provider.complete).toHaveBeenCalledOnce();
  });

  it("rejects H1 Redis publication when H2 commits between the attempt check and publication", async () => {
    const f = await seed(), target = await f.claim();
    const snapshot = (await f.jobs.readAttemptContext(fixture.scope, target))!;
    const context = { privacyEpoch: snapshot.privacyEpoch, contextSourceRefs: snapshot.sourceRefs,
      claimToken: target.claimToken, executionId: target.executionId, attemptContext: snapshot };
    await f.jobs.assertAttemptContext(fixture.scope, target, snapshot);
    const revised = await f.correct();
    const publish = vi.fn(async () => {});

    await expect(f.jobs.withStreamPublication(fixture.scope, f.saved.jobId, context, publish))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(publish).not.toHaveBeenCalled();

    const latest = (await f.jobs.readAttemptContext(fixture.scope, target))!;
    expect(latest.headObservationId).toBe(revised.headObservationId);
    await f.jobs.withStreamPublication(fixture.scope, f.saved.jobId, { ...context, attemptContext: latest }, publish);
    expect(publish).toHaveBeenCalledOnce();
  });

  it.each(["revision", "first submission"] as const)("rejects in-flight bytes after the publishing backend dies and %s commits", async mutation => {
    const submitted = mutation === "revision" ? await seed() : null;
    const f = submitted ?? await learningAttemptFixture(fixture);
    const attempt = submitted?.attempt ?? await f.start();
    const binding = submitted ?? await bindAttempt(f, attempt, "hint");
    const { jobs, saved } = binding;
    // Legacy turns can carry their attempt binding only in the saved anchor.
    if (!submitted) await fixture.sql`UPDATE opening_turns SET attempt_id=NULL WHERE id IN (${saved.turnId},${saved.assistantTurnId})`;
    const target = await binding.claim();
    const { scope, sql } = fixture;
    const snapshot = (await jobs.readAttemptContext(scope, target))!;
    expect(snapshot.headObservationId).toBe(submitted?.graded.id ?? null);
    const context = { privacyEpoch: snapshot.privacyEpoch, contextSourceRefs: snapshot.sourceRefs, exposureReceiptId: null,
      claimToken: target.claimToken, executionId: target.executionId, attemptFence: tutorAttemptFence(snapshot) };
    const redisUrl = process.env.REDIS_URL!;
    const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 0, commandTimeout: 3_000 });
    const transport = await openRedisTransport(redisUrl);
    const appendRedis = redis.duplicate({ host: "127.0.0.1", port: transport.port });
    const publication = openRaceSession();
    const writer = createTutorStreamWriter(redis), reader = createTutorStreamReader(redis);
    const key = tutorStreamKey(scope.workspaceId, saved.jobId);
    let rootId = submitted?.original.id;
    const checkpoint = deferred(), events: TutorStreamDelta[] = [];
    let unsubscribe: (() => Promise<void>) | undefined;
    try {
      await Promise.all([publication.ready, redis.connect(), appendRedis.connect()]);
      await writer.begin(scope.workspaceId, saved.jobId, context);
      expect(await writer.append(scope.workspaceId, saved.jobId,
        "Already published", target.executionId, snapshot.privacyEpoch, context.attemptFence)).toBe(1);
      unsubscribe = await reader.subscribe(scope.workspaceId, saved.jobId, delta => {
        if (delta.text === "checkpoint") checkpoint.resolve();
        else events.push(delta);
      });
      const before = await reader.read(scope.workspaceId, saved.jobId);
      expect(before).toMatchObject({ text: "Already published", sequence: 1 });
      const stalled = transport.holdWrites();
      let appendResult: Promise<number> | undefined;
      const publishing = track(createOpeningTutorJobsRepository(publication.sql).withStreamPublication(scope, saved.jobId,
        { ...context, attemptContext: snapshot }, async () => {
          appendResult = createTutorStreamWriter(appendRedis).append(scope.workspaceId, saved.jobId,
            "stale attempt bytes", target.executionId, snapshot.privacyEpoch, context.attemptFence);
          await appendResult;
        }));
      try {
        await Promise.race([stalled.received, publishing.then(() => { throw new Error("append settled before reaching TCP"); })]);
        const [terminated] = await sql`SELECT pg_terminate_backend(${publication.pid}) AS terminated`;
        expect(terminated?.terminated).toBe(true);
        await expect(publishing).rejects.toMatchObject({ code: "CONNECTION_CLOSED" });
        // PostgreSQL accepts either UUID casing. The Redis fence must use the stored root identity.
        const newHead = submitted ? (await submitted.correct(submitted.original.id.toUpperCase())).headObservationId
          : (await f.submit(attempt)).id;
        rootId ??= newHead;
        const headKey = submitted
          ? tutorStreamAttemptHeadKey(scope.workspaceId, submitted.original.id)
          : tutorStreamPreAnswerHeadKey(scope.workspaceId, attempt.id);
        await vi.waitFor(async () => {
          expect(await redis.get(headKey)).toBe(newHead);
        });
        const latest = (await jobs.readAttemptContext(scope, target))!;
        expect(latest.headObservationId).toBe(newHead);
        const reply = stalled.nextReply();
        stalled.release();
        expect(await reply).toBe(":0\r\n");
        expect(await appendResult).toBe(0);
        await writer.begin(scope.workspaceId, saved.jobId, context);
        expect(await reader.read(scope.workspaceId, saved.jobId)).toEqual(before);
        await redis.publish(`${key}:events`, JSON.stringify({ text: "checkpoint", sequence: 2 }));
        await checkpoint.promise;
        expect(events).toEqual([]);
        const currentFence = tutorAttemptFence(latest);
        // The crashed executionId was sealed in Redis; a new execution with the updated attempt head succeeds.
        const nextExecutionId = randomUUID();
        await writer.begin(scope.workspaceId, saved.jobId, { ...context, executionId: nextExecutionId, attemptFence: currentFence });
        expect(await writer.append(scope.workspaceId, saved.jobId, "late bytes after new head began",
          target.executionId, snapshot.privacyEpoch, context.attemptFence)).toBe(0);
        expect(await writer.append(scope.workspaceId, saved.jobId, "late bytes with stale head on new execution",
          nextExecutionId, snapshot.privacyEpoch, context.attemptFence)).toBe(0);
        expect(await writer.append(scope.workspaceId, saved.jobId, "current head bytes",
          nextExecutionId, snapshot.privacyEpoch, currentFence)).toBe(1);
        expect(await reader.read(scope.workspaceId, saved.jobId)).toMatchObject({ text: "current head bytes", sequence: 1 });
      } finally {
        stalled.release();
        await publishing.catch(() => undefined);
      }
    } finally {
      try {
        await unsubscribe?.();
        if (redis.status === "ready") await redis.del(key, tutorStreamEpochKey(scope.workspaceId),
          tutorStreamPreAnswerHeadKey(scope.workspaceId, attempt.id),
          ...(rootId ? [tutorStreamAttemptHeadKey(scope.workspaceId, rootId)] : []));
      } finally {
        redis.disconnect();
        appendRedis.disconnect();
        await Promise.all([transport.close(), closeRace(publication.sql)]);
      }
    }
  }, 15_000);

  it("commits learner revisions in PostgreSQL without blocking on Redis outages while still fencing stale streams", async () => {
    const f = await seed(), target = await f.claim();
    const beforeSnapshot = (await f.jobs.readAttemptContext(fixture.scope, target))!;
    const staleContext = {
      privacyEpoch: beforeSnapshot.privacyEpoch, contextSourceRefs: beforeSnapshot.sourceRefs,
      exposureReceiptId: null, claimToken: target.claimToken, executionId: target.executionId,
      attemptFence: tutorAttemptFence(beforeSnapshot),
    };
    const sockets = new Set<import("node:net").Socket>();
    const server = createServer(socket => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      // Blackholed Redis: revision commits immediately in PG and PG rejects stale stream snapshots.
      vi.stubEnv("REDIS_URL", `redis://127.0.0.1:${(server.address() as AddressInfo).port}`);
      const startedAt = performance.now();
      const revised = await f.correct();
      expect(performance.now() - startedAt).toBeLessThan(1_000);
      expect(await f.jobs.readAttemptContext(fixture.scope, target)).toMatchObject({ headObservationId: revised.headObservationId });
      await expect(f.jobs.readStream(fixture.scope, f.saved.jobId, staleContext)).rejects.toThrow("stream attempt context changed");

      // Completed/terminal Tutor job + missing REDIS_URL: subsequent revision succeeds cleanly.
      vi.stubEnv("REDIS_URL", undefined);
      await fixture.sql`UPDATE opening_tutor_jobs SET status='succeeded' WHERE id=${f.saved.jobId}`;
      const revisedAgain = await reviseOpeningLearningObservation(fixture.sql, fixture.scope, {
        rootObservationId: f.original.id, revisesObservationId: revised.headObservationId,
        expectedHead: revised.headObservationId, revisionKind: "replace", reason: "修正步骤2",
        clientKey: randomUUID(), replacement: { answer: "2x = 6, x = 3", outcome: "unverified", assistance: "independent" },
      });
      expect(await fixture.sql`SELECT effective_head_id FROM opening_learning_observations WHERE id=${f.original.id}`)
        .toMatchObject([{ effective_head_id: revisedAgain.headObservationId }]);
    } finally {
      vi.unstubAllEnvs();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => { server.close(() => resolve()); });
    }
  });

  it("supports Redis-free revision with a queued turn and no execution for the attempt", async () => {
    const f = await seed();
    vi.stubEnv("REDIS_URL", undefined);
    try {
      const revised = await f.correct();
      const target = await f.claim();
      expect(await f.jobs.readAttemptContext(fixture.scope, target)).toMatchObject({ headObservationId: revised.headObservationId });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("commits the first submission in PostgreSQL when Redis is unavailable while PG still fences stale pre-answer streams", async () => {
    const f = await learningAttemptFixture(fixture), attempt = await f.start();
    const { jobs, saved, claim } = await bindAttempt(f, attempt, "hint");
    const target = await claim();
    const preAnswerSnapshot = (await jobs.readAttemptContext(fixture.scope, target))!;
    const preAnswerContext = {
      privacyEpoch: preAnswerSnapshot.privacyEpoch, contextSourceRefs: preAnswerSnapshot.sourceRefs,
      exposureReceiptId: null, claimToken: target.claimToken, executionId: target.executionId,
      attemptFence: tutorAttemptFence(preAnswerSnapshot),
    };
    vi.stubEnv("REDIS_URL", undefined);
    try {
      const submitted = await f.submit(attempt);
      expect(await jobs.readAttemptContext(fixture.scope, target)).toMatchObject({ headObservationId: submitted.id });
      await expect(jobs.readStream(fixture.scope, saved.jobId, preAnswerContext)).rejects.toThrow("stream attempt context changed");
    } finally { vi.unstubAllEnvs(); }
  });

  it("advances Redis attempt-head on idle revision after a completed explanation so subsequent streaming on rev2 succeeds", async () => {
    const f = await seed();
    const { scope, sql } = fixture;
    const redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 0 });
    const writer = createTutorStreamWriter(redis), reader = createTutorStreamReader(redis);
    const headKey = tutorStreamAttemptHeadKey(scope.workspaceId, f.original.id);
    const keysToClean = [tutorStreamKey(scope.workspaceId, f.saved.jobId), tutorStreamEpochKey(scope.workspaceId), headKey, `${headKey}:rev`];
    try {
      // Complete a real streaming explanation on rev1 (f.graded.id), leaving attempt-head = rev1 in Redis and 0 running jobs.
      const firstRun = handler(f, async emit => {
        await emit!("rev1 explanation");
      }, writer);
      expect(await firstRun.run(f.saved.jobId)).toEqual({ skipped: false });
      expect(await f.jobs.get(scope, f.saved.jobId)).toMatchObject({ status: "succeeded" });
      expect(await redis.get(headKey)).toBe(f.graded.id);

      // Revise the attempt to rev2 while zero Tutor jobs are running.
      const revised = await f.correct();
      await vi.waitFor(async () => {
        expect(await redis.get(headKey)).toBe(revised.headObservationId);
      });

      // Start a new streaming explanation on rev2 and verify SSE deltas publish and read cleanly.
      const secondTurn = await bindAttempt(f, f.attempt, "explain");
      keysToClean.push(tutorStreamKey(scope.workspaceId, secondTurn.saved.jobId));
      const secondClaim = await secondTurn.claim();
      const secondSnapshot = (await f.jobs.readAttemptContext(scope, secondClaim))!;
      expect(secondSnapshot.headObservationId).toBe(revised.headObservationId);
      const secondContext = {
        privacyEpoch: secondSnapshot.privacyEpoch, contextSourceRefs: secondSnapshot.sourceRefs,
        exposureReceiptId: null, claimToken: secondClaim.claimToken, executionId: secondClaim.executionId,
        attemptFence: tutorAttemptFence(secondSnapshot),
      };
      await f.jobs.withStreamPublication(scope, secondTurn.saved.jobId, { ...secondContext, attemptContext: secondSnapshot }, async () => {
        await writer.begin(scope.workspaceId, secondTurn.saved.jobId, secondContext);
        expect(await writer.append(scope.workspaceId, secondTurn.saved.jobId, "rev2 explanation delta",
          secondClaim.executionId, secondSnapshot.privacyEpoch, secondContext.attemptFence)).toBe(1);
      });
      const cached = (await reader.read(scope.workspaceId, secondTurn.saved.jobId))!;
      expect(cached).toMatchObject({ text: "rev2 explanation delta", sequence: 1 });
      expect(await f.jobs.readStream(scope, secondTurn.saved.jobId, cached)).toMatchObject({ status: "running" });
      expect(await sql`SELECT status FROM opening_tutor_jobs WHERE id=${secondTurn.saved.jobId}`).toMatchObject([{ status: "running" }]);
    } finally {
      try { if (redis.status === "ready") await redis.del(...keysToClean); }
      finally { redis.disconnect(); }
    }
  });

  it("streams and saves an explanation pinned to available source v1 after it advances to v2", async () => {
    const f = await seed();
    const { scope, sql } = fixture;
    await sql`UPDATE opening_sources SET version=2 WHERE id=${f.sourceId}`;
    await sql`INSERT INTO opening_source_versions (source_id,version,workspace_id,availability)
      VALUES (${f.sourceId},0,${scope.workspaceId},'available') ON CONFLICT DO NOTHING`;
    const redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 0 });
    const reader = createTutorStreamReader(redis);
    const h = handler(f, async emit => {
      await emit!("sm95 explanation");
      const snapshot = (await reader.read(scope.workspaceId, f.saved.jobId))!;
      expect(snapshot).toMatchObject({ text: "sm95 explanation", sequence: 1,
        contextSourceRefs: [{ sourceId: f.sourceId, sourceVersion: 1 }] });
      expect(await f.jobs.readStream(scope, f.saved.jobId, snapshot)).toMatchObject({ status: "running" });
      const extraRefs = [...snapshot.contextSourceRefs, { sourceId: f.sourceId, sourceVersion: 0 }];
      const attemptContext = (await f.jobs.readAttemptContext(scope, {
        jobId: f.saved.jobId, userTurnId: f.saved.turnId, claimToken: snapshot.claimToken,
      }))!;
      const publish = vi.fn();
      await expect(f.jobs.withStreamPublication(scope, f.saved.jobId, { ...snapshot, attemptContext, contextSourceRefs: extraRefs }, publish))
        .rejects.toMatchObject({ code: "CONFLICT" });
      expect(publish).not.toHaveBeenCalled();
    }, createTutorStreamWriter(redis));
    try {
      expect(await h.run(f.saved.jobId)).toEqual({ skipped: false });
      expect(h.provider.complete).toHaveBeenCalledOnce();
      expect(await f.jobs.get(scope, f.saved.jobId)).toMatchObject({ status: "succeeded" });
      expect(await sql`SELECT text,context_source_refs FROM opening_turns WHERE id=${f.saved.assistantTurnId}`)
        .toMatchObject([{ text: "sm95 explanation", context_source_refs: [{ sourceId: f.sourceId, sourceVersion: 1 }] }]);
    } finally {
      try { await redis.del(tutorStreamKey(scope.workspaceId, f.saved.jobId), tutorStreamEpochKey(scope.workspaceId),
        tutorStreamAttemptHeadKey(scope.workspaceId, f.original.id)); }
      finally { redis.disconnect(); }
    }
  });

  it("sm95 P1b denies H1 cached bytes after H2 edit on reconnect and delayed flush", async () => {
    const f = await seed(), target = await f.claim();
    const snapshot = (await f.jobs.readAttemptContext(fixture.scope, target))!;
    const context = { privacyEpoch: snapshot.privacyEpoch, contextSourceRefs: snapshot.sourceRefs, exposureReceiptId: null, claimToken: target.claimToken,
      attemptFence: tutorAttemptFence(snapshot), executionId: target.executionId };
    const redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 0 });
    const key = `opening:tutor-stream:${fixture.scope.workspaceId}:${f.saved.jobId}`;
    try {
      const writer = createTutorStreamWriter(redis), reader = createTutorStreamReader(redis);
      await writer.begin(fixture.scope.workspaceId, f.saved.jobId, context);
      expect(await writer.append(fixture.scope.workspaceId, f.saved.jobId, "sm95 H1 cached secret bytes",
        context.executionId, snapshot.privacyEpoch, context.attemptFence)).toBe(1);
      const cached = (await reader.read(fixture.scope.workspaceId, f.saved.jobId))!;
      expect(cached.attemptFence).toEqual(context.attemptFence);
      const job = (await f.jobs.readStream(fixture.scope, f.saved.jobId, cached))!;
      await expect(f.jobs.readStream(fixture.scope, f.saved.jobId, { ...cached, attemptFence: undefined })).rejects.toThrow("fence missing");
      let release!: () => void, entered!: () => void;
      const waiting = new Promise<void>(resolve => { entered = resolve; });
      const unblock = new Promise<void>(resolve => { release = resolve; });
      const delayed = await createJobStreamResponse({ job, signal: new AbortController().signal,
        reader: { read: async () => { entered(); await unblock; return cached; }, subscribe: async () => async () => {} },
        getJob: () => f.jobs.get(fixture.scope, f.saved.jobId),
        authorizeSnapshot: snapshot => f.jobs.readStream(fixture.scope, f.saved.jobId, snapshot), close: () => {} });
      await waiting;
      await f.correct();
      release();
      expect(await delayed.text()).toBe("");
      // Reconnect authorizes the actual cached snapshot against H2, without waiting for another model delta.
      for (const read of [async () => reader.read(fixture.scope.workspaceId, f.saved.jobId)]) {
        const response = await createJobStreamResponse({ job, signal: new AbortController().signal,
          reader: { read, subscribe: async () => async () => {} }, getJob: () => f.jobs.get(fixture.scope, f.saved.jobId),
          authorizeSnapshot: snapshot => f.jobs.readStream(fixture.scope, f.saved.jobId, snapshot), close: () => {} });
        expect(await response.text()).toBe("");
      }
      await expect(f.jobs.readStream(fixture.scope, f.saved.jobId, cached)).rejects.toThrow();
    } finally {
      try { await redis.del(key, tutorStreamEpochKey(fixture.scope.workspaceId)); }
      finally { redis.disconnect(); }
    }
    const turns = await f.conversations.listTurns(fixture.scope, f.conversation.id);
    expect(turns.find(turn => turn.id===f.saved.assistantTurnId)?.text).not.toContain("sm95 H1 cached secret bytes");
    const continuity = await f.conversations.loadContinuityTurns(fixture.scope, f.conversation.id);
    expect(JSON.stringify(continuity)).not.toContain("sm95 H1 cached secret bytes");
    const resume = await createTutorService({ conversations: f.conversations, sourceChunks: createOpeningSourceChunksRepository(fixture.sql),
      readSelection: async () => ({ sourceIds: [], currentPage: null, chunkId: null }) }).resumeConversation(fixture.scope, f.conversation.id);
    expect(JSON.stringify(resume)).not.toContain("sm95 H1 cached secret bytes");
    expect(JSON.stringify(await f.jobs.get(fixture.scope, f.saved.jobId))).not.toContain("sm95 H1 cached secret bytes");
  });
  it.each([false, true])("captures original question/answer/effective grade and provenance, sealed photo=%s; redelivery is inert", async photo => {
    const f = await seed(photo), h = handler(f);
    expect(await h.run(f.saved.jobId)).toEqual({ skipped: false });
    const payload = JSON.parse(h.inputs[0]!.text);
    expect(payload.request).toBe("请讲解本次作答");
    expect(payload.attemptContext).toMatchObject({ originalQuestion: "1/2 + 1/2?", rootObservationId: f.original.id,
      headObservationId: f.graded.id, originalAnswer: { answer: "sm95 wrong saved answer", answerRevision: 1 },
      currentAnswer: { answerFrom: "originalAnswer", observationId: f.graded.id, answerRevision: 1 },
      effectiveGrading: { observationId: f.graded.id, answerRevision: 1, aiEvaluation: { feedback: "sm95 feedback: the answer is wrong" } },
      workSource: f.workSource ?? null });
    const [turn] = await fixture.sql`SELECT context_source_refs FROM opening_turns WHERE id=${f.saved.assistantTurnId}`;
    expect(turn!.context_source_refs).toContainEqual({ sourceId: f.sourceId, sourceVersion: f.original.sourceVersions![f.sourceId] });
    if (photo) expect(turn!.context_source_refs).toContainEqual({ sourceId: f.workSource!.id, sourceVersion: 0 });
    const before = await fixture.sql`SELECT * FROM opening_budget_reservations WHERE workspace_id=${fixture.scope.workspaceId} ORDER BY id`;
    expect(await h.run(f.saved.jobId)).toEqual({ skipped: true });
    expect(h.provider.complete).toHaveBeenCalledOnce();
    expect(await fixture.sql`SELECT * FROM opening_budget_reservations WHERE workspace_id=${fixture.scope.workspaceId} ORDER BY id`).toEqual(before);
    await f.conversations.listTurns(fixture.scope, f.conversation.id);
    const exposures = await fixture.sql`SELECT * FROM opening_help_exposures WHERE turn_id=${f.saved.assistantTurnId}`;
    await f.conversations.listTurns(fixture.scope, f.conversation.id);
    expect(exposures).toHaveLength(1);
    expect(await fixture.sql`SELECT * FROM opening_help_exposures WHERE turn_id=${f.saved.assistantTurnId}`).toEqual(exposures);
  });

  it("rejects foreign owner and foreign workspace without reading another account", async () => {
    const f = await seed(), target = await f.claim();
    for (const scope of [fixture.otherScope, { ...fixture.scope, ownerUserId: fixture.otherScope.ownerUserId }]) {
      await expect(f.jobs.readAttemptContext(scope, target)).rejects.toMatchObject({ code: "CONFLICT" });
    }
  });

  it.each(["epoch", "answer", "course", "exclude", "purpose", "photo", "source-version", "owner", "session", "attempt", "item"])("fails closed on late %s drift at assertion AND completion", async drift => {
    const f = await seed(drift === "photo"), target = await f.claim();
    const snapshot = await f.jobs.readAttemptContext(fixture.scope, target);
    expect(snapshot).not.toBeNull();
    if (drift === "epoch") await fixture.sql`UPDATE workspaces SET privacy_epoch=privacy_epoch+1 WHERE id=${fixture.scope.workspaceId}`;
    if (drift === "answer") await f.correct();
    if (drift === "course") await fixture.sql`UPDATE courses SET archived_at=now() WHERE id=${f.courseId}`;
    if (drift === "exclude") await fixture.sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id) VALUES (${fixture.scope.workspaceId},${f.sourceId})`;
    if (drift === "purpose") await fixture.sql`UPDATE course_asset_memberships SET purpose='reference' WHERE course_id=${f.courseId}`;
    if (drift === "photo") await fixture.sql`UPDATE opening_learning_observations SET grading_work_source=${fixture.sql.json({ ...f.workSource!, version: 1 })} WHERE id=${f.graded.id}`;
    if (drift === "source-version") await fixture.sql`UPDATE opening_source_versions SET availability='unavailable' WHERE source_id=${f.sourceId}`;
    if (drift === "owner") {
      const owner = randomUUID();
      await fixture.sql`INSERT INTO users(id,email,display_name,password_hash) VALUES (${owner},${`${owner}@example.com`},'sm95 new owner','test')`;
      await fixture.sql`UPDATE workspaces SET owner_user_id=${owner} WHERE id=${fixture.scope.workspaceId}`;
    }
    if (drift === "session") await fixture.sql`UPDATE opening_turns SET learning_session_id=${randomUUID()} WHERE id IN (${f.saved.turnId},${f.saved.assistantTurnId})`;
    if (drift === "attempt") await fixture.sql`UPDATE opening_turns SET context_anchor=jsonb_set(context_anchor,'{attemptId}',${fixture.sql.json(randomUUID())}) WHERE id=${f.saved.turnId}`;
    if (drift === "item") await fixture.sql`UPDATE opening_turns SET context_anchor=jsonb_set(context_anchor,'{itemVersionId}',${fixture.sql.json(randomUUID())}) WHERE id=${f.saved.turnId}`;
    await expect(f.jobs.assertAttemptContext(fixture.scope, target, snapshot!)).rejects.toThrow();
    await expect(f.jobs.completeTurn(completion(f, target), { attemptContext: { target, snapshot: snapshot! } })).rejects.toThrow();
    expect((await fixture.sql`SELECT status FROM opening_turns WHERE id=${f.saved.assistantTurnId}`)[0]!.status).not.toBe("complete");
    if (drift === "owner") await fixture.sql`UPDATE workspaces SET owner_user_id=${fixture.scope.ownerUserId} WHERE id=${fixture.scope.workspaceId}`;
  });

  it("loads current revised answer but never carries old grade to it; rejects forged old grading at a new head", async () => {
    const f = await seed(), revised = await f.correct(), target = await f.claim();
    const snapshot = await f.jobs.readAttemptContext(fixture.scope, target);
    expect(snapshot).toMatchObject({ currentAnswer: { answer: "sm95 revised answer", answerRevision: 2 }, effectiveGrading: null });
    await fixture.sql`UPDATE opening_learning_observations SET ai_evaluation=${fixture.sql.json(f.graded.aiEvaluation!)},verdict_source='ai_graded'
      WHERE id=${revised.observation!.id}`;
    await expect(f.jobs.readAttemptContext(fixture.scope, target)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("loads only the saved stem before submission, without inventing an answer or grade", async () => {
    const f = await seed(), next = await f.start();
    const saved = await f.conversations.appendSavedTurn({ scope: fixture.scope, conversationId: f.conversation.id,
      text: "请讲解这道题", mode: "explain", purpose: "answer", clientKey: randomUUID(), sourceIds: [],
      learningSessionId: f.sessionId, attemptId: next.id, currentPage: null, chunkId: null });
    const claimed = await f.jobs.claim(saved.jobId);
    const snapshot = await f.jobs.readAttemptContext(fixture.scope, { userTurnId: saved.turnId, jobId: saved.jobId, claimToken: claimed!.claimToken });
    expect(snapshot).toMatchObject({ originalQuestion: "1/2 + 1/2?", originalAnswer: null, currentAnswer: null, effectiveGrading: null });
  });

  it("rejects a grade with a mismatched answer revision even if its observation id matches", async () => {
    const f = await seed(), target = await f.claim();
    await fixture.sql`UPDATE opening_learning_observations SET answer_revision=2 WHERE id=${f.graded.id}`;
    await expect(f.jobs.readAttemptContext(fixture.scope, target)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("late answer edit during provider call is not published and cannot cause a second paid send", async () => {
    const f = await seed(), h = handler(f, async () => { await f.correct(); });
    await expect(h.run(f.saved.jobId)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(h.provider.complete).toHaveBeenCalledOnce();
    expect(await h.run(f.saved.jobId)).toEqual({ skipped: true });
    expect(h.provider.complete).toHaveBeenCalledOnce();
    expect((await fixture.sql`SELECT status FROM opening_turns WHERE id=${f.saved.assistantTurnId}`)[0]!.status).not.toBe("complete");
  });
});
