import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOpeningSourceActionsRepository, createOpeningSourceRepository } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let f: OpeningFixture;
beforeEach(async () => { f = await createOpeningFixture(); });
afterEach(async () => { await f?.close(); });
const input = (uploadId = randomUUID()) => ({ uploadId, name: "same.pdf", mime: "application/pdf" as const, bytes: 4, sha256: "a".repeat(64) });

describe("begin upload operation identity with real SQL", () => {
  it("replays concurrent same-owner starts once even at the object and byte quota", async () => {
    const repo = createOpeningSourceRepository(f.sql, { quota: { maxBytes: 4, maxObjects: 1 } });
    const operation = input();
    const [first, repeated] = await Promise.all([repo.create(f.scope, operation), repo.create(f.scope, operation)]);
    expect(first.id).toBe(operation.uploadId);
    expect(repeated).toEqual(first);
    expect(await f.sql`SELECT id FROM opening_sources WHERE workspace_id=${f.scope.workspaceId}`).toEqual([{ id: first.id }]);
  });

  it.each([
    { name: "changed.pdf" }, { mime: "text/plain" as const }, { bytes: 3 }, { sha256: "b".repeat(64) },
  ])("rejects reuse with changed original metadata %j", async changed => {
    const repo = createOpeningSourceRepository(f.sql), operation = input();
    await repo.create(f.scope, operation);
    await expect(repo.create(f.scope, { ...operation, ...changed })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await f.sql`SELECT id,name,mime,bytes,sha256 FROM opening_sources WHERE id=${operation.uploadId}`)
      .toEqual([{ id: operation.uploadId, name: operation.name, mime: operation.mime, bytes: operation.bytes, sha256: operation.sha256 }]);
  });

  it("keeps intentional uploads separate and never rebinds an identity to another owner", async () => {
    const repo = createOpeningSourceRepository(f.sql), operation = input();
    const first = await repo.create(f.scope, operation);
    await expect(repo.create(f.otherScope, operation)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(repo.create({ ...f.scope, ownerUserId: f.otherScope.ownerUserId }, operation))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    const second = await repo.create(f.scope, { ...operation, uploadId: randomUUID() });
    expect(second.id).not.toBe(first.id);
    expect(await f.sql`SELECT id FROM opening_sources WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(2);
  });

  it.each(["exclude", "delete"] as const)("never revives an identity after %s, including from a different workspace", async action => {
    const repo = createOpeningSourceRepository(f.sql), operation = input();
    const source = await repo.create(f.scope, operation);
    await createOpeningSourceActionsRepository(f.sql).apply(f.scope, source.id,
      { action, expectedVersion: 0, expectedMembershipIds: [] },
      { stagingKey: id => `opening/staging/${id}`, finalKey: (id, version) => `opening/sources/${id}/v${version}` }, new Date());
    await expect(repo.create(f.scope, operation)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(repo.create(f.otherScope, operation)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await f.sql`SELECT id FROM opening_sources WHERE id=${source.id}`).toHaveLength(action === "delete" ? 0 : 1);
  });

  it("rejects a historical orphan identity instead of attaching its old references to a new upload", async () => {
    const operation = input();
    await f.sql`INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability)
      VALUES(${operation.uploadId},0,${f.scope.workspaceId},4,${operation.sha256},'unavailable')`;
    await expect(createOpeningSourceRepository(f.sql).create(f.otherScope, operation)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await f.sql`SELECT id FROM opening_sources WHERE id=${operation.uploadId}`).toEqual([]);
  });
});
