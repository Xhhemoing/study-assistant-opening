import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { createOpeningJobRepository } from "./opening-jobs";

const SOURCE = "00000000-0000-4000-8000-000000000003";
const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const OWNER = "canonical-owner";

describe("opening job privacy snapshot", () => {
  it("reads the workspace privacy epoch when validating a source job", async () => {
    const queries: string[] = [];
    const sql = ((parts: TemplateStringsArray) => {
      const query = parts.join("?").replace(/\s+/g, " ").trim();
      queries.push(query);
      return Promise.resolve([{ privacy_epoch: 7 }]);
    }) as unknown as Sql;
    const repo = createOpeningJobRepository(sql);
    await expect(repo.sourcePrivacyEpoch(SOURCE, WORKSPACE)).resolves.toBe(7);
    expect(queries[0]).toContain("JOIN workspaces");
  });
});

type Options = {
  kind?: string;
  payload?: unknown;
  missing?: boolean;
  lockedMissing?: boolean;
  lost?: boolean;
  moved?: boolean;
  historyError?: Error;
  helperMissing?: boolean;
  currentOwner?: string | null;
};
function claimSql(options: Options = {}) {
  const recorded: { query: string; values: unknown[] }[] = [];
  let rolledBack = false;
  const sql = ((parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.join("?").replace(/\s+/g, " ").trim();
    recorded.push({ query, values });
    if (query.startsWith("SELECT w.id, w.owner_user_id")) return Promise.resolve(options.missing ? [] : [{ id: WORKSPACE, owner_user_id: OWNER }]);
    if (query.startsWith("SELECT id FROM workspaces")) return Promise.resolve(options.helperMissing ? [] : [{ id: WORKSPACE }]);
    if (query.startsWith("INSERT INTO opening_workspace_history_revisions")) {
      if (options.historyError) return Promise.reject(options.historyError);
      return Promise.resolve([]);
    }
    if (query.startsWith("SELECT revision FROM opening_workspace_history_revisions")) return Promise.resolve([{ revision: 17 }]);
    if (query.startsWith("SELECT w.id FROM workspaces")) return Promise.resolve(options.lockedMissing ? [] : [{ id: WORKSPACE }]);
    if (query.startsWith("SELECT owner_user_id FROM workspaces")) return Promise.resolve(options.currentOwner === null ? [] : [{ owner_user_id: options.currentOwner ?? OWNER }]);
    if (query.startsWith("SELECT workspace_id FROM opening_jobs")) return Promise.resolve([{ workspace_id: options.moved ? "elsewhere" : WORKSPACE }]);
    if (query.startsWith("UPDATE opening_jobs SET state = 'running'")) return Promise.resolve(options.lost ? [] : [{
      id: "job-1", workspace_id: WORKSPACE, owner_user_id: "legacy-job-owner", key: "parse:1",
      kind: options.kind ?? "parse", payload: options.payload ?? { sourceId: SOURCE, sourceVersion: 1 },
      result: null, state: "running", privacy_epoch: 7, claim_token: values[0],
    }]);
    if (query.startsWith("UPDATE opening_sources")) return Promise.resolve([]);
    throw new Error(`unexpected query: ${query}`);
  }) as unknown as Sql;
  sql.begin = (async (callback: (tx: Sql) => Promise<unknown>) => {
    try { return await callback(sql); }
    catch (error) { rolledBack = true; throw error; }
  }) as Sql["begin"];
  return { sql, recorded, rolledBack: () => rolledBack };
}

describe("opening job claim projects parse running", () => {
  it.each(["parse", "parse-media"])("claims %s with canonical history before table fence and preserves job owner", async kind => {
    const db = claimSql({ kind });
    const claimed = await createOpeningJobRepository(db.sql).claim("job-1");
    expect(claimed).toMatchObject({ state: "running", kind, ownerUserId: "legacy-job-owner", claimToken: expect.any(String) });
    const history = db.recorded.find(r => r.query.startsWith("INSERT INTO opening_workspace_history_revisions"))!;
    expect(history.values).toEqual([WORKSPACE, OWNER]);
    const lockIndex = db.recorded.findIndex(r => r.query.includes("FOR UPDATE"));
    const shareIndex = db.recorded.findIndex(r => r.query.includes("FOR SHARE OF w"));
    expect(lockIndex).toBeLessThan(shareIndex);
    const cas = db.recorded.find(r => r.query.startsWith("UPDATE opening_jobs"))!;
    expect(cas.query).toContain("workspace_id = ? AND state = 'queued'");
    expect(cas.values).toContain(WORKSPACE);
    const marker = db.recorded.find(r => r.query.startsWith("UPDATE opening_sources"))!;
    expect(marker.values).toContain(SOURCE);
    expect(marker.values).toContain(1);
    expect(marker.query).toContain("s.workspace_id = ?");
    expect(marker.query).toContain("s.upload_state = 'uploaded'");
    expect(marker.query).toContain("s.version = ?::integer");
    expect(marker.query).toContain("('not_started', 'queued', 'running')");
  });

  it.each([{ missing: true }, { lost: true }])("does not touch sources on missing/lost claim %j", async options => {
    const db = claimSql(options);
    expect(await createOpeningJobRepository(db.sql).claim("job-1")).toBeNull();
    expect(db.rolledBack()).toBe(false);
    expect(db.recorded.some(r => r.query.startsWith("UPDATE opening_sources"))).toBe(false);
  });

  it.each([{ lockedMissing: true }, { lost: true, moved: true }, { helperMissing: true, currentOwner: "new-owner" }, { helperMissing: true, currentOwner: null }])("rolls back identity drift %j to null", async options => {
    const db = claimSql(options);
    expect(await createOpeningJobRepository(db.sql).claim("job-1")).toBeNull();
    expect(db.rolledBack()).toBe(true);
    expect(db.recorded.some(r => r.query.startsWith("UPDATE opening_sources"))).toBe(false);
  });

  it("does not swallow helper NOT_FOUND when the candidate owner still matches", async () => {
    const db = claimSql({ helperMissing: true });
    await expect(createOpeningJobRepository(db.sql).claim("job-1")).rejects.toMatchObject({ code: "NOT_FOUND", message: "workspace not found" });
    expect(db.rolledBack()).toBe(true);
  });

  it.each(["55P03", "22P02", "XX000", "NOT_FOUND"])("propagates original history failure %s without retry", async code => {
    const error = Object.assign(new Error("original SQL/helper failure"), { code });
    const db = claimSql({ historyError: error });
    await expect(createOpeningJobRepository(db.sql).claim("job-1")).rejects.toBe(error);
    expect(db.rolledBack()).toBe(true);
    expect(db.recorded.filter(r => r.query.startsWith("INSERT INTO opening_workspace_history_revisions"))).toHaveLength(1);
  });

  it.each([{ sourceId: "invalid" }, { sourceId: 1 }, {}])("preserves invalid source marker no-op %j", async payload => {
    const db = claimSql({ payload });
    expect(await createOpeningJobRepository(db.sql).claim("job-1")).toMatchObject({ state: "running" });
    expect(db.recorded.some(r => r.query.startsWith("UPDATE opening_sources"))).toBe(false);
  });
});
