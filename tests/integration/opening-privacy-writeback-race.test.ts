import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createOpeningMemoryRepository,
  createOpeningTutorJobsRepository,
} from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import {
  awaitAllSettled,
  closeRace,
  holdRow,
  openRaceSession,
  track,
  waitUntilBlocked,
  type RaceSession,
  type RowHold,
} from "./opening-race-helpers";

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

async function seedRace() {
  const ids = {
    conversationId: randomUUID(), userTurnId: randomUUID(), assistantTurnId: randomUUID(),
    jobId: randomUUID(), memoryId: randomUUID(), sessionId: randomUUID(), exposureId: randomUUID(), courseId: randomUUID(),
  };
  const scope = fixture.scope;
  await fixture.sql`INSERT INTO courses (id, workspace_id, title, slug)
    VALUES (${ids.courseId}, ${scope.workspaceId}, 'race course', ${ids.courseId})`;
  await fixture.sql`
    INSERT INTO opening_conversations (id, workspace_id, owner_user_id, title)
    VALUES (${ids.conversationId}, ${scope.workspaceId}, ${scope.ownerUserId}, 'race')`;
  await fixture.sql`
    INSERT INTO opening_turns (id, workspace_id, conversation_id, role, text, mode, status, citations)
    VALUES
      (${ids.userTurnId}, ${scope.workspaceId}, ${ids.conversationId}, 'user', 'question', 'explain', 'complete', '[]'::jsonb),
      (${ids.assistantTurnId}, ${scope.workspaceId}, ${ids.conversationId}, 'assistant', '', 'explain', 'pending', '[]'::jsonb)`;
  await fixture.sql`
    INSERT INTO opening_tutor_jobs
      (id, workspace_id, conversation_id, user_turn_id, assistant_turn_id, status, mode)
    VALUES (
      ${ids.jobId}, ${scope.workspaceId}, ${ids.conversationId},
      ${ids.userTurnId}, ${ids.assistantTurnId}, 'running', 'explain')`;
  await fixture.sql`
    INSERT INTO opening_memories (id, workspace_id, kind, text, source_turn_ids, version, status)
    VALUES (${ids.memoryId}, ${scope.workspaceId}, 'candidate', 'secret memory', '[]'::jsonb, 0, 'active')`;
  await fixture.sql`
    INSERT INTO opening_learning_sessions
      (id, workspace_id, owner_user_id, course_id, skill_label, source_ids)
    VALUES (${ids.sessionId}, ${scope.workspaceId}, ${scope.ownerUserId}, ${ids.courseId}, 'race', '{}'::uuid[])`;
  await fixture.sql`UPDATE opening_turns SET learning_session_id=${ids.sessionId}
    WHERE id IN (${ids.userTurnId},${ids.assistantTurnId})`;
  return ids;
}

function raceRows(ids: Awaited<ReturnType<typeof seedRace>>) {
  return Promise.all([
    fixture.sql`SELECT status, text, citations FROM opening_turns WHERE id = ${ids.assistantTurnId}`,
    fixture.sql`SELECT id FROM opening_assistant_candidates WHERE source_turn_id = ${ids.assistantTurnId}`,
    fixture.sql`SELECT id FROM opening_help_exposures WHERE id = ${ids.exposureId}`,
  ]);
}

function turnInput(ids: Awaited<ReturnType<typeof seedRace>>): Parameters<
  ReturnType<typeof createOpeningTutorJobsRepository>["completeTurn"]
>[0] {
  const citation = { chunkId: randomUUID(), sourceId: randomUUID(), sourceVersion: 1, label: "race citation" };
  return {
    scope: fixture.scope, jobId: ids.jobId, assistantTurnId: ids.assistantTurnId,
    text: "answer that must not leak early", citations: [citation], expectedPrivacyEpoch: 0,
    candidates: [{ payload: { kind: "memory", text: "candidate leak", temporary: false }, sourceIds: [] }],
    helpExposure: {
      id: ids.exposureId, sessionId: ids.sessionId, problemId: null,
      turnId: ids.assistantTurnId, level: "hinted", delivered: true,
    },
  };
}

async function finishRace(
  held: RowHold | undefined,
  pending: Promise<unknown>[],
  sessions: Array<RaceSession & { ready: Promise<RaceSession> }>,
): Promise<void> {
  held?.release();
  if (held) pending.push(held.done);
  await awaitAllSettled(pending);
  const closed = await Promise.allSettled(sessions.map((session) => closeRace(session.sql)));
  const failed = closed.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}

