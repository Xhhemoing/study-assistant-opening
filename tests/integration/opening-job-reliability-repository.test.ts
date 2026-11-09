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
import { failOpeningJob } from "../../packages/database/src/repositories/opening-job-failure";
import { insertTestTeachingActivity } from "./opening-fixture";
import type { Sql } from "postgres";

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

describe("job failure history fence", () => {
  async function history(revision?: number) {
    await fixture.sql`DELETE FROM opening_workspace_history_revisions WHERE workspace_id = ${fixture.scope.workspaceId}`;
    if (revision !== undefined) await fixture.sql`INSERT INTO opening_workspace_history_revisions
      (workspace_id, owner_user_id, revision) VALUES (${fixture.scope.workspaceId}, ${fixture.scope.ownerUserId}, ${revision})`;
  }

  async function snapshot() {
    return fixture.sql`SELECT
      (SELECT jsonb_agg(to_jsonb(j) ORDER BY id) FROM opening_jobs j) AS jobs,
      (SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM opening_sources s) AS sources,
      (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM opening_teaching_activities a) AS activities`;
  }

  async function behindHistory(jobId: string, check: (tx: Sql) => Promise<void>,
    options: Parameters<typeof failOpeningJob>[4] = {}) {
    const gate = openRaceSession(), writer = openRaceSession(), observer = openRaceSession();
    let pending: Promise<boolean> | undefined;
    try {
      await Promise.all([gate.ready, writer.ready, observer.ready]);
      await gate.sql.begin(async tx => {
        await tx`SELECT revision FROM opening_workspace_history_revisions
          WHERE workspace_id = ${fixture.scope.workspaceId} AND owner_user_id = ${fixture.scope.ownerUserId} FOR UPDATE`;
        const before = await snapshot();
        pending = track(failOpeningJob(writer.sql, jobId, { privateDetail: "failure" }, "failed", options));
        await vi.waitFor(async () => {
          const [lock] = await observer.sql`SELECT count(*)::int AS n FROM pg_locks
            WHERE pid = ${writer.pid} AND NOT granted AND ${gate.pid} = ANY(pg_blocking_pids(pid))`;
          expect(lock!.n).toBeGreaterThan(0);
          const [activity] = await observer.sql`SELECT query FROM pg_stat_activity WHERE pid = ${writer.pid}`;
          expect(activity!.query).toMatch(/opening_workspace_history_revisions/);
        }, { timeout: 1500, interval: 20 });
        expect(await snapshot()).toEqual(before);
        // No workspace/job/source lock may precede history, even for a root SQL caller.
        await tx`SELECT id FROM workspaces WHERE id = ${fixture.scope.workspaceId} FOR UPDATE NOWAIT`;
        await tx`SELECT id FROM opening_jobs WHERE id = ${jobId} FOR UPDATE NOWAIT`;
        await tx`SELECT id FROM opening_sources WHERE workspace_id = ${fixture.scope.workspaceId} FOR UPDATE NOWAIT`;
        await check(tx as unknown as Sql);
      });
      return await pending!;
    } finally {
      await Promise.allSettled(pending ? [pending] : []);
      await Promise.all([closeRace(gate.sql), closeRace(writer.sql), closeRace(observer.sql)]);
    }
  }

  it("waits on real history before any old graph lock or mutation and never advances nonzero history", async () => {
    const { job, jobs, sourceId } = await seed();
    const claimed = (await jobs.claim(job.id))!;
    await history(37);
    expect(await behindHistory(job.id, async () => {}, { claimToken: claimed.claimToken })).toBe(true);
    expect((await jobs.get(fixture.scope, job.id)).state).toBe("failed");
    expect((await fixture.sql`SELECT parse_state FROM opening_sources WHERE id = ${sourceId}`)[0]!.parse_state).toBe("failed");
    expect(Number((await fixture.sql`SELECT revision FROM opening_workspace_history_revisions
      WHERE workspace_id = ${fixture.scope.workspaceId}`)[0]!.revision)).toBe(37);
  });

  it.each(["token", "state", "stale"] as const)("rechecks %s CAS after history wait without projecting", async change => {
    const { job, jobs, sourceId } = await seed();
    const claimed = (await jobs.claim(job.id))!;
    await history(9);
    const cutoff = new Date(Date.now() - 60_000);
    await fixture.sql`UPDATE opening_jobs SET updated_at = ${new Date(cutoff.getTime() - 1)} WHERE id = ${job.id}`;
    expect(await behindHistory(job.id, async tx => {
      if (change === "token") await tx`UPDATE opening_jobs SET claim_token = ${randomUUID()} WHERE id = ${job.id}`;
      if (change === "state") await tx`UPDATE opening_jobs SET state = 'cancelled' WHERE id = ${job.id}`;
      if (change === "stale") await tx`UPDATE opening_jobs SET updated_at = ${cutoff} WHERE id = ${job.id}`;
    }, { claimToken: claimed.claimToken, staleBefore: cutoff })).toBe(false);
    const [source] = await fixture.sql`SELECT parse_state, error FROM opening_sources WHERE id = ${sourceId}`;
    expect(source!.error).toBeNull();
    expect(source!.parse_state).toBe(change === "state" ? "not_started" : "running");
    expect((await fixture.sql`SELECT result FROM opening_jobs WHERE id = ${job.id}`)[0]!.result).toBeNull();
  });

  it.each(["owner", "delete"] as const)("rolls back identity drift (%s), without following the new identity", async change => {
    const { job, jobs } = await seed();
    await jobs.claim(job.id);
    await history(17);
    const newOwner = randomUUID();
    await fixture.sql`INSERT INTO users (id, email, display_name, password_hash)
      VALUES (${newOwner}, ${`${newOwner}@example.com`}, 'New owner', 'test')`;
    try {
      expect(await behindHistory(job.id, async tx => {
        if (change === "owner") await tx`UPDATE workspaces SET owner_user_id = ${newOwner} WHERE id = ${fixture.scope.workspaceId}`;
        else await tx`DELETE FROM workspaces WHERE id = ${fixture.scope.workspaceId}`;
      })).toBe(false);
      expect(await fixture.sql`SELECT revision FROM opening_workspace_history_revisions
        WHERE workspace_id = ${fixture.scope.workspaceId} AND owner_user_id = ${newOwner}`).toHaveLength(0);
      if (change === "owner") expect((await fixture.sql`SELECT state FROM opening_jobs WHERE id = ${job.id}`)[0]!.state).toBe("running");
    } finally {
      if (change === "owner") await fixture.sql`UPDATE workspaces SET owner_user_id = ${fixture.scope.ownerUserId} WHERE id = ${fixture.scope.workspaceId}`;
      else await fixture.sql`INSERT INTO workspaces (id, owner_user_id) VALUES (${fixture.scope.workspaceId}, ${fixture.scope.ownerUserId})`;
    }
  });

  it.each(["history-check", "locked-reread"] as const)("rolls back lazy ensure when identity changes at %s", async stage => {
    const { job, jobs } = await seed();
    await jobs.claim(job.id);
    await history();
    const owner = randomUUID();
    await fixture.sql`INSERT INTO users (id, email, display_name, password_hash)
      VALUES (${owner}, ${`${owner}@example.com`}, 'Drift owner', 'test')`;
    const before = await snapshot();
    const writer = openRaceSession();
    let changed = false;
    try {
      await writer.ready;
      // Run real SQL; intercept only to commit an external identity change at
      // the precise discovery/helper/reread boundary (no outer graph locks).
      const observed = new Proxy(writer.sql, { get(target, key) {
        if (key !== "begin") return Reflect.get(target, key);
        return (callback: (tx: Sql) => Promise<boolean>) => target.begin(tx => callback(new Proxy(tx, {
          apply(query, self, args: [TemplateStringsArray, ...unknown[]]) {
            const text = args[0].join("?").replace(/\s+/g, " ").trim();
            const match = stage === "history-check"
              ? text.startsWith("SELECT id FROM workspaces") : text.includes("FOR UPDATE OF w");
            if (!changed && match) {
              changed = true;
              return fixture.sql`UPDATE workspaces SET owner_user_id = ${owner} WHERE id = ${fixture.scope.workspaceId}`
                .then(() => Reflect.apply(query, self, args));
            }
            return Reflect.apply(query, self, args);
          },
        }) as unknown as Sql));
      } });
      expect(await failOpeningJob(observed, job.id, {})).toBe(false);
      expect(changed).toBe(true);
      expect(await snapshot()).toEqual(before);
      expect(await fixture.sql`SELECT revision FROM opening_workspace_history_revisions WHERE workspace_id = ${fixture.scope.workspaceId}`).toHaveLength(0);
    } finally {
      await fixture.sql`UPDATE workspaces SET owner_user_id = ${fixture.scope.ownerUserId} WHERE id = ${fixture.scope.workspaceId}`;
      await closeRace(writer.sql);
    }
  });

  it("lazily ensures zero history, retains static job-owner mismatch termination and same-scope release", async () => {
    const { job, jobs, sourceId } = await seed();
    await jobs.claim(job.id);
    await history();
    await fixture.sql`UPDATE opening_jobs SET owner_user_id = ${fixture.otherScope.ownerUserId} WHERE id = ${job.id}`;
    expect(await failOpeningJob(fixture.sql, job.id, { detail: "original" })).toBe(true);
    expect((await fixture.sql`SELECT state, result FROM opening_jobs WHERE id = ${job.id}`)[0])
      .toEqual({ state: "failed", result: { detail: "original" } });
    expect((await fixture.sql`SELECT parse_state, error FROM opening_sources WHERE id = ${sourceId}`)[0])
      .toEqual({ parse_state: "not_started", error: null });
    expect(Number((await fixture.sql`SELECT revision FROM opening_workspace_history_revisions WHERE workspace_id = ${fixture.scope.workspaceId}`)[0]!.revision)).toBe(0);
  });

  it.each(["normal", "owner", "cas"] as const)("never releases a cross-workspace source (%s path)", async path => {
    const { job, jobs, sourceId } = await seed();
    await jobs.claim(job.id);
    await fixture.sql`UPDATE opening_sources SET workspace_id = ${fixture.otherScope.workspaceId} WHERE id = ${sourceId}`;
    if (path === "owner") await fixture.sql`UPDATE opening_jobs SET owner_user_id = ${fixture.otherScope.ownerUserId} WHERE id = ${job.id}`;
    if (path === "cas") await fixture.sql`UPDATE opening_jobs SET state = 'cancelled' WHERE id = ${job.id}`;
    expect(await failOpeningJob(fixture.sql, job.id, {})).toBe(path !== "cas");
    expect((await fixture.sql`SELECT parse_state, error FROM opening_sources WHERE id = ${sourceId}`)[0])
      .toEqual({ parse_state: "running", error: null });
  });

  it("holds the same-scope release source lock until commit so a concurrent move waits", async () => {
    const { job, jobs, sourceId } = await seed();
    await jobs.claim(job.id);
    await history(3);
    await fixture.sql`UPDATE opening_jobs SET owner_user_id = ${fixture.otherScope.ownerUserId} WHERE id = ${job.id}`;
    const writer = openRaceSession(), mover = openRaceSession(), observer = openRaceSession();
    let moving: Promise<unknown> | undefined;
    try {
      await Promise.all([writer.ready, mover.ready, observer.ready]);
      const observed = new Proxy(writer.sql, { get(target, key) {
        if (key !== "begin") return Reflect.get(target, key);
        return (callback: (tx: Sql) => Promise<boolean>) => target.begin(async tx => {
          const result = await callback(tx as unknown as Sql);
          moving = track(mover.sql`UPDATE opening_sources SET workspace_id = ${fixture.otherScope.workspaceId} WHERE id = ${sourceId}`.execute());
          await waitUntilBlocked(observer.sql, mover.pid, writer.pid, "source move after scoped release", /UPDATE opening_sources/);
          expect((await tx`SELECT parse_state FROM opening_sources WHERE id = ${sourceId}`)[0]!.parse_state).toBe("not_started");
          return result;
        });
      } });
      expect(await failOpeningJob(observed, job.id, {})).toBe(true);
      await moving;
    } finally {
      await Promise.allSettled(moving ? [moving] : []);
      await Promise.all([closeRace(writer.sql), closeRace(mover.sql), closeRace(observer.sql)]);
    }
  });

  it("rolls back lazy history and the whole graph on a real source SQL failure", async () => {
    const { job, jobs } = await seed();
    await jobs.claim(job.id);
    await history();
    const before = await snapshot();
    const constraint = `test_fail_${randomUUID().replaceAll("-", "")}`;
    try {
      await fixture.sql.unsafe(`ALTER TABLE opening_sources ADD CONSTRAINT ${constraint} CHECK (parse_state <> 'failed') NOT VALID`);
      await expect(failOpeningJob(fixture.sql, job.id, {})).rejects.toMatchObject({ code: "23514" });
      expect(await snapshot()).toEqual(before);
      expect(await fixture.sql`SELECT revision FROM opening_workspace_history_revisions WHERE workspace_id = ${fixture.scope.workspaceId}`).toHaveLength(0);
    } finally { await fixture.sql.unsafe(`ALTER TABLE opening_sources DROP CONSTRAINT IF EXISTS ${constraint}`); }
    expect(await failOpeningJob(fixture.sql, job.id, {})).toBe(true);
  });

  it("retains queued/null-safe tokens, stale epoch termination and compile activity projection", async () => {
    const { job, sourceId } = await seed();
    await history();
    await fixture.sql`UPDATE workspaces SET privacy_epoch = 1 WHERE id = ${fixture.scope.workspaceId}`;
    expect(await failOpeningJob(fixture.sql, job.id, {}, "failed", { expectedState: "queued", claimToken: null })).toBe(true);
    expect((await fixture.sql`SELECT error FROM opening_sources WHERE id = ${sourceId}`)[0]!.error.code).toBe("PARSE_STALE");
    const activityId = await insertTestTeachingActivity(fixture.sql, fixture.scope);
    await fixture.sql`UPDATE opening_teaching_activities SET generate_status = 'generating' WHERE id = ${activityId}`;
    const [activity] = await fixture.sql`SELECT content_version FROM opening_teaching_activities WHERE id = ${activityId}`;
    const compile = await createOpeningJobRepository(fixture.sql).createOnce(fixture.scope, {
      key: randomUUID(), kind: "compile-teaching-unit", privacyEpoch: 1, payload: { activityId, expectedContentVersion: activity!.content_version },
    });
    expect(await failOpeningJob(fixture.sql, compile.id, {}, "failed", { expectedState: "queued" })).toBe(true);
    expect((await fixture.sql`SELECT generate_status FROM opening_teaching_activities WHERE id = ${activityId}`)[0]!.generate_status).toBe("failed");
  });

  it("propagates a real history lock timeout and leaves the old graph and revision untouched", async () => {
    const { job, jobs } = await seed();
    await jobs.claim(job.id);
    await history(23);
    const before = await snapshot();
    const gate = openRaceSession(), writer = openRaceSession();
    try {
      await Promise.all([gate.ready, writer.ready]);
      await writer.sql`SET lock_timeout = '100ms'`;
      await gate.sql.begin(async tx => {
        await tx`SELECT revision FROM opening_workspace_history_revisions WHERE workspace_id = ${fixture.scope.workspaceId} FOR UPDATE`;
        await expect(failOpeningJob(writer.sql, job.id, {})).rejects.toMatchObject({ code: "55P03" });
      });
      expect(await snapshot()).toEqual(before);
      expect(Number((await fixture.sql`SELECT revision FROM opening_workspace_history_revisions WHERE workspace_id = ${fixture.scope.workspaceId}`)[0]!.revision)).toBe(23);
    } finally { await Promise.all([closeRace(gate.sql), closeRace(writer.sql)]); }
  });

  it("distinguishes explicit null from omitted tokens and preserves stale excluded projection", async () => {
    const { job, jobs, sourceId } = await seed();
    await jobs.claim(job.id);
    await history();
    expect(await failOpeningJob(fixture.sql, job.id, {}, "failed", { claimToken: null })).toBe(false);
    expect((await jobs.get(fixture.scope, job.id)).state).toBe("running");
    await fixture.sql`UPDATE workspaces SET privacy_epoch = 1 WHERE id = ${fixture.scope.workspaceId}`;
    await fixture.sql`INSERT INTO opening_privacy_exclusions (workspace_id, source_id, deleted_at)
      VALUES (${fixture.scope.workspaceId}, ${sourceId}, now())`;
    expect(await failOpeningJob(fixture.sql, job.id, {}, "outcome_unknown")).toBe(true);
    expect((await fixture.sql`SELECT parse_state, error FROM opening_sources WHERE id = ${sourceId}`)[0])
      .toMatchObject({ parse_state: "failed", error: { code: "PRIVACY_EXCLUDED", retryable: false } });
    expect((await jobs.get(fixture.scope, job.id)).state).toBe("outcome_unknown");
  });

  it("preserves initially missing jobs and invalid UUID SQL errors", async () => {
    await history();
    expect(await failOpeningJob(fixture.sql, randomUUID(), {})).toBe(false);
    await expect(failOpeningJob(fixture.sql, "invalid-uuid", {})).rejects.toMatchObject({ code: "22P02" });
    expect(await fixture.sql`SELECT revision FROM opening_workspace_history_revisions WHERE workspace_id = ${fixture.scope.workspaceId}`).toHaveLength(0);
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
