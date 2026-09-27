import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createOpeningMemoryRepository, OpeningMemoryError } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { counts, insertCandidate, insertTurn } from "./opening-memory-candidate-fixture";

let fixture: OpeningFixture;
let memories: ReturnType<typeof createOpeningMemoryRepository>;
let now = new Date("2026-09-21T00:00:00.000Z");

beforeAll(async () => {
  fixture = await createOpeningFixture();
  memories = createOpeningMemoryRepository(fixture.sql, { now: () => now });
});

beforeEach(async () => {
  now = new Date("2026-09-21T00:00:00.000Z");
  await fixture.reset();
  await fixture.sql`TRUNCATE opening_memories, opening_privacy_exclusions, opening_assistant_candidates, opening_turns, opening_conversations, courses RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await fixture?.close();
});

async function course(scope = fixture.scope): Promise<string> {
  const id = randomUUID();
  await fixture.sql`
    INSERT INTO courses (id, workspace_id, title, slug)
    VALUES (${id}, ${scope.workspaceId}, 'scoped', ${`scoped-${id}`})`;
  return id;
}

async function temporary(text: string, courseId: string | null = null) {
  const conversationId = randomUUID();
  await fixture.sql`
    INSERT INTO opening_conversations (id, workspace_id, owner_user_id, title, course_id)
    VALUES (${conversationId}, ${fixture.scope.workspaceId}, ${fixture.scope.ownerUserId}, 'scoped', ${courseId})`;
  const sourceTurnId = await insertTurn(fixture.sql, fixture.scope, conversationId);
  const id = await insertCandidate(fixture.sql, fixture.scope, {
    conversationId,
    sourceTurnId,
    payload: { kind: "memory", text, temporary: true },
  });
  return { id, conversationId, sourceTurnId };
}

describe("memory candidate replay and course scope", () => {
  it("replays a temporary confirm after its stored expiry without rechecking the clock", async () => {
    const { id } = await temporary("稍后过期");
    const input = {
      id,
      expectedVersion: 0,
      clientKey: "replay-after-expiry",
      action: "confirm" as const,
      expiresAt: "2026-09-21T00:00:05.000Z",
    };
    const first = await memories.decideMemoryCandidate(fixture.scope, input);
    now = new Date("2026-09-21T00:00:06.000Z");
    const replay = await memories.decideMemoryCandidate(fixture.scope, input);
    expect(replay).toEqual(first);
    expect(replay.expiresAt).toBe("2026-09-21T00:00:05.000Z");
    expect(await counts(fixture.sql, fixture.scope)).toEqual({ memories: 1, accepted: 1 });
  });

  it("rejects a temporary candidate without an expiry and replays that rejection", async () => {
    const { id } = await temporary("拒绝临时候选");
    const input = {
      id,
      expectedVersion: 0,
      clientKey: "reject-temporary",
      action: "reject" as const,
      expiresAt: null,
    };
    const rejected = await memories.decideMemoryCandidate(fixture.scope, input);
    expect(rejected).toMatchObject({ status: "rejected", expiresAt: null, kind: "candidate" });
    await expect(memories.decideMemoryCandidate(fixture.scope, input)).resolves.toEqual(rejected);
    await expect(memories.decideMemoryCandidate(fixture.scope, {
      ...input,
      expiresAt: "2099-01-01T00:00:00.000Z",
    })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await counts(fixture.sql, fixture.scope)).toEqual({ memories: 1, accepted: 0 });
  });

  it("suppresses the same text and source turn inside its owned conversation", async () => {
    const { id, conversationId, sourceTurnId } = await temporary("同会话抑制");
    await fixture.sql`UPDATE opening_assistant_candidates SET payload = ${fixture.sql.json({ kind: "memory", text: "同会话抑制", temporary: false })} WHERE id = ${id}`;
    await memories.decideMemoryCandidate(fixture.scope, {
      id, expectedVersion: 0, clientKey: "same-conversation-reject", action: "reject", expiresAt: null,
    });
    const again = await insertCandidate(fixture.sql, fixture.scope, {
      conversationId,
      sourceTurnId,
      payload: { kind: "memory", text: "同会话抑制", temporary: false },
    });
    await expect(memories.decideMemoryCandidate(fixture.scope, {
      id: again, expectedVersion: 0, clientKey: "same-conversation-confirm", action: "confirm", expiresAt: null,
    })).rejects.toMatchObject({ code: "CONFLICT", message: "equivalent proposal was rejected" });
    const [row] = await fixture.sql<{ status: string }[]>`
      SELECT status FROM opening_assistant_candidates WHERE id = ${again}`;
    expect(row!.status).toBe("pending");
    expect(await counts(fixture.sql, fixture.scope)).toEqual({ memories: 1, accepted: 0 });
  });

  it("returns not found for a same-workspace pretender owner", async () => {
    const { id } = await temporary("伪所有者");
    const pretender = { workspaceId: fixture.scope.workspaceId, ownerUserId: fixture.otherScope.ownerUserId };
    await expect(memories.decideMemoryCandidate(pretender, {
      id, expectedVersion: 0, clientKey: "pretend-owner-1", action: "confirm", expiresAt: "2099-01-01T00:00:00.000Z",
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await counts(fixture.sql, fixture.scope)).toEqual({ memories: 0, accepted: 0 });
  });

  it("persists the locked conversation course and does not leak it to another course", async () => {
    const math = await course();
    const history = await course();
    const { id } = await temporary("只属于数学", math);
    const saved = await memories.decideMemoryCandidate(fixture.scope, {
      id, expectedVersion: 0, clientKey: "course-confirm-1", action: "confirm", expiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(saved.courseId).toBe(math);
    expect((await memories.listForContext(fixture.scope, math)).map((item) => item.id)).toEqual([id]);
    expect(await memories.listForContext(fixture.scope, history)).toEqual([]);
    const [row] = await fixture.sql<{ course_id: string | null }[]>`
      SELECT course_id FROM opening_memories WHERE id = ${id}`;
    expect(row!.course_id).toBe(math);
  });

  it("does not replay a confirm when the candidate was discarded, or the reverse", async () => {
    const rejected = await temporary("状态错配拒绝");
    await memories.decideMemoryCandidate(fixture.scope, {
      id: rejected.id, expectedVersion: 0, clientKey: "status-reject", action: "reject", expiresAt: null,
    });
    await expect(memories.decideMemoryCandidate(fixture.scope, {
      id: rejected.id,
      expectedVersion: 0,
      clientKey: "status-reject",
      action: "confirm",
      expiresAt: "2099-01-01T00:00:00.000Z",
    })).rejects.toBeInstanceOf(OpeningMemoryError);
    const accepted = await temporary("状态错配确认");
    await memories.decideMemoryCandidate(fixture.scope, {
      id: accepted.id,
      expectedVersion: 0,
      clientKey: "status-confirm",
      action: "confirm",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    await expect(memories.decideMemoryCandidate(fixture.scope, {
      id: accepted.id, expectedVersion: 0, clientKey: "status-confirm", action: "reject", expiresAt: null,
    })).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