describe("opening privacy writeback true overlap", () => {
  it("delete holds the workspace lock, then completeTurn rolls back on epoch drift", async () => {
    const ids = await seedRace();
    const writer = openRaceSession();
    const deleteSql = openRaceSession();
    let held: RowHold | undefined;
    const inFlight: Promise<unknown>[] = [];
    try {
      const writerSession = await writer.ready;
      const deleteSession = await deleteSql.ready;
      const realJobs = createOpeningTutorJobsRepository(writerSession.sql);
      const realMemories = createOpeningMemoryRepository(deleteSession.sql);
      held = holdRow(gate.sql, "opening_memories", ids.memoryId);
      await held.opened;
      const deleted = track(realMemories.deleteMemory(fixture.scope, {
        id: ids.memoryId, expectedVersion: 0, deleteSourceText: false, clientKey: "race-del",
      }));
      inFlight.push(deleted);
      await waitUntilBlocked(observer.sql, deleteSession.pid, gate.pid, "deleteMemory", /FROM opening_memories[\s\S]*FOR UPDATE/i);
      const completed = track(realJobs.completeTurn(turnInput(ids)));
      inFlight.push(completed);
      await waitUntilBlocked(observer.sql, writerSession.pid, deleteSession.pid, "completeTurn", /opening_workspace_history_revisions|FROM workspaces[\s\S]*FOR UPDATE/i);
      held.release();
      const gateDone = held.done;
      held = undefined;
      await gateDone;
      await expect(deleted).resolves.toMatchObject({ privacyEpoch: 1 });
      await expect(completed).rejects.toThrow(/privacy epoch drift/);
      const job = await realJobs.get(fixture.scope, ids.jobId);
      const memory = await fixture.sql`SELECT status FROM opening_memories WHERE id = ${ids.memoryId}`;
      const epoch = await fixture.sql`SELECT privacy_epoch FROM workspaces WHERE id = ${fixture.scope.workspaceId}`;
      const [turn, candidates, exposures] = await raceRows(ids);
      expect(memory[0]?.status).toBe("deleted");
      expect(Number(epoch[0]?.privacy_epoch)).toBe(1);
      expect(job?.status).toBe("running");
      expect(turn).toEqual([{ status: "pending", text: "", citations: [] }]);
      expect(candidates).toHaveLength(0);
      expect(exposures).toHaveLength(0);
    } finally {
      await finishRace(held, inFlight, [writer, deleteSql]);
    }
  }, 25_000);

  it("completeTurn commits before delete when it already holds the workspace lock", async () => {
    const ids = await seedRace();
    const writer = openRaceSession();
    const deleteSql = openRaceSession();
    let held: RowHold | undefined;
    const inFlight: Promise<unknown>[] = [];
    try {
      const writerSession = await writer.ready;
      const deleteSession = await deleteSql.ready;
      const realJobs = createOpeningTutorJobsRepository(writerSession.sql);
      const realMemories = createOpeningMemoryRepository(deleteSession.sql);
      held = holdRow(gate.sql, "opening_turns", ids.assistantTurnId);
      await held.opened;
      const completed = track(realJobs.completeTurn(turnInput(ids)));
      inFlight.push(completed);
      await waitUntilBlocked(observer.sql, writerSession.pid, gate.pid, "completeTurn", /UPDATE opening_turns SET/i);
      const waiting = await observer.sql<{ locktype: string; mode: string; granted: boolean }[]>`
        SELECT l.locktype, l.mode, l.granted FROM pg_locks l
        WHERE l.pid = ${writerSession.pid} AND NOT l.granted
          AND ${gate.pid} = ANY(pg_blocking_pids(l.pid))
      `;
      expect(waiting).toEqual([{ locktype: "transactionid", mode: "ShareLock", granted: false }]);
      const deleted = track(realMemories.deleteMemory(fixture.scope, {
        id: ids.memoryId, expectedVersion: 0, deleteSourceText: false, clientKey: "race-del-2",
      }));
      inFlight.push(deleted);
      await waitUntilBlocked(observer.sql, deleteSession.pid, writerSession.pid, "deleteMemory", /opening_workspace_history_revisions|FROM workspaces[\s\S]*FOR UPDATE/i);
      held.release();
      const gateDone = held.done;
      held = undefined;
      await gateDone;
      await expect(completed).resolves.toBeUndefined();
      await expect(deleted).resolves.toMatchObject({ privacyEpoch: 1 });
      const job = await realJobs.get(fixture.scope, ids.jobId);
      const [turn, candidates, exposures] = await raceRows(ids);
      expect(turn[0]).toMatchObject({ status: "complete", text: "answer that must not leak early" });
      expect(job?.status).toBe("succeeded");
      expect(candidates).toHaveLength(1);
      expect(exposures).toHaveLength(1);
    } finally {
      await finishRace(held, inFlight, [writer, deleteSql]);
    }
  }, 25_000);
});
