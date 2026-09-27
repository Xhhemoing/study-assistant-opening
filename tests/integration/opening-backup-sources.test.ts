import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { OpeningBackupSourceError, readOpeningBackupSources } from "../../packages/database/src/repositories/opening-backup-sources";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let fixture: OpeningFixture;
const sha = (seed: string) => seed.repeat(64).slice(0, 64);

function bySourceId<T extends { sourceId: string }>(left: T, right: T): number {
  if (left.sourceId < right.sourceId) return -1;
  if (left.sourceId > right.sourceId) return 1;
  return 0;
}

async function source(id: string, workspaceId: string, state: string, version = 1) {
  await fixture.sql`
    INSERT INTO opening_sources (
      id, workspace_id, name, mime, bytes, sha256, version, upload_state, parse_state
    ) VALUES (
      ${id}, ${workspaceId}, ${`${state}.pdf`}, 'application/pdf', ${100 + version},
      ${sha(seedOf(id))}, ${version}, ${state}, 'ready'
    )`;
}

function seedOf(id: string): string {
  return id.replace(/-/g, "").slice(0, 2);
}

beforeAll(async () => {
  fixture = await createOpeningFixture();
});

afterAll(async () => {
  if (!fixture) return;
  try {
    const ids = [fixture.scope.workspaceId, fixture.otherScope.workspaceId];
    const users = [fixture.scope.ownerUserId, fixture.otherScope.ownerUserId];
    await fixture.sql`DELETE FROM opening_privacy_exclusions WHERE workspace_id IN ${fixture.sql(ids)}`;
    await fixture.sql`DELETE FROM opening_sources WHERE workspace_id IN ${fixture.sql(ids)}`;
    await fixture.sql`DELETE FROM sessions WHERE user_id IN ${fixture.sql(users)}`;
    await fixture.sql`DELETE FROM workspaces WHERE id IN ${fixture.sql(ids)}`;
    await fixture.sql`DELETE FROM users WHERE id IN ${fixture.sql(users)}`;
  } finally {
    await fixture.close();
  }
});

it("inventories owned uploaded sources and omits foreign, pending, rejected, and excluded rows", async () => {
  const own = randomUUID();
  const later = randomUUID();
  const pending = randomUUID();
  const rejected = randomUUID();
  const excluded = randomUUID();
  const absent = randomUUID();
  const foreign = randomUUID();
  const deletedAt = new Date("2026-09-21T08:30:00.000Z");
  const absentAt = new Date("2026-09-20T01:00:00.000Z");
  await source(later, fixture.scope.workspaceId, "uploaded", 2);
  await source(own, fixture.scope.workspaceId, "uploaded", 1);
  await source(pending, fixture.scope.workspaceId, "pending", 0);
  await source(rejected, fixture.scope.workspaceId, "rejected", 4);
  await source(excluded, fixture.scope.workspaceId, "uploaded", 5);
  await source(foreign, fixture.otherScope.workspaceId, "uploaded", 9);
  await fixture.sql`
    UPDATE workspaces SET privacy_epoch = 7
    WHERE id = ${fixture.scope.workspaceId} AND owner_user_id = ${fixture.scope.ownerUserId}`;
  await fixture.sql`
    INSERT INTO opening_privacy_exclusions (id, workspace_id, source_id, memory_id, deleted_at)
    VALUES
      (${randomUUID()}, ${fixture.scope.workspaceId}, ${excluded}, NULL, ${deletedAt}),
      (${randomUUID()}, ${fixture.scope.workspaceId}, ${absent}, NULL, ${absentAt}),
      (${randomUUID()}, ${fixture.otherScope.workspaceId}, ${own}, NULL, ${deletedAt})`;

  const snapshot = await readOpeningBackupSources(fixture.sql, fixture.scope);

  expect(snapshot.workspaceId).toBe(fixture.scope.workspaceId);
  expect(snapshot.privacyEpoch).toBe(7);
  expect(snapshot.deletionJournal).toEqual([
    { sourceId: excluded, deletedAt: deletedAt.toISOString() },
    { sourceId: absent, deletedAt: absentAt.toISOString() },
  ].sort(bySourceId));
  expect(snapshot.deletionJournal.map((mark) => mark.sourceId)).not.toContain(own);
  expect(snapshot.sources).toEqual([
    { sourceId: own, version: 1, bytes: 101, sha256: sha(seedOf(own)) },
    { sourceId: later, version: 2, bytes: 102, sha256: sha(seedOf(later)) },
  ].sort(bySourceId));
  expect(snapshot.sources.map((row) => row.sourceId)).not.toContain(foreign);
  const impostor = readOpeningBackupSources(fixture.sql, {
    workspaceId: fixture.scope.workspaceId,
    ownerUserId: fixture.otherScope.ownerUserId,
  });
  await expect(impostor).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(impostor).rejects.toBeInstanceOf(OpeningBackupSourceError);
});
