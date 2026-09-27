import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createOpeningMemoryRepository,
  OpeningMemoryError,
} from "@aistudy/database";
import { memoriesForContext } from "@aistudy/domain";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

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
