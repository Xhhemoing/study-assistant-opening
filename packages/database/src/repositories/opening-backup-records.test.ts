import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { readOpeningBackupRecords } from "./opening-backup-records";
import { OpeningBackupSourceError } from "./opening-backup-sources";

const workspaceId = "a1000000-0000-4000-8000-000000000001";
const ownerUserId = "b2000000-0000-4000-8000-000000000001";
const candidateId = "c3000000-0000-4000-8000-000000000001";
const turnId = "d4000000-0000-4000-8000-000000000001";
type Call = { query: string; values: unknown[] };

function flatten(value: unknown, values: unknown[]): string {
  if (value && typeof value === "object" && "fragment" in value) {
    const nested = value as unknown as { strings: TemplateStringsArray; values: unknown[] };
    return nested.strings.reduce((sql, part, index) => sql + part
      + (index < nested.strings.length - 1 ? flatten(nested.values[index], values) : ""), "");
  }
  values.push(value);
  return "?";
}

function fakeSql(handler: (call: Call) => unknown[]) {
  const calls: Call[] = [];
  const root = (async () => { throw new Error("query outside transaction"); }) as unknown as Sql & {
    calls: Call[]; begins: number; option?: string;
  };
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const fragment = { fragment: true, strings, values };
    return { ...fragment, then: (resolve: (rows: unknown[]) => void, reject: (error: unknown) => void) => {
      try {
        const pending: unknown[] = [];
        const query = flatten(fragment, pending);
        calls.push({ query, values: pending });
        resolve(handler({ query, values: pending }));
      } catch (error) { reject(error); }
    } };
  }) as unknown as Sql;
  root.calls = calls;
  root.begins = 0;
  root.begin = (async (option: string, callback: (transaction: Sql) => Promise<unknown>) => {
    root.begins += 1;
    root.option = option;
    return callback(tx);
  }) as unknown as Sql["begin"];
  return root;
}

describe("readOpeningBackupRecords", () => {
  it("authorizes first and reads the fixed durable table set in one read-only transaction", async () => {
    const sql = fakeSql((call) => call.query.includes("FROM workspaces") ? [{ privacy_epoch: 3 }] : []);
    const snapshot = await readOpeningBackupRecords(sql, { workspaceId, ownerUserId });
    expect(sql.begins).toBe(1);
    expect(sql.option).toMatch(/repeatable read/i);
    expect(sql.option).toMatch(/read only/i);
    expect(sql.calls[0]?.values).toEqual([workspaceId, ownerUserId]);
    expect(snapshot.privacyEpoch).toBe(3);
    expect(Object.keys(snapshot.tables)).toHaveLength(26);
    expect(sql.calls.some((call) => /(?:FROM|JOIN)\s+(?:opening_tutor_jobs|opening_jobs|opening_outbox|opening_budget_reservations|sessions)(?:\s|$)/.test(call.query))).toBe(false);
  });

  it("does not read metadata when owner authorization fails", async () => {
    const sql = fakeSql((call) => {
      if (call.query.includes("FROM workspaces")) return [];
      throw new Error("unexpected metadata read");
    });
    await expect(readOpeningBackupRecords(sql, { workspaceId, ownerUserId }))
      .rejects.toBeInstanceOf(OpeningBackupSourceError);
    expect(sql.calls).toHaveLength(1);
  });

  it("uses scope-bound filters and protects source chunks through their parent source", async () => {
    const sql = fakeSql((call) => call.query.includes("FROM workspaces") ? [{ privacy_epoch: 0 }] : []);
    await readOpeningBackupRecords(sql, { workspaceId, ownerUserId });
    for (const call of sql.calls.slice(1)) {
      expect(call.query).not.toContain("SELECT * FROM ?");
      if (!call.query.includes("opening_privacy_exclusions")) expect(call.values).toContain(workspaceId);
    }
    const chunks = sql.calls.find((call) => call.query.includes("opening_source_chunks"));
    expect(chunks?.query).toMatch(/JOIN opening_sources/);
    expect(chunks?.query).toMatch(/upload_state = 'uploaded'/);
    expect(chunks?.query).toMatch(/NOT EXISTS/);
  });

  it("maps rows without exposing a package or arbitrary table names", async () => {
    const sql = fakeSql((call) => {
      if (call.query.includes("FROM workspaces")) return [{ privacy_epoch: 4 }];
      if (call.query.includes("FROM opening_tasks")) return [{ id: "task-1", workspace_id: workspaceId }];
      return [];
    });
    const snapshot = await readOpeningBackupRecords(sql, { workspaceId, ownerUserId });
    expect(snapshot.tables.opening_tasks).toEqual([{ id: "task-1", workspace_id: workspaceId, candidate_id: null }]);
    expect(snapshot).not.toHaveProperty("objects");
    expect(snapshot).not.toHaveProperty("workspace");
  });

  it("retains an accepted task candidate only when its assistant candidate and source turn are included", async () => {
    const sql = fakeSql((call) => {
      if (call.query.includes("FROM workspaces")) return [{ privacy_epoch: 4 }];
      if (call.query.includes("FROM opening_tasks")) {
        return [{ id: "task-1", workspace_id: workspaceId, owner_user_id: ownerUserId, candidate_id: candidateId }];
      }
      if (call.query.includes("FROM opening_assistant_candidates")) {
        return [{ id: candidateId, workspace_id: workspaceId, conversation_id: "e5000000-0000-4000-8000-000000000001", source_turn_id: turnId }];
      }
      if (call.query.includes("FROM opening_turns")) {
        return [{ id: turnId, workspace_id: workspaceId, attempt_id: null }];
      }
      return [];
    });

    const snapshot = await readOpeningBackupRecords(sql, { workspaceId, ownerUserId });
    expect(snapshot.tables.opening_tasks[0]?.candidate_id).toBe(candidateId);
  });
});


it("exports the owner-scoped workspace counter as an exact safe JSON number", async () => {
  const sql = fakeSql(call => {
    if (call.query.includes("FROM workspaces")) return [{ privacy_epoch: 0 }];
    if (call.query.includes("FROM opening_workspace_history_revisions")) {
      expect(call.values).toEqual([workspaceId, ownerUserId]);
      return [{ workspace_id: workspaceId, owner_user_id: ownerUserId, revision: "9007199254740991" }];
    }
    return [];
  });
  const snapshot = await readOpeningBackupRecords(sql, { workspaceId, ownerUserId });
  expect(snapshot.tables.opening_workspace_history_revisions).toEqual([
    { workspace_id: workspaceId, owner_user_id: ownerUserId, revision: Number.MAX_SAFE_INTEGER },
  ]);
});

it("retains each observation workspace revision as a portable number", async () => {
  const sql = fakeSql(call => {
    if (call.query.includes("FROM workspaces")) return [{ privacy_epoch: 0 }];
    if (call.query.includes("FROM opening_learning_observations o")) return [{
      id: candidateId, workspace_id: workspaceId, owner_user_id: ownerUserId,
      workspace_history_revision: "7", source_versions: null, source_turn_ids: [], attempt_id: null, item_version_id: null,
    }];
    return [];
  });
  const snapshot = await readOpeningBackupRecords(sql, { workspaceId, ownerUserId });
  expect(snapshot.tables.opening_learning_observations).toMatchObject([{ id: candidateId, workspace_history_revision: 7 }]);
});
