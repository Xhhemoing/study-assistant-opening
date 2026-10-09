import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpeningProvider } from "@aistudy/ai";
import {
  createOpeningBudgetRepository,
  createOpeningMemoryRepository,
  createOpeningPrivacyRepository,
  createOpeningSourceChunksRepository,
  createOpeningTutorJobsRepository,
} from "@aistudy/database";
import { createTutorTurnHandler } from "../../apps/worker/src/jobs/tutor-turn";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import {
  awaitAllSettled, closeRace, holdRow, openRaceSession, track, waitUntilBlocked,
  type RaceSession, type RowHold,
} from "./opening-race-helpers";
import { providerBody, RATES, SECRET_ANSWER, seedWorkerRace } from "./opening-worker-race-fixture";

/** RP2: real Postgres + handler + provider. Only fetch is a promise barrier. */
let fixture: OpeningFixture;
let gate: RaceSession;
let observer: RaceSession;

beforeAll(async () => {
  fixture = await createOpeningFixture();
  gate = await openRaceSession().ready;
  observer = await openRaceSession().ready;
});
beforeEach(async () => {
  await fixture.reset();
  await fixture.sql`TRUNCATE opening_learning_observations, opening_help_exposures, opening_problem_refs, opening_learning_sessions, opening_privacy_exclusions, opening_memories RESTART IDENTITY CASCADE`;
  await fixture.sql`UPDATE workspaces SET privacy_epoch = 0 WHERE id = ${fixture.scope.workspaceId}`;
});
afterAll(async () => {
  await closeRace(observer?.sql);
  await closeRace(gate?.sql);
  await fixture?.close();
});

function barrierFetch(chunkId: string) {
  let release: () => void = () => undefined;
  const releasePromise = new Promise<void>((resolve) => { release = resolve; });
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    calls.push(String(init?.body ?? ""));
    await releasePromise;
    return new Response(providerBody(chunkId), { status: 200 });
  });
  return { calls, fetchImpl: fetchImpl as typeof fetch, release: () => release() };
}

function handler(sql: Parameters<typeof createOpeningTutorJobsRepository>[0], fetchImpl: typeof fetch) {
  return createTutorTurnHandler({
    tutorJobs: createOpeningTutorJobsRepository(sql),
    chunks: createOpeningSourceChunksRepository(sql),
    budget: createOpeningBudgetRepository(sql, { envCapCents: 100_000_000 }),
    provider: createOpeningProvider({
      baseUrl: "https://offline.invalid", apiKey: "fake", model: "fake", fetchImpl,
    }),
    privacy: createOpeningPrivacyRepository(sql),
    config: { maxContextCharacters: 12_000, reservedCents: 100, maxOutputTokens: 256, ...RATES },
  });
}

describe("opening worker privacy race (handler/repository)", () => {
  it("fails the real job when delete commits after the model returns", async () => {
    const seeded = await seedWorkerRace(fixture);
    const writer = openRaceSession();
    const deleteSql = openRaceSession();
    const barrier = barrierFetch(seeded.chunkId);
    let held: RowHold | undefined;
    const inFlight: Promise<unknown>[] = [];
    try {
      const { pid: writerPid } = await writer.ready;
      const { pid: deletePid } = await deleteSql.ready;
      const realJobs = createOpeningTutorJobsRepository(writer.sql);
      const realMemories = createOpeningMemoryRepository(deleteSql.sql);
      held = holdRow(gate.sql, "opening_memories", seeded.memoryId);
      await held.opened;
      const processed = track(handler(writer.sql, barrier.fetchImpl)(seeded.jobId));
      inFlight.push(processed);
      await vi.waitFor(() => expect(barrier.calls).toHaveLength(1), { timeout: 5_000, interval: 40 });
      expect(barrier.calls[0]).toContain(seeded.chunkId);
      const deleted = track(realMemories.deleteMemory(fixture.scope, {
        id: seeded.memoryId, expectedVersion: seeded.memoryVersion,
        deleteSourceText: false, clientKey: "rp2-delete",
      }));
      inFlight.push(deleted);
      await waitUntilBlocked(observer.sql, deletePid, gate.pid, "deleteMemory", /FROM opening_memories[\s\S]*FOR UPDATE/i);
      const epoch = await observer.sql<{ privacy_epoch: number }[]>`
        SELECT privacy_epoch FROM workspaces WHERE id = ${fixture.scope.workspaceId}`;
      expect(Number(epoch[0]?.privacy_epoch)).toBe(0);
      barrier.release();
      await waitUntilBlocked(observer.sql, writerPid, deletePid, "completeTurn", /opening_workspace_history_revisions|FROM workspaces[\s\S]*FOR UPDATE/i);
      held.release();
      const gateDone = held.done;
      held = undefined;
      await gateDone;
      await expect(deleted).resolves.toMatchObject({ privacyEpoch: 1, excludedSourceIds: [seeded.sourceId] });
      await expect(processed).rejects.toThrow(/privacy epoch drift/);
      const again = await handler(writer.sql, barrier.fetchImpl)(seeded.jobId);
      expect(again).toEqual({ skipped: true });
      expect(barrier.calls).toHaveLength(1);
      const job = await realJobs.get(fixture.scope, seeded.jobId);
      const turn = await fixture.sql<{ status: string; text: string; citations: unknown[] }[]>`
        SELECT status, text, citations FROM opening_turns WHERE id = ${seeded.assistantTurnId}`;
      const candidates = await fixture.sql`SELECT id FROM opening_assistant_candidates WHERE source_turn_id = ${seeded.assistantTurnId}`;
      const exposures = await fixture.sql`SELECT id FROM opening_help_exposures WHERE session_id = ${seeded.sessionId}`;
      const memory = await fixture.sql<{ status: string }[]>`SELECT status FROM opening_memories WHERE id = ${seeded.memoryId}`;
      const exclusions = await fixture.sql`SELECT source_id FROM opening_privacy_exclusions WHERE memory_id = ${seeded.memoryId}`;
      const budget = await fixture.sql<{ state: string; amount_cents: number }[]>`
        SELECT state, amount_cents FROM opening_budget_reservations WHERE request_id = ${`tutor:${seeded.jobId}`}`;
      expect(job?.status).toBe("failed");
      expect(job?.error?.message).toMatch(/privacy epoch drift/);
      expect(turn[0]?.status).toBe("failed");
      expect(turn[0]?.text).toMatch(/privacy epoch drift/);
      expect(turn[0]?.text).not.toContain(SECRET_ANSWER);
      expect(turn[0]?.citations).toEqual([]);
      expect(candidates).toHaveLength(0);
      expect(exposures).toHaveLength(0);
      expect(memory[0]?.status).toBe("deleted");
      expect(exclusions).toEqual([{ source_id: seeded.sourceId }]);
      expect(budget).toHaveLength(1);
      expect(budget[0]?.state).toBe("completed");
      expect(Number(budget[0]?.amount_cents)).toBe(28);
    } finally {
      barrier.release();
      held?.release();
      if (held) inFlight.push(held.done);
      await awaitAllSettled(inFlight);
      await Promise.all([closeRace(writer.sql), closeRace(deleteSql.sql)]);
    }
  }, 25_000);
});
