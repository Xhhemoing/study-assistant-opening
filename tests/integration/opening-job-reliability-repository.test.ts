import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLibraryRepository, createOpeningConversationRepository, createOpeningJobRepository,
  createOpeningSourceChunksRepository, createOpeningSourceRepository, createOpeningTutorJobsRepository,
  createOpeningReminderRepository,
  createSqlClient, openingJobScope,
} from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { closeRace, openRaceSession, track, waitUntilBlocked } from "./opening-race-helpers";

let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => {
  await fixture.reset();
  await fixture.sql`UPDATE workspaces SET privacy_epoch = 0 WHERE id = ${fixture.scope.workspaceId}`;
});
afterAll(async () => { await fixture?.close(); });

async function seed() {
  const sourceId = randomUUID();
  await fixture.sql`INSERT INTO opening_sources (id, workspace_id, name, mime, bytes, sha256, version, upload_state, parse_state)
    VALUES (${sourceId}, ${fixture.scope.workspaceId}, 'notes.txt', 'text/plain', 5, ${"a".repeat(64)}, 0, 'uploaded', 'queued')`;
  const jobs = createOpeningJobRepository(fixture.sql);
  const job = await jobs.createOnce(fixture.scope, {
    key: randomUUID(), kind: "parse", payload: { sourceId, sourceVersion: 0 }, privacyEpoch: 0,
  });
  const [outbox] = await fixture.sql`INSERT INTO opening_outbox (workspace_id, job_id, topic, payload)
    VALUES (${fixture.scope.workspaceId}, ${job.id}, 'opening.job.enqueue',
      ${fixture.sql.json({ kind: "parse", jobId: job.id })}) RETURNING id`;
  return { sourceId, jobs, job, outboxId: outbox!.id as string };
}

