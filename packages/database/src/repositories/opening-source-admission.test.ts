import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { createOpeningSourceRepository } from "./opening-sources";

const scope = { workspaceId: "11111111-1111-4111-8111-111111111111", ownerUserId: "22222222-2222-4222-8222-222222222222" };
const id = "33333333-3333-4333-8333-333333333333";
const now = new Date("2026-10-17T12:00:00Z");
const input = { name: "test.pdf", mime: "application/pdf" as const, bytes: 4, sha256: "a".repeat(64) };
const pending = { id, workspace_id: scope.workspaceId, ...input, version: 0, upload_state: "pending", parse_state: "not_started", error: null, created_at: now };

function database(usage = { bytes: "0", objects: "0" }, row: Record<string, unknown> = pending) {
  let transaction = false, locked = false, checked = false, inserts = 0;
  const sql = ((parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.join("?").replace(/\s+/g, " ").trim();
    if (query.startsWith("SELECT id FROM workspaces")) {
      expect(transaction).toBe(true);
      locked = true;
      return [{ id: scope.workspaceId }];
    }
    if (query.startsWith("WITH quota_objects AS")) {
      expect(transaction && locked).toBe(true);
      checked = true;
      return [usage];
    }
    if (query.startsWith("INSERT INTO opening_sources")) {
      expect(transaction && locked && checked).toBe(true);
      inserts += 1;
      return [pending];
    }
    if (query.startsWith("SELECT * FROM opening_sources")) {
      return values[0] === id && values[1] === scope.workspaceId && values[3] === scope.ownerUserId ? [row] : [];
    }
    if (query.startsWith("INSERT INTO opening_jobs")) return [{ id, state: "queued" }];
    if (query.startsWith("INSERT INTO opening_outbox")) return [];
    throw new Error(`unexpected query: ${query}`);
  }) as unknown as Sql;
  sql.json = ((value: unknown) => value) as unknown as Sql["json"];
  sql.begin = (async (run: (tx: Sql) => Promise<unknown>) => {
    transaction = true;
    try { return await run(sql); } finally { transaction = false; }
  }) as Sql["begin"];
  return { sql, inserts: () => inserts };
}

describe("source admission", () => {
  it.each(["create", "createWithParseJob"] as const)("holds admission and %s insertion in the same transaction", async method => {
    const db = database({ bytes: "6", objects: "1" });
    const repo = createOpeningSourceRepository(db.sql, { quota: { maxBytes: 10, maxObjects: 2 } });
    const created = method === "create" ? await repo.create(scope, input)
      : (await repo.createWithParseJob(scope, { source: input, key: "parse:quota", payload: {}, privacyEpoch: 0 })).source;
    expect(created.uploadState).toBe("pending");
    expect(db.inserts()).toBe(1);
  });

  it.each([{ bytes: "7", objects: "0" }, { bytes: "0", objects: "2" }])("rejects before either creation path inserts when quota is exhausted: %j", async usage => {
    const db = database(usage);
    const repo = createOpeningSourceRepository(db.sql, { quota: { maxBytes: 10, maxObjects: 2 } });
    await expect(repo.create(scope, input)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repo.createWithParseJob(scope, { source: input, key: "parse:quota", payload: {}, privacyEpoch: 0 }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(db.inserts()).toBe(0);
  });

  it("returns the existing upload lease or the legacy 15-minute fallback", async () => {
    for (const upload_url_expires_at of [undefined, new Date(now.getTime() + 120_000)]) {
      const { sql } = database(undefined, { ...pending, upload_url_expires_at });
      const value = await createOpeningSourceRepository(sql, { now: () => now }).getPendingUpload(scope, id);
      expect(value.expiresAt).toBe(new Date(now.getTime() + (upload_url_expires_at ? 120_000 : 900_000)).toISOString());
    }
  });

  it.each([
    { upload_url_expires_at: now },
    { upload_url_expires_at: "invalid" },
    { created_at: new Date(now.getTime() - 900_000) },
  ])("rejects expired or invalid upload leases: %j", async fields => {
    const { sql } = database(undefined, { ...pending, ...fields });
    await expect(createOpeningSourceRepository(sql, { now: () => now }).getPendingUpload(scope, id))
      .rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("hides another owner and non-pending uploads", async () => {
    const { sql } = database();
    await expect(createOpeningSourceRepository(sql).getPendingUpload({ ...scope, ownerUserId: id }, id))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    const uploaded = database(undefined, { ...pending, upload_state: "uploaded" });
    await expect(createOpeningSourceRepository(uploaded.sql).getPendingUpload(scope, id))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
