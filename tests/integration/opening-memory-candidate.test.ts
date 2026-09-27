import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createOpeningMemoryRepository, OpeningMemoryError } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { counts, insertCandidate, insertOwnedConversation, insertTurn } from "./opening-memory-candidate-fixture";

let fixture: OpeningFixture;
let memories: ReturnType<typeof createOpeningMemoryRepository>;

beforeAll(async () => {
  fixture = await createOpeningFixture();
  memories = createOpeningMemoryRepository(fixture.sql);
});

beforeEach(async () => {
  await fixture.reset();
  await fixture.sql`TRUNCATE opening_memories, opening_privacy_exclusions, opening_assistant_candidates, opening_turns, opening_conversations RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await fixture?.close();
});

async function pendingMemory(text = "喜欢提示") {
  const conversationId = await insertOwnedConversation(fixture.sql, fixture.scope);
  const sourceTurnId = await insertTurn(fixture.sql, fixture.scope, conversationId);
  const id = await insertCandidate(fixture.sql, fixture.scope, {
    conversationId,
    sourceTurnId,
    payload: { kind: "memory", text, temporary: false },
  });
  return { id, sourceTurnId };
}

describe("assistant memory candidate bridge", () => {
  it("does not treat a pending candidate as a fact until one confirm", async () => {
    const { id } = await pendingMemory();
    expect(await memories.listForContext(fixture.scope, null)).toEqual([]);
    const confirmed = await memories.decideMemoryCandidate(fixture.scope, {
      id,
      expectedVersion: 0,
      clientKey: "bridge-confirm-1",
      action: "confirm",
      expiresAt: null,
    });
    expect(confirmed).toMatchObject({ id, kind: "confirmed", version: 1, status: "active", expiresAt: null });
    const [candidate] = await fixture.sql<{ status: string }[]>`
      SELECT status FROM opening_assistant_candidates WHERE id = ${id}`;
    expect(candidate!.status).toBe("accepted");
    expect((await memories.listForContext(fixture.scope, null)).map((item) => item.id)).toEqual([id]);
  });

  it("keeps one row when the same key confirms concurrently", async () => {
    const { id } = await pendingMemory("并发");
    const input = { id, expectedVersion: 0, clientKey: "bridge-race-1", action: "confirm" as const, expiresAt: null };
    const [a, b] = await Promise.all([
      memories.decideMemoryCandidate(fixture.scope, input),
      memories.decideMemoryCandidate(fixture.scope, input),
    ]);
    expect(a).toEqual(b);
    expect(await counts(fixture.sql, fixture.scope)).toEqual({ memories: 1, accepted: 1 });
  });

  it("conflicts when the same key changes expiry, action, or version, or a new key arrives", async () => {
    const { id } = await pendingMemory("冲突");
    await memories.decideMemoryCandidate(fixture.scope, {
      id, expectedVersion: 0, clientKey: "bridge-conflict-1", action: "confirm", expiresAt: null,
    });
    const clashes = [
      { expectedVersion: 0, clientKey: "bridge-conflict-1", action: "confirm" as const, expiresAt: "2099-01-01T00:00:00.000Z" },
      { expectedVersion: 0, clientKey: "bridge-conflict-1", action: "reject" as const, expiresAt: null },
      { expectedVersion: 1, clientKey: "bridge-conflict-1", action: "confirm" as const, expiresAt: null },
      { expectedVersion: 0, clientKey: "bridge-conflict-2", action: "confirm" as const, expiresAt: null },
    ];
    for (const clash of clashes) {
      await expect(memories.decideMemoryCandidate(fixture.scope, { id, ...clash })).rejects.toMatchObject({ code: "CONFLICT" });
    }
    expect(await counts(fixture.sql, fixture.scope)).toEqual({ memories: 1, accepted: 1 });
  });

  it("suppresses the same text and source after reject", async () => {
    const conversationId = await insertOwnedConversation(fixture.sql, fixture.scope);
    const sourceTurnId = await insertTurn(fixture.sql, fixture.scope, conversationId);
    const first = await insertCandidate(fixture.sql, fixture.scope, {
      conversationId,
      sourceTurnId,
      payload: { kind: "memory", text: "重复", temporary: false },
    });
    await memories.decideMemoryCandidate(fixture.scope, {
      id: first, expectedVersion: 0, clientKey: "bridge-reject-1", action: "reject", expiresAt: null,
    });
    const again = await insertCandidate(fixture.sql, fixture.scope, {
      conversationId,
      sourceTurnId,
      payload: { kind: "memory", text: "重复", temporary: false },
    });
    await expect(memories.decideMemoryCandidate(fixture.scope, {
      id: again, expectedVersion: 0, clientKey: "bridge-reject-2", action: "confirm", expiresAt: null,
    })).rejects.toMatchObject({ code: "CONFLICT", message: "equivalent proposal was rejected" });
    const [row] = await fixture.sql<{ status: string }[]>`SELECT status FROM opening_assistant_candidates WHERE id = ${again}`;
    expect(row!.status).toBe("pending");
    expect(await counts(fixture.sql, fixture.scope)).toEqual({ memories: 1, accepted: 0 });
  });

  it("rejects temporary without expiry and keeps a future expiry temporary", async () => {
    const missing = await pendingMemory("临时缺");
    await fixture.sql`UPDATE opening_assistant_candidates SET payload = ${fixture.sql.json({ kind: "memory", text: "临时缺", temporary: true })} WHERE id = ${missing.id}`;
    await expect(memories.decideMemoryCandidate(fixture.scope, {
      id: missing.id, expectedVersion: 0, clientKey: "bridge-temp-missing", action: "confirm", expiresAt: null,
    })).rejects.toMatchObject({ code: "VALIDATION" });
    const kept = await pendingMemory("临时留");
    await fixture.sql`UPDATE opening_assistant_candidates SET payload = ${fixture.sql.json({ kind: "memory", text: "临时留", temporary: true })} WHERE id = ${kept.id}`;
    const item = await memories.decideMemoryCandidate(fixture.scope, {
      id: kept.id, expectedVersion: 0, clientKey: "bridge-temp-future", action: "confirm", expiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(item).toMatchObject({ kind: "temporary", expiresAt: "2099-01-01T00:00:00.000Z" });
  });

  it("rejects foreign, task, malformed, and excluded candidates without partial rows", async () => {
    const foreignTurn = await insertTurn(
      fixture.sql,
      fixture.otherScope,
      await insertOwnedConversation(fixture.sql, fixture.otherScope),
    );
    const conversationId = await insertOwnedConversation(fixture.sql, fixture.scope);
    const foreign = await insertCandidate(fixture.sql, fixture.scope, {
      conversationId,
      sourceTurnId: foreignTurn,
      payload: { kind: "memory", text: "外域", temporary: false },
    });
    const taskTurn = await insertTurn(fixture.sql, fixture.scope, conversationId);
    const task = await insertCandidate(fixture.sql, fixture.scope, {
      conversationId, sourceTurnId: taskTurn, payload: { kind: "task", title: "作业", minutes: 10, dueText: null },
    });
    const badTurn = await insertTurn(fixture.sql, fixture.scope, conversationId);
    const malformed = await insertCandidate(fixture.sql, fixture.scope, {
      conversationId, sourceTurnId: badTurn, payload: { kind: "memory", text: "", temporary: false },
    });
    const sourceId = randomUUID();
    await fixture.sql`
      INSERT INTO opening_sources (id, workspace_id, name, mime, bytes, sha256, version, upload_state, parse_state)
      VALUES (${sourceId}, ${fixture.scope.workspaceId}, 's.pdf', 'application/pdf', 1, ${"b".repeat(64)}, 0, 'uploaded', 'ready')`;
    await fixture.sql`
      INSERT INTO opening_privacy_exclusions (id, workspace_id, source_id, memory_id, deleted_at)
      VALUES (${randomUUID()}, ${fixture.scope.workspaceId}, ${sourceId}, NULL, now())`;
    const excludedTurn = await insertTurn(fixture.sql, fixture.scope, conversationId, { sourceIds: [sourceId] });
    const excluded = await insertCandidate(fixture.sql, fixture.scope, {
      conversationId, sourceTurnId: excludedTurn, sourceIds: [sourceId], payload: { kind: "memory", text: "排除", temporary: false },
    });
    for (const id of [foreign, task, malformed, excluded]) {
      await expect(memories.decideMemoryCandidate(fixture.scope, {
        id, expectedVersion: 0, clientKey: `bridge-deny-${id.slice(0, 8)}`, action: "confirm", expiresAt: null,
      })).rejects.toBeInstanceOf(OpeningMemoryError);
    }
    const otherOwned = await pendingMemory("别人的");
    await expect(memories.decideMemoryCandidate(fixture.otherScope, {
      id: otherOwned.id, expectedVersion: 0, clientKey: "bridge-other-owner", action: "confirm", expiresAt: null,
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await counts(fixture.sql, fixture.scope)).toEqual({ memories: 0, accepted: 0 });
  });
});
