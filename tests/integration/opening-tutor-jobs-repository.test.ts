import { randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOpeningConversationRepository,
  createOpeningTutorJobsRepository,
  createOpeningJobRepository,
} from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { TUTOR_FAILURE_MESSAGE, TUTOR_UNKNOWN_MESSAGE, TUTOR_CANCELLED_MESSAGE, PAGE_CITATION_CLARIFY_MESSAGE } from "@aistudy/domain";
import { createTutorTurnHandler } from "../../apps/worker/src/jobs/tutor-turn";
import { createTutorMetadataHandler } from "../../apps/worker/src/jobs/tutor-metadata";
import { runJob } from "../../apps/worker/src/runtime/run-job";
import { closeRace, openRaceSession, track } from "./opening-race-helpers";

let fixture: OpeningFixture;

beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => { await fixture.reset(); });
afterAll(async () => { await fixture?.close(); });

async function seedConversation() {
  const conversations = createOpeningConversationRepository(fixture.sql);
  const conversation = await conversations.create(fixture.scope, { title: "unknown recovery", courseId: null });
  const append = (text = "请解释这个概念") => conversations.appendSavedTurn({
    scope: fixture.scope,
    conversationId: conversation.id,
    text,
    mode: "explain",
    clientKey: `client-${randomUUID()}`,
    sourceIds: [],
    learningSessionId: null,
    currentPage: null,
    chunkId: null,
  });
  return { conversationId: conversation.id, append };
}

