/**
 * Durable tutor redelivery and interrupted-writeback safety, plus teaching
 * completed-key replay. Real Postgres ledger and tutor-jobs repository; no
 * terminal/running tutor job is reset to queued to manufacture a retry entry.
 */
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOpeningBudgetRepository, createOpeningConversationRepository,
  createOpeningSourceChunksRepository, createOpeningTutorJobsRepository,
} from "@aistudy/database";
import type { OpeningJobRecord } from "@aistudy/database";
import type { ProviderOutput } from "@aistudy/contracts";
import { createTutorTurnHandler } from "../../apps/worker/src/jobs/tutor-turn";
import { createCompileTeachingUnitHandler, type TeachingGenerateStatus } from "../../apps/worker/src/jobs/compile-teaching-unit";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let f: OpeningFixture;
beforeAll(async () => { f = await createOpeningFixture(); });
beforeEach(async () => { await f.reset(); });
afterAll(async () => { await f?.close(); });

const output = (text: string): ProviderOutput => ({ text, citedChunkIds: [], requestId: null, candidates: [], inputTokens: 20, outputTokens: 10 });

async function ledger() {
  const rows = await f.sql`
    SELECT count(*)::int AS rows,
      COALESCE(sum(amount_cents) FILTER (WHERE state='completed'),0)::int AS used,
      COALESCE(sum(amount_cents) FILTER (WHERE state='reserved'),0)::int AS reserved,
      COALESCE(sum(pending_reconcile_cents),0)::int AS pending
    FROM opening_budget_reservations WHERE workspace_id=${f.scope.workspaceId}`;
  return rows[0] as unknown as { rows: number; used: number; reserved: number; pending: number };
}
function record(name: string, logicalOps: number, providerCalls: number, l: { used: number; reserved: number; pending: number }, outcome: string) {
  if (!process.env.BUDGET_MATRIX_OUT) return;
  appendFileSync(process.env.BUDGET_MATRIX_OUT, `${JSON.stringify({ case: name, logicalOps, providerCalls, used: l.used, reserved: l.reserved, pending: l.pending, reconcileEvents: "-", outcome })}\n`);
}

function tutor(tutorJobsOverride?: Partial<ReturnType<typeof createOpeningTutorJobsRepository>>) {
  const provider = { complete: vi.fn(async () => output("persisted answer")) };
  const run = createTutorTurnHandler({
    tutorJobs: { ...createOpeningTutorJobsRepository(f.sql), ...tutorJobsOverride },
    chunks: createOpeningSourceChunksRepository(f.sql),
    budget: createOpeningBudgetRepository(f.sql, { envCapCents: 100_000 }),
    provider,
    config: { maxContextCharacters: 12_000, reservedCents: 100, maxOutputTokens: 256, inputCentsPerMillion: 1, outputCentsPerMillion: 1 },
  });
  return { run, provider };
}
async function newTurn() {
  const conversations = createOpeningConversationRepository(f.sql);
  const c = await conversations.create(f.scope, { title: "replay", courseId: null });
  const input = {
    scope: f.scope, conversationId: c.id, text: "explain", sourceIds: [], mode: "explain" as const,
    clientKey: randomUUID(), learningSessionId: null, currentPage: null, chunkId: null,
  };
  const saved = await conversations.appendSavedTurn(input);
  return { ...saved, replaySubmission: () => conversations.appendSavedTurn(input) };
}

