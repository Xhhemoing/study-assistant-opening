import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCourseMembershipRepository, createOpeningSourceRepository, createOpeningSourceChunksRepository, type OpeningStorage } from "@aistudy/database";
import { createOpeningSourceService } from "../../apps/web/src/features/opening/sources/source-service";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { openRaceSession, closeRace, track, waitUntilBlocked } from "./opening-race-helpers";

let f: OpeningFixture;
beforeAll(async () => { f = await createOpeningFixture(); });
afterAll(async () => { await f?.close(); });
const bytes = Buffer.from("%PDF-1.4\nsource"), sha = createHash("sha256").update(bytes).digest("hex");
function deferred() { let resolve = () => {}; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function storage() {
  const objects = new Set<string>();
  const adapter = { stagingKey: (id: string) => `opening/staging/${id}`, finalKey: (id: string, v: number) => `opening/sources/${id}/v${v}`,
    headObject: async () => ({ exists: true, etag: "fixed", bytes: bytes.length, mime: "application/pdf" }),
    streamDigest: async () => ({ bytes: bytes.length, sha256: sha, firstBytes: bytes }),
    copyStagingToFinal: async (_from: string, to: string) => { objects.add(to); },
    deleteObject: async (key: string) => { objects.delete(key); },
  } as OpeningStorage;
  return { adapter, objects };
}
async function seed(uploaded: boolean) {
  const source = await createOpeningSourceRepository(f.sql).create(f.scope, { name: "race.pdf", mime: "application/pdf", bytes: bytes.length, sha256: sha });
  await f.sql`UPDATE opening_sources SET upload_state=${uploaded ? "uploaded" : "pending"}, upload_url_expires_at=now()-interval '1 hour' WHERE id=${source.id}`;
  return source.id;
}
const principal = () => ({ workspaceId: f.scope.workspaceId, userId: f.scope.ownerUserId, sessionId: "fixture" });
describe("source deletion serialization", () => {
  it("waits for an in-flight final-object copy and removes the copied object after commit", async () => {
    const id = await seed(false), a = await openRaceSession().ready, b = await openRaceSession().ready;
    const s = storage(), entered = deferred(), release = deferred();
    s.adapter.copyStagingToFinal = async (_from, to) => { entered.resolve(); await release.promise; s.objects.add(to); };
    const complete = track(createOpeningSourceService(a.sql, s.adapter).completeUpload(principal(), id));
    let deletion: Promise<unknown> | undefined;
    try {
      await entered.promise;
      deletion = track(createOpeningSourceService(b.sql, s.adapter).actOnSource(principal(), id, { action: "delete", expectedVersion: 0, expectedMembershipIds: [] }));
      await waitUntilBlocked(f.sql, b.pid, a.pid, "deletion behind copy", /workspaces/);
      release.resolve();
      await complete; await deletion;
      expect(s.objects.size).toBe(0); expect(await f.sql`SELECT id FROM opening_sources WHERE id=${id}`).toHaveLength(0);
    } finally { release.resolve(); await Promise.allSettled([complete, ...(deletion ? [deletion] : [])]); await closeRace(a.sql); await closeRace(b.sql); }
  });
  it.each(["parse", "attach"] as const)("rejects late %s writes after deletion acquires its source lock", async kind => {
    const id = await seed(true), blocker = await openRaceSession().ready, remover = await openRaceSession().ready, writer = await openRaceSession().ready;
    const opened = deferred(), release = deferred(), s = storage();
    const hold = track(blocker.sql.begin(async tx => { await tx`SELECT id FROM opening_sources WHERE id=${id} FOR UPDATE`; opened.resolve(); await release.promise; }));
    const course = await createCourseMembershipRepository(f.sql).createCourse({ workspaceId: f.scope.workspaceId, title: "Concurrent course", slug: randomUUID() });
    let deletion: Promise<unknown> | undefined, pending: Promise<unknown> | undefined;
    try {
      await opened.promise;
      deletion = track(createOpeningSourceService(remover.sql, s.adapter).actOnSource(principal(), id, { action: "delete", expectedVersion: 0, expectedMembershipIds: [] }));
      await waitUntilBlocked(f.sql, remover.pid, blocker.pid, "delete waiting on source", /opening_sources/);
      pending = track(kind === "parse" ? createOpeningSourceChunksRepository(writer.sql).replaceChunks(f.scope, { sourceId: id, sourceVersion: 0, chunks: [] })
        : createCourseMembershipRepository(writer.sql).addAssetMembership({ workspaceId: f.scope.workspaceId, courseId: course.id, assetType: "source", assetId: id, role: "core", visibility: "private" }));
      await waitUntilBlocked(f.sql, writer.pid, remover.pid, "late writer waiting");
      release.resolve(); await hold; await deletion;
      await expect(pending).rejects.toThrow(/source not found/i);
      expect(await f.sql`SELECT id FROM course_asset_memberships WHERE asset_id=${id}`).toHaveLength(0);
      expect(await f.sql`SELECT id FROM opening_source_chunks WHERE source_id=${id}`).toHaveLength(0);
    } finally { release.resolve(); await Promise.allSettled([hold, ...(deletion ? [deletion] : []), ...(pending ? [pending] : [])]); await closeRace(blocker.sql); await closeRace(remover.sql); await closeRace(writer.sql); }
  }, 20_000);
});
