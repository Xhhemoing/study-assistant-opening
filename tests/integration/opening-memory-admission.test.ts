import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCourseMembershipRepository,
  createOpeningBudgetRepository,
  createOpeningConversationRepository,
  createOpeningMemoryRepository,
  createOpeningPrivacyRepository,
  createOpeningSourceChunksRepository,
  createOpeningTutorJobsRepository,
  OpeningMemoryError,
  withOpeningTutorStreamFenceCommit,
} from "@aistudy/database";
import { memoriesForContext } from "@aistudy/domain";
import { createTutorTurnHandler } from "../../apps/worker/src/jobs/tutor-turn";
import { createOpeningMaterialRetriever } from "../../apps/worker/src/runtime/material-retrieval";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { closeRace, openRaceSession, track } from "./opening-race-helpers";
import { lockWorkspaceLearningHistory } from "../../packages/database/src/repositories/opening-learning-facts";
import { applyAssistantProposal, proposalTransactionClient } from "../../packages/database/src/repositories/opening-assistant-proposal-effects";
import { readTurnsWithActiveMemoryDependencies } from "../../packages/database/src/repositories/opening-context-provenance";
import { insertOwnedTurn, insertSource } from "./opening-memory-context-fixture";

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
  it("proposes, confirms and lists ordinary memories within the PostgreSQL latency budget", async () => {
    const turnId = await insertTurn(fixture.scope.workspaceId, fixture.scope.ownerUserId);
    const sql = postgres(process.env.OPENING_TEST_DATABASE_URL!, { max: 1 });
    try {
      await sql`SELECT 1`;
      const repository = createOpeningMemoryRepository(sql);
      let start = performance.now();
      const sourceLess = await repository.proposeMemory(fixture.scope, { text: "Standalone note", sourceTurnIds: [], expiresAt: null });
      await expect(repository.confirm(fixture.scope, sourceLess.id, sourceLess.version, randomUUID())).resolves.toMatchObject({ kind: "confirmed" });
      await expect(repository.listForContext(fixture.scope, null)).resolves.toEqual([]);
      expect(performance.now() - start).toBeLessThan(500);

      start = performance.now();
      const memory = await repository.proposeMemory(fixture.scope, { text: "Ordinary source", sourceTurnIds: [turnId], expiresAt: null });
      await expect(repository.confirm(fixture.scope, memory.id, memory.version, randomUUID())).resolves.toMatchObject({ kind: "confirmed" });
      await expect(repository.listForContext(fixture.scope, null)).resolves.toMatchObject([{ id: memory.id, kind: "confirmed" }]);
      expect(performance.now() - start).toBeLessThan(500);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it.each(["source_ids", "context_source_refs"] as const)(
    "takes course, source and membership share locks for a same-course user origin with %s", async evidence => {
    const { sql, scope } = fixture;
    const courses = createCourseMembershipRepository(sql);
    const course = await courses.createCourse({ workspaceId: scope.workspaceId, title: "Memory locks", slug: randomUUID() });
    const sourceId = await insertSource(sql, scope);
    await courses.addAssetMembership({ workspaceId: scope.workspaceId, courseId: course.id, assetType: "source",
      assetId: sourceId, role: "core", visibility: "course", purpose: "teaching" });
    const turnId = await insertOwnedTurn(sql, scope, evidence === "source_ids"
      ? { sourceIds: [sourceId] } : { contextSourceRefs: [{ sourceId, sourceVersion: 0 }] });
    await sql`UPDATE opening_turns SET context_anchor=${sql.json({ courseId: course.id })} WHERE id=${turnId}`;
    const statements: string[] = [];
    const observed = postgres(process.env.OPENING_TEST_DATABASE_URL!, {
      max: 1, debug: (_connection, query) => statements.push(query.replace(/\s+/g, " ").trim()),
    });
    try {
      await createOpeningMemoryRepository(observed).proposeMemory(scope, {
        courseId: course.id, text: "Own course material", sourceTurnIds: [turnId], expiresAt: null,
      });
      const locks = statements.filter(query => query.endsWith("FOR SHARE"));
      const courseLock = locks.findIndex(query => query.startsWith("SELECT id FROM courses"));
      const sourceLock = locks.findIndex(query => query.startsWith("SELECT id, version FROM opening_sources"));
      const membershipLock = locks.findIndex(query => query.startsWith("SELECT id FROM course_asset_memberships"));
      expect(courseLock).toBeGreaterThanOrEqual(0);
      expect(sourceLock).toBeGreaterThan(courseLock);
      expect(membershipLock).toBeGreaterThan(sourceLock);
      expect(statements.indexOf(locks[membershipLock]!)).toBeLessThan(
        statements.findIndex(query => query.startsWith("INSERT INTO opening_memories")),
      );
    } finally {
      await observed.end({ timeout: 5 });
    }
  });

  it("admits same-course memory descendants and rejects laundering through global or other-course memory", async () => {
    const { sql, scope } = fixture;
    const courses = createCourseMembershipRepository(sql);
    const conversations = createOpeningConversationRepository(sql);
    const courseA = await courses.createCourse({ workspaceId: scope.workspaceId, title: "Memory lineage A", slug: "memory-lineage-a" });
    const courseB = await courses.createCourse({ workspaceId: scope.workspaceId, title: "Memory lineage B", slug: "memory-lineage-b" });
    const material = await insertSource(sql, scope);
    await courses.addAssetMembership({ workspaceId: scope.workspaceId, courseId: courseA.id,
      assetType: "source", assetId: material, role: "core", visibility: "course", purpose: null });
    const evidence = await insertOwnedTurn(sql, scope, { sourceIds: [material] });
    const unrelatedEvidence = await insertOwnedTurn(sql, scope, { sourceIds: [material] });
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const ancestor = await memories.proposeMemory(scope, {
      courseId: courseA.id, text: "Temporary course A ancestor", sourceTurnIds: [evidence], expiresAt,
    });
    const conversation = await conversations.create(scope, { title: "Anchored assistant lineage", courseId: null });
    const turn = await conversations.appendSavedTurn({ scope, conversationId: conversation.id,
      text: "Follow the course preference", mode: "explain", sourceIds: [], clientKey: randomUUID(),
      learningSessionId: null, currentPage: null, chunkId: null });
    await sql`UPDATE opening_turns SET context_anchor=${sql.json({ purpose: "learning_help", courseId: courseA.id })} WHERE id=${turn.turnId}`;
    const memoryRef = { sourceId: material, sourceVersion: 0, memoryOnly: true };
    const saveRefs = async (refs: Array<typeof memoryRef | { memoryDependencyIds: string[] }>) => sql`UPDATE opening_turns
      SET status='complete', context_source_refs=${sql.json(refs)} WHERE id=${turn.assistantTurnId}`;
    await saveRefs([memoryRef, { memoryDependencyIds: [ancestor.id] }]);
    const sourceTurnIds = [turn.assistantTurnId];
    const proposal = { text: "Derived course preference", sourceTurnIds, expiresAt: null };
    await expect(readTurnsWithActiveMemoryDependencies(sql, scope.workspaceId, sourceTurnIds)).resolves.toEqual(new Set(sourceTurnIds));
    for (const courseId of [null, courseB.id]) {
      await expect(memories.proposeMemory(scope, { ...proposal, courseId })).rejects.toMatchObject({ code: "VALIDATION" });
    }
    const scoped = await memories.proposeMemory(scope, { ...proposal, courseId: courseA.id });
    await expect(memories.confirm(scope, scoped.id, scoped.version, randomUUID())).resolves.toMatchObject({ courseId: courseA.id });
    const active = await memories.listContext(scope, new Date().toISOString(), courseA.id);
    expect(active.memories.map(memory => memory.id)).toEqual([ancestor.id, scoped.id]);
    expect(active).toMatchObject({ temporaryMemoryExpiresAt: expiresAt, dependencyMemoryIds: [ancestor.id] });

    const global = await memories.proposeMemory(scope, { text: "Unrelated global", sourceTurnIds: [unrelatedEvidence], expiresAt: null });
    const confirmedGlobal = await memories.confirm(scope, global.id, global.version, randomUUID());
    const replace = { text: "Corrected from the derived turn", sourceTurnIds, clientKey: randomUUID() };
    await expect(memories.replaceMemory(scope, { ...replace, id: global.id, expectedVersion: confirmedGlobal.version }))
      .rejects.toMatchObject({ code: "VALIDATION" });
    await expect(memories.replaceMemory(scope, { ...replace, id: scoped.id, expectedVersion: scoped.version + 1 }))
      .resolves.toMatchObject({ courseId: courseA.id });
    // A course-anchored legacy source reference has no attributable memory authority.
    await saveRefs([memoryRef]);
    for (const courseId of [null, courseA.id, courseB.id]) {
      await expect(memories.proposeMemory(scope, { ...proposal, courseId })).rejects.toMatchObject({ code: "VALIDATION" });
    }
    await expect(memories.replaceMemory(scope, { ...replace, id: global.id, expectedVersion: confirmedGlobal.version, clientKey: randomUUID() }))
      .rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rejects a failed assistant as a new or existing memory origin", async () => {
    const { sql, scope } = fixture;
    const origin = await insertOwnedTurn(sql, scope, { role: "assistant", contextSourceRefs: [] });
    const input = { text: "Assistant evidence", sourceTurnIds: [origin], expiresAt: null };
    const candidate = await memories.proposeMemory(scope, input);
    const confirmed = await memories.proposeMemory(scope, { ...input, text: "Previously confirmed evidence" });
    await memories.confirm(scope, confirmed.id, confirmed.version, randomUUID());
    await sql`UPDATE opening_turns SET status='failed' WHERE id=${origin}`;
    await expect(memories.proposeMemory(scope, { ...input, text: "New failed evidence" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(memories.confirm(scope, candidate.id, candidate.version, randomUUID())).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(memories.listContext(scope, new Date().toISOString())).resolves.toEqual({ memories: [], sourceRefs: [] });
  });

  it.each([false, true])("checks paired-user memory across courses with explicit backing refs = %s", async includeBacking => {
    const { sql, scope } = fixture;
    const courses = createCourseMembershipRepository(sql);
    const conversations = createOpeningConversationRepository(sql);
    const jobs = createOpeningTutorJobsRepository(sql);
    const createCourse = (title: string) => courses.createCourse({ workspaceId: scope.workspaceId, title, slug: randomUUID() });
    const userCourse = await createCourse("Paired user memory");
    const assistantCourse = await createCourse("Assistant memory destination");
    const material = await insertSource(sql, scope);
    const scoped = await memories.proposeMemory(scope, {
      courseId: userCourse.id, text: "Course-only preference", sourceTurnIds: [], expiresAt: null,
    });
    await memories.confirm(scope, scoped.id, scoped.version, randomUUID());
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const global = await memories.proposeMemory(scope, {
      text: "Temporary global material", expiresAt, sourceTurnIds: [await insertOwnedTurn(sql, scope, { sourceIds: [material] })],
    });
    const conversation = await conversations.create(scope, { title: "Split-course exchange", courseId: null });
    const turn = await conversations.appendSavedTurn({ scope, conversationId: conversation.id,
      text: "Use the saved preference", mode: "explain", sourceIds: [], clientKey: randomUUID(),
      learningSessionId: null, currentPage: null, chunkId: null });
    const claim = (await jobs.claim(turn.jobId))!;
    await jobs.completeTurn({ scope, jobId: turn.jobId, assistantTurnId: turn.assistantTurnId, claimToken: claim.claimToken,
      text: "Answer from the saved preference", citations: [], candidates: [], contextSourceRefs: [] });
    await sql`UPDATE opening_turns SET context_anchor=${sql.json({ courseId: assistantCourse.id })} WHERE id=${turn.assistantTurnId}`;
    const setUserRefs = async (refs: unknown[]) => sql`UPDATE opening_turns
      SET context_anchor=${sql.json({ courseId: userCourse.id })}, context_source_refs=${sql.json(refs as never)}
      WHERE id=${turn.turnId}`;
    const propose = (courseId: string | null) => memories.proposeMemory(scope, {
      courseId, text: `Derived from paired user ${courseId ?? "global"}`, sourceTurnIds: [turn.assistantTurnId], expiresAt: null,
    });
    await setUserRefs([{ memoryDependencyIds: [scoped.id] }]);
    await expect(propose(assistantCourse.id)).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(propose(null)).rejects.toMatchObject({ code: "VALIDATION" });
    await setUserRefs([{ memoryDependencyIds: [global.id] },
      ...(includeBacking ? [{ sourceId: material, sourceVersion: 0, memoryOnly: true }] : []),
    ]);
    for (const courseId of [assistantCourse.id, null]) {
      const derived = await propose(courseId);
      await memories.confirm(scope, derived.id, derived.version, randomUUID());
      const context = () => memories.listContext(scope, new Date().toISOString(), courseId);
      await expect(context()).resolves.toMatchObject({
        memories: expect.arrayContaining([expect.objectContaining({ id: derived.id })]),
        dependencyMemoryIds: [global.id], temporaryMemoryExpiresAt: expiresAt,
        sourceRefs: [{ sourceId: material, sourceVersion: 0 }],
      });
    }
    await sql`UPDATE opening_memories SET expires_at=now()-interval '1 second' WHERE id=${global.id}`;
    await expect(memories.listContext(scope, new Date().toISOString(), assistantCourse.id))
      .resolves.toEqual({ memories: [], sourceRefs: [] });
  });

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
  await expect(withOpeningTutorStreamFenceCommit(fixture.sql, async tx => {
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

it("never lets an active global memory exempt a detached course source shared with conversation history or learner context", async () => {
  const courses = createCourseMembershipRepository(fixture.sql);
  const conversations = createOpeningConversationRepository(fixture.sql);
  const chunks = createOpeningSourceChunksRepository(fixture.sql);
  const jobs = createOpeningTutorJobsRepository(fixture.sql);
  const budget = createOpeningBudgetRepository(fixture.sql, { envCapCents: 100_000 });
  const course = await courses.createCourse({
    workspaceId: fixture.scope.workspaceId,
    title: "Shared lineage admission course",
    slug: randomUUID(),
  });
  const sharedSourceId = randomUUID();
  await fixture.sql`INSERT INTO opening_sources (id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
    VALUES (${sharedSourceId},${fixture.scope.workspaceId},'shared.txt','text/plain',16,${"c".repeat(64)},0,'uploaded','ready')`;
  await fixture.sql`INSERT INTO opening_source_versions (source_id,version,workspace_id,availability)
    VALUES (${sharedSourceId},0,${fixture.scope.workspaceId},'available')`;
  await chunks.replaceChunks(fixture.scope, {
    sourceId: sharedSourceId,
    sourceVersion: 0,
    chunks: [{ page: 1, text: "Detached course material", slideLabel: null, startMs: null, endMs: null, imageObjectKey: null }],
  });
  await courses.addAssetMembership({
    workspaceId: fixture.scope.workspaceId,
    courseId: course.id,
    assetType: "source",
    assetId: sharedSourceId,
    role: "core",
    sortOrder: 0,
    visibility: "course",
    purpose: "teaching",
  });

  // Use a legacy assistant row to exercise the send fence after history loading.
  const courseConversation = await conversations.create(fixture.scope, { title: "Course history", courseId: course.id });
  const priorTurn = await conversations.appendSavedTurn({
    scope: fixture.scope,
    conversationId: courseConversation.id,
    text: "Summarize shared material",
    mode: "explain",
    clientKey: randomUUID(),
    sourceIds: [sharedSourceId],
    learningSessionId: null,
    currentPage: 1,
    chunkId: null,
  });
  await fixture.sql`UPDATE opening_turns SET created_at = now() - interval '1 hour' WHERE id IN (${priorTurn.turnId}, ${priorTurn.assistantTurnId})`;
  await fixture.sql`UPDATE opening_turns SET status = 'complete', text = 'Prior answer using shared material', source_ids = '{}',
    context_source_refs = ${fixture.sql.json([{ sourceId: sharedSourceId, sourceVersion: 0 }])} WHERE id = ${priorTurn.assistantTurnId}`;
  await fixture.sql`UPDATE opening_tutor_jobs SET status = 'succeeded' WHERE id = ${priorTurn.jobId}`;

  // An independent standalone memory also cites the source.
  const standalone = await conversations.create(fixture.scope, { title: "Standalone evidence", courseId: null });
  const globalEvidence = await conversations.appendSavedTurn({
    scope: fixture.scope, conversationId: standalone.id, text: "Use step-by-step summaries",
    mode: "explain", clientKey: randomUUID(), sourceIds: [sharedSourceId], learningSessionId: null,
    currentPage: null, chunkId: null,
  });
  const proposed = await memories.proposeMemory(fixture.scope, {
    text: "Learner likes step-by-step summaries",
    sourceTurnIds: [globalEvidence.turnId],
    courseId: null,
    expiresAt: null,
  });
  await memories.confirm(fixture.scope, proposed.id, proposed.version, randomUUID());

  // Detach sharedSourceId from the course.
  await courses.removeAssetMembership({
    workspaceId: fixture.scope.workspaceId,
    courseId: course.id,
    assetType: "source",
    assetId: sharedSourceId,
  });

  // 1) Shared with conversation history: must fail closed before provider dispatch!
  const followUp = await conversations.appendSavedTurn({
    scope: fixture.scope,
    conversationId: courseConversation.id,
    text: "Follow up on what we just covered",
    mode: "explain",
    clientKey: randomUUID(),
    sourceIds: [],
    learningSessionId: null,
    currentPage: null,
    chunkId: null,
  });
  const providerComplete = vi.fn(async () => ({
    text: "must never be dispatched",
    citedChunkIds: [],
    candidates: [],
    requestId: null,
    inputTokens: 1,
    outputTokens: 1,
  }));
  await expect(createTutorTurnHandler({
    tutorJobs: jobs,
    chunks,
    budget,
    provider: { complete: providerComplete },
    memories: { listContext: (scope, now) => memories.listContext(scope, now) },
    privacy: createOpeningPrivacyRepository(fixture.sql),
    retrieveContext: createOpeningMaterialRetriever(fixture.sql, budget, null),
    config: { maxContextCharacters: 2000, reservedCents: 100, maxOutputTokens: 100, inputCentsPerMillion: 100, outputCentsPerMillion: 200 },
  })(followUp.jobId)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(providerComplete).not.toHaveBeenCalled();

  // 2) Shared with learnerContext in a fresh course conversation (no prior history): must ALSO fail closed!
  const freshCourseConversation = await conversations.create(fixture.scope, { title: "Fresh course learner ctx", courseId: course.id });
  const learnerTurn = await conversations.appendSavedTurn({
    scope: fixture.scope,
    conversationId: freshCourseConversation.id,
    text: "What should I review next?",
    mode: "explain",
    clientKey: randomUUID(),
    sourceIds: [],
    learningSessionId: null,
    currentPage: null,
    chunkId: null,
  });
  await expect(createTutorTurnHandler({
    tutorJobs: jobs,
    chunks,
    budget,
    provider: { complete: providerComplete },
    memories: { listContext: (scope, now) => memories.listContext(scope, now) },
    learnerContext: {
      read: async () => ({
        courseId: course.id,
        title: "Shared lineage admission course",
        asOf: "2026-11-21T00:00:00Z",
        privacyEpoch: 0,
        goal: null,
        weaknesses: [],
        recentMistakes: [],
        observationIds: [],
        sourceRefs: [{ sourceId: sharedSourceId, sourceVersion: 0 }],
      }),
      assertCurrent: async () => {},
    },
    privacy: createOpeningPrivacyRepository(fixture.sql),
    retrieveContext: createOpeningMaterialRetriever(fixture.sql, budget, null),
    config: { maxContextCharacters: 2000, reservedCents: 100, maxOutputTokens: 100, inputCentsPerMillion: 100, outputCentsPerMillion: 200 },
  })(learnerTurn.jobId)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(providerComplete).not.toHaveBeenCalled();
});

it("allows follow-up turns in a course conversation after a valid global-memory turn and omits expired temporary-memory history", async () => {
  const courses = createCourseMembershipRepository(fixture.sql);
  const conversations = createOpeningConversationRepository(fixture.sql);
  const chunks = createOpeningSourceChunksRepository(fixture.sql);
  const jobs = createOpeningTutorJobsRepository(fixture.sql);
  const budget = createOpeningBudgetRepository(fixture.sql, { envCapCents: 100_000 });
  const course = await courses.createCourse({
    workspaceId: fixture.scope.workspaceId,
    title: "Multi-turn global memory course",
    slug: randomUUID(),
  });
  const standaloneSourceId = randomUUID();
  await fixture.sql`INSERT INTO opening_sources (id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
    VALUES (${standaloneSourceId},${fixture.scope.workspaceId},'standalone-mem.txt','text/plain',16,${"d".repeat(64)},0,'uploaded','ready')`;
  await fixture.sql`INSERT INTO opening_source_versions (source_id,version,workspace_id,availability)
    VALUES (${standaloneSourceId},0,${fixture.scope.workspaceId},'available')`;
  await chunks.replaceChunks(fixture.scope, {
    sourceId: standaloneSourceId,
    sourceVersion: 0,
    chunks: [{ page: 1, text: "Standalone origin notes", slideLabel: null, startMs: null, endMs: null, imageObjectKey: null }],
  });

  // Origin turn in standalone conversation backs a temporary global memory (course_id IS NULL).
  const standaloneConv = await conversations.create(fixture.scope, { title: "Standalone origin", courseId: null });
  const originTurn = await conversations.appendSavedTurn({
    scope: fixture.scope, conversationId: standaloneConv.id, text: "Use concise proofs", mode: "explain",
    clientKey: randomUUID(), sourceIds: [standaloneSourceId], learningSessionId: null, currentPage: 1, chunkId: null,
  });
  const tempMemory = await memories.proposeMemory(fixture.scope, {
    text: "Use concise proofs today",
    sourceTurnIds: [originTurn.turnId],
    courseId: null,
    expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
  });

  const courseConv = await conversations.create(fixture.scope, { title: "Course multi-turn", courseId: course.id });
  const receivedHistories: Array<Array<{ role: string; text: string }>> = [];
  const makeHandler = (answerText: string) => createTutorTurnHandler({
    tutorJobs: jobs,
    chunks,
    budget,
    provider: {
      complete: async input => {
        receivedHistories.push(input.history ?? []);
        return { text: answerText, citedChunkIds: [], candidates: [], requestId: null, inputTokens: 10, outputTokens: 10 };
      },
    },
    memories: { listContext: (scope, now) => memories.listContext(scope, now) },
    privacy: createOpeningPrivacyRepository(fixture.sql),
    retrieveContext: createOpeningMaterialRetriever(fixture.sql, budget, null),
    config: { maxContextCharacters: 2000, reservedCents: 100, maxOutputTokens: 100, inputCentsPerMillion: 100, outputCentsPerMillion: 200 },
  });

  // Turn 1 in Course A uses active temporary global memory backed by standaloneSourceId -> persists memoryOnly: true.
  const turn1 = await conversations.appendSavedTurn({
    scope: fixture.scope, conversationId: courseConv.id, text: "Turn 1 question", mode: "explain",
    clientKey: randomUUID(), sourceIds: [], learningSessionId: null, currentPage: null, chunkId: null,
  });
  await expect(makeHandler("Turn 1 answer with temporary global memory")(turn1.jobId)).resolves.toEqual({ skipped: false });
  const [persistedTurn1] = await fixture.sql`SELECT context_source_refs FROM opening_turns WHERE id = ${turn1.assistantTurnId}`;
  expect(persistedTurn1?.context_source_refs).toEqual([
    { sourceId: standaloneSourceId, sourceVersion: 0, memoryOnly: true },
    { memoryDependencyIds: [tempMemory.id] },
  ]);

  // Turn 2 in Course A while temporary global memory is STILL active -> loads Turn 1 history and SUCCEEDS!
  await fixture.sql`UPDATE opening_turns SET created_at = now() - interval '2 minutes' WHERE id IN (${turn1.turnId}, ${turn1.assistantTurnId})`;
  const turn2 = await conversations.appendSavedTurn({
    scope: fixture.scope, conversationId: courseConv.id, text: "Turn 2 follow-up", mode: "explain",
    clientKey: randomUUID(), sourceIds: [], learningSessionId: null, currentPage: null, chunkId: null,
  });
  await expect(makeHandler("Turn 2 answer continuing Turn 1")(turn2.jobId)).resolves.toEqual({ skipped: false });
  expect(receivedHistories[1]).toEqual([
    { role: "user", text: "Turn 1 question" },
    { role: "assistant", text: "Turn 1 answer with temporary global memory" },
  ]);

  // Also create a CONFIRMED global memory M2 backed by the SAME standaloneSourceId:
  // when M1 (tempMemory) expires while M2 remains active, M2 MUST NOT keep M1's derived Turn 1/2 answers in history!
  const confirmedSiblingProposal = await memories.proposeMemory(fixture.scope, {
    text: "Sibling confirmed memory on same source",
    sourceTurnIds: [originTurn.turnId],
    courseId: null,
    expiresAt: null,
  });
  await memories.confirm(fixture.scope, confirmedSiblingProposal.id, confirmedSiblingProposal.version, randomUUID());

  // Now expire the temporary global memory BEFORE Turn 3 -> Turn 3 MUST NOT leak Turn 1/2 expired-memory answers!
  await fixture.sql`UPDATE opening_turns SET created_at = now() - interval '1 minute' WHERE id IN (${turn2.turnId}, ${turn2.assistantTurnId})`;
  await fixture.sql`UPDATE opening_memories SET expires_at = now() - interval '1 second' WHERE id = ${tempMemory.id}`;
  const turn3 = await conversations.appendSavedTurn({
    scope: fixture.scope, conversationId: courseConv.id, text: "Turn 3 after expiry", mode: "explain",
    clientKey: randomUUID(), sourceIds: [], learningSessionId: null, currentPage: null, chunkId: null,
  });
  await expect(makeHandler("Turn 3 clean answer")(turn3.jobId)).resolves.toEqual({ skipped: false });
  expect(receivedHistories[2]).toEqual([]);
});

it("persists exact memoryDependencyIds for documentless chat memories and omits history once expired or superseded", async () => {
  const conversations = createOpeningConversationRepository(fixture.sql);
  const chunks = createOpeningSourceChunksRepository(fixture.sql);
  const jobs = createOpeningTutorJobsRepository(fixture.sql);
  const budget = createOpeningBudgetRepository(fixture.sql, { envCapCents: 100_000 });
  const originConv = await conversations.create(fixture.scope, { title: "Pure chat origin", courseId: null });
  const originTurn = await conversations.appendSavedTurn({
    scope: fixture.scope, conversationId: originConv.id, text: "I prefer visual analogies", mode: "explain",
    clientKey: randomUUID(), sourceIds: [], learningSessionId: null, currentPage: null, chunkId: null,
  });
  const chatTempMemory = await memories.proposeMemory(fixture.scope, {
    text: "Use visual analogies today",
    sourceTurnIds: [originTurn.turnId],
    courseId: null,
    expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
  });
  const chatConv = await conversations.create(fixture.scope, { title: "Documentless memory follow-up", courseId: null });
  const receivedHistories: Array<Array<{ role: string; text: string }>> = [];
  const makeHandler = (answerText: string) => createTutorTurnHandler({
    tutorJobs: jobs, chunks, budget,
    provider: {
      complete: async input => {
        receivedHistories.push(input.history ?? []);
        return { text: answerText, citedChunkIds: [], candidates: [], requestId: null, inputTokens: 10, outputTokens: 10 };
      },
    },
    memories: { listContext: (scope, now) => memories.listContext(scope, now) },
    privacy: createOpeningPrivacyRepository(fixture.sql),
    retrieveContext: createOpeningMaterialRetriever(fixture.sql, budget, null),
    config: { maxContextCharacters: 2000, reservedCents: 100, maxOutputTokens: 100, inputCentsPerMillion: 100, outputCentsPerMillion: 200 },
  });

  const turn1 = await conversations.appendSavedTurn({
    scope: fixture.scope, conversationId: chatConv.id, text: "Explain gravity", mode: "explain",
    clientKey: randomUUID(), sourceIds: [], learningSessionId: null, currentPage: null, chunkId: null,
  });
  await expect(makeHandler("Visual analogy answer")(turn1.jobId)).resolves.toEqual({ skipped: false });
  const [persisted] = await fixture.sql`SELECT context_source_refs FROM opening_turns WHERE id = ${turn1.assistantTurnId}`;
  expect(persisted?.context_source_refs).toEqual([{ memoryDependencyIds: [chatTempMemory.id] }]);

  // Expire documentless chatTempMemory -> Turn 2 MUST NOT see Turn 1's derived answer in history!
  await fixture.sql`UPDATE opening_turns SET created_at = now() - interval '1 minute' WHERE id IN (${turn1.turnId}, ${turn1.assistantTurnId})`;
  await fixture.sql`UPDATE opening_memories SET expires_at = now() - interval '1 second' WHERE id = ${chatTempMemory.id}`;
  const turn2 = await conversations.appendSavedTurn({
    scope: fixture.scope, conversationId: chatConv.id, text: "Explain more", mode: "explain",
    clientKey: randomUUID(), sourceIds: [], learningSessionId: null, currentPage: null, chunkId: null,
  });
  await expect(makeHandler("Fresh answer without expired chat memory")(turn2.jobId)).resolves.toEqual({ skipped: false });
  expect(receivedHistories[1]).toEqual([]);
});

it("blocks confirming or injecting a derived permanent memory once its temporary ancestor memory expires", async () => {
  const conversations = createOpeningConversationRepository(fixture.sql);
  const chunks = createOpeningSourceChunksRepository(fixture.sql);
  const jobs = createOpeningTutorJobsRepository(fixture.sql);
  const budget = createOpeningBudgetRepository(fixture.sql, { envCapCents: 100_000 });
  const originConv = await conversations.create(fixture.scope, { title: "Temp ancestor origin", courseId: null });
  const originTurn = await conversations.appendSavedTurn({
    scope: fixture.scope, conversationId: originConv.id, text: "Focus on matrices today", mode: "explain",
    clientKey: randomUUID(), sourceIds: [], learningSessionId: null, currentPage: null, chunkId: null,
  });
  const ancestorExpiry = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
  const ancestorTemp = await memories.proposeMemory(fixture.scope, {
    text: "Focus on matrices today",
    sourceTurnIds: [originTurn.turnId],
    courseId: null,
    expiresAt: ancestorExpiry,
  });

  const derivedConv = await conversations.create(fixture.scope, { title: "Derived candidate chat", courseId: null });
  const derivedTurn = await conversations.appendSavedTurn({
    scope: fixture.scope, conversationId: derivedConv.id, text: "Give me a matrix exercise", mode: "explain",
    clientKey: randomUUID(), sourceIds: [], learningSessionId: null, currentPage: null, chunkId: null,
  });
  await expect(createTutorTurnHandler({
    tutorJobs: jobs, chunks, budget,
    provider: {
      complete: async () => ({
        text: "Matrix exercise answer",
        citedChunkIds: [],
        candidates: [
          { kind: "memory", text: "Derived permanent preference A", temporary: false },
          { kind: "memory", text: "Derived permanent preference B", temporary: false },
        ],
        requestId: null, inputTokens: 10, outputTokens: 10,
      }),
    },
    memories: { listContext: (scope, now) => memories.listContext(scope, now) },
    privacy: createOpeningPrivacyRepository(fixture.sql),
    retrieveContext: createOpeningMaterialRetriever(fixture.sql, budget, null),
    config: { maxContextCharacters: 2000, reservedCents: 100, maxOutputTokens: 100, inputCentsPerMillion: 100, outputCentsPerMillion: 200 },
  })(derivedTurn.jobId)).resolves.toEqual({ skipped: false });

  const candidates = await fixture.sql<{ id: string }[]>`
    SELECT id FROM opening_assistant_candidates
    WHERE source_turn_id = ${derivedTurn.assistantTurnId}
    ORDER BY created_at ASC, id ASC`;
  expect(candidates).toHaveLength(2);

  // Confirm first permanent candidate WHILE temporary ancestor is active -> inherits ancestor expiry & dependency ID.
  const confirmedDerived = await memories.decideMemoryCandidate(fixture.scope, {
    id: candidates[0]!.id, action: "confirm", expectedVersion: 0, expiresAt: null, clientKey: randomUUID(),
  });
  const activeContext = await memories.listContext(fixture.scope, new Date().toISOString());
  expect(activeContext.memories.map(m => m.id)).toContain(confirmedDerived.id);
  expect(activeContext.dependencyMemoryIds).toContain(ancestorTemp.id);
  expect(Date.parse(activeContext.temporaryMemoryExpiresAt!)).toBe(Date.parse(ancestorExpiry));

  // Now expire the temporary ancestor memory:
  await fixture.sql`UPDATE opening_memories SET expires_at = now() - interval '1 second' WHERE id = ${ancestorTemp.id}`;

  // 1) Second candidate derived from the same turn can no longer be confirmed.
  await expect(memories.decideMemoryCandidate(fixture.scope, {
    id: candidates[1]!.id, action: "confirm", expectedVersion: 0, expiresAt: null, clientKey: randomUUID(),
  })).rejects.toMatchObject({ code: "VALIDATION" });

  // 2) Already-confirmed permanent memory derived from the expired temporary ancestor is excluded from context.
  const afterExpiryContext = await memories.listContext(fixture.scope, new Date().toISOString());
  expect(afterExpiryContext.memories).toEqual([]);

  // 3) Direct send authorization with [confirmedDerived.id] also rejects fail-closed via transitive SQL check.
  const probeTurn = await conversations.appendSavedTurn({
    scope: fixture.scope, conversationId: derivedConv.id, text: "Probe send gate", mode: "explain",
    clientKey: randomUUID(), sourceIds: [], learningSessionId: null, currentPage: null, chunkId: null,
  });
  const probeClaim = (await jobs.claim(probeTurn.jobId))!;
  await expect(jobs.assertSendAuthorized(fixture.scope, probeTurn.jobId, {
    claimToken: probeClaim.claimToken,
    executionId: probeClaim.executionId,
    contextSourceRefs: [],
    globalMemoryIds: [confirmedDerived.id],
  })).rejects.toMatchObject({ code: "CONFLICT" });

  // 4) Ordinary proposeMemory + confirm path also blocks confirming a memory derived from an expired ancestor.
  const activeTemp2 = await memories.proposeMemory(fixture.scope, {
    text: "Temporary preference 2",
    sourceTurnIds: [originTurn.turnId],
    courseId: null,
    expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
  });
  const freshConv = await conversations.create(fixture.scope, { title: "Independent temporary memory chat", courseId: null });
  const turnFromTemp2 = await conversations.appendSavedTurn({
    scope: fixture.scope, conversationId: freshConv.id, text: "Ask with temp 2", mode: "explain",
    clientKey: randomUUID(), sourceIds: [], learningSessionId: null, currentPage: null, chunkId: null,
  });
  await expect(createTutorTurnHandler({
    tutorJobs: jobs, chunks, budget,
    provider: {
      complete: async () => ({
        text: "Answer using temp 2", citedChunkIds: [], candidates: [],
        requestId: null, inputTokens: 10, outputTokens: 10,
      }),
    },
    memories: { listContext: (scope, now) => memories.listContext(scope, now) },
    privacy: createOpeningPrivacyRepository(fixture.sql),
    retrieveContext: createOpeningMaterialRetriever(fixture.sql, budget, null),
    config: { maxContextCharacters: 2000, reservedCents: 100, maxOutputTokens: 100, inputCentsPerMillion: 100, outputCentsPerMillion: 200 },
  })(turnFromTemp2.jobId)).resolves.toEqual({ skipped: false });

  // Propose via ordinary POST /api/opening/memory path while activeTemp2 is still active, then expire activeTemp2 before confirm.
  const proposedOrdinary = await memories.proposeMemory(fixture.scope, {
    text: "Ordinary proposed derived memory",
    sourceTurnIds: [turnFromTemp2.assistantTurnId],
    courseId: null,
    expiresAt: null,
  });
  await fixture.sql`UPDATE opening_memories SET expires_at = now() - interval '1 second' WHERE id = ${activeTemp2.id}`;
  await expect(memories.confirm(fixture.scope, proposedOrdinary.id, proposedOrdinary.version, randomUUID()))
    .rejects.toMatchObject({ code: "VALIDATION" });
  expect(await memories.get(fixture.scope, proposedOrdinary.id)).toMatchObject({ kind: "candidate", version: 0 });
  // Proposing after ancestor expiry also fails closed.
  await expect(memories.proposeMemory(fixture.scope, {
    text: "Late proposed derived memory",
    sourceTurnIds: [turnFromTemp2.assistantTurnId],
    courseId: null,
    expiresAt: null,
  })).rejects.toMatchObject({ code: "VALIDATION" });
});

it("admits restored uppercase source_turn_ids on document-backed global memories across send authorization and history replay", async () => {
  const courses = createCourseMembershipRepository(fixture.sql);
  const conversations = createOpeningConversationRepository(fixture.sql);
  const chunks = createOpeningSourceChunksRepository(fixture.sql);
  const jobs = createOpeningTutorJobsRepository(fixture.sql);
  const budget = createOpeningBudgetRepository(fixture.sql, { envCapCents: 100_000 });
  const course = await courses.createCourse({
    workspaceId: fixture.scope.workspaceId,
    title: "Restored uppercase memory course",
    slug: randomUUID(),
  });
  const docSourceId = randomUUID();
  await fixture.sql`INSERT INTO opening_sources (id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
    VALUES (${docSourceId},${fixture.scope.workspaceId},'restored-doc.txt','text/plain',16,${"e".repeat(64)},0,'uploaded','ready')`;
  await fixture.sql`INSERT INTO opening_source_versions (source_id,version,workspace_id,availability)
    VALUES (${docSourceId},0,${fixture.scope.workspaceId},'available')`;
  await chunks.replaceChunks(fixture.scope, {
    sourceId: docSourceId,
    sourceVersion: 0,
    chunks: [{ page: 1, text: "Restored document notes", slideLabel: null, startMs: null, endMs: null, imageObjectKey: null }],
  });

  const originConv = await conversations.create(fixture.scope, { title: "Standalone doc origin", courseId: null });
  const originTurn = await conversations.appendSavedTurn({
    scope: fixture.scope, conversationId: originConv.id, text: "Remember restored doc fact", mode: "explain",
    clientKey: randomUUID(), sourceIds: [docSourceId], learningSessionId: null, currentPage: 1, chunkId: null,
  });
  const proposed = await memories.proposeMemory(fixture.scope, {
    text: "Restored uppercase memory fact",
    sourceTurnIds: [originTurn.turnId],
    courseId: null,
    expiresAt: null,
  });
  const confirmed = await memories.confirm(fixture.scope, proposed.id, proposed.version, randomUUID());
  // Simulate Backup v2 restore preserving uppercase UUID strings in JSONB source_turn_ids.
  await fixture.sql`UPDATE opening_memories
    SET source_turn_ids = ${fixture.sql.json([originTurn.turnId.toUpperCase()] as never)}
    WHERE id = ${confirmed.id}`;

  const courseConv = await conversations.create(fixture.scope, { title: "Course chat using restored memory", courseId: course.id });
  const receivedHistories: Array<Array<{ role: string; text: string }>> = [];
  const makeHandler = (answerText: string) => createTutorTurnHandler({
    tutorJobs: jobs, chunks, budget,
    provider: {
      complete: async input => {
        receivedHistories.push(input.history ?? []);
        return { text: answerText, citedChunkIds: [], candidates: [], requestId: null, inputTokens: 10, outputTokens: 10 };
      },
    },
    memories: { listContext: (scope, now) => memories.listContext(scope, now) },
    privacy: createOpeningPrivacyRepository(fixture.sql),
    retrieveContext: createOpeningMaterialRetriever(fixture.sql, budget, null),
    config: { maxContextCharacters: 2000, reservedCents: 100, maxOutputTokens: 100, inputCentsPerMillion: 100, outputCentsPerMillion: 200 },
  });

  const turn1 = await conversations.appendSavedTurn({
    scope: fixture.scope, conversationId: courseConv.id, text: "Turn 1 with restored uppercase memory", mode: "explain",
    clientKey: randomUUID(), sourceIds: [], learningSessionId: null, currentPage: null, chunkId: null,
  });
  await expect(makeHandler("Answer 1 with restored memory")(turn1.jobId)).resolves.toEqual({ skipped: false });

  // Turn 2 replays Turn 1's memoryOnly history referencing the uppercase source_turn_ids memory.
  await fixture.sql`UPDATE opening_turns SET created_at = now() - interval '1 minute' WHERE id IN (${turn1.turnId}, ${turn1.assistantTurnId})`;
  const turn2 = await conversations.appendSavedTurn({
    scope: fixture.scope, conversationId: courseConv.id, text: "Turn 2 history replay", mode: "explain",
    clientKey: randomUUID(), sourceIds: [], learningSessionId: null, currentPage: null, chunkId: null,
  });
  await expect(makeHandler("Answer 2 continuing Turn 1")(turn2.jobId)).resolves.toEqual({ skipped: false });
  expect(receivedHistories[1]).toEqual([
    { role: "user", text: "Turn 1 with restored uppercase memory" },
    { role: "assistant", text: "Answer 1 with restored memory" },
  ]);
});
