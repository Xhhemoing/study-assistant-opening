import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createOpeningMemoryRepository,
  createOpeningPrivacyRepository,
} from "@aistudy/database";
import { assertCurrentEpoch, PrivacyEpochError } from "../../apps/worker/src/runtime/privacy-guard";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let fixture: OpeningFixture;
let memories: ReturnType<typeof createOpeningMemoryRepository>;
let privacy: ReturnType<typeof createOpeningPrivacyRepository>;

beforeAll(async () => {
  fixture = await createOpeningFixture();
  // applyMigrations requires contiguous 0001..N; 0023 (P02) is not on disk yet.
  // Apply Heidi-assigned 0023 SQL directly (idempotent IF NOT EXISTS).
  const sql0023 = readFileSync(
    resolve("packages/database/src/migrations/0023_opening_memory_privacy_epoch.sql"),
    "utf8",
  );
  await fixture.sql.unsafe(sql0023);
  memories = createOpeningMemoryRepository(fixture.sql);
  privacy = createOpeningPrivacyRepository(fixture.sql);
});
beforeEach(async () => {
  await fixture.reset();
  await fixture.sql`TRUNCATE opening_privacy_exclusions, opening_memories RESTART IDENTITY CASCADE`;
  await fixture.sql`UPDATE workspaces SET privacy_epoch = 0 WHERE id = ${fixture.scope.workspaceId}`;
  await fixture.sql`UPDATE workspaces SET privacy_epoch = 0 WHERE id = ${fixture.otherScope.workspaceId}`;
});
afterAll(async () => {
  await fixture?.close();
});

describe("opening privacy deletion (guarded M02)", () => {
  it("assertCurrentEpoch rejects mismatched job snapshots", () => {
    expect(() => assertCurrentEpoch(2, 3)).toThrow(PrivacyEpochError);
    expect(() => assertCurrentEpoch(3, 3)).not.toThrow();
  });

  it("deleteMemory tombstones, bumps epoch, records content-free exclusions", async () => {
    const sourceId = randomUUID();
    const turnId = randomUUID();
    await fixture.sql`
      INSERT INTO opening_sources (id, workspace_id, name, mime, bytes, sha256, version, upload_state, parse_state)
      VALUES (${sourceId}, ${fixture.scope.workspaceId}, 'x.pdf', 'application/pdf', 1, ${"a".repeat(64)}, 0, 'uploaded', 'ready')`;
    const conversationId = randomUUID();
    await fixture.sql`
      INSERT INTO opening_conversations (id, workspace_id, owner_user_id, title)
      VALUES (${conversationId}, ${fixture.scope.workspaceId}, ${fixture.scope.ownerUserId}, 'priv')`;
    await fixture.sql`
      INSERT INTO opening_turns (id, workspace_id, conversation_id, role, text, mode, status, source_ids)
      VALUES (${turnId}, ${fixture.scope.workspaceId}, ${conversationId}, 'user', 'secret text', 'explain', 'complete', ${[sourceId]}::uuid[])`;

    const proposed = await memories.proposeMemory(fixture.scope, {
      text: "remember secret",
      sourceTurnIds: [turnId],
      expiresAt: null,
    });
    const receipt = await memories.deleteMemory(fixture.scope, {
      id: proposed.id,
      expectedVersion: proposed.version,
      deleteSourceText: true,
      clientKey: "del-1",
    });
    expect(receipt.privacyEpoch).toBe(1);
    expect(receipt.excludedSourceIds).toEqual([sourceId]);
    expect(JSON.stringify(receipt)).not.toContain("remember secret");
    expect(JSON.stringify(receipt)).not.toContain("secret text");

    const row = await fixture.sql`SELECT status, text FROM opening_memories WHERE id = ${proposed.id}`;
    expect(row[0].status).toBe("deleted");
    expect(await privacy.isSourceExcluded(fixture.scope, sourceId)).toBe(true);
    expect(await privacy.getWorkspaceEpoch(fixture.scope)).toBe(1);

    const turn = await fixture.sql`SELECT text FROM opening_turns WHERE id = ${turnId}`;
    expect(turn[0].text).toBe("");
  });

  it("re-delete with same clientKey is idempotent; stale version 409; cross-workspace 404", async () => {
    const proposed = await memories.proposeMemory(fixture.scope, {
      text: "x",
      sourceTurnIds: [],
      expiresAt: null,
    });
    const first = await memories.deleteMemory(fixture.scope, {
      id: proposed.id,
      expectedVersion: proposed.version,
      deleteSourceText: false,
      clientKey: "del-idem",
    });
    const second = await memories.deleteMemory(fixture.scope, {
      id: proposed.id,
      expectedVersion: proposed.version,
      deleteSourceText: false,
      clientKey: "del-idem",
    });
    expect(second.privacyEpoch).toBe(first.privacyEpoch);

    const other = await memories.proposeMemory(fixture.scope, {
      text: "y",
      sourceTurnIds: [],
      expiresAt: null,
    });
    await expect(
      memories.deleteMemory(fixture.scope, {
        id: other.id,
        expectedVersion: other.version + 9,
        deleteSourceText: false,
        clientKey: "stale",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await expect(
      memories.deleteMemory(fixture.otherScope, {
        id: other.id,
        expectedVersion: other.version,
        deleteSourceText: false,
        clientKey: "cross",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("delete vs writeback race: epoch bump fails a stale assertCurrentEpoch", async () => {
    const epoch = await privacy.getWorkspaceEpoch(fixture.scope);
    const proposed = await memories.proposeMemory(fixture.scope, {
      text: "race",
      sourceTurnIds: [],
      expiresAt: null,
    });
    await memories.deleteMemory(fixture.scope, {
      id: proposed.id,
      expectedVersion: proposed.version,
      deleteSourceText: false,
      clientKey: "race-1",
    });
    const after = await privacy.getWorkspaceEpoch(fixture.scope);
    expect(after).toBe(epoch + 1);
    expect(() => assertCurrentEpoch(epoch, after)).toThrow(PrivacyEpochError);
  });
});