describe("completeTurn history fence", () => {
  async function completion() {
    const { append } = await seedConversation();
    const saved = await append();
    const jobs = createOpeningTutorJobsRepository(fixture.sql);
    const claimed = await jobs.claim(saved.jobId);
    return { scope: fixture.scope, jobId: saved.jobId, assistantTurnId: saved.assistantTurnId,
      claimToken: claimed!.claimToken, text: "Fenced answer", citations: [],
      candidates: [{ payload: { kind: "memory", text: "Fenced candidate", temporary: false }, sourceIds: [] }],
      enqueueMetadata: true };
  }

  async function history() {
    return fixture.sql`SELECT workspace_id, owner_user_id, revision::int FROM opening_workspace_history_revisions
      WHERE workspace_id IN (${fixture.scope.workspaceId}, ${fixture.otherScope.workspaceId}) ORDER BY workspace_id`;
  }

  async function graph(input: Awaited<ReturnType<typeof completion>>) {
    const [job] = await fixture.sql`SELECT * FROM opening_tutor_jobs WHERE id=${input.jobId}`;
    const [turn] = await fixture.sql`SELECT * FROM opening_turns WHERE id=${input.assistantTurnId}`;
    const candidates = await fixture.sql`SELECT * FROM opening_assistant_candidates WHERE source_turn_id=${input.assistantTurnId}`;
    const metadata = await fixture.sql`SELECT * FROM opening_jobs WHERE key=${`tutor-metadata:${input.jobId}`}`;
    const outbox = await fixture.sql`SELECT * FROM opening_outbox WHERE job_id IN
      (SELECT id FROM opening_jobs WHERE key=${`tutor-metadata:${input.jobId}`})`;
    const exposures = await fixture.sql`SELECT * FROM opening_help_exposures WHERE turn_id=${input.assistantTurnId}`;
    return { job, turn, candidates, metadata, outbox, exposures };
  }

  beforeEach(async () => {
    await fixture.sql`DELETE FROM opening_workspace_history_revisions
      WHERE workspace_id IN (${fixture.scope.workspaceId}, ${fixture.otherScope.workspaceId})`;
  });

  it("no-exposure completion waits on history before workspace/job/turn locks or graph writes", async () => {
    const input = await completion();
    const original = await graph(input);
    expect(await history()).toEqual([{ workspace_id: fixture.scope.workspaceId, owner_user_id: fixture.scope.ownerUserId, revision: 0 }]);
    expect(await fixture.sql`UPDATE opening_workspace_history_revisions SET revision=17
      WHERE workspace_id=${fixture.scope.workspaceId} AND owner_user_id=${fixture.scope.ownerUserId} RETURNING revision::int`)
      .toEqual([{ revision: 17 }]);
    const holder = openRaceSession(), writer = openRaceSession(), observer = openRaceSession();
    let pending: Promise<void> | undefined;
    let settled = false;
    try {
      await Promise.all([holder.ready, writer.ready, observer.ready]);
      await holder.sql.begin(async tx => {
        await tx`SELECT revision FROM opening_workspace_history_revisions
          WHERE workspace_id=${fixture.scope.workspaceId} AND owner_user_id=${fixture.scope.ownerUserId} FOR UPDATE`;
        pending = track(createOpeningTutorJobsRepository(writer.sql).completeTurn(input));
        pending.then(() => { settled = true; }, () => { settled = true; });
        await vi.waitFor(async () => {
          expect(settled, "completion must not settle while history is held").toBe(false);
          const [lock] = await observer.sql`SELECT count(*)::int AS blocked FROM pg_locks
            WHERE pid=${writer.pid} AND NOT granted AND ${holder.pid}=ANY(pg_blocking_pids(pid))`;
          expect(lock!.blocked).toBeGreaterThan(0);
          const [activity] = await observer.sql`SELECT query FROM pg_stat_activity WHERE pid=${writer.pid}`;
          expect(activity!.query).toMatch(/opening_workspace_history_revisions/);
        }, { timeout: 1000, interval: 20 });
        await tx`SELECT id FROM workspaces WHERE id=${input.scope.workspaceId} FOR UPDATE NOWAIT`;
        await tx`SELECT id FROM opening_tutor_jobs WHERE id=${input.jobId} FOR UPDATE NOWAIT`;
        await tx`SELECT id FROM opening_turns WHERE id=${input.assistantTurnId} FOR UPDATE NOWAIT`;
        expect(await graph(input)).toEqual(original);
      });
      await pending;
      const completed = await graph(input);
      expect(completed.job).toMatchObject({ status: "succeeded" });
      expect(completed.turn).toMatchObject({ status: "complete", text: input.text });
      expect(completed.candidates).toHaveLength(1);
      expect(completed.metadata).toHaveLength(1);
      expect(completed.outbox).toHaveLength(1);
      expect(completed.exposures).toHaveLength(0);
      expect(await history()).toEqual([{ workspace_id: input.scope.workspaceId, owner_user_id: input.scope.ownerUserId, revision: 17 }]);
    } finally {
      await Promise.allSettled(pending ? [pending] : []);
      await Promise.all([closeRace(holder.sql), closeRace(writer.sql), closeRace(observer.sql)]);
    }
  });

  it.each([null, 0, 23])("preserves conversation-created no-exposure history at revision %s without touching another workspace", async revision => {
    const input = await completion();
    await fixture.sql`INSERT INTO opening_workspace_history_revisions(workspace_id,owner_user_id,revision)
      VALUES (${fixture.otherScope.workspaceId},${fixture.otherScope.ownerUserId},41)`;
    expect(await history()).toHaveLength(2);
    expect(await history()).toEqual(expect.arrayContaining([
      { workspace_id: input.scope.workspaceId, owner_user_id: input.scope.ownerUserId, revision: 0 },
      { workspace_id: fixture.otherScope.workspaceId, owner_user_id: fixture.otherScope.ownerUserId, revision: 41 },
    ]));
    if (revision !== null) expect(await fixture.sql`UPDATE opening_workspace_history_revisions SET revision=${revision}
      WHERE workspace_id=${input.scope.workspaceId} AND owner_user_id=${input.scope.ownerUserId} RETURNING revision::int`)
      .toEqual([{ revision }]);
    await createOpeningTutorJobsRepository(fixture.sql).completeTurn(input);
    expect(await history()).toEqual(expect.arrayContaining([
      { workspace_id: input.scope.workspaceId, owner_user_id: input.scope.ownerUserId, revision: revision ?? 0 },
      { workspace_id: fixture.otherScope.workspaceId, owner_user_id: fixture.otherScope.ownerUserId, revision: 41 },
    ]));
    expect(await history()).toHaveLength(2);
  });

  it.each(["old token", "cancelled", "succeeded"] as const)("keeps the graph unchanged on %s CAS no-op without advancing history", async state => {
    const input = await completion();
    const jobs = createOpeningTutorJobsRepository(fixture.sql);
    if (state === "old token") input.claimToken = randomUUID();
    if (state === "cancelled") await jobs.cancel(fixture.scope, input.jobId);
    if (state === "succeeded") await jobs.completeTurn(input);
    await fixture.sql`DELETE FROM opening_workspace_history_revisions WHERE workspace_id=${input.scope.workspaceId}`;
    const original = await graph(input);
    await jobs.completeTurn(input);
    expect(await graph(input)).toEqual(original);
    expect(await history()).toEqual([{ workspace_id: input.scope.workspaceId, owner_user_id: input.scope.ownerUserId, revision: 0 }]);
  });

  it.each(["epoch", "pin", "receipt", "missing assistant"] as const)("preserves conversation-created history and rolls back the entire graph on %s rejection", async invalid => {
    const input = await completion();
    const original = await graph(input);
    const jobs = createOpeningTutorJobsRepository(fixture.sql);
    expect(await history()).toEqual([{ workspace_id: input.scope.workspaceId, owner_user_id: input.scope.ownerUserId, revision: 0 }]);
    for (const revision of [0, 29]) {
      expect(await fixture.sql`UPDATE opening_workspace_history_revisions SET revision=${revision}
        WHERE workspace_id=${input.scope.workspaceId} AND owner_user_id=${input.scope.ownerUserId} RETURNING revision::int`)
        .toEqual([{ revision }]);
      const beforeHistory = await history();
      if (invalid === "epoch") await expect(jobs.completeTurn({ ...input, expectedPrivacyEpoch: 999 })).rejects.toThrow("privacy epoch drift");
      if (invalid === "pin") await expect(jobs.completeTurn(input, { materialPurposePin: {
        courseId: randomUUID(), materialUse: "teaching", sources: [],
      } })).rejects.toThrow("course is no longer available");
      if (invalid === "receipt") await expect(jobs.completeTurn({ ...input, systemQuery: {
        authorization: { purpose: "system_record_lookup", workspaceId: input.scope.workspaceId,
          principalId: fixture.otherScope.ownerUserId, role: "workspace_owner", permissionRevision: "1" },
        version: "study-query-v1", asOf: new Date().toISOString(), privacyEpoch: 0,
        mode: "deterministic", status: "ok", reason: "read", results: [],
      } })).rejects.toThrow("query receipt grant changed");
      if (invalid === "missing assistant") await expect(jobs.completeTurn({ ...input, assistantTurnId: randomUUID() }))
        .rejects.toThrow("assistant turn was not persisted");
      expect(await graph(input)).toEqual(original);
      expect(await history()).toEqual(beforeHistory);
    }
  });

  it.each(["wrong owner", "other workspace"] as const)("preserves permission rejection for %s before durable writes", async invalid => {
    const input = await completion();
    const original = await graph(input);
    const scope = invalid === "wrong owner" ? { ...input.scope, ownerUserId: fixture.otherScope.ownerUserId }
      : { ...input.scope, workspaceId: fixture.otherScope.workspaceId };
    const error = await createOpeningTutorJobsRepository(fixture.sql).completeTurn({ ...input, scope }).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ message: "workspace permission changed" });
    expect(error).not.toHaveProperty("code");
    expect(await history()).toEqual([{ workspace_id: input.scope.workspaceId, owner_user_id: input.scope.ownerUserId, revision: 0 }]);
    expect(await graph(input)).toEqual(original);
  });

  it.each(["owner", "delete"] as const)("retains permission error after prelookup %s drift and leaves no history", async drift => {
    // Use a disposable workspace so deleting/changing its owner cannot affect
    // the shared fixture or a later case. Only scheduling is intercepted; SQL is real.
    const workspaceId = randomUUID(), ownerUserId = randomUUID(), replacementOwnerId = randomUUID();
    await fixture.sql`INSERT INTO users(id,email,display_name,password_hash) VALUES
      (${ownerUserId},${`${ownerUserId}@example.com`},'Race owner','test'),
      (${replacementOwnerId},${`${replacementOwnerId}@example.com`},'Replacement owner','test')`;
    await fixture.sql`INSERT INTO workspaces(id,owner_user_id) VALUES (${workspaceId},${ownerUserId})`;
    const scope = { workspaceId, ownerUserId };
    const mutator = openRaceSession();
    let reads = 0;
    const coordinated = new Proxy(fixture.sql, {
      get(target, property, receiver) {
        if (property !== "begin") return Reflect.get(target, property, receiver);
        return (execute: (tx: TransactionSql) => Promise<unknown>) => target.begin(tx => execute(new Proxy(tx, {
          apply(query, thisArg, args) {
            const result = Reflect.apply(query, thisArg, args) as Promise<unknown>;
            const [strings] = args as [TemplateStringsArray];
            if (!strings.join(" ").includes("SELECT id FROM workspaces") || ++reads !== 1) return result;
            return result.then(async rows => {
              if (drift === "owner") await mutator.sql`UPDATE workspaces SET owner_user_id=${replacementOwnerId} WHERE id=${workspaceId}`;
              else await mutator.sql`DELETE FROM workspaces WHERE id=${workspaceId}`;
              return rows;
            });
          },
        })));
      },
    });
    try {
      await mutator.ready;
      const error = await createOpeningTutorJobsRepository(coordinated).completeTurn({ scope, jobId: randomUUID(), assistantTurnId: randomUUID(),
        text: "must not persist", citations: [], candidates: [], enqueueMetadata: true }).catch((cause: unknown) => cause);
      expect(reads).toBe(2);
      expect(error).toMatchObject({ message: "workspace permission changed" });
      expect(error).not.toHaveProperty("code");
      expect(await fixture.sql`SELECT * FROM opening_workspace_history_revisions WHERE workspace_id=${workspaceId}`).toEqual([]);
      expect(await fixture.sql`SELECT id FROM opening_jobs WHERE workspace_id=${workspaceId}`).toEqual([]);
      expect(await fixture.sql`SELECT id FROM opening_turns WHERE workspace_id=${workspaceId}`).toEqual([]);
    } finally {
      await closeRace(mutator.sql);
      await fixture.sql`DELETE FROM workspaces WHERE id=${workspaceId}`;
      await fixture.sql`DELETE FROM users WHERE id IN (${ownerUserId},${replacementOwnerId})`;
    }
  });
});