describe("durable opening job delivery and execution", () => {
  it("replays semantically identical jsonb payloads with reordered keys", async () => {
    const { jobs, job, sourceId } = await seed();
    const replay = await jobs.createOnce(fixture.scope, {
      key: job.key, kind: "parse", payload: { sourceVersion: 0, sourceId }, privacyEpoch: 0,
    });
    expect(replay.id).toBe(job.id);
  });

  it("commits the dispatch lease before Redis I/O and excludes a second dispatcher", async () => {
    const { outboxId } = await seed();
    const isolated = createSqlClient(process.env.DATABASE_URL!, { max: 1 });
    try {
      const [connection] = await isolated`SELECT pg_backend_pid() AS pid`;
      const jobs = createOpeningJobRepository(isolated);
      const sent = await jobs.dispatchPending(async () => {
        const [activity] = await fixture.sql`SELECT state, xact_start FROM pg_stat_activity WHERE pid = ${connection!.pid}`;
        expect(activity!.state).toBe("idle");
        expect(activity!.xact_start).toBeNull();
        const second = vi.fn(async () => undefined);
        expect(await createOpeningJobRepository(fixture.sql).dispatchPending(second)).toBe(0);
        expect(second).not.toHaveBeenCalled();
        // This max:1 query would deadlock if enqueue still held a SQL transaction.
        expect((await isolated`SELECT 1 AS alive`)[0]!.alive).toBe(1);
      });
      expect(sent).toBe(1);
      expect((await fixture.sql`SELECT state, dispatch_token, lease_until FROM opening_outbox WHERE id = ${outboxId}`)[0])
        .toEqual({ state: "published", dispatch_token: null, lease_until: null });
    } finally { await isolated.end({ timeout: 5 }); }
  });

  it("retries transient delivery without mutating the durable event payload", async () => {
    const { jobs, outboxId, job } = await seed();
    expect(await jobs.dispatchPending(async () => { throw new Error("Redis unavailable"); })).toBe(0);
    const [failed] = await fixture.sql`SELECT state, payload, last_error, attempts, next_attempt_at > now() AS backed_off
      FROM opening_outbox WHERE id = ${outboxId}`;
    expect(failed).toMatchObject({ state: "pending", payload: { kind: "parse", jobId: job.id }, last_error: "Redis unavailable", attempts: 1, backed_off: true });
    await fixture.sql`UPDATE opening_outbox SET next_attempt_at = now() - interval '1 second' WHERE id = ${outboxId}`;
    expect(await jobs.dispatchPending(async () => undefined)).toBe(1);
  });

  it("dispatches only the latest event after a quiet reminder schedules a delayed delivery", async () => {
    const { jobs, job, outboxId } = await seed();
    await fixture.sql`UPDATE opening_outbox SET state = 'published',
      created_at = now() - interval '10 minutes', updated_at = now() - interval '10 minutes' WHERE id = ${outboxId}`;
    const availableAt = new Date(Date.now() + 60_000).toISOString();
    const [latest] = await fixture.sql`INSERT INTO opening_outbox (workspace_id, job_id, topic, payload)
      VALUES (${fixture.scope.workspaceId}, ${job.id}, 'opening.job.enqueue',
        ${fixture.sql.json({ kind: "remind", jobId: job.id, availableAt })}) RETURNING id`;
    const sent = vi.fn(async () => undefined);
    expect(await jobs.dispatchPending(sent)).toBe(1);
    expect(sent).toHaveBeenCalledWith(expect.objectContaining({ id: latest!.id, payload: { kind: "remind", jobId: job.id, availableAt } }));
    // An exhausted obsolete event cannot fail the newer queued execution.
    await fixture.sql`UPDATE opening_outbox SET state = 'pending', attempts = 10 WHERE id = ${outboxId}`;
    expect(await jobs.dispatchPending(sent)).toBe(0);
    expect((await jobs.get(fixture.scope, job.id)).state).toBe("queued");
  });

  it("ends exhausted queued work and exposes a safe manual parse retry", async () => {
    const { jobs, job, outboxId, sourceId } = await seed();
    await fixture.sql`UPDATE opening_outbox SET attempts = 9 WHERE id = ${outboxId}`;
    await jobs.dispatchPending(async () => { throw new Error("Redis still unavailable"); });
    expect((await jobs.get(fixture.scope, job.id)).state).toBe("failed");
    expect(await createOpeningSourceRepository(fixture.sql).get(fixture.scope, sourceId))
      .toMatchObject({ parseState: "failed", error: { code: "PARSE_FAILED", retryable: true } });
  });

  it("recovers a dead final publisher lease after process interruption", async () => {
    const { jobs, job, outboxId } = await seed();
    await fixture.sql`UPDATE opening_outbox SET attempts = 10, dispatch_token = ${randomUUID()},
      lease_until = now() - interval '1 second' WHERE id = ${outboxId}`;
    await jobs.dispatchPending(async () => { throw new Error("must not dispatch again"); });
    expect((await jobs.get(fixture.scope, job.id)).state).toBe("failed");
  });

  it("heartbeats the current claim only and never takes over an old running execution", async () => {
    const { jobs, job } = await seed();
    const claimed = (await jobs.claim(job.id))!;
    expect(claimed.claimToken).toBeTypeOf("string");
    expect(await jobs.heartbeat(job.id, randomUUID(), fixture.scope)).toBe(false);
    await fixture.sql`UPDATE opening_jobs SET updated_at = now() - interval '10 minutes' WHERE id = ${job.id}`;
    expect(await jobs.claim(job.id)).toBeNull();
    expect(await jobs.heartbeat(job.id, claimed.claimToken!, fixture.scope)).toBe(true);
    expect(await jobs.recoverExpired()).toBe(0);
    expect(await jobs.finish(job.id, "succeeded", { ok: true }, randomUUID())).toBe(false);
    expect(await jobs.finish(job.id, "succeeded", { ok: true }, claimed.claimToken)).toBe(true);
  });

  it("ends interrupted execution as unknown and rejects late source/document writes", async () => {
    const { jobs, job, sourceId } = await seed();
    const claimed = (await jobs.claim(job.id))!;
    const scope = openingJobScope(claimed);
    await fixture.sql`UPDATE opening_jobs SET updated_at = now() - interval '10 minutes' WHERE id = ${job.id}`;
    expect(await jobs.recoverExpired()).toBe(1);
    expect((await jobs.get(fixture.scope, job.id)).state).toBe("outcome_unknown");
    const sources = createOpeningSourceRepository(fixture.sql);
    expect(await sources.get(fixture.scope, sourceId)).toMatchObject({ parseState: "failed", error: { retryable: false } });
    await expect(createOpeningSourceChunksRepository(fixture.sql).replaceChunks(scope, {
      sourceId, sourceVersion: 0, chunks: [{ page: 1, slideLabel: null, startMs: null, endMs: null, text: "late", imageObjectKey: null }],
    })).rejects.toThrow("job execution is no longer current");
    await expect(sources.markParseState(scope, sourceId, "ready")).rejects.toThrow("job execution is no longer current");
    const library = createLibraryRepository(fixture.sql);
    const document = await library.createDocument({ workspaceId: scope.workspaceId, title: "teaching draft", blocks: [{ id: randomUUID(), type: "text", content: { text: "original" } }] });
    await expect(library.updateDocument({ workspaceId: scope.workspaceId, jobScope: scope, documentId: document.id,
      expectedRevisionNumber: 1, blocks: [{ id: randomUUID(), type: "text", content: { text: "late" } }] }))
      .rejects.toThrow("job execution is no longer current");
    expect((await library.getDocument({ workspaceId: scope.workspaceId, documentId: document.id })).currentRevisionNumber).toBe(1);
    expect(await jobs.finish(job.id, "succeeded", { ok: true }, claimed.claimToken)).toBe(false);
  });

  it("rechecks the lease after waiting for a workspace lock", async () => {
    const { jobs, job } = await seed();
    const claimed = (await jobs.claim(job.id))!;
    await fixture.sql`UPDATE opening_jobs SET updated_at = now() - interval '10 minutes' WHERE id = ${job.id}`;
    const gate = openRaceSession();
    const reaper = openRaceSession();
    const observer = openRaceSession();
    let pending: Promise<number> | undefined;
    try {
      await Promise.all([gate.ready, reaper.ready, observer.ready]);
      await gate.sql.begin(async (tx) => {
        await tx`SELECT id FROM workspaces WHERE id = ${fixture.scope.workspaceId} FOR UPDATE`;
        pending = track(createOpeningJobRepository(reaper.sql).recoverExpired());
        await waitUntilBlocked(observer.sql, reaper.pid, gate.pid, "job recovery", /FOR UPDATE OF w/);
        expect(await jobs.heartbeat(job.id, claimed.claimToken!, fixture.scope)).toBe(true);
      });
      expect(await pending).toBe(0);
      expect((await jobs.get(fixture.scope, job.id)).state).toBe("running");
    } finally {
      await Promise.allSettled(pending ? [pending] : []);
      await Promise.all([closeRace(gate.sql), closeRace(reaper.sql), closeRace(observer.sql)]);
    }
  });

  it("locks workspace before recording a quiet retry so recovery cannot deadlock on its outbox FK", async () => {
    const { jobs, job } = await seed();
    await fixture.sql`UPDATE opening_jobs SET kind = 'remind' WHERE id = ${job.id}`;
    const claimed = (await jobs.claim(job.id))!;
    const gate = openRaceSession();
    const writer = openRaceSession();
    const observer = openRaceSession();
    let pending: Promise<boolean> | undefined;
    try {
      await Promise.all([gate.ready, writer.ready, observer.ready]);
      await gate.sql.begin(async (tx) => {
        await tx`SELECT id FROM workspaces WHERE id = ${fixture.scope.workspaceId} FOR UPDATE`;
        pending = track(createOpeningReminderRepository(writer.sql).recordAttempt(job.id, {
          claimToken: claimed.claimToken, state: "queued", outcome: "quiet", receiptId: null,
          availableAt: new Date(Date.now() + 60_000).toISOString(),
        }));
        await waitUntilBlocked(observer.sql, writer.pid, gate.pid, "quiet retry workspace lock", /FOR SHARE OF w/);
        // Recovery can still acquire the job: the blocked recorder owns no job
        // lock, so there is no workspace -> job -> workspace cycle.
        await tx`SELECT id FROM opening_jobs WHERE id = ${job.id} FOR UPDATE NOWAIT`;
        await tx`UPDATE opening_jobs SET state = 'outcome_unknown' WHERE id = ${job.id}`;
      });
      expect(await pending).toBe(false);
      expect(await fixture.sql`SELECT id FROM opening_outbox WHERE job_id = ${job.id}`).toHaveLength(1);
    } finally {
      await Promise.allSettled(pending ? [pending] : []);
      await Promise.all([closeRace(gate.sql), closeRace(writer.sql), closeRace(observer.sql)]);
    }
  });

  it("recovers tutor turn atomically and fences an interrupted worker's late completion", async () => {
    const conversations = createOpeningConversationRepository(fixture.sql);
    const conversation = await conversations.create(fixture.scope, { title: "interrupted", courseId: null });
    const saved = await conversations.appendSavedTurn({ scope: fixture.scope, conversationId: conversation.id,
      text: "explain", mode: "explain", clientKey: randomUUID(), sourceIds: [], learningSessionId: null, currentPage: null, chunkId: null });
    const jobs = createOpeningTutorJobsRepository(fixture.sql);
    const claimed = (await jobs.claim(saved.jobId))!;
    await fixture.sql`UPDATE opening_tutor_jobs SET updated_at = now() - interval '10 minutes' WHERE id = ${saved.jobId}`;
    expect(await jobs.claim(saved.jobId)).toBeNull();
    expect(await jobs.recoverExpired()).toBe(1);
    await jobs.completeTurn({ scope: fixture.scope, jobId: saved.jobId, claimToken: claimed.claimToken,
      assistantTurnId: saved.assistantTurnId, text: "late answer", citations: [], candidates: [] });
    expect((await jobs.get(fixture.scope, saved.jobId))!.status).toBe("outcome_unknown");
    const turns = await conversations.listTurns(fixture.scope, conversation.id);
    expect(turns.find(turn => turn.id === saved.assistantTurnId)).toMatchObject({ status: "outcome_unknown" });
    expect(turns.some(turn => turn.text === "late answer")).toBe(false);
  });
});
