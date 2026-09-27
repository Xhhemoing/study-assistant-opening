import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { OpeningBackupSourceError, readOpeningBackupSources } from "./opening-backup-sources";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const ownerUserId = "00000000-0000-4000-8000-0000000000aa";
const scope = { workspaceId, ownerUserId };

type Call = { query: string; values: unknown[] };

function fakeSql(handler: (call: Call) => unknown[]) {
  const calls: Call[] = [];
  let begins = 0;
  const root = (async () => {
    throw new Error("root query outside transaction");
  }) as unknown as Sql & { calls: Call[]; begins: number; transaction?: string };
  root.calls = calls;
  root.begins = 0;
  const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const call = { query: strings.join("?"), values };
    calls.push(call);
    return handler(call);
  }) as unknown as Sql;
  root.begin = (async (option: string, callback: (tx: Sql) => Promise<unknown>) => {
    begins += 1;
    root.begins = begins;
    root.transaction = option;
    return callback(tx);
  }) as unknown as Sql["begin"];
  return root;
}

describe("readOpeningBackupSources", () => {
  it("uses exactly one repeatable read, read only transaction", async () => {
    const sql = fakeSql((call) => {
      if (call.query.includes("FROM workspaces")) return [{ privacy_epoch: 2 }];
      return [];
    });

    await readOpeningBackupSources(sql, scope);

    expect(sql.begins).toBe(1);
    expect(sql.transaction).toMatch(/repeatable read/i);
    expect(sql.transaction).toMatch(/read only/i);
    expect(sql.calls.length).toBeGreaterThan(0);
  });

  it("rejects an owner mismatch before metadata reads", async () => {
    const sql = fakeSql((call) => {
      if (call.query.includes("FROM workspaces")) return [];
      throw new Error(`unexpected query: ${call.query}`);
    });

    const rejection = readOpeningBackupSources(sql, scope);
    await expect(rejection).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(rejection).rejects.toBeInstanceOf(OpeningBackupSourceError);
    expect(sql.begins).toBe(1);
    expect(sql.calls).toHaveLength(1);
    expect(sql.calls[0]?.query).toMatch(/FROM workspaces/);
    expect(sql.calls[0]?.values).toEqual([workspaceId, ownerUserId]);
  });

  it("maps uploaded sources and journal marks with distinct ids", async () => {
    const exportedId = "00000000-0000-4000-8000-000000000010";
    const excludedId = "00000000-0000-4000-8000-000000000099";
    const sql = fakeSql((call) => {
      if (call.query.includes("FROM workspaces")) return [{ privacy_epoch: 4 }];
      if (call.query.includes("FROM opening_sources")) {
        return [{ id: exportedId, version: "3", bytes: "12", sha256: "ab".repeat(32) }];
      }
      if (call.query.includes("opening_privacy_exclusions")) {
        return [{ source_id: excludedId, deleted_at: new Date("2026-09-21T00:00:00.000Z") }];
      }
      throw new Error(`unexpected query: ${call.query}`);
    });

    const snapshot = await readOpeningBackupSources(sql, scope);

    const journal = sql.calls.find((call) => call.query.includes("opening_privacy_exclusions"));
    const sources = sql.calls.find((call) => call.query.includes("FROM opening_sources"));
    expect(journal?.values).toEqual([workspaceId]);
    expect(sources?.values).toEqual([workspaceId, workspaceId]);
    expect(sources?.query).toMatch(/upload_state = 'uploaded'/);
    expect(sources?.query).toMatch(/NOT EXISTS/);
    expect(sources?.query).not.toMatch(/SELECT \*/);
    expect(snapshot).toEqual({
      workspaceId,
      privacyEpoch: 4,
      deletionJournal: [{ sourceId: excludedId, deletedAt: "2026-09-21T00:00:00.000Z" }],
      sources: [{ sourceId: exportedId, version: 3, bytes: 12, sha256: "ab".repeat(32) }],
    });
    expect(snapshot.sources.map((source) => source.sourceId)).not.toContain(excludedId);
    expect(snapshot).not.toHaveProperty("tables");
    expect(snapshot).not.toHaveProperty("objects");
    expect(sql.begins).toBe(1);
  });
});