describe("markTerminal history fence", () => {
  async function terminal() {
    const { append } = await seedConversation();
    const saved = await append();
    const claimed = await createOpeningTutorJobsRepository(fixture.sql).claim(saved.jobId);
    return { ...saved, claimToken: claimed!.claimToken };
  }

  async function history() {
    return fixture.sql`SELECT workspace_id, owner_user_id, revision::int FROM opening_workspace_history_revisions
      WHERE workspace_id IN (${fixture.scope.workspaceId}, ${fixture.otherScope.workspaceId}) ORDER BY workspace_id`;
  }

  async function graph(input: Awaited<ReturnType<typeof terminal>>) {
    const jobs = await fixture.sql`SELECT * FROM opening_tutor_jobs WHERE workspace_id=${fixture.scope.workspaceId} ORDER BY id`;
    const turns = await fixture.sql`SELECT * FROM opening_turns WHERE workspace_id=${fixture.scope.workspaceId} ORDER BY id`;
    const candidates = await fixture.sql`SELECT * FROM opening_assistant_candidates WHERE source_turn_id=${input.assistantTurnId}`;
    const metadata = await fixture.sql`SELECT * FROM opening_jobs WHERE workspace_id=${fixture.scope.workspaceId} ORDER BY id`;
    const outbox = await fixture.sql`SELECT * FROM opening_outbox WHERE workspace_id=${fixture.scope.workspaceId} ORDER BY id`;
    const exposures = await fixture.sql`SELECT * FROM opening_help_exposures WHERE turn_id=${input.assistantTurnId}`;
    return { jobs, turns, candidates, metadata, outbox, exposures };
  }

  beforeEach(async () => {
    await fixture.sql`DELETE FROM opening_workspace_history_revisions
      WHERE workspace_id IN (${fixture.scope.workspaceId}, ${fixture.otherScope.workspaceId})`;
  });

  it.each(["fail", "markUnknown"] as const)("%s waits on history with no early business locks or graph writes", async method => {
    const input = await terminal();
    // A nonempty old graph makes accidental writes visible, not merely a zero-row assertion.
    const [job] = await fixture.sql`SELECT conversation_id FROM opening_tutor_jobs WHERE id=${input.jobId}`;
    await fixture.sql`INSERT INTO opening_assistant_candidates(id,workspace_id,conversation_id,source_turn_id,source_ids,payload)
      VALUES (${randomUUID()},${fixture.scope.workspaceId},${job!.conversation_id},
        ${input.assistantTurnId},'[]','{"kind":"memory","text":"old candidate","temporary":false}')`;
    const original = await graph(input);
    expect(await history()).toEqual([{ workspace_id: fixture.scope.workspaceId, owner_user_id: fixture.scope.ownerUserId, revision: 0 }]);
    expect(await fixture.sql`UPDATE opening_workspace_history_revisions SET revision=17
      WHERE workspace_id=${fixture.scope.workspaceId} AND owner_user_id=${fixture.scope.ownerUserId} RETURNING revision::int`)
      .toEqual([{ revision: 17 }]);
    const holder = openRaceSession(), writer = openRaceSession(), observer = openRaceSession();
    let pending: Promise<void> | undefined;
    let settled = false;
    try {
      await Promise.all([holder.ready, writer.ready, observer.ready]);
      await holder.sql.begin(async tx => {
        await tx`SELECT revision FROM opening_workspace_history_revisions
          WHERE workspace_id=${fixture.scope.workspaceId} AND owner_user_id=${fixture.scope.ownerUserId} FOR UPDATE`;
        const jobs = createOpeningTutorJobsRepository(writer.sql);
        pending = track(method === "fail"
          ? jobs.fail(fixture.scope, input.jobId, "terminal message", undefined, input.claimToken)
          : jobs.markUnknown(fixture.scope, input.jobId, "terminal message", input.claimToken));
        pending.then(() => { settled = true; }, () => { settled = true; });
        await vi.waitFor(async () => {
          expect(settled, "terminal writer must wait for history").toBe(false);
          const [lock] = await observer.sql`SELECT count(*)::int AS blocked FROM pg_locks
            WHERE pid=${writer.pid} AND NOT granted AND ${holder.pid}=ANY(pg_blocking_pids(pid))`;
          expect(lock!.blocked).toBeGreaterThan(0);
          const [activity] = await observer.sql`SELECT query FROM pg_stat_activity WHERE pid=${writer.pid}`;
          expect(activity!.query).toMatch(/opening_workspace_history_revisions/);
        }, { timeout: 1000, interval: 20 });
        await tx`SELECT id FROM workspaces WHERE id=${fixture.scope.workspaceId} FOR UPDATE NOWAIT`;
        await tx`SELECT id FROM opening_tutor_jobs WHERE id=${input.jobId} FOR UPDATE NOWAIT`;
        await tx`SELECT id FROM opening_turns WHERE id=${input.assistantTurnId} FOR UPDATE NOWAIT`;
        expect(await graph(input)).toEqual(original);
      });
      await expect(pending).resolves.toBeUndefined();
      const result = await graph(input);
      const status = method === "fail" ? "failed" : "outcome_unknown";
      expect(result.jobs.find(job => job.id === input.jobId)).toMatchObject({ status });
      expect(result.turns.find(turn => turn.id === input.assistantTurnId)).toMatchObject({ status, text: "terminal message" });
      expect({ ...result, jobs: original.jobs, turns: original.turns }).toEqual(original);
      expect(await history()).toEqual([{ workspace_id: fixture.scope.workspaceId, owner_user_id: fixture.scope.ownerUserId, revision: 17 }]);
    } finally {
      await Promise.allSettled(pending ? [pending] : []);
      await Promise.all([closeRace(holder.sql), closeRace(writer.sql), closeRace(observer.sql)]);
    }
  });

  it.each(["fail", "markUnknown"] as const)("%s lazily ensures only canonical history without revision advance or owner authorization changes", async method => {
    for (const revision of [null, 0, 23]) {
      const input = await terminal();
      await fixture.sql`DELETE FROM opening_workspace_history_revisions WHERE workspace_id=${fixture.scope.workspaceId}`;
      if (revision !== null) await fixture.sql`INSERT INTO opening_workspace_history_revisions(workspace_id,owner_user_id,revision)
        VALUES (${fixture.scope.workspaceId},${fixture.scope.ownerUserId},${revision})`;
      await fixture.sql`INSERT INTO opening_workspace_history_revisions(workspace_id,owner_user_id,revision)
        VALUES (${fixture.otherScope.workspaceId},${fixture.otherScope.ownerUserId},41) ON CONFLICT DO NOTHING`;
      const jobs = createOpeningTutorJobsRepository(fixture.sql);
      // A stable nonempty wrong owner historically does not reject this API.
      const wrongOwner = { ...fixture.scope, ownerUserId: fixture.otherScope.ownerUserId };
      await expect(method === "fail" ? jobs.fail(wrongOwner, input.jobId, "legacy mismatch", undefined, input.claimToken)
        : jobs.markUnknown(wrongOwner, input.jobId, "legacy mismatch", input.claimToken)).resolves.toBeUndefined();
      expect(await history()).toHaveLength(2);
      expect(await history()).toEqual(expect.arrayContaining([
        { workspace_id: fixture.scope.workspaceId, owner_user_id: fixture.scope.ownerUserId, revision: revision ?? 0 },
        { workspace_id: fixture.otherScope.workspaceId, owner_user_id: fixture.otherScope.ownerUserId, revision: 41 },
      ]));
      expect((await fixture.sql`SELECT status FROM opening_tutor_jobs WHERE id=${input.jobId}`)[0]!.status)
        .toBe(method === "fail" ? "failed" : "outcome_unknown");
    }
  });

  it.each(["fail", "markUnknown"] as const)("%s keeps CAS no-ops, NULL/non-NULL tokens and cross-workspace behavior", async method => {
    await fixture.sql`INSERT INTO opening_workspace_history_revisions(workspace_id,owner_user_id,revision) VALUES
      (${fixture.scope.workspaceId},${fixture.scope.ownerUserId},31),
      (${fixture.otherScope.workspaceId},${fixture.otherScope.ownerUserId},43)`;
    const beforeHistory = await history();
    for (const state of ["old token", "missing token", "cancelled", "succeeded", "failed", "outcome_unknown", "foreign workspace", "queued unknown"]) {
      const input = await terminal();
      if (["cancelled", "succeeded", "failed", "outcome_unknown"].includes(state)) {
        await fixture.sql`UPDATE opening_tutor_jobs SET status=${state} WHERE id=${input.jobId}`;
      }
      if (state === "queued unknown") {
        if (method === "fail") continue;
        await fixture.sql`UPDATE opening_tutor_jobs SET status='queued',claim_token=NULL WHERE id=${input.jobId}`;
      }
      const token = state === "old token" ? randomUUID() : state === "missing token" || state === "queued unknown" ? undefined : input.claimToken;
      const scope = state === "foreign workspace" ? fixture.otherScope : fixture.scope;
      const original = await graph(input);
      const jobs = createOpeningTutorJobsRepository(fixture.sql);
      await expect(method === "fail" ? jobs.fail(scope, input.jobId, "no overwrite", undefined, token)
        : jobs.markUnknown(scope, input.jobId, "no overwrite", token)).resolves.toBeUndefined();
      expect(await graph(input)).toEqual(original);
      expect(await history()).toEqual(beforeHistory);
    }
    const input = await terminal();
    await fixture.sql`UPDATE opening_tutor_jobs SET claim_token=NULL WHERE id=${input.jobId}`;
    const jobs = createOpeningTutorJobsRepository(fixture.sql);
    await (method === "fail" ? jobs.fail(fixture.scope, input.jobId, "NULL lease") : jobs.markUnknown(fixture.scope, input.jobId, "NULL lease"));
    expect((await fixture.sql`SELECT status,text FROM opening_turns WHERE id=${input.assistantTurnId}`)[0])
      .toMatchObject({ status: method === "fail" ? "failed" : "outcome_unknown", text: "NULL lease" });
  });

  it.each(["fail", "markUnknown"] as const)("%s never overwrites an already terminal assistant turn", async method => {
    for (const status of ["complete", "failed", "clarify", "outcome_unknown"]) {
      const input = await terminal();
      await fixture.sql`UPDATE opening_turns SET status=${status},text='protected text' WHERE id=${input.assistantTurnId}`;
      const [original] = await fixture.sql`SELECT * FROM opening_turns WHERE id=${input.assistantTurnId}`;
      const jobs = createOpeningTutorJobsRepository(fixture.sql);
      await (method === "fail" ? jobs.fail(fixture.scope, input.jobId, "new message", { code: "page_not_in_sources", nextAction: "clarify" }, input.claimToken)
        : jobs.markUnknown(fixture.scope, input.jobId, "new message", input.claimToken));
      expect((await fixture.sql`SELECT * FROM opening_turns WHERE id=${input.assistantTurnId}`)[0]).toEqual(original);
      expect((await fixture.sql`SELECT status FROM opening_tutor_jobs WHERE id=${input.jobId}`)[0]!.status)
        .toBe(method === "fail" ? "failed" : "outcome_unknown");
    }
    if (method === "fail") {
      const input = await terminal();
      await createOpeningTutorJobsRepository(fixture.sql).fail(fixture.scope, input.jobId, "clarify message",
        { code: "page_not_in_sources", nextAction: "clarify" }, input.claimToken);
      expect((await fixture.sql`SELECT status,text FROM opening_turns WHERE id=${input.assistantTurnId}`)[0])
        .toMatchObject({ status: "clarify", text: "clarify message" });
    }
  });

  it.each(["expireStale", "recoverExpired"] as const)("%s counts successful empty-owner recovery using canonical history", async method => {
    const running = await terminal();
    const { append } = await seedConversation();
    const queued = await append();
    await fixture.sql`UPDATE opening_tutor_jobs SET updated_at=now()-interval '10 minutes'
      WHERE id IN (${running.jobId},${queued.jobId})`;
    const jobs = createOpeningTutorJobsRepository(fixture.sql);
    expect(await (method === "expireStale" ? jobs.expireStale({ staleMs: 300_000 }) : jobs.recoverExpired()))
      .toBe(method === "expireStale" ? 2 : 1);
    expect((await fixture.sql`SELECT status FROM opening_tutor_jobs WHERE id=${running.jobId}`)[0]!.status).toBe("outcome_unknown");
    expect((await fixture.sql`SELECT status FROM opening_tutor_jobs WHERE id=${queued.jobId}`)[0]!.status)
      .toBe(method === "expireStale" ? "failed" : "queued");
    expect(await history()).toEqual([{ workspace_id: fixture.scope.workspaceId, owner_user_id: fixture.scope.ownerUserId, revision: 0 }]);
    expect(await (method === "expireStale" ? jobs.expireStale({ staleMs: 300_000 }) : jobs.recoverExpired())).toBe(0);
  });

  it.each([
    { method: "expireStale", change: "equal cutoff", status: "queued" },
    { method: "expireStale", change: "equal cutoff", status: "running" },
    { method: "expireStale", change: "heartbeat", status: "running" },
    { method: "recoverExpired", change: "equal cutoff", status: "running" },
    { method: "recoverExpired", change: "heartbeat", status: "running" },
  ])("$method keeps strict cutoff and excludes $status after $change following selection", async ({ method, change, status }) => {
    const input = await terminal();
    await fixture.sql`UPDATE opening_tutor_jobs SET status=${status},updated_at=now()-interval '10 minutes' WHERE id=${input.jobId}`;
    const coordinated = new Proxy(fixture.sql, {
      apply(query, thisArg, args) {
        const result = Reflect.apply(query, thisArg, args) as Promise<Array<{ stale_before: Date }>>;
        if (!(args[0] as TemplateStringsArray).join(" ").includes("AS stale_before")) return result;
        return result.then(async rows => {
          expect(rows).toHaveLength(1);
          if (change === "equal cutoff") await fixture.sql`UPDATE opening_tutor_jobs SET updated_at=${rows[0]!.stale_before} WHERE id=${input.jobId}`;
          else expect(await createOpeningTutorJobsRepository(fixture.sql).heartbeat(input.jobId, input.claimToken!)).toBe(true);
          return rows;
        });
      },
    });
    const jobs = createOpeningTutorJobsRepository(coordinated);
    expect(await (method === "expireStale" ? jobs.expireStale({ staleMs: 300_000 }) : jobs.recoverExpired())).toBe(0);
    expect((await fixture.sql`SELECT status FROM opening_tutor_jobs WHERE id=${input.jobId}`)[0]!.status).toBe(status);
    expect((await fixture.sql`SELECT status FROM opening_turns WHERE id=${input.assistantTurnId}`)[0]!.status).toBe("pending");
  });

  it.each(["fail", "markUnknown"] as const)("%s rolls back actual job/turn writes without changing conversation-created history on SQL failure", async method => {
    for (const revision of [0, 29]) {
      const input = await terminal();
      expect(await history()).toEqual([{ workspace_id: fixture.scope.workspaceId, owner_user_id: fixture.scope.ownerUserId, revision: 0 }]);
      expect(await fixture.sql`UPDATE opening_workspace_history_revisions SET revision=${revision}
        WHERE workspace_id=${fixture.scope.workspaceId} AND owner_user_id=${fixture.scope.ownerUserId} RETURNING revision::int`)
        .toEqual([{ revision }]);
      const original = await graph(input), beforeHistory = await history();
      const coordinated = new Proxy(fixture.sql, {
        get(target, property, receiver) {
          if (property !== "begin") return Reflect.get(target, property, receiver);
          return (execute: (tx: TransactionSql) => Promise<unknown>) => target.begin(tx => execute(new Proxy(tx, {
            apply(query, thisArg, args) {
              const result = Reflect.apply(query, thisArg, args) as Promise<unknown>;
              if (!(args[0] as TemplateStringsArray).join(" ").includes("UPDATE opening_turns SET text")) return result;
              return result.then(async rows => { await tx`SELECT 1/0`; return rows; });
            },
          })));
        },
      });
      const jobs = createOpeningTutorJobsRepository(coordinated);
      await expect(method === "fail" ? jobs.fail(fixture.scope, input.jobId, "must rollback", undefined, input.claimToken)
        : jobs.markUnknown(fixture.scope, input.jobId, "must rollback", input.claimToken)).rejects.toMatchObject({ code: "22012" });
      expect(await graph(input)).toEqual(original);
      expect(await history()).toEqual(beforeHistory);
    }
  });

  it.each(["before helper", "after helper"] as const)("deletion %s preserves conversation-created history without adding lazy history and retains missing-workspace UUID errors", async window => {
    for (const invalid of ["valid", "job", "token"] as const) {
      const workspaceId = randomUUID(), ownerUserId = randomUUID();
      await fixture.sql`INSERT INTO users(id,email,display_name,password_hash)
        VALUES (${ownerUserId},${`${ownerUserId}@example.com`},'Deletion race','test')`;
      await fixture.sql`INSERT INTO workspaces(id,owner_user_id) VALUES (${workspaceId},${ownerUserId})`;
      const scope = { workspaceId, ownerUserId };
      const conversations = createOpeningConversationRepository(fixture.sql);
      const conversation = await conversations.create(scope, { title: "Deleted terminal graph", courseId: null });
      const saved = await conversations.appendSavedTurn({ scope, conversationId: conversation.id, text: "race question", mode: "explain",
        clientKey: randomUUID(), sourceIds: [], learningSessionId: null, currentPage: null, chunkId: null });
      const claimed = await createOpeningTutorJobsRepository(fixture.sql).claim(saved.jobId);
      expect(await fixture.sql`SELECT id FROM opening_turns WHERE workspace_id=${workspaceId}`).toHaveLength(2);
      // History has no workspace FK: create's committed canonical zero survives
      // deletion. A terminal operation must neither remove it nor add another row.
      const beforeHistory = await fixture.sql`SELECT workspace_id,owner_user_id,revision::int
        FROM opening_workspace_history_revisions WHERE workspace_id=${workspaceId}`;
      expect(beforeHistory).toEqual([{ workspace_id: workspaceId, owner_user_id: ownerUserId, revision: 0 }]);
      const mutator = openRaceSession();
      let scheduled = false;
      const coordinated = new Proxy(fixture.sql, {
        get(target, property, receiver) {
          if (property !== "begin") return Reflect.get(target, property, receiver);
          return (execute: (tx: TransactionSql) => Promise<unknown>) => target.begin(tx => execute(new Proxy(tx, {
            apply(query, thisArg, args) {
              const result = Reflect.apply(query, thisArg, args) as Promise<unknown>;
              const text = (args[0] as TemplateStringsArray).join(" ");
              const boundary = window === "before helper" ? "SELECT owner_user_id FROM workspaces" : "SELECT revision FROM opening_workspace_history_revisions";
              if (scheduled || !text.includes(boundary)) return result;
              scheduled = true;
              return result.then(async rows => { await mutator.sql`DELETE FROM workspaces WHERE id=${workspaceId}`; return rows; });
            },
          })));
        },
      });
      try {
        await mutator.ready;
        const result = createOpeningTutorJobsRepository(coordinated).fail(scope, invalid === "job" ? "invalid-job-uuid" : saved.jobId,
          "no write", undefined, invalid === "token" ? "invalid-token-uuid" : claimed!.claimToken);
        if (invalid !== "valid") await expect(result).rejects.toMatchObject({ code: "22P02" });
        else await expect(result).resolves.toBeUndefined();
        expect(scheduled).toBe(true);
        expect(await fixture.sql`SELECT workspace_id,owner_user_id,revision::int
          FROM opening_workspace_history_revisions WHERE workspace_id=${workspaceId}`).toEqual(beforeHistory);
        expect(await fixture.sql`SELECT * FROM opening_tutor_jobs WHERE workspace_id=${workspaceId}`).toEqual([]);
        expect(await fixture.sql`SELECT * FROM opening_turns WHERE workspace_id=${workspaceId}`).toEqual([]);
      } finally {
        await closeRace(mutator.sql);
        await fixture.sql`DELETE FROM workspaces WHERE id=${workspaceId}`;
        await fixture.sql`DELETE FROM opening_workspace_history_revisions WHERE workspace_id=${workspaceId}`;
        await fixture.sql`DELETE FROM users WHERE id=${ownerUserId}`;
      }
    }
  });

  it.each(["before helper", "after helper"] as const)("owner move %s rejects coordination instead of relocking or succeeding", async window => {
    const workspaceId = randomUUID(), ownerUserId = randomUUID(), replacementOwnerId = randomUUID();
    await fixture.sql`INSERT INTO users(id,email,display_name,password_hash) VALUES
      (${ownerUserId},${`${ownerUserId}@example.com`},'Owner race','test'),
      (${replacementOwnerId},${`${replacementOwnerId}@example.com`},'Replacement','test')`;
    await fixture.sql`INSERT INTO workspaces(id,owner_user_id) VALUES (${workspaceId},${ownerUserId})`;
    const scope = { workspaceId, ownerUserId };
    const mutator = openRaceSession();
    let scheduled = false;
    const coordinated = new Proxy(fixture.sql, {
      get(target, property, receiver) {
        if (property !== "begin") return Reflect.get(target, property, receiver);
        return (execute: (tx: TransactionSql) => Promise<unknown>) => target.begin(tx => execute(new Proxy(tx, {
          apply(query, thisArg, args) {
            const result = Reflect.apply(query, thisArg, args) as Promise<unknown>;
            const text = (args[0] as TemplateStringsArray).join(" ");
            const boundary = window === "before helper" ? "SELECT owner_user_id FROM workspaces" : "SELECT revision FROM opening_workspace_history_revisions";
            if (scheduled || !text.includes(boundary)) return result;
            scheduled = true;
            return result.then(async rows => {
              await mutator.sql`UPDATE workspaces SET owner_user_id=${replacementOwnerId} WHERE id=${workspaceId}`;
              return rows;
            });
          },
        })));
      },
    });
    try {
      await mutator.ready;
      const failure = await createOpeningTutorJobsRepository(coordinated).markUnknown(scope, randomUUID(), "no write").catch((error: unknown) => error);
      expect(failure).toMatchObject(window === "before helper" ? { code: "NOT_FOUND", message: "workspace not found" }
        : { message: "terminal history coordination drift: workspace owner changed" });
      expect(scheduled).toBe(true);
      expect(await fixture.sql`SELECT * FROM opening_workspace_history_revisions WHERE workspace_id=${workspaceId}`).toEqual([]);
    } finally {
      await closeRace(mutator.sql);
      await fixture.sql`DELETE FROM workspaces WHERE id=${workspaceId}`;
      await fixture.sql`DELETE FROM opening_workspace_history_revisions WHERE workspace_id=${workspaceId}`;
      await fixture.sql`DELETE FROM users WHERE id IN (${ownerUserId},${replacementOwnerId})`;
    }
  });

  it.each(["fail", "markUnknown"] as const)("%s preserves missing workspace errors instead of swallowing malformed job/token UUIDs", async method => {
    const scope = { workspaceId: randomUUID(), ownerUserId: "" };
    const jobs = createOpeningTutorJobsRepository(fixture.sql);
    for (const [jobId, token] of [[randomUUID(), undefined], ["invalid-job", undefined], [randomUUID(), "invalid-token"]]) {
      const result = method === "fail" ? jobs.fail(scope, jobId!, "no write", undefined, token) : jobs.markUnknown(scope, jobId!, "no write", token);
      if (jobId === "invalid-job" || token) await expect(result).rejects.toMatchObject({ code: "22P02" });
      else await expect(result).resolves.toBeUndefined();
    }
    expect(await fixture.sql`SELECT * FROM opening_workspace_history_revisions WHERE workspace_id=${scope.workspaceId}`).toEqual([]);
  });
});

