import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { createOpeningSourceRepository } from "./opening-sources";

const W = "00000000-0000-4000-8000-000000000001";
const S = "00000000-0000-4000-8000-000000000003";
const SHA = "a".repeat(64);
const scope = { workspaceId: W, ownerUserId: "00000000-0000-4000-8000-0000000000aa" };

function pendingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: S,
    workspace_id: W,
    name: "a.pdf",
    mime: "application/pdf",
    bytes: 12,
    sha256: SHA,
    version: 0,
    upload_state: "pending",
    parse_state: "not_started",
    error: null,
    created_at: new Date("2026-09-13T00:00:00.000Z"),
    updated_at: new Date("2026-09-13T00:00:00.000Z"),
    ...overrides,
  };
}

function transactionalSql(handler: (query: string) => unknown[]) {
  let revision = 0;
  const sql = ((parts: TemplateStringsArray | unknown[]) => {
    if (!Object.hasOwn(parts, "raw")) return parts;
    const query = parts.join("?").replace(/\s+/g, " ").trim();
    if (query.startsWith("SELECT id FROM workspaces")) return Promise.resolve([{ id: W }]);
    if (query.startsWith("INSERT INTO opening_workspace_history_revisions")) return Promise.resolve([]);
    if (query.startsWith("SELECT revision FROM opening_workspace_history_revisions")) return Promise.resolve([{ revision }]);
    if (query.startsWith("UPDATE opening_workspace_history_revisions")) return Promise.resolve([{ revision: ++revision }]);
    if (query.startsWith("DELETE FROM opening_learning_eligibility") || query.startsWith("p.") || query === "FALSE") return Promise.resolve([]);
    return Promise.resolve(handler(query));
  }) as unknown as Sql;
  sql.begin = (async (callback: (tx: Sql) => Promise<unknown>) => callback(sql)) as Sql["begin"];
  return { sql, revision: () => revision };
}
describe("opening source upload completion boundary", () => {
  it("rejects complete when stored object mismatches ticket", async () => {
    const { sql, revision } = transactionalSql((q) => {
      if (q.startsWith("SELECT * FROM opening_sources")) return [pendingRow()];
      throw new Error("unexpected: " + q);
    });
    const repo = createOpeningSourceRepository(sql);
    await expect(
      repo.complete(scope, S, { bytes: 11, sha256: SHA, mime: "application/pdf" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(revision()).toBe(0);
  });

  it("pending → uploaded on exact match; replay is idempotent", async () => {
    let state = "pending";
    const { sql, revision } = transactionalSql((q) => {
      if (q.startsWith("SELECT * FROM opening_sources")) {
        return [pendingRow({ upload_state: state })];
      }
      if (q.startsWith("WITH completed AS (")) {
        state = "uploaded";
        return [pendingRow({ upload_state: "uploaded" })];
      }
      throw new Error("unexpected: " + q);
    });
    const repo = createOpeningSourceRepository(sql);
    const first = await repo.complete(scope, S, {
      bytes: 12,
      sha256: SHA,
      mime: "application/pdf",
    });
    expect(first.uploadState).toBe("uploaded");
    expect(first).not.toHaveProperty("courseId");
    const second = await repo.complete(scope, S, {
      bytes: 12,
      sha256: SHA,
      mime: "application/pdf",
    });
    expect(second.uploadState).toBe("uploaded");
    expect(revision()).toBe(1);
  });

  it("create returns SourceRecord without courseId", async () => {
    const { sql, revision } = transactionalSql((q) => {
      if (q.startsWith("INSERT INTO opening_sources")) return [pendingRow()];
      throw new Error("unexpected: " + q);
    });
    const repo = createOpeningSourceRepository(sql);
    const record = await repo.create(scope, {
      name: "a.pdf",
      mime: "application/pdf",
      bytes: 12,
      sha256: SHA,
    });
    expect(record.uploadState).toBe("pending");
    expect(Object.keys(record)).not.toContain("courseId");
    expect(revision()).toBe(0);
  });
});
