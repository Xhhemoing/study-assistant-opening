import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOpeningMemoryRepository,
  OpeningMemoryError,
} from "@aistudy/database";
import { memoriesForContext } from "@aistudy/domain";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { closeRace, openRaceSession, track } from "./opening-race-helpers";
import { lockWorkspaceLearningHistory } from "../../packages/database/src/repositories/opening-learning-facts";
import { applyAssistantProposal, proposalTransactionClient } from "../../packages/database/src/repositories/opening-assistant-proposal-effects";

let fixture: OpeningFixture;
let memories: ReturnType<typeof createOpeningMemoryRepository>;

async function insertTurn(
  workspaceId: string,
  ownerUserId: string,
  turnId = randomUUID(),
): Promise<string> {
  const conversationId = randomUUID();
  await fixture.sql`
    INSERT INTO opening_conversations (id, workspace_id, owner_user_id, title)
    VALUES (${conversationId}, ${workspaceId}, ${ownerUserId}, 'admission')`;
  await fixture.sql`
    INSERT INTO opening_turns (
      id, workspace_id, conversation_id, role, text, mode, status
    ) VALUES (
      ${turnId}, ${workspaceId}, ${conversationId}, 'user', 'owned turn', 'explain', 'complete'
    )`;
  return turnId;
}

beforeAll(async () => {
  fixture = await createOpeningFixture();
  memories = createOpeningMemoryRepository(fixture.sql);
});

beforeEach(async () => {
  await fixture.reset();
  await fixture.sql`TRUNCATE opening_memories, opening_turns, opening_conversations RESTART IDENTITY CASCADE`;
  await fixture.sql`DELETE FROM opening_workspace_history_revisions
    WHERE workspace_id IN (${fixture.scope.workspaceId}, ${fixture.otherScope.workspaceId})`;
});

afterAll(async () => {
  await fixture?.close();
});