describe("tutor-turn redelivery and interrupted writeback", () => {
  it("replays the saved submission and reads its persisted result without reclaiming a completed job", async () => {
    const t = await newTurn();
    const first = tutor();
    await first.run(t.jobId);
    expect(first.provider.complete).toHaveBeenCalledTimes(1);
    const before = await ledger();
    const ref = await f.sql`SELECT result_ref FROM opening_budget_reservations WHERE request_id=${`tutor:${t.jobId}`}`;
    expect(ref[0]!.result_ref).toBe(`opening_turn:${t.assistantTurnId}`);
    expect(await t.replaySubmission()).toEqual({ turnId: t.turnId, jobId: t.jobId, assistantTurnId: t.assistantTurnId });
    const repo = createOpeningTutorJobsRepository(f.sql);
    expect(await repo.loadReplayedTurn(f.scope, String(ref[0]!.result_ref))).toEqual({
      id: t.assistantTurnId, status: "complete", text: "persisted answer",
    });
    const second = tutor();
    await expect(second.run(t.jobId)).resolves.toEqual({ skipped: true });
    expect(second.provider.complete).not.toHaveBeenCalled();
    const after = await ledger();
    expect(after).toEqual(before);
    const job = await f.sql`SELECT status FROM opening_tutor_jobs WHERE id=${t.jobId}`;
    const turn = await f.sql`SELECT status, text FROM opening_turns WHERE id=${t.assistantTurnId}`;
    expect(job[0]!.status).toBe("succeeded");
    expect(turn[0]).toEqual({ status: "complete", text: "persisted answer" });
    record("tutor-turn completed submission redelivery", 2, 1, after, "read persisted opening_turn; succeeded job was not reclaimed");
  });

  it("does not reclaim stale running work; recovery preserves settled spend and fences late writeback", async () => {
    const t = await newTurn();
    const repo = createOpeningTutorJobsRepository(f.sql);
    let pauseWriteback!: () => void;
    let resumeWriteback!: () => void;
    const atWriteback = new Promise<void>((resolve) => { pauseWriteback = resolve; });
    const resumed = new Promise<void>((resolve) => { resumeWriteback = resolve; });
    // The real handler claims queued work and settles the call. Pause only at
    // the write boundary, modeling a worker lost after settlement, before SQL.
    const first = tutor({ completeTurn: async (input) => {
      pauseWriteback();
      await resumed;
      await repo.completeTurn(input);
    } });
    const inFlight = first.run(t.jobId);
    try {
      await Promise.race([atWriteback, inFlight.then(() => { throw new Error("handler did not reach writeback"); })]);
      expect(first.provider.complete).toHaveBeenCalledTimes(1);
      const before = await ledger();
      const ref = await f.sql`SELECT state, result_ref FROM opening_budget_reservations WHERE request_id=${`tutor:${t.jobId}`}`;
      expect(ref[0]).toEqual({ state: "completed", result_ref: `opening_turn:${t.assistantTurnId}` });
      const aged = await f.sql`UPDATE opening_tutor_jobs SET updated_at = now() - interval '10 minutes'
        WHERE id=${t.jobId} AND status='running' RETURNING claim_token`;
      expect(aged).toHaveLength(1);
      expect(aged[0]!.claim_token).toEqual(expect.any(String));
      const second = tutor();
      await expect(second.run(t.jobId)).resolves.toEqual({ skipped: true });
      expect(await repo.recoverExpired()).toBe(1);
      await expect(second.run(t.jobId)).resolves.toEqual({ skipped: true });
      expect(await t.replaySubmission()).toEqual({ turnId: t.turnId, jobId: t.jobId, assistantTurnId: t.assistantTurnId });
      expect(await repo.get(f.scope, t.jobId)).toMatchObject({ status: "outcome_unknown" });
      const turn = await repo.loadReplayedTurn(f.scope, `opening_turn:${t.assistantTurnId}`);
      expect(turn?.status).toBe("outcome_unknown");
      expect(second.provider.complete).not.toHaveBeenCalled();
      expect(await ledger()).toEqual(before);

      resumeWriteback();
      await inFlight;
      expect(await repo.get(f.scope, t.jobId)).toMatchObject({ status: "outcome_unknown" });
      expect(await repo.loadReplayedTurn(f.scope, `opening_turn:${t.assistantTurnId}`)).toEqual(turn);
      const after = await ledger();
      expect(after).toEqual(before);
      record("tutor-turn settled before interrupted writeback", 3, 1, after, "stale running skipped; recovered outcome_unknown; late write fenced; no re-send");
    } finally {
      resumeWriteback();
      await inFlight;
    }
  });

  it("keeps a thrown writeback failure terminal instead of inventing a recoverable retry", async () => {
    const t = await newTurn();
    const first = tutor({ completeTurn: async () => { throw new Error("write-back failed"); } });
    await expect(first.run(t.jobId)).rejects.toThrow("write-back failed");
    const before = await ledger();
    const repo = createOpeningTutorJobsRepository(f.sql);
    expect(await repo.get(f.scope, t.jobId)).toMatchObject({ status: "failed" });
    expect(await repo.recoverExpired()).toBe(0);
    expect(await t.replaySubmission()).toEqual({ turnId: t.turnId, jobId: t.jobId, assistantTurnId: t.assistantTurnId });
    const second = tutor();
    await expect(second.run(t.jobId)).resolves.toEqual({ skipped: true });
    expect(first.provider.complete).toHaveBeenCalledTimes(1);
    expect(second.provider.complete).not.toHaveBeenCalled();
    const after = await ledger();
    expect(after).toEqual(before);
    const job = await f.sql`SELECT status FROM opening_tutor_jobs WHERE id=${t.jobId}`;
    const turn = await f.sql`SELECT status FROM opening_turns WHERE id=${t.assistantTurnId}`;
    expect(job[0]!.status).toBe("failed");
    expect(turn[0]!.status).not.toBe("complete");
    record("tutor-turn settled writeback failure", 2, 1, after, "failed job remains terminal; settled result unavailable; no re-send");
  });

  it("loadReplayedTurn is scope-bound", async () => {
    const t = await newTurn();
    const repo = createOpeningTutorJobsRepository(f.sql);
    expect(await repo.loadReplayedTurn(f.scope, `opening_turn:${t.assistantTurnId}`)).toMatchObject({ id: t.assistantTurnId });
    expect(await repo.loadReplayedTurn(f.otherScope, `opening_turn:${t.assistantTurnId}`)).toBeNull();
    expect(await repo.loadReplayedTurn(f.scope, "teaching_activity:x")).toBeNull();
  });
});

