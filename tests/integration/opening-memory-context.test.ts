import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createOpeningMemoryRepository } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { insertMemory, insertOwnedTurn, insertSource } from "./opening-memory-context-fixture";

let fixture: OpeningFixture;
let memories: ReturnType<typeof createOpeningMemoryRepository>;

beforeAll(async () => {
  fixture = await createOpeningFixture();
  memories = createOpeningMemoryRepository(fixture.sql);
});

beforeEach(async () => {
  await fixture.reset();
  await fixture.sql`TRUNCATE opening_memories, opening_privacy_exclusions, opening_turns, opening_conversations RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await fixture?.close();
});

describe("opening memory context admission", () => {
  it("loads a confirmed memory whose owned user turn has no sources", async () => {
    const turnId = await insertOwnedTurn(fixture.sql, fixture.scope);
    const id = await insertMemory(fixture.sql, fixture.scope, "source-less fact", [turnId]);
    const loaded = await memories.listForContext(fixture.scope, null);
    expect(loaded.map((item) => item.id)).toEqual([id]);
  });

  it("hides memories with a missing or foreign turn and a foreign conversation owner", async () => {
    const missing = await insertMemory(fixture.sql, fixture.scope, "missing turn", [randomUUID()]);
    const foreignTurn = await insertOwnedTurn(fixture.sql, fixture.otherScope);
    const foreign = await insertMemory(fixture.sql, fixture.scope, "foreign turn", [foreignTurn]);
    const conversationId = randomUUID();
    const turnId = randomUUID();
    await fixture.sql`
      INSERT INTO opening_conversations (id, workspace_id, owner_user_id, title)
      VALUES (${conversationId}, ${fixture.scope.workspaceId}, ${fixture.otherScope.ownerUserId}, 'foreign owner')`;
    await fixture.sql`
      INSERT INTO opening_turns (id, workspace_id, conversation_id, role, text, mode, status)
      VALUES (${turnId}, ${fixture.scope.workspaceId}, ${conversationId}, 'user', 'x', 'explain', 'complete')`;
    const foreignOwner = await insertMemory(fixture.sql, fixture.scope, "foreign owner", [turnId]);
    const ids = (await memories.listForContext(fixture.scope, null)).map((item) => item.id);
    expect(ids).not.toEqual(expect.arrayContaining([missing, foreign, foreignOwner]));
    const listed = (await memories.list(fixture.scope)).map((item) => item.id);
    expect(listed).toEqual(expect.arrayContaining([missing, foreign, foreignOwner]));
  });

  it("fail-closes excluded, revoked, citation-only, and version-drifted sources", async () => {
    const excludedId = await insertSource(fixture.sql, fixture.scope);
    const excludedTurn = await insertOwnedTurn(fixture.sql, fixture.scope, { sourceIds: [excludedId] });
    const excluded = await insertMemory(fixture.sql, fixture.scope, "excluded", [excludedTurn]);
    await fixture.sql`
      INSERT INTO opening_privacy_exclusions (id, workspace_id, source_id, memory_id, deleted_at)
      VALUES (${randomUUID()}, ${fixture.scope.workspaceId}, ${excludedId}, NULL, now())`;

    const revokedId = await insertSource(fixture.sql, fixture.scope, "rejected");
    const revokedTurn = await insertOwnedTurn(fixture.sql, fixture.scope, { sourceIds: [revokedId] });
    const revoked = await insertMemory(fixture.sql, fixture.scope, "revoked", [revokedTurn]);

    const citedId = await insertSource(fixture.sql, fixture.scope);
    const citationTurn = await insertOwnedTurn(fixture.sql, fixture.scope, {
      citations: [{ sourceId: citedId, sourceVersion: 0 }],
    });
    const citation = await insertMemory(fixture.sql, fixture.scope, "citation only", [citationTurn]);
    await fixture.sql`
      INSERT INTO opening_privacy_exclusions (id, workspace_id, source_id, memory_id, deleted_at)
      VALUES (${randomUUID()}, ${fixture.scope.workspaceId}, ${citedId}, NULL, now())`;

    const driftedId = await insertSource(fixture.sql, fixture.scope, "uploaded", 2);
    const driftedTurn = await insertOwnedTurn(fixture.sql, fixture.scope, {
      citations: [{ sourceId: driftedId, sourceVersion: 1 }],
    });
    const drifted = await insertMemory(fixture.sql, fixture.scope, "drifted", [driftedTurn]);

    const ids = (await memories.listForContext(fixture.scope, null)).map((item) => item.id);
    expect(ids).not.toEqual(expect.arrayContaining([excluded, revoked, citation, drifted]));
  });

  it("does not let another workspace exclusion or a deleted sibling hide a legal memory", async () => {
    const shared = await insertSource(fixture.sql, fixture.scope);
    const legalTurn = await insertOwnedTurn(fixture.sql, fixture.scope, { sourceIds: [shared] });
    const legal = await insertMemory(fixture.sql, fixture.scope, "legal", [legalTurn]);
    const siblingTurn = await insertOwnedTurn(fixture.sql, fixture.scope, { sourceIds: [shared] });
    const sibling = await insertMemory(fixture.sql, fixture.scope, "sibling", [siblingTurn]);
    await fixture.sql`
      UPDATE opening_memories SET status = 'deleted' WHERE id = ${sibling}`;
    await fixture.sql`
      INSERT INTO opening_privacy_exclusions (id, workspace_id, source_id, memory_id, deleted_at)
      VALUES (${randomUUID()}, ${fixture.otherScope.workspaceId}, ${shared}, ${sibling}, now())`;

    expect((await memories.listForContext(fixture.scope, null)).map((item) => item.id)).toEqual([legal]);
    expect((await memories.list(fixture.scope)).map((item) => item.id)).toEqual([legal]);
  });

  it("keeps an empty sourceTurnIds memory visible in list but out of context", async () => {
    const id = await insertMemory(fixture.sql, fixture.scope, "no evidence", []);
    expect((await memories.list(fixture.scope)).map((item) => item.id)).toEqual([id]);
    expect(await memories.listForContext(fixture.scope, null)).toEqual([]);
  });
});