describe("tutor job recovery repository", () => {
  it("releases tutor work while a separately claimed metadata job is waiting, and attaches late suggestions to the original answer", async () => {
    const { conversationId, append } = await seedConversation();
    const first = await append();
    const jobs = createOpeningTutorJobsRepository(fixture.sql);
    const metadataJobs = createOpeningJobRepository(fixture.sql);
    const conversations = createOpeningConversationRepository(fixture.sql);
    let releaseMetadata!: () => void;
    const metadataGate = new Promise<void>(resolve => { releaseMetadata = resolve; });
    let metadataStarted!: () => void;
    const started = new Promise<void>(resolve => { metadataStarted = resolve; });
    let settled = 0;
    const candidate = { kind: "memory" as const, text: "Learner asked about Newton", temporary: false };
    const processTurn = createTutorTurnHandler({
      tutorJobs: jobs,
      chunks: { listForSources: async () => [], listChunksAtVersion: async () => [] },
      stream: { begin: async () => {}, append: async () => {} },
      budget: { reserve: async () => ({ id: randomUUID() }), claimExecution: async () => true,
        settle: async () => { settled += 1; }, release: async () => {}, markUnknown: async () => {} } as never,
      provider: { complete: async () => ({ text: "Force equals mass times acceleration.",
        citedChunkIds: [], candidates: [], requestId: null, inputTokens: 10, outputTokens: 10 }) },
      config: { maxContextCharacters: 5000, reservedCents: 100, maxOutputTokens: 2048,
        inputCentsPerMillion: 100, outputCentsPerMillion: 200 },
    });
    await processTurn(first.jobId);
    expect(settled).toBe(1);
    expect(await jobs.get(fixture.scope, first.jobId)).toMatchObject({ status: "succeeded" });
    expect(await jobs.findPendingForConversation(fixture.scope, conversationId)).toBeNull();
    expect((await conversations.listTurns(fixture.scope, conversationId)).find(turn => turn.id === first.assistantTurnId))
      .toMatchObject({ status: "complete", text: "Force equals mass times acceleration." });
    const [outbox] = await fixture.sql`SELECT j.id, j.payload, o.state FROM opening_jobs j JOIN opening_outbox o ON o.job_id=j.id
      WHERE j.key=${`tutor-metadata:${first.jobId}`}`;
    expect(outbox).toMatchObject({ state: "pending", payload: { tutorJobId: first.jobId, assistantTurnId: first.assistantTurnId } });
    const processMetadata = createTutorMetadataHandler({ tutorJobs: jobs, callModel: async (_scope, _mode, options) => {
      await options.beforeSend?.();
      metadataStarted();
      await metadataGate;
      const output = { text: "", citedChunkIds: [], candidates: [candidate], requestId: null, inputTokens: 10, outputTokens: 10 };
      await options.persistResult?.(output, { reservationId: "metadata", settledCents: 1 });
      settled += 1;
      return output;
    } });
    const run = runJob(metadataJobs, String(outbox!.id), processMetadata);
    try {
      await Promise.race([started, run.then(() => { throw new Error("metadata was never requested"); })]);
      // More than the tutor queue's two slots: none remains occupied by metadata.
      for (let index = 0; index < 3; index += 1) {
        const next = await append(`What happens when mass is ${index + 2}?`);
        await processTurn(next.jobId);
        expect(await jobs.get(fixture.scope, next.jobId)).toMatchObject({ status: "succeeded" });
      }
      expect(settled).toBe(4);
      releaseMetadata();
      await run;
      expect(settled).toBe(5);
      expect(await jobs.findPendingForConversation(fixture.scope, conversationId)).toBeNull();
      expect((await metadataJobs.get(fixture.scope, String(outbox!.id))).state).toBe("succeeded");
      const candidates = await fixture.sql`SELECT source_turn_id, payload FROM opening_assistant_candidates WHERE conversation_id=${conversationId}`;
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({ source_turn_id: first.assistantTurnId, payload: candidate });
    } finally {
      releaseMetadata();
      await run;
    }
  });

  async function completedMetadataTarget() {
    const { conversationId, append } = await seedConversation();
    const saved = await append();
    const jobs = createOpeningTutorJobsRepository(fixture.sql);
    const claimed = await jobs.claim(saved.jobId);
    const sourceId = randomUUID();
    await fixture.sql`INSERT INTO opening_sources (id, workspace_id, name, mime, bytes, sha256, version, upload_state, parse_state)
      VALUES (${sourceId}, ${fixture.scope.workspaceId}, 'notes.pdf', 'application/pdf', 1, ${"a".repeat(64)}, 0, 'uploaded', 'ready')`;
    const [workspace] = await fixture.sql`SELECT privacy_epoch FROM workspaces WHERE id=${fixture.scope.workspaceId}`;
    const target = { scope: fixture.scope, jobId: saved.jobId, assistantTurnId: saved.assistantTurnId,
      claimToken: claimed!.claimToken, expectedPrivacyEpoch: Number(workspace!.privacy_epoch) };
    await jobs.completeTurn({ ...target, text: "Saved answer", citations: [], candidates: [], enqueueMetadata: true,
      contextSourceRefs: [{ sourceId, sourceVersion: 0 }] });
    const [metadata] = await fixture.sql`SELECT id FROM opening_jobs WHERE key=${`tutor-metadata:${saved.jobId}`}`;
    const metadataJobs = createOpeningJobRepository(fixture.sql);
    const metadataClaim = await metadataJobs.claim(String(metadata!.id));
    return { jobs, target: { ...target, metadataLease: { id: metadataClaim!.id, claimToken: metadataClaim!.claimToken } }, sourceId, conversationId };
  }

  it("keeps late suggestions owned, tied to the saved answer's sources, and idempotent even after acceptance", async () => {
    const { jobs, target, sourceId } = await completedMetadataTarget();
    const candidates = [{ kind: "memory", text: "Useful note", temporary: false }];
    expect(await jobs.canAppendCompletedTurnCandidates(target)).toBe(true);
    for (const invalid of [
      { ...target, scope: fixture.otherScope },
      { ...target, scope: { ...fixture.scope, ownerUserId: fixture.otherScope.ownerUserId } },
      { ...target, assistantTurnId: randomUUID() },
      { ...target, claimToken: randomUUID() },
      { ...target, metadataLease: { ...target.metadataLease, claimToken: randomUUID() } },
    ]) {
      expect(await jobs.canAppendCompletedTurnCandidates(invalid)).toBe(false);
      expect(await jobs.appendCompletedTurnCandidates({ ...invalid, candidates })).toBe(false);
    }
    expect(await jobs.appendCompletedTurnCandidates({ ...target, candidates })).toBe(true);
    await fixture.sql`UPDATE opening_assistant_candidates SET status='accepted' WHERE source_turn_id=${target.assistantTurnId}`;
    expect(await jobs.canAppendCompletedTurnCandidates(target)).toBe(false);
    expect(await jobs.appendCompletedTurnCandidates({ ...target, candidates })).toBe(false);
    const rows = await fixture.sql`SELECT source_ids FROM opening_assistant_candidates WHERE source_turn_id=${target.assistantTurnId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source_ids).toEqual([sourceId]);
    expect(await jobs.get(fixture.scope, target.jobId)).toMatchObject({ status: "succeeded" });
    expect((await fixture.sql`SELECT text, status FROM opening_turns WHERE id=${target.assistantTurnId}`)[0])
      .toMatchObject({ text: "Saved answer", status: "complete" });
  });

  it.each(["privacy changed", "source replaced", "source excluded", "answer deleted", "answer moved", "metadata cancelled"])(
    "does not send or append late suggestions after %s", async change => {
      const { jobs, target, sourceId } = await completedMetadataTarget();
      if (change === "privacy changed") await fixture.sql`UPDATE workspaces SET privacy_epoch=privacy_epoch+1 WHERE id=${fixture.scope.workspaceId}`;
      if (change === "source replaced") await fixture.sql`UPDATE opening_sources SET version=version+1 WHERE id=${sourceId}`;
      if (change === "source excluded") await fixture.sql`INSERT INTO opening_privacy_exclusions (id, workspace_id, source_id, memory_id, deleted_at)
        VALUES (${randomUUID()}, ${fixture.scope.workspaceId}, ${sourceId}, NULL, now())`;
      if (change === "metadata cancelled") await createOpeningJobRepository(fixture.sql).cancel(fixture.scope, target.metadataLease.id);
      if (change === "answer deleted") await fixture.sql`DELETE FROM opening_turns WHERE id=${target.assistantTurnId}`;
      if (change === "answer moved") {
        const other = await seedConversation();
        await fixture.sql`UPDATE opening_turns SET conversation_id=${other.conversationId} WHERE id=${target.assistantTurnId}`;
      }
      expect(await jobs.canAppendCompletedTurnCandidates(target)).toBe(false);
      expect(await jobs.appendCompletedTurnCandidates({ ...target, candidates: [{ kind: "memory", text: "Old context", temporary: false }] })).toBe(false);
      expect(await fixture.sql`SELECT id FROM opening_assistant_candidates WHERE source_turn_id=${target.assistantTurnId}`).toHaveLength(0);
    },
  );

  it.each([
    { jobStatus: "failed", turnStatus: "failed", detail: {}, message: TUTOR_FAILURE_MESSAGE },
    { jobStatus: "failed", turnStatus: "failed", detail: { code: "REQUEST_CAP_EXCEEDED" }, message: "该模型今天的请求次数已达上限；可在设置中为该用途指定备用模型。" },
    { jobStatus: "failed", turnStatus: "clarify", detail: { code: "page_not_in_sources", nextAction: "clarify" }, message: PAGE_CITATION_CLARIFY_MESSAGE },
    { jobStatus: "outcome_unknown", turnStatus: "outcome_unknown", detail: {}, message: TUTOR_UNKNOWN_MESSAGE },
    { jobStatus: "outcome_unknown", turnStatus: "pending", detail: {}, message: TUTOR_UNKNOWN_MESSAGE },
    { jobStatus: "cancelled", turnStatus: "failed", detail: {}, message: TUTOR_CANCELLED_MESSAGE },
  ])("hides legacy $jobStatus/$turnStatus diagnostics at job, history and preview reads without rewriting storage", async ({ jobStatus, turnStatus, detail, message }) => {
    const diagnostic = "SQL SELECT credential FROM private at /server/secret.ts:4";
    const { conversationId, append } = await seedConversation();
    const saved = await append(diagnostic);
    await fixture.sql`UPDATE opening_tutor_jobs SET status=${jobStatus}, error=${fixture.sql.json({ message: diagnostic, ...detail })} WHERE id=${saved.jobId}`;
    await fixture.sql`UPDATE opening_turns SET status=${turnStatus}, text=${diagnostic}, created_at=now()+interval '1 second' WHERE id=${saved.assistantTurnId}`;
    const jobs = createOpeningTutorJobsRepository(fixture.sql);
    const conversations = createOpeningConversationRepository(fixture.sql);

    expect((await jobs.get(fixture.scope, saved.jobId))?.error?.message).toBe(message);
    const turns = await conversations.listTurns(fixture.scope, conversationId);
    expect(turns.find(turn => turn.id === saved.assistantTurnId)).toMatchObject({ text: message, status: turnStatus });
    // A user's technical question is their content, never treated as an exception by string matching.
    expect(turns.find(turn => turn.id === saved.turnId)?.text).toBe(diagnostic);
    const summary = (await conversations.listSummaries(fixture.scope)).find(item => item.id === conversationId)!;
    expect(summary.lastTurnPreview).not.toContain(diagnostic);
    expect(summary.lastTurnPreview).toBe(turnStatus === "failed" && jobStatus !== "cancelled" ? TUTOR_FAILURE_MESSAGE : message);
    expect(await conversations.loadContinuityTurns(fixture.scope, conversationId)).toEqual([
      { id: saved.turnId, role: "user", text: diagnostic, citations: [] },
      ...(turnStatus === "pending" ? [{ id: saved.assistantTurnId, role: "assistant", text: message, citations: [] }] : []),
    ]);
    if (jobStatus === "outcome_unknown") expect(await jobs.findPendingForConversation(fixture.scope, conversationId))
      .toMatchObject({ id: saved.jobId, status: "outcome_unknown", error: { message: TUTOR_UNKNOWN_MESSAGE } });
    expect(await jobs.get(fixture.otherScope, saved.jobId)).toBeNull();
    await expect(conversations.listTurns(fixture.otherScope, conversationId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await fixture.sql`SELECT text FROM opening_turns WHERE id=${saved.assistantTurnId}`)[0]?.text).toBe(diagnostic);
  });

  it("preserves successful model and user text even when it looks like a technical exception", async () => {
    const text = "Error: SELECT examples FROM tutorial at /example.ts:1";
    const { conversationId, append } = await seedConversation();
    const saved = await append(text);
    await fixture.sql`UPDATE opening_tutor_jobs SET status='succeeded' WHERE id=${saved.jobId}`;
    await fixture.sql`UPDATE opening_turns SET status='complete', text=${text}, created_at=now()+interval '1 second' WHERE id=${saved.assistantTurnId}`;
    const conversations = createOpeningConversationRepository(fixture.sql);
    expect((await conversations.listTurns(fixture.scope, conversationId)).map(turn => turn.text)).toEqual([text, text]);
    expect((await conversations.listSummaries(fixture.scope)).find(item => item.id === conversationId)?.lastTurnPreview).toBe(text);
    expect((await conversations.loadContinuityTurns(fixture.scope, conversationId)).map(turn => turn.text)).toEqual([text, text]);
  });

  it.each(["queued", "running"] as const)("restores the latest %s job with its pending assistant turn", async (status) => {
    const { conversationId, append } = await seedConversation();
    const saved = await append();
    const jobs = createOpeningTutorJobsRepository(fixture.sql);
    if (status === "running") await jobs.claim(saved.jobId);

    expect(await jobs.findPendingForConversation(fixture.scope, conversationId)).toMatchObject({
      id: saved.jobId, status, error: null,
    });
  });

  it("recovers an unknown job after markUnknown atomically terminates its assistant turn", async () => {
    const { conversationId, append } = await seedConversation();
    const saved = await append();
    const jobs = createOpeningTutorJobsRepository(fixture.sql);
    const claimed = await jobs.claim(saved.jobId);
    await jobs.markUnknown(fixture.scope, saved.jobId, "provider outcome unknown; usage reconciliation pending", claimed!.claimToken);
    const persisted = await jobs.get(fixture.scope, saved.jobId);

    expect(await jobs.findPendingForConversation(fixture.scope, conversationId)).toEqual({
      id: saved.jobId,
      status: "outcome_unknown",
      error: persisted!.error,
      updatedAt: persisted!.updatedAt,
    });
    const turns = await createOpeningConversationRepository(fixture.sql).listTurns(fixture.scope, conversationId);
    expect(turns.find((turn) => turn.id === saved.assistantTurnId)?.status).toBe("outcome_unknown");
  });

  it("still recovers a legacy unknown job whose assistant turn is pending", async () => {
    const { conversationId, append } = await seedConversation();
    const saved = await append();
    await fixture.sql`UPDATE opening_tutor_jobs SET status = 'outcome_unknown' WHERE id = ${saved.jobId}`;

    expect(await createOpeningTutorJobsRepository(fixture.sql).findPendingForConversation(fixture.scope, conversationId))
      .toMatchObject({ id: saved.jobId, status: "outcome_unknown" });
  });

  it.each(["queued", "running", "succeeded", "failed", "cancelled"] as const)(
    "does not revive an older unknown after a newer %s job",
    async (status) => {
      const { conversationId, append } = await seedConversation();
      const old = await append();
      await fixture.sql`UPDATE opening_tutor_jobs SET status = 'outcome_unknown', created_at = now() - interval '1 minute' WHERE id = ${old.jobId}`;
      await fixture.sql`UPDATE opening_turns SET status = 'outcome_unknown' WHERE id = ${old.assistantTurnId}`;
      const latest = await append();
      await fixture.sql`UPDATE opening_tutor_jobs SET status = ${status} WHERE id = ${latest.jobId}`;
      const turnStatus = status === "succeeded" ? "complete" : status === "failed" || status === "cancelled" ? "failed" : "pending";
      await fixture.sql`UPDATE opening_turns SET status = ${turnStatus} WHERE id = ${latest.assistantTurnId}`;

      const result = await createOpeningTutorJobsRepository(fixture.sql).findPendingForConversation(fixture.scope, conversationId);
      if (status === "queued" || status === "running") {
        expect(result).toMatchObject({ id: latest.jobId, status });
      } else {
        expect(result).toBeNull();
      }
    },
  );

  it.each(["complete", "failed", "clarify"] as const)("does not recover an unknown job over its protected %s assistant turn", async (status) => {
    const { conversationId, append } = await seedConversation();
    const saved = await append();
    await fixture.sql`UPDATE opening_tutor_jobs SET status = 'outcome_unknown' WHERE id = ${saved.jobId}`;
    await fixture.sql`UPDATE opening_turns SET status = ${status} WHERE id = ${saved.assistantTurnId}`;

    expect(await createOpeningTutorJobsRepository(fixture.sql).findPendingForConversation(fixture.scope, conversationId)).toBeNull();
  });

  it("breaks equal creation-time ties by job id before filtering terminal states", async () => {
    const { conversationId, append } = await seedConversation();
    const first = await append();
    const second = await append();
    const newest = first.jobId > second.jobId ? first : second;
    const older = newest === first ? second : first;
    await fixture.sql`UPDATE opening_tutor_jobs SET created_at = '2026-10-15T00:00:00Z' WHERE id IN (${first.jobId}, ${second.jobId})`;
    await fixture.sql`UPDATE opening_tutor_jobs SET status = 'outcome_unknown' WHERE id = ${older.jobId}`;
    await fixture.sql`UPDATE opening_turns SET status = 'outcome_unknown' WHERE id = ${older.assistantTurnId}`;
    await fixture.sql`UPDATE opening_tutor_jobs SET status = 'succeeded' WHERE id = ${newest.jobId}`;
    await fixture.sql`UPDATE opening_turns SET status = 'complete' WHERE id = ${newest.assistantTurnId}`;

    expect(await createOpeningTutorJobsRepository(fixture.sql).findPendingForConversation(fixture.scope, conversationId)).toBeNull();
  });

  it("keeps recovery bound to both the conversation owner and workspace", async () => {
    const { conversationId, append } = await seedConversation();
    const saved = await append();
    const jobs = createOpeningTutorJobsRepository(fixture.sql);
    const claimed = await jobs.claim(saved.jobId);
    await jobs.markUnknown(fixture.scope, saved.jobId, "provider timeout", claimed!.claimToken);

    expect(await jobs.findPendingForConversation(fixture.otherScope, conversationId)).toBeNull();
    expect(await jobs.findPendingForConversation({ ...fixture.scope, ownerUserId: fixture.otherScope.ownerUserId }, conversationId)).toBeNull();
    expect(await jobs.findPendingForConversation({ ...fixture.otherScope, ownerUserId: fixture.scope.ownerUserId }, conversationId)).toBeNull();
  });

  it("keeps concurrent equal-time user/assistant pairs adjacent and aligned with the latest recovery job", async () => {
    const { conversationId, append } = await seedConversation();
    const saved = await Promise.all(["解释导数", "解释积分", "解释极限"].map(async (text) => ({ ...await append(text), text })));
    const ordered = [...saved].sort((left, right) => left.jobId.localeCompare(right.jobId));
    const latest = ordered.at(-1)!;
    await fixture.sql`UPDATE opening_turns SET created_at = '2026-10-15T00:00:00Z' WHERE conversation_id = ${conversationId}`;
    await fixture.sql`UPDATE opening_tutor_jobs SET created_at = '2026-10-15T00:00:00Z', status = 'succeeded' WHERE conversation_id = ${conversationId}`;
    await fixture.sql`UPDATE opening_turns SET status = 'complete' WHERE conversation_id = ${conversationId}`;
    await fixture.sql`UPDATE opening_tutor_jobs SET status = 'running' WHERE id = ${latest.jobId}`;
    await fixture.sql`UPDATE opening_turns SET status = 'pending' WHERE id = ${latest.assistantTurnId}`;
    const jobs = createOpeningTutorJobsRepository(fixture.sql);
    await jobs.markUnknown(fixture.scope, latest.jobId, "provider timeout");
    // Move the user tuple after the terminal assistant tuple. Physical row
    // order must not determine which question recovery puts back in the draft.
    await fixture.sql`UPDATE opening_turns SET text = text WHERE id = ${latest.turnId}`;

    const turns = await createOpeningConversationRepository(fixture.sql).listTurns(fixture.scope, conversationId);
    expect(turns.map((turn) => turn.id)).toEqual(ordered.flatMap((row) => [row.turnId, row.assistantTurnId]));
    expect(turns.at(-2)).toMatchObject({ id: latest.turnId, role: "user", text: latest.text });
    expect(turns.at(-1)).toMatchObject({ id: latest.assistantTurnId, role: "assistant", status: "outcome_unknown" });
    expect(await jobs.findPendingForConversation(fixture.scope, conversationId)).toMatchObject({ id: latest.jobId, status: "outcome_unknown" });
  });
});
