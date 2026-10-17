import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpeningSourceActionsRepository, createOpeningSourceRepository } from "@aistudy/database";
import { createOpeningMediaSegmentsService } from "../../apps/web/src/features/opening/media/media-segments-service";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let f: OpeningFixture;
beforeEach(async () => { f = await createOpeningFixture(); });
afterEach(async () => { vi.unstubAllEnvs(); await f?.close(); });
const upload = (bytes: number) => ({ name: "quota.pdf", mime: "application/pdf" as const, bytes, sha256: "a".repeat(64) });

describe("workspace upload quota with real SQL", () => {
  it.each(["create", "createWithParseJob"] as const)("serializes concurrent %s reservations under the byte limit", async method => {
    const repo = createOpeningSourceRepository(f.sql, { quota: { maxBytes: 10, maxObjects: 10 } });
    const create = () => method === "create" ? repo.create(f.scope, upload(6))
      : repo.createWithParseJob(f.scope, { source: upload(6), key: randomUUID(), payload: {}, privacyEpoch: 0 });
    const results = await Promise.allSettled([create(), create()]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toMatchObject([{ reason: { code: "CONFLICT" } }]);
    expect(await f.sql`SELECT bytes,upload_state FROM opening_sources WHERE workspace_id=${f.scope.workspaceId}`)
      .toEqual([{ bytes: 6, upload_state: "pending" }]);
    const [jobs] = await f.sql`SELECT count(*)::int AS count FROM opening_jobs WHERE workspace_id=${f.scope.workspaceId}`;
    expect(jobs!.count).toBe(method === "create" ? 0 : 1);
  });

  it("reserves pending objects, stays owner-scoped and leaves another workspace independent", async () => {
    const repo = createOpeningSourceRepository(f.sql, { quota: { maxBytes: 100, maxObjects: 1 } });
    const first = await repo.create(f.scope, upload(4));
    await expect(repo.create(f.scope, upload(4))).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repo.create({ ...f.scope, ownerUserId: f.otherScope.ownerUserId }, upload(4)))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(repo.getPendingUpload(f.otherScope, first.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(repo.getPendingUpload({ ...f.scope, ownerUserId: f.otherScope.ownerUserId }, first.id))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await repo.create(f.otherScope, upload(4))).uploadState).toBe("pending");
  });

  it("counts retained historical versions once and rolls a failed parse reservation back", async () => {
    const repo = createOpeningSourceRepository(f.sql, { quota: { maxBytes: 10, maxObjects: 3 } });
    const source = await repo.create(f.scope, upload(4));
    await repo.complete(f.scope, source.id, upload(4));
    await f.sql`UPDATE opening_sources SET version=1,bytes=3 WHERE id=${source.id}`;
    await f.sql`INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability)
      VALUES(${source.id},1,${f.scope.workspaceId},3,${"a".repeat(64)},'available')`;
    // Historical reference metadata does not claim that an object is stored.
    await f.sql`INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability)
      VALUES(${source.id},98,${f.scope.workspaceId},NULL,NULL,'unknown'),
        (${source.id},99,${f.scope.workspaceId},NULL,NULL,'unavailable')`;
    await expect(repo.create(f.scope, upload(4))).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repo.createWithParseJob(f.scope, { source: upload(3), key: randomUUID(), kind: "invalid", payload: {}, privacyEpoch: 0 }))
      .rejects.toThrow();
    expect((await repo.create(f.scope, upload(3))).bytes).toBe(3);
    await expect(createOpeningSourceRepository(f.sql, { quota: { maxBytes: 100, maxObjects: 3 } }).create(f.scope, upload(1)))
      .rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("serializes media history copies with new upload reservations before S3 writes", async () => {
    vi.stubEnv("OPENING_UPLOAD_MAX_WORKSPACE_BYTES", "10");
    vi.stubEnv("OPENING_UPLOAD_MAX_WORKSPACE_OBJECTS", "3");
    const repo = createOpeningSourceRepository(f.sql, { quota: { maxBytes: 10, maxObjects: 3 } });
    const source = await repo.create(f.scope, { ...upload(4), name: "quota.mp4", mime: "video/mp4" });
    await repo.complete(f.scope, source.id, { ...upload(4), mime: "video/mp4" });
    // Legacy restore can retain the current object without a version journal.
    await f.sql`DELETE FROM opening_source_versions WHERE source_id=${source.id}`;
    const copyObject = vi.fn(async () => {});
    const service = createOpeningMediaSegmentsService(f.sql, {
      finalKey: (id: string, version: number) => `opening/sources/${id}/v${version}`, copyObject,
    } as never, {
      privacy: { getWorkspaceEpoch: async () => 0 },
      knowledge: { markNeedsCheckForSources: async () => ({ updated: 0, courseIds: [] }), enqueueRebuild: vi.fn() },
      jobs: { createOnce: async () => ({ id: randomUUID(), state: "succeeded" }) as never,
        claim: async () => null, finish: async () => true },
    });
    const result = await Promise.allSettled([
      service.applyCorrections({ userId: f.scope.ownerUserId, workspaceId: f.scope.workspaceId, sessionId: "quota" }, source.id, {
        expectedVersion: 0, durationMs: 1000, clientKey: "quota-copy-1", segments: [{ sourceId: source.id, sourceVersion: 0,
          startMs: 0, endMs: 1000, text: "课程", frameChunkIds: [], quality: "needs_check" }],
      }),
      repo.create(f.scope, upload(4)),
    ]);
    expect(result.filter(value => value.status === "fulfilled")).toHaveLength(1);
    expect(result.filter(value => value.status === "rejected")).toMatchObject([{ reason: { code: "CONFLICT" } }]);
    const correctionWon = result[0]!.status === "fulfilled";
    expect(copyObject).toHaveBeenCalledTimes(correctionWon ? 1 : 0);
    expect((await repo.get(f.scope, source.id)).version).toBe(correctionWon ? 1 : 0);
    await expect(repo.create(f.scope, upload(4))).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it.each([false, true])("releases deleted quota only after cleanup acknowledgements (uploaded=%s)", async uploaded => {
    const repo = createOpeningSourceRepository(f.sql, { quota: { maxBytes: 4, maxObjects: 1 } });
    const source = await repo.create(f.scope, upload(4));
    if (uploaded) await repo.complete(f.scope, source.id, upload(4));
    const actions = createOpeningSourceActionsRepository(f.sql);
    const removed = await actions.apply(f.scope, source.id, { action: "delete", expectedVersion: 0, expectedMembershipIds: [] }, {
      stagingKey: id => `opening/staging/${id}`, finalKey: (id, version) => `opening/sources/${id}/v${version}`,
    }, new Date());
    await expect(repo.create(f.scope, upload(4))).rejects.toMatchObject({ code: "CONFLICT" });
    // The object store acknowledges removal before these journal entries clear.
    for (const key of removed.cleanup.keys) await actions.cleaned(f.scope, source.id, key);
    expect((await repo.create(f.scope, upload(4))).bytes).toBe(4);
    const versions = await f.sql`SELECT availability FROM opening_source_versions WHERE source_id=${source.id}`;
    expect(versions).toEqual(uploaded ? [{ availability: "unavailable" }] : []);
  });

  it("rejects an expired pending lease even before the sweeper marks it rejected", async () => {
    const repo = createOpeningSourceRepository(f.sql);
    const source = await repo.create(f.scope, upload(4));
    const pending = await repo.getPendingUpload(f.scope, source.id);
    expect(Date.parse(pending.expiresAt) - Date.parse(source.createdAt)).toBe(900_000);
    await f.sql`UPDATE opening_sources SET upload_url_expires_at=now()-interval '1 second' WHERE id=${source.id}`;
    await expect(repo.getPendingUpload(f.scope, source.id)).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