describe("opening memory owner and source admission", () => {
  it("rejects a same-workspace impostor on list, get, propose, and reject", async () => {
    const turnId = await insertTurn(fixture.scope.workspaceId, fixture.scope.ownerUserId);
    const owned = await memories.proposeMemory(fixture.scope, {
      text: "owned candidate",
      sourceTurnIds: [turnId],
      expiresAt: null,
    });
    const impostor = {
      workspaceId: fixture.scope.workspaceId,
      ownerUserId: fixture.otherScope.ownerUserId,
    };

    await expect(memories.list(impostor)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(memories.get(impostor, owned.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      memories.proposeMemory(impostor, {
        text: "forged",
        sourceTurnIds: [turnId],
        expiresAt: null,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      memories.reject(impostor, owned.id, owned.version, "reject-impostor"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const still = await memories.get(fixture.scope, owned.id);
    expect(still?.status).toBe("active");
    expect(still?.kind).toBe("candidate");
  });

  it("rejects missing and foreign source turns without writing a row", async () => {
    const before = await fixture.sql`
      SELECT count(*)::int AS n FROM opening_memories WHERE workspace_id = ${fixture.scope.workspaceId}`;
    await expect(
      memories.proposeMemory(fixture.scope, {
        text: "missing source",
        sourceTurnIds: [randomUUID()],
        expiresAt: null,
      }),
    ).rejects.toBeInstanceOf(OpeningMemoryError);

    const foreignTurn = await insertTurn(
      fixture.otherScope.workspaceId,
      fixture.otherScope.ownerUserId,
    );
    await expect(
      memories.proposeMemory(fixture.scope, {
        text: "foreign source",
        sourceTurnIds: [foreignTurn],
        expiresAt: null,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    const after = await fixture.sql`
      SELECT count(*)::int AS n FROM opening_memories WHERE workspace_id = ${fixture.scope.workspaceId}`;
    expect(after[0]?.n).toBe(before[0]?.n);
  });

  it("confirms an owned-turn memory into domain context and keeps source-less confirms display-only", async () => {
    const turnId = await insertTurn(fixture.scope.workspaceId, fixture.scope.ownerUserId);
    const sourced = await memories.proposeMemory(fixture.scope, {
      text: "from my turn",
      sourceTurnIds: [turnId],
      expiresAt: null,
    });
    const confirmed = await memories.confirm(
      fixture.scope,
      sourced.id,
      sourced.version,
      "confirm-owned-1",
    );
    expect(confirmed.kind).toBe("confirmed");

    const manual = await memories.proposeMemory(fixture.scope, {
      text: "manual note",
      sourceTurnIds: [],
      expiresAt: null,
    });
    const manualConfirmed = await memories.confirm(
      fixture.scope,
      manual.id,
      manual.version,
      "confirm-manual-1",
    );
    expect(manualConfirmed.kind).toBe("confirmed");
    expect(manualConfirmed.sourceTurnIds).toEqual([]);

    const now = "2099-01-01T00:00:00.000Z";
    const listed = await memories.list(fixture.scope);
    expect(listed.map((item) => item.id).sort()).toEqual([confirmed.id, manualConfirmed.id].sort());
    expect(memoriesForContext(listed, now).map((item) => item.id)).toEqual([confirmed.id]);
  });

  it("rejects a courseId that is not a course in the owned workspace", async () => {
    const foreignCourse = randomUUID();
    await fixture.sql`
      INSERT INTO courses (id, workspace_id, title, slug)
      VALUES (${foreignCourse}, ${fixture.otherScope.workspaceId}, 'other', ${`slug-${foreignCourse}`})`;
    await expect(
      memories.proposeMemory(fixture.scope, {
        text: "wrong course",
        sourceTurnIds: [],
        expiresAt: null,
        courseId: foreignCourse,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    const rows = await fixture.sql`
      SELECT count(*)::int AS n FROM opening_memories
      WHERE workspace_id = ${fixture.scope.workspaceId} AND text = 'wrong course'`;
    expect(rows[0]?.n).toBe(0);
  });

  it("rolls back the locked insert when the transaction fails after the row write", async () => {
    await fixture.sql`
      CREATE OR REPLACE FUNCTION opening_memory_abort_probe() RETURNS trigger AS $$
      BEGIN
        IF NEW.text = 'abort after insert' THEN
          RAISE EXCEPTION 'abort proposal after insert';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`;
    await fixture.sql`
      CREATE TRIGGER opening_memory_abort_probe
      AFTER INSERT ON opening_memories
      FOR EACH ROW EXECUTE FUNCTION opening_memory_abort_probe()`;
    try {
      await expect(
        memories.proposeMemory(fixture.scope, {
          text: "abort after insert",
          sourceTurnIds: [],
          expiresAt: null,
        }),
      ).rejects.toThrow(/abort proposal after insert/);
      const rows = await fixture.sql`
        SELECT count(*)::int AS n FROM opening_memories
        WHERE workspace_id = ${fixture.scope.workspaceId} AND text = 'abort after insert'`;
      expect(rows[0]?.n).toBe(0);
    } finally {
      await fixture.sql`DROP TRIGGER IF EXISTS opening_memory_abort_probe ON opening_memories`;
      await fixture.sql`DROP FUNCTION IF EXISTS opening_memory_abort_probe()`;
    }
  });
});

const nativeWriters = ["propose", "confirm", "reject"] as const;
const proposal = { text: "native proposal", sourceTurnIds: [], expiresAt: null };

async function seedMemory() {
  // Seed the old graph without going through a writer that may create history.
  const id = randomUUID();
  await fixture.sql`INSERT INTO opening_memories(id,workspace_id,kind,text,source_turn_ids,status)
    VALUES (${id},${fixture.scope.workspaceId},'candidate','old graph','[]'::jsonb,'active')`;
  return id;
}

async function memoryGraph() {
  return fixture.sql`SELECT * FROM opening_memories
    WHERE workspace_id=${fixture.scope.workspaceId} ORDER BY id`;
}

async function historyGraph() {
  return fixture.sql`SELECT * FROM opening_workspace_history_revisions
    WHERE workspace_id IN (${fixture.scope.workspaceId},${fixture.otherScope.workspaceId}) ORDER BY workspace_id`;
}

for (const writer of nativeWriters) {
  it(`${writer} waits on history before business locks and leaves the old graph visible`, async () => {
    const id = await seedMemory();
    await fixture.sql`INSERT INTO opening_workspace_history_revisions(workspace_id,owner_user_id,revision)
      VALUES (${fixture.scope.workspaceId},${fixture.scope.ownerUserId},17)`;
    const oldMemories = await memoryGraph(), oldHistory = await historyGraph();
    const holder = openRaceSession(), waiter = openRaceSession();
    let release = () => {};
    const released = new Promise<void>(resolve => { release = resolve; });
    let entered = () => {};
    const locked = new Promise<void>(resolve => { entered = resolve; });
    const pending: Promise<unknown>[] = [];
    let settled = false;
    try {
      await Promise.all([holder.ready, waiter.ready]);
      const held = track(holder.sql.begin(async tx => {
        await lockWorkspaceLearningHistory(tx, fixture.scope);
        entered();
        await released;
      }));
      pending.push(held);
      await locked;
      const repo = createOpeningMemoryRepository(waiter.sql);
      const write = track(writer === "propose" ? repo.proposeMemory(fixture.scope, proposal)
        : repo[writer](fixture.scope, id, 0, `${writer}-barrier`));
      write.then(() => { settled = true; }, () => { settled = true; });
      pending.push(write);
      // Stop immediately if the unfenced baseline commits instead of waiting.
      let waiting = false;
      await vi.waitFor(async () => {
        const [row] = await fixture.sql`SELECT EXISTS (
          SELECT 1 FROM pg_locks WHERE pid=${waiter.pid} AND NOT granted
            AND ${holder.pid}=ANY(pg_blocking_pids(pid))) AS blocked,
          (SELECT query FROM pg_stat_activity WHERE pid=${waiter.pid}) AS query`;
        waiting = Boolean(row?.blocked) && /opening_workspace_history_revisions/.test(String(row?.query));
        if (!waiting && !settled) throw new Error("native writer has not reached history yet");
      }, { timeout: 1500, interval: 20 });
      expect(waiting, "writer must block on the history holder, not commit unfenced").toBe(true);
      // NOWAIT proves the blocked writer owns neither business row lock.
      await fixture.sql.begin(async tx => {
        await tx`SELECT id FROM workspaces WHERE id=${fixture.scope.workspaceId} FOR UPDATE NOWAIT`;
        await tx`SELECT id FROM opening_memories WHERE id=${id} FOR UPDATE NOWAIT`;
      });
      expect(await memoryGraph()).toEqual(oldMemories);
      expect(await historyGraph()).toEqual(oldHistory);
      // A different workspace progresses while this history row is held.
      await memories.proposeMemory(fixture.otherScope, { ...proposal, text: "other workspace" });
      release();
      await Promise.all([held, write]);
      const [stored] = await fixture.sql`SELECT * FROM opening_memories WHERE id=${id}`;
      if (writer === "propose") expect(await memoryGraph()).toHaveLength(2);
      else expect(stored).toMatchObject(writer === "confirm"
        ? { kind: "confirmed", status: "active", version: 1 }
        : { kind: "candidate", status: "rejected", version: 1 });
      const [history] = await fixture.sql`SELECT revision FROM opening_workspace_history_revisions
        WHERE workspace_id=${fixture.scope.workspaceId}`;
      expect(Number(history?.revision)).toBe(17);
    } finally {
      release();
      await Promise.allSettled(pending);
      await Promise.all([closeRace(holder.sql), closeRace(waiter.sql)]);
    }
  });

  it(`${writer} lazily creates revision zero without advancing and preserves typed owner denial`, async () => {
    const id = await seedMemory();
    const impostor = { ...fixture.scope, ownerUserId: fixture.otherScope.ownerUserId };
    const old = await memoryGraph();
    const denied = writer === "propose" ? memories.proposeMemory(impostor, proposal)
      : memories[writer](impostor, id, 0, "denied");
    await expect(denied).rejects.toBeInstanceOf(OpeningMemoryError);
    await expect(denied).rejects.toMatchObject({ code: "NOT_FOUND", message: "workspace not found" });
    expect(await historyGraph()).toEqual([]);
    expect(await memoryGraph()).toEqual(old);
    const result = writer === "propose" ? await memories.proposeMemory(fixture.scope, proposal)
      : await memories[writer](fixture.scope, id, 0, "lazy");
    expect(result.status).toBe(writer === "reject" ? "rejected" : "active");
    const rows = await historyGraph();
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.revision)).toBe(0);
  });
}

it("keeps decision replay before version checks and stale/state protections without history advance", async () => {
  const id = await seedMemory();
  const confirmed = await memories.confirm(fixture.scope, id, 0, "confirm");
  expect(await memories.confirm(fixture.scope, id, 0, "confirm")).toEqual(confirmed);
  await expect(memories.confirm(fixture.scope, id, 0, "new")).rejects.toMatchObject({ message: "stale memory version" });
  await expect(memories.confirm(fixture.scope, id, 1, "new")).rejects.toMatchObject({ message: "memory cannot be confirmed" });
  const rejected = await memories.reject(fixture.scope, id, 1, "reject");
  expect(await memories.reject(fixture.scope, id, 1, "reject")).toEqual(rejected);
  await expect(memories.reject(fixture.scope, id, 1, "new")).rejects.toMatchObject({ message: "stale memory version" });
  await expect(memories.reject(fixture.scope, id, 2, "new")).rejects.toMatchObject({ message: "memory cannot be rejected" });
  await expect(memories.confirm(fixture.scope, id, 2, "new")).rejects.toMatchObject({ message: "memory cannot be confirmed" });
  expect(Number((await historyGraph())[0]?.revision)).toBe(0);
});

it("preserves trimmed rejected equivalence with unordered sources and source/course error precedence", async () => {
  const a = await insertTurn(fixture.scope.workspaceId, fixture.scope.ownerUserId);
  const b = await insertTurn(fixture.scope.workspaceId, fixture.scope.ownerUserId);
  const candidate = await memories.proposeMemory(fixture.scope, { ...proposal, text: "rejected", sourceTurnIds: [a, b] });
  await memories.reject(fixture.scope, candidate.id, 0, "reject-equivalent");
  const old = await memoryGraph(), history = await historyGraph();
  await expect(memories.proposeMemory(fixture.scope, { ...proposal, text: " rejected ", sourceTurnIds: [b, a] }))
    .rejects.toMatchObject({ code: "CONFLICT", message: "equivalent proposal was rejected" });
  await expect(memories.proposeMemory(fixture.scope, { ...proposal, sourceTurnIds: [randomUUID()], courseId: randomUUID() }))
    .rejects.toMatchObject({ code: "VALIDATION", message: "source turns must belong to an owned conversation" });
  await expect(memories.proposeMemory(fixture.scope, { ...proposal, courseId: randomUUID() }))
    .rejects.toMatchObject({ code: "VALIDATION", message: "course is not in this workspace" });
  expect(await memoryGraph()).toEqual(old);
  expect(await historyGraph()).toEqual(history);
  await memories.proposeMemory(fixture.scope, { ...proposal, text: "rejected", sourceTurnIds: [a] });
});

it("reenters held history/business locks through actual proposal effects and rolls back the outer graph", async () => {
  const turnId = await insertTurn(fixture.scope.workspaceId, fixture.scope.ownerUserId);
  const id = await seedMemory();
  const old = await memoryGraph(), history = await historyGraph();
  await expect(fixture.sql.begin(async tx => {
    await lockWorkspaceLearningHistory(tx, fixture.scope);
    await tx`SELECT id FROM workspaces WHERE id=${fixture.scope.workspaceId} FOR UPDATE`;
    await tx`SELECT id FROM opening_memories WHERE id=${id} FOR UPDATE`;
    const result = await applyAssistantProposal(tx, fixture.scope, {
      sourceTurnId: turnId, clientKey: "nested-proposal",
      tool: { name: "propose_memory", arguments: { text: "nested accepted memory" } },
    }, null, [], randomUUID());
    expect(result.kind).toBe("memory");
    const repo = createOpeningMemoryRepository(proposalTransactionClient(tx));
    await repo.reject(fixture.scope, id, 0, "nested-reject");
    // Actual SQL failure rolls back only its savepoint; the outer tx remains usable.
    await expect(repo.proposeMemory(fixture.scope, { ...proposal, courseId: "not-a-uuid" }))
      .rejects.toMatchObject({ code: "22P02" });
    const rows = await tx`SELECT id,kind,status FROM opening_memories WHERE workspace_id=${fixture.scope.workspaceId}`;
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: result.id, kind: "confirmed", status: "active" }),
      expect.objectContaining({ id, kind: "candidate", status: "rejected" }),
    ]));
    // Fail in PostgreSQL after all three native writers released their savepoints.
    await tx`SELECT 1 / 0`;
  })).rejects.toMatchObject({ code: "22012" });
  expect(await memoryGraph()).toEqual(old);
  expect(await historyGraph()).toEqual(history);
});