describe("compile-teaching-unit completed replay", () => {
  const ACTIVITY = randomUUID();
  function compile(statusStore: Map<string, TeachingGenerateStatus>) {
    const provider = { complete: vi.fn(async () => output("{}")) };
    const publishActivitySpec = vi.fn(async () => ({ id: "spec" }));
    const loadReplayedResult = vi.fn(async (_scope: unknown, resultRef: string) => {
      const id = resultRef.replace(/^teaching_activity:/, "");
      const s = statusStore.get(id);
      return s ? { activityId: id, generateStatus: s } : null;
    });
    const run = createCompileTeachingUnitHandler({
      budget: createOpeningBudgetRepository(f.sql, { envCapCents: 100_000 }),
      provider,
      reservedCents: 100,
      setGenerateStatus: async (_scope, id, status, options) => {
        const cur = statusStore.get(id) ?? "queued";
        if (options?.from && !options.from.includes(cur)) return false;
        statusStore.set(id, status);
        return true;
      },
      publishActivitySpec,
      loadReplayedResult,
      getJobState: async () => "running",
    });
    return { run, provider, publishActivitySpec, loadReplayedResult };
  }
  const job = (): OpeningJobRecord => ({
    id: "00000000-0000-4000-8000-0000000000j1", workspaceId: f.scope.workspaceId, ownerUserId: f.scope.ownerUserId,
    key: "k", kind: "compile-teaching-unit", payload: {}, result: null, state: "running", privacyEpoch: 0,
  });
  const payload = { mode: "generate" as const, activityId: ACTIVITY, teachingUnitId: randomUUID(), expectedContentVersion: 0, clientKey: "client-key-01", sourceIds: [] };

  it("loads the persisted activity via resultRef: no provider call, no publish, no new charge", async () => {
    const store = new Map<string, TeachingGenerateStatus>([[ACTIVITY, "queued"]]);
    const first = compile(store);
    await first.run(job(), payload);
    expect(first.provider.complete).toHaveBeenCalledTimes(1);
    expect(store.get(ACTIVITY)).toBe("needs_check");
    const before = await ledger();
    const second = compile(store);
    await expect(second.run(job(), payload)).resolves.toEqual({ replayed: true, activityId: ACTIVITY, generateStatus: "needs_check" });
    expect(second.loadReplayedResult).toHaveBeenCalledWith(expect.anything(), `teaching_activity:${ACTIVITY}`);
    expect(second.provider.complete).not.toHaveBeenCalled();
    expect(second.publishActivitySpec).not.toHaveBeenCalled();
    const after = await ledger();
    expect(after).toEqual(before);
    record("compile-teaching-unit completed replay (result persisted)", 2, 1, after, "loaded teaching_activity via resultRef");
  });

  it("result settled but not persisted: no re-send, status unknown, non-retryable error", async () => {
    const store = new Map<string, TeachingGenerateStatus>([[ACTIVITY, "queued"]]);
    const first = compile(store);
    first.publishActivitySpec.mockImplementationOnce(async () => { throw new Error("publish failed"); });
    await expect(first.run(job(), payload)).rejects.toThrow("publish failed");
    store.set(ACTIVITY, "generating");
    const before = await ledger();
    const second = compile(store);
    await expect(second.run(job(), payload)).rejects.toMatchObject({ code: "BUDGET_REPLAY_RESULT_MISSING" });
    expect(second.provider.complete).not.toHaveBeenCalled();
    expect(store.get(ACTIVITY)).toBe("unknown");
    const after = await ledger();
    expect(after).toEqual(before);
    record("compile-teaching-unit completed replay (result missing)", 2, 1, after, "status unknown; BUDGET_REPLAY_RESULT_MISSING");
  });
});
