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

async function seed(scope = fixture.scope) {
  const sourceId = randomUUID();
  await fixture.sql`INSERT INTO opening_sources (id, workspace_id, name, mime, bytes, sha256, version, upload_state, parse_state)
    VALUES (${sourceId}, ${scope.workspaceId}, 'notes.txt', 'text/plain', 5, ${"a".repeat(64)}, 0, 'uploaded', 'queued')`;
  const jobs = createOpeningJobRepository(fixture.sql);
  const job = await jobs.createOnce(scope, {
    key: randomUUID(), kind: "parse", payload: { sourceId, sourceVersion: 0 }, privacyEpoch: 0,
  });
  const [outbox] = await fixture.sql`INSERT INTO opening_outbox (workspace_id, job_id, topic, payload)
    VALUES (${scope.workspaceId}, ${job.id}, 'opening.job.enqueue',
      ${fixture.sql.json({ kind: "parse", jobId: job.id })}) RETURNING id`;
  return { sourceId, jobs, job, outboxId: outbox!.id as string };
}

describe("claim history-first coordination", () => {
  beforeEach(async () => {
    await fixture.sql`DELETE FROM opening_workspace_history_revisions
      WHERE workspace_id IN (${fixture.scope.workspaceId},${fixture.otherScope.workspaceId})`;
  });
  async function blocked(observer: typeof fixture.sql, writer: number, holder: number, pattern: RegExp) {
    // Leave room for cleanup inside the unchanged default 5000ms test budget.
    await vi.waitFor(async () => {
      const [row] = await observer`SELECT a.query,
        EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND NOT l.granted) AS waiting,
        ${holder}=ANY(pg_blocking_pids(a.pid)) AS blocked
        FROM pg_stat_activity a WHERE a.pid=${writer}`;
      expect(row).toMatchObject({ waiting: true, blocked: true });
      expect(row!.query).toMatch(pattern);
    }, { timeout: 1200, interval: 20 });
  }
  async function history(revision?: number) {
    await fixture.sql`DELETE FROM opening_workspace_history_revisions WHERE workspace_id=${fixture.scope.workspaceId}`;
    if (revision !== undefined) await fixture.sql`INSERT INTO opening_workspace_history_revisions
      (workspace_id,owner_user_id,revision) VALUES (${fixture.scope.workspaceId},${fixture.scope.ownerUserId},${revision})`;
  }
  async function graph(sourceId: string, jobId: string) {
    const [row] = await fixture.sql`SELECT
      (SELECT row_to_json(j) FROM opening_jobs j WHERE id=${jobId}) AS job,
      (SELECT row_to_json(s) FROM opening_sources s WHERE id=${sourceId}) AS source,
      (SELECT jsonb_agg(c ORDER BY id) FROM opening_source_chunks c WHERE source_id=${sourceId}) AS chunks`;
    return row;
  }
  async function revision() {
    return fixture.sql`SELECT owner_user_id,revision::int FROM opening_workspace_history_revisions
      WHERE workspace_id=${fixture.scope.workspaceId} ORDER BY owner_user_id`;
  }
  async function oldChunk(sourceId: string) {
    await fixture.sql`INSERT INTO opening_source_chunks(source_id,source_version,page,text)
      VALUES (${sourceId},0,1,'nonempty old graph')`;
  }

  it("waits on history before workspace/job/source locks; other workspace progresses; exactly one token wins", async () => {
    const { sourceId, job } = await seed();
    const other = await seed(fixture.otherScope);
    await oldChunk(sourceId);
    await history(19);
    const before = await graph(sourceId, job.id);
    const holder = openRaceSession(), writer = openRaceSession(), observer = openRaceSession();
    let pending: ReturnType<ReturnType<typeof createOpeningJobRepository>["claim"]> | undefined;
    try {
      await Promise.all([holder.ready, writer.ready, observer.ready]);
      await holder.sql.begin(async tx => {
        await tx`SELECT revision FROM opening_workspace_history_revisions
          WHERE workspace_id=${fixture.scope.workspaceId} FOR UPDATE`;
        pending = track(createOpeningJobRepository(writer.sql).claim(job.id));
        await blocked(observer.sql, writer.pid, holder.pid, /opening_workspace_history_revisions/);
        await tx`SELECT id FROM workspaces WHERE id=${fixture.scope.workspaceId} FOR UPDATE NOWAIT`;
        await tx`SELECT id FROM opening_jobs WHERE id=${job.id} FOR UPDATE NOWAIT`;
        await tx`SELECT id FROM opening_sources WHERE id=${sourceId} FOR UPDATE NOWAIT`;
        expect(await graph(sourceId, job.id)).toEqual(before);
        expect(await other.jobs.claim(other.job.id)).toMatchObject({ state: "running", workspaceId: fixture.otherScope.workspaceId });
      });
      const claimed = await pending;
      expect(claimed).toMatchObject({ id: job.id, state: "running", claimToken: expect.any(String) });
      expect(claimed!.claimToken).toMatch(/^[0-9a-f-]{36}$/);
      expect(await createOpeningJobRepository(fixture.sql).claim(job.id)).toBeNull();
      const after = await graph(sourceId, job.id);
      expect(after!.job).toMatchObject({ claim_token: claimed!.claimToken, state: "running" });
      expect(after!.source).toMatchObject({ parse_state: "running" });
      expect(after!.chunks).toEqual(before!.chunks);
      expect(await revision()).toEqual([{ owner_user_id: fixture.scope.ownerUserId, revision: 19 }]);
    } finally {
      await Promise.allSettled(pending ? [pending] : []);
      await Promise.all([closeRace(holder.sql), closeRace(writer.sql), closeRace(observer.sql)]);
    }
  });

  it.each([undefined, 23])("ensures lazy zero / preserves revision %s without advancing; static job owner mismatch still claims", async initial => {
    const { job, jobs } = await seed();
    await history(initial);
    await fixture.sql`UPDATE opening_jobs SET owner_user_id=${fixture.otherScope.ownerUserId} WHERE id=${job.id}`;
    expect(await jobs.claim(job.id)).toMatchObject({ state: "running", ownerUserId: fixture.otherScope.ownerUserId });
    expect(await revision()).toEqual([{ owner_user_id: fixture.scope.ownerUserId, revision: initial ?? 0 }]);
  });

  it.each(["owner", "delete", "job workspace"] as const)("rolls back history and returns null for dynamic %s drift after locating", async drift => {
    const { job, sourceId } = await seed();
    await oldChunk(sourceId);
    await history();
    const newOwner = randomUUID();
    if (drift === "owner") await fixture.sql`INSERT INTO users(id,email,display_name,password_hash)
      VALUES (${newOwner},${`${newOwner}@example.com`},'New owner','test')`;
    const holder = openRaceSession(), writer = openRaceSession(), observer = openRaceSession();
    let pending: ReturnType<ReturnType<typeof createOpeningJobRepository>["claim"]> | undefined;
    try {
      await Promise.all([holder.ready, writer.ready, observer.ready]);
      // An uncommitted ensure blocks the writer's lazy INSERT after its ordinary lookup.
      await holder.sql.begin(async tx => {
        await tx`INSERT INTO opening_workspace_history_revisions(workspace_id,owner_user_id,revision)
          VALUES (${fixture.scope.workspaceId},${fixture.scope.ownerUserId},31)`;
        pending = track(createOpeningJobRepository(writer.sql).claim(job.id));
        await blocked(observer.sql, writer.pid, holder.pid, /INSERT INTO opening_workspace_history_revisions/);
        if (drift === "owner") await tx`UPDATE workspaces SET owner_user_id=${newOwner} WHERE id=${fixture.scope.workspaceId}`;
        if (drift === "delete") await tx`DELETE FROM workspaces WHERE id=${fixture.scope.workspaceId}`;
        if (drift === "job workspace") await tx`UPDATE opening_jobs SET workspace_id=${fixture.otherScope.workspaceId} WHERE id=${job.id}`;
        // Remove only the holder's ensure: the writer must create its own zero,
        // then roll it back when the locked identity no longer matches.
        await tx`DELETE FROM opening_workspace_history_revisions WHERE workspace_id=${fixture.scope.workspaceId}`;
      });
      expect(await pending).toBeNull();
      expect(await revision()).toEqual([]);
      expect(await fixture.sql`SELECT revision FROM opening_workspace_history_revisions WHERE workspace_id=${fixture.otherScope.workspaceId}`).toEqual([]);
      if (drift !== "delete") {
        expect((await graph(sourceId, job.id))!.job).toMatchObject({ state: "queued", claim_token: null });
        expect((await graph(sourceId, job.id))!.source).toMatchObject({ parse_state: "queued" });
        expect((await graph(sourceId, job.id))!.chunks).toHaveLength(1);
      }
    } finally {
      await Promise.allSettled(pending ? [pending] : []);
      // Restore this fixture's workspace, including deletion cascades, for later tests.
      await fixture.sql`INSERT INTO workspaces(id,owner_user_id) VALUES (${fixture.scope.workspaceId},${fixture.scope.ownerUserId})
        ON CONFLICT(id) DO UPDATE SET owner_user_id=EXCLUDED.owner_user_id`;
      await fixture.sql`DELETE FROM opening_workspace_history_revisions WHERE workspace_id=${fixture.otherScope.workspaceId}`;
      await Promise.all([closeRace(holder.sql), closeRace(writer.sql), closeRace(observer.sql)]);
    }
  });

  it("retains the workspace SHARE fence after history without locking job/source early", async () => {
    const { job, sourceId } = await seed();
    await history(7);
    const holder = openRaceSession(), writer = openRaceSession(), observer = openRaceSession();
    let pending: ReturnType<ReturnType<typeof createOpeningJobRepository>["claim"]> | undefined;
    try {
      await Promise.all([holder.ready, writer.ready, observer.ready]);
      await holder.sql.begin(async tx => {
        await tx`SELECT id FROM workspaces WHERE id=${fixture.scope.workspaceId} FOR UPDATE`;
        pending = track(createOpeningJobRepository(writer.sql).claim(job.id));
        await blocked(observer.sql, writer.pid, holder.pid, /FOR SHARE OF w/);
        await tx`SELECT id FROM opening_jobs WHERE id=${job.id} FOR UPDATE NOWAIT`;
        await tx`SELECT id FROM opening_sources WHERE id=${sourceId} FOR UPDATE NOWAIT`;
      });
      expect(await pending).toMatchObject({ state: "running" });
      expect(await revision()).toEqual([{ owner_user_id: fixture.scope.ownerUserId, revision: 7 }]);
    } finally {
      await Promise.allSettled(pending ? [pending] : []);
      await Promise.all([closeRace(holder.sql), closeRace(writer.sql), closeRace(observer.sql)]);
    }
  });

  it("propagates a real history lock timeout without retry or marker writes", async () => {
    const { job, sourceId } = await seed();
    await history(5);
    const before = await graph(sourceId, job.id);
    const holder = openRaceSession(), writer = openRaceSession();
    try {
      await Promise.all([holder.ready, writer.ready]);
      await writer.sql`SET lock_timeout='250ms'`;
      await holder.sql.begin(async tx => {
        await tx`SELECT revision FROM opening_workspace_history_revisions WHERE workspace_id=${fixture.scope.workspaceId} FOR UPDATE`;
        await expect(createOpeningJobRepository(writer.sql).claim(job.id)).rejects.toMatchObject({ code: "55P03" });
        expect(await graph(sourceId, job.id)).toEqual(before);
      });
      expect(await revision()).toEqual([{ owner_user_id: fixture.scope.ownerUserId, revision: 5 }]);
    } finally { await Promise.all([closeRace(holder.sql), closeRace(writer.sql)]); }
  });

  it("does not take over outcome_unknown and still ensures history coordination", async () => {
    const { job, sourceId, jobs } = await seed();
    await history();
    await fixture.sql`UPDATE opening_jobs SET state='outcome_unknown' WHERE id=${job.id}`;
    const before = await graph(sourceId, job.id);
    expect(await jobs.claim(job.id)).toBeNull();
    expect(await graph(sourceId, job.id)).toEqual(before);
    expect(await revision()).toEqual([{ owner_user_id: fixture.scope.ownerUserId, revision: 0 }]);
  });

  it("rechecks the original workspace CAS after a concurrent job relocation while waiting on the job", async () => {
    const { job, sourceId } = await seed();
    await history();
    const before = await graph(sourceId, job.id);
    const holder = openRaceSession(), writer = openRaceSession(), observer = openRaceSession();
    let pending: ReturnType<ReturnType<typeof createOpeningJobRepository>["claim"]> | undefined;
    try {
      await Promise.all([holder.ready, writer.ready, observer.ready]);
      await holder.sql.begin(async tx => {
        await tx`SELECT id FROM opening_jobs WHERE id=${job.id} FOR UPDATE`;
        pending = track(createOpeningJobRepository(writer.sql).claim(job.id));
        await blocked(observer.sql, writer.pid, holder.pid, /UPDATE opening_jobs/);
        await tx`UPDATE opening_jobs SET workspace_id=${fixture.otherScope.workspaceId} WHERE id=${job.id}`;
      });
      expect(await pending).toBeNull();
      expect(await revision()).toEqual([]);
      const after = await graph(sourceId, job.id);
      expect(after!.job).toMatchObject({ workspace_id: fixture.otherScope.workspaceId, state: "queued", claim_token: null });
      expect(after!.source).toEqual(before!.source);
    } finally {
      await Promise.allSettled(pending ? [pending] : []);
      await Promise.all([closeRace(holder.sql), closeRace(writer.sql), closeRace(observer.sql)]);
    }
  });

  it.each([undefined, 29])("rolls back history %s, token, and nonempty source graph on a real SQL cast failure", async initial => {
    const { job, sourceId, jobs } = await seed();
    await oldChunk(sourceId);
    await history(initial);
    await fixture.sql`UPDATE opening_jobs SET payload=${fixture.sql.json({ sourceId, sourceVersion: 2147483648 })} WHERE id=${job.id}`;
    const before = await graph(sourceId, job.id);
    await expect(jobs.claim(job.id)).rejects.toMatchObject({ code: "22003" });
    expect(await graph(sourceId, job.id)).toEqual(before);
    expect(await revision()).toEqual(initial === undefined ? [] : [{ owner_user_id: fixture.scope.ownerUserId, revision: initial }]);
  });

  it.each([
    ["not_started", "uploaded", 0, "running"], ["queued", "uploaded", 0, "running"],
    ["running", "uploaded", 0, "running"], ["ready", "uploaded", 0, "ready"],
    ["failed", "uploaded", 0, "failed"], ["unsupported", "uploaded", 0, "unsupported"],
    ["queued", "pending", 0, "queued"], ["queued", "uploaded", 1, "queued"],
  ])("preserves marker eligibility: parse=%s upload=%s version=%s -> %s", async (parse, upload, version, expected) => {
    const { job, sourceId, jobs } = await seed();
    await fixture.sql`UPDATE opening_sources SET parse_state=${parse},upload_state=${upload},version=${version} WHERE id=${sourceId}`;
    expect(await jobs.claim(job.id)).toMatchObject({ state: "running" });
    expect((await fixture.sql`SELECT parse_state FROM opening_sources WHERE id=${sourceId}`)[0]!.parse_state).toBe(expected);
  });

  it("does not mark a source in another scope and still claims parse-media with an omitted version", async () => {
    const { job, sourceId, jobs } = await seed();
    await fixture.sql`UPDATE opening_sources SET workspace_id=${fixture.otherScope.workspaceId} WHERE id=${sourceId}`;
    expect(await jobs.claim(job.id)).toMatchObject({ state: "running" });
    expect((await fixture.sql`SELECT parse_state FROM opening_sources WHERE id=${sourceId}`)[0]!.parse_state).toBe("queued");
    const media = await seed();
    await fixture.sql`UPDATE opening_jobs SET kind='parse-media',payload=${fixture.sql.json({ sourceId: media.sourceId })} WHERE id=${media.job.id}`;
    expect(await jobs.claim(media.job.id)).toMatchObject({ kind: "parse-media", state: "running" });
    expect((await fixture.sql`SELECT parse_state FROM opening_sources WHERE id=${media.sourceId}`)[0]!.parse_state).toBe("running");
  });

  it("keeps invalid job UUID casts and missing job/workspace null semantics", async () => {
    const { jobs, job } = await seed();
    await expect(jobs.claim("not-a-uuid")).rejects.toMatchObject({ code: "22P02" });
    expect(await jobs.claim(randomUUID())).toBeNull();
    await fixture.sql`DELETE FROM workspaces WHERE id=${fixture.scope.workspaceId}`;
    try { expect(await jobs.claim(job.id)).toBeNull(); }
    finally { await fixture.sql`INSERT INTO workspaces(id,owner_user_id) VALUES (${fixture.scope.workspaceId},${fixture.scope.ownerUserId})`; }
  });
});

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
