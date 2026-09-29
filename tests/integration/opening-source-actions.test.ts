import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCourseMembershipRepository, createOpeningConversationRepository, createOpeningMemoryRepository, createOpeningPrivacyRepository, createOpeningSourceChunksRepository, OpeningS3, type OpeningStorage } from "@aistudy/database";
import { readOpeningBackupRecords } from "../../packages/database/src/repositories/opening-backup-records";
import { readOpeningBackupSources } from "../../packages/database/src/repositories/opening-backup-sources";
import { createOpeningSourceService } from "../../apps/web/src/features/opening/sources/source-service";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { backupRows } from "./opening-backup-records-fixture";

let f: OpeningFixture;
beforeAll(async () => { f = await createOpeningFixture(); });
afterAll(async () => { await f?.close(); });
function setup() {
  const objects = new Set<string>();
  let blocked: string | null = null;
  const storage = {
    stagingKey: (id: string) => `opening/staging/${id}`,
    finalKey: (id: string, version: number) => `opening/sources/${id}/v${version}`,
    deleteObject: async (key: string) => { if (key === blocked) throw new Error("storage unavailable"); objects.delete(key); },
    objectExists: async (key: string) => objects.has(key),
    presignGet: async (key: string) => `https://private.invalid/${key}`,
  } as OpeningStorage;
  const service = createOpeningSourceService(f.sql, storage);
  return { service, objects, block: (key: string | null) => { blocked = key; }, storage,
    principal: { workspaceId: f.scope.workspaceId, userId: f.scope.ownerUserId, sessionId: "fixture" } };
}
async function asset() {
  const rows = backupRows(f.sql, f.scope), sourceId = await rows.source("uploaded", 2);
  await f.sql`UPDATE opening_sources SET mime='application/pdf', upload_url_expires_at=now()-interval '1 hour' WHERE id=${sourceId}`;
  await rows.chunk(sourceId, 1);
  await f.sql`UPDATE opening_source_chunks SET image_object_key=NULL WHERE source_id=${sourceId}`;
  await f.sql`INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability)
    VALUES (${sourceId},1,${f.scope.workspaceId},10,${"a".repeat(64)},'available'),(${sourceId},2,${f.scope.workspaceId},10,${"b".repeat(64)},'available')`;
  const courses = createCourseMembershipRepository(f.sql), memberships = [];
  for (const title of ["First", "Archived"]) {
    const course = await courses.createCourse({ workspaceId: f.scope.workspaceId, title, slug: randomUUID() });
    if (title === "Archived") await f.sql`UPDATE courses SET archived_at=now() WHERE id=${course.id}`;
    memberships.push(await courses.addAssetMembership({ workspaceId: f.scope.workspaceId, courseId: course.id,
      assetType: "source", assetId: sourceId, role: "core", visibility: "private" }));
  }
  return { sourceId, rows, memberships };
}
describe("source actions", () => {
  it("previews both course references and excludes AI without removing the asset", async () => {
    const a = await asset(), s = setup();
    const preview = await s.service.getSourceImpact(s.principal, a.sourceId);
    expect(preview.courses.map(row => row.title).sort()).toEqual(["Archived", "First"]);
    expect(preview.courses.find(row => row.title === "Archived")?.archivedAt).not.toBeNull();
    const result = await s.service.actOnSource(s.principal, a.sourceId, { action: "exclude", expectedVersion: 2,
      expectedMembershipIds: preview.courses.map(row => row.membershipId) });
    expect(result).toMatchObject({ sourceId: a.sourceId, aiExcluded: true, deleted: false, cleanupPending: 0 });
    const privacy = createOpeningPrivacyRepository(f.sql), epoch = await privacy.getWorkspaceEpoch(f.scope);
    await s.service.actOnSource(s.principal, a.sourceId, { action: "exclude", expectedVersion: 2, expectedMembershipIds: [] });
    expect(await privacy.getWorkspaceEpoch(f.scope)).toBe(epoch);
    expect(await f.sql`SELECT id FROM opening_sources WHERE id=${a.sourceId}`).toHaveLength(1);
    expect(await f.sql`SELECT id FROM course_asset_memberships WHERE asset_id=${a.sourceId}`).toHaveLength(2);
    expect(await f.sql`SELECT id FROM opening_source_chunks WHERE source_id=${a.sourceId}`).toHaveLength(1);
  });
  it("commits application deletion, exposes failed object cleanup, and retries after the source is gone", async () => {
    const a = await asset(), s = setup();
    for (const key of [s.storage.stagingKey(a.sourceId), s.storage.finalKey(a.sourceId, 1), s.storage.finalKey(a.sourceId, 2)]) s.objects.add(key);
    s.block(s.storage.finalKey(a.sourceId, 1));
    const result = await s.service.actOnSource(s.principal, a.sourceId, { action: "delete", expectedVersion: 2,
      expectedMembershipIds: a.memberships.map(row => row.id) });
    expect(result).toMatchObject({ deleted: true, aiExcluded: true, cleanupPending: 1 });
    expect(await f.sql`SELECT id FROM opening_sources WHERE id=${a.sourceId}`).toEqual([]);
    expect(await f.sql`SELECT id FROM opening_source_chunks WHERE source_id=${a.sourceId}`).toEqual([]);
    expect(await f.sql`SELECT id FROM course_asset_memberships WHERE asset_id=${a.sourceId}`).toEqual([]);
    expect(await s.service.listSourceDeletions(s.principal)).toContainEqual({ sourceId: a.sourceId, cleanupPending: 1, retryAfter: null });
    expect(JSON.stringify(result)).not.toContain("opening/sources");
    s.block(null);
    expect(await s.service.actOnSource(s.principal, a.sourceId, { action: "retry_cleanup" })).toMatchObject({ deleted: true, cleanupPending: 0 });
    expect(s.objects.size).toBe(0);
    expect(await s.service.listSourceDeletions(s.principal)).not.toContainEqual(expect.objectContaining({ sourceId: a.sourceId }));
    expect(await createOpeningPrivacyRepository(f.sql).isSourceExcluded(f.scope, a.sourceId)).toBe(true);
    await expect(s.service.getDownloadUrl(s.principal, a.sourceId, 1)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(createOpeningSourceChunksRepository(f.sql).replaceChunks(f.scope, { sourceId: a.sourceId, sourceVersion: 2, chunks: [] })).rejects.toThrow("source not found");
  });
  it("requires confirmation again when a new course reference appears", async () => {
    const a = await asset(), s = setup(), courses = createCourseMembershipRepository(f.sql);
    const preview = await s.service.getSourceImpact(s.principal, a.sourceId);
    const third = await courses.createCourse({ workspaceId: f.scope.workspaceId, title: "New reference", slug: randomUUID() });
    await courses.addAssetMembership({ workspaceId: f.scope.workspaceId, courseId: third.id, assetType: "source", assetId: a.sourceId, role: "core", visibility: "private" });
    await expect(s.service.actOnSource(s.principal, a.sourceId, { action: "delete", expectedVersion: 2,
      expectedMembershipIds: preview.courses.map(row => row.membershipId) })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await f.sql`SELECT id FROM opening_sources WHERE id=${a.sourceId}`).toHaveLength(1);
  });
  it("keeps deleted-source derivatives out of history and memory display without erasing user originals", async () => {
    const a = await asset(), s = setup(), conversation = await a.rows.conversation();
    const assistant = await a.rows.turn(conversation, [], [{ sourceId: a.sourceId, sourceVersion: 2 }]);
    const user = await a.rows.turn(conversation, [a.sourceId], null);
    await f.sql`UPDATE opening_turns SET role='user',text='My original note' WHERE id=${user}`;
    const memory = await a.rows.memory([assistant]);
    await s.service.actOnSource(s.principal, a.sourceId, { action: "delete", expectedVersion: 2, expectedMembershipIds: a.memberships.map(row => row.id) });
    const turns = await createOpeningConversationRepository(f.sql).listTurns(f.scope, conversation);
    expect(turns.find(row => row.id === assistant)?.text).not.toBe("saved answer");
    expect(turns.find(row => row.id === user)?.text).toBe("My original note");
    expect((await createOpeningMemoryRepository(f.sql).list(f.scope)).find(row => row.id === memory)?.text).not.toBe("Saved memory");
  });
  it("rejects foreign owner operations and deleted-source cleanup retries", async () => {
    const a = await asset(), s = setup(), foreign = { ...s.principal, workspaceId: f.otherScope.workspaceId, userId: f.otherScope.ownerUserId };
    await expect(s.service.getSourceImpact(foreign, a.sourceId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await s.service.actOnSource(s.principal, a.sourceId, { action: "delete", expectedVersion: 2, expectedMembershipIds: a.memberships.map(row => row.id) });
    await expect(s.service.actOnSource(foreign, a.sourceId, { action: "retry_cleanup" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await s.service.listSourceDeletions(foreign)).toEqual([]);
    const falseOwner = { ...s.principal, userId: f.otherScope.ownerUserId };
    await expect(s.service.actOnSource(falseOwner, a.sourceId, { action: "retry_cleanup" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(s.service.listSourceDeletions(falseOwner)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("keeps staging cleanup pending through the signed PUT lifetime and removes late bytes on retry", async () => {
    const a = await asset(), s = setup();
    let clock = new Date("2026-09-30T01:00:00Z");
    const until = "2026-09-30T01:10:00.000Z";
    await f.sql`UPDATE opening_sources SET upload_url_expires_at=${new Date(until)} WHERE id=${a.sourceId}`;
    const service = createOpeningSourceService(f.sql, s.storage, { now: () => clock });
    const deleted = await service.actOnSource(s.principal, a.sourceId, { action: "delete", expectedVersion: 2, expectedMembershipIds: a.memberships.map(row => row.id) });
    expect(deleted).toMatchObject({ deleted: true, cleanupPending: 1, retryAfter: until });
    s.objects.add(s.storage.stagingKey(a.sourceId)); // A previously issued upload finishes after application deletion.
    clock = new Date("2026-09-30T01:11:00Z");
    expect(await service.actOnSource(s.principal, a.sourceId, { action: "retry_cleanup" })).toMatchObject({ cleanupPending: 0, retryAfter: null });
    expect(s.objects.size).toBe(0);
  });
  it("rolls back deletion when a stored image key cannot be attributed to this source", async () => {
    const a = await asset(), s = setup();
    await f.sql`UPDATE opening_source_chunks SET image_object_key='foreign/private-image' WHERE source_id=${a.sourceId}`;
    await expect(s.service.actOnSource(s.principal, a.sourceId, { action: "delete", expectedVersion: 2, expectedMembershipIds: a.memberships.map(row => row.id) }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(await f.sql`SELECT id FROM opening_sources WHERE id=${a.sourceId}`).toHaveLength(1);
    expect(await createOpeningPrivacyRepository(f.sql).isSourceExcluded(f.scope, a.sourceId)).toBe(false);
  });
  it("exports the later asset deletion fact without replayable storage cleanup metadata", async () => {
    const a = await asset(), s = setup();
    const input = { expectedVersion: 2, expectedMembershipIds: a.memberships.map(row => row.id) };
    await s.service.actOnSource(s.principal, a.sourceId, { action: "exclude", ...input });
    const privacy = createOpeningPrivacyRepository(f.sql), excludedEpoch = await privacy.getWorkspaceEpoch(f.scope);
    const conversation = await a.rows.conversation(), turn = await a.rows.turn(conversation, [], [{ sourceId: a.sourceId, sourceVersion: 2 }]);
    expect((await createOpeningConversationRepository(f.sql).listTurns(f.scope, conversation)).find(row => row.id === turn)?.text).toBe("saved answer");
    expect(await privacy.isSourceAssetDeleted(f.scope, a.sourceId)).toBe(false);
    await s.service.actOnSource(s.principal, a.sourceId, { action: "delete", ...input });
    expect(await privacy.getWorkspaceEpoch(f.scope)).toBe(excludedEpoch + 1);
    expect(await privacy.isSourceAssetDeleted(f.scope, a.sourceId)).toBe(true);
    const records = await readOpeningBackupRecords(f.sql, f.scope), sources = await readOpeningBackupSources(f.sql, f.scope);
    const mark = records.deletionJournal.find(row => row.sourceId === a.sourceId)!;
    expect(mark.assetDeletedAt).toBeTruthy(); expect(sources.deletionJournal).toContainEqual(mark);
    const journal = records.tables.opening_privacy_exclusions.find(row => row.source_id === a.sourceId)!;
    expect(journal).toHaveProperty("asset_deleted_at"); expect(journal).not.toHaveProperty("pending_object_keys"); expect(journal).not.toHaveProperty("cleanup_not_before");
  });
  it("deletes real MinIO staging, current and historical objects using the production adapter", async () => {
    const a = await asset(), s = setup();
    const storage = new OpeningS3({ endpoint: process.env.S3_ENDPOINT!, region: process.env.S3_REGION!, bucket: process.env.S3_BUCKET!,
      accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!, forcePathStyle: true });
    const keys = [storage.stagingKey(a.sourceId), storage.finalKey(a.sourceId, 1), storage.finalKey(a.sourceId, 2)];
    try {
      for (const key of keys) {
        const url = await storage.presignPut(key, { mime: "application/pdf", bytes: 4, expiresInSeconds: 60 });
        const response = await fetch(url, { method: "PUT", headers: { "content-type": "application/pdf" }, body: Buffer.from("%PDF") });
        expect(response.ok).toBe(true); expect(await storage.objectExists(key)).toBe(true);
      }
      const service = createOpeningSourceService(f.sql, storage);
      expect(await service.actOnSource(s.principal, a.sourceId, { action: "delete", expectedVersion: 2, expectedMembershipIds: a.memberships.map(row => row.id) }))
        .toMatchObject({ deleted: true, cleanupPending: 0 });
      for (const key of keys) expect(await storage.objectExists(key)).toBe(false);
    } finally { for (const key of keys) await storage.deleteObject(key); }
  });
});
