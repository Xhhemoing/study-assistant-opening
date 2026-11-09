import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { createOpeningSourceRepository, OpeningSourceError, type OpeningScope } from "./opening-sources";

const W = "00000000-0000-4000-8000-000000000001";
const O = "00000000-0000-4000-8000-000000000002";
const S = "00000000-0000-4000-8000-000000000003";
const scope = { workspaceId: W, ownerUserId: O };
const job = { ...scope, jobExecution: { id: S, token: W, privacyEpoch: 7 } };
const row = { id: S, workspace_id: W, name: "notes.pdf", mime: "application/pdf", bytes: 8,
  sha256: "a".repeat(64), version: 1, upload_state: "uploaded", parse_state: "ready", error: null,
  created_at: new Date("2026-01-01") };
type Call = { query: string; values: unknown[] };
function database(handle?: (call: Call) => unknown[] | undefined) {
  const calls: Call[] = [];
  let transactions = 0;
  const sql = ((parts: TemplateStringsArray, ...values: unknown[]) => {
    const call = { query: parts.join("?").replace(/\s+/g, " ").trim(), values };
    calls.push(call);
    const result = handle?.(call);
    if (result !== undefined) return Promise.resolve(result);
    if (call.query.startsWith("SELECT owner_user_id")) return Promise.resolve([{ owner_user_id: O }]);
    if (call.query.startsWith("SELECT id FROM workspaces")) return Promise.resolve([{ id: W }]);
    if (call.query.startsWith("SELECT id FROM opening_jobs")) return Promise.resolve([{ id: S }]);
    if (call.query.startsWith("SELECT revision")) return Promise.resolve([{ revision: 23 }]);
    if (call.query.startsWith("INSERT INTO opening_workspace_history_revisions")) return Promise.resolve([]);
    if (call.query.startsWith("UPDATE opening_sources")) return Promise.resolve([row]);
    if (call.query.startsWith("SELECT ?::uuid")) return Promise.resolve([]);
    throw new Error("unexpected query: " + call.query);
  }) as unknown as Sql;
  sql.json = value => value as never;
  sql.begin = (async (callback: (tx: Sql) => Promise<unknown>) => {
    transactions++;
    return callback(sql);
  }) as Sql["begin"];
  return { sql, calls, transactions: () => transactions };
}
const staleError = { code: "CONFLICT", message: "job execution is no longer current" };

describe("markParseState narrow history boundary", () => {
  it.each(["workspace", "job"])("keeps stale %s ahead of missing or invalid source without touching history", async stale => {
    for (const id of [S, "invalid-source-uuid"]) {
      const db = database(({ query }) => query.startsWith(stale === "workspace"
        ? "SELECT id FROM workspaces" : "SELECT id FROM opening_jobs") ? [] : undefined);
      await expect(createOpeningSourceRepository(db.sql).markParseState(job, id, "ready")).rejects.toMatchObject(staleError);
      expect(db.calls.every(c => !c.query.includes("history") && !c.query.includes("opening_sources"))).toBe(true);
    }
  });

  it("checks exact job identity before history and rechecks the locked gate after history", async () => {
    const db = database();
    expect(await createOpeningSourceRepository(db.sql).markParseState(job, S, "ready")).toMatchObject({ id: S, parseState: "ready" });
    const history = db.calls.findIndex(c => c.query.startsWith("INSERT INTO opening_workspace_history_revisions"));
    const gates = db.calls.filter(c => c.query.startsWith("SELECT id FROM opening_jobs"));
    expect(gates).toHaveLength(2);
    expect(gates[0]!.values).toEqual([S, W, O, W]);
    expect(gates[0]!.query).toContain("state = 'running' AND claim_token = ?");
    expect(gates[0]!.query).not.toContain("FOR SHARE");
    expect(gates[1]!.query).toContain("FOR SHARE");
    expect(db.calls.indexOf(gates[0]!)).toBeLessThan(history);
    expect(db.calls.indexOf(gates[1]!)).toBeGreaterThan(history);
    expect(db.calls.filter(c => c.query.startsWith("SELECT id FROM workspaces"))[0]!.values).toEqual([W, O, 7]);
    expect(db.calls.at(-1)!.query).toContain("UPDATE opening_sources");
  });

  it.each(["", "not-a-uuid", W])("uses canonical history owner, never caller owner %j as new authorization/cast input", async ownerUserId => {
    const db = database();
    await createOpeningSourceRepository(db.sql).markParseState({ ...scope, ownerUserId }, S, "ready");
    expect(db.transactions()).toBe(1);
    expect(db.calls.find(c => c.query.startsWith("INSERT INTO opening_workspace_history_revisions"))!.values).toEqual([W, O]);
    expect(db.calls.filter(c => c.query.startsWith("SELECT owner_user_id"))[0]!.values).toEqual([W]);
    expect(db.calls.some(c => c.query.includes("FOR SHARE"))).toBe(true);
    expect(db.calls.some(c => c.query.startsWith("UPDATE opening_workspace_history_revisions") || c.query.includes("eligibility"))).toBe(false);
  });

  it("retains the source-only missing-workspace path and typed missing-source error", async () => {
    const db = database(({ query }) => query.startsWith("SELECT owner_user_id") || query.startsWith("UPDATE opening_sources") ? [] : undefined);
    const work = createOpeningSourceRepository(db.sql).markParseState({ ...scope, ownerUserId: "" }, S, "ready");
    await expect(work).rejects.toBeInstanceOf(OpeningSourceError);
    await expect(work).rejects.toMatchObject({ code: "NOT_FOUND", message: `Source not found: ${S}` });
    expect(db.calls.map(c => c.query.split(" ")[0])).toEqual(["SELECT", "UPDATE"]);
  });

  it.each(["canonical", "history", "history-lock", "workspace-lock", "job-lock", "update"])("propagates driver/cast errors unchanged at %s", async boundary => {
    for (const code of ["55P03", "22P02", "XX000"]) {
      const failure = Object.assign(new Error("driver failure"), { code });
      const db = database(({ query }) => {
        if ((boundary === "canonical" && query.startsWith("SELECT owner_user_id"))
          || (boundary === "history-lock" && query.startsWith("SELECT revision"))
          || (boundary === "history" && query.startsWith("INSERT INTO opening_workspace_history_revisions"))
          || (boundary === "workspace-lock" && query.includes("FROM workspaces") && query.includes("FOR SHARE"))
          || (boundary === "job-lock" && query.includes("FROM opening_jobs") && query.includes("FOR SHARE"))
          || (boundary === "update" && query.startsWith("UPDATE opening_sources"))) throw failure;
        return undefined;
      });
      await expect(createOpeningSourceRepository(db.sql).markParseState(boundary === "canonical" ? scope : job, S, "ready")).rejects.toBe(failure);
    }
  });

  it.each([job, scope])("translates only the helper's exact workspace-not-found error (%j)", async input => {
    const exact = Object.assign(new Error("workspace not found"), { code: "NOT_FOUND" });
    const db = database(({ query }) => {
      if (query.startsWith("SELECT id FROM workspaces") && !query.includes("privacy_epoch")) throw exact;
      return undefined;
    });
    await expect(createOpeningSourceRepository(db.sql).markParseState(input, S, "ready")).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it.each([
    Object.assign(new Error("different message"), { code: "NOT_FOUND" }),
    Object.assign(new Error("workspace not found"), { code: "22P02" }),
    { code: "NOT_FOUND", message: "workspace not found" },
  ])("does not blanket-translate helper/driver errors %j", async failure => {
    const db = database(({ query }) => {
      if (query.startsWith("INSERT INTO opening_workspace_history_revisions")) throw failure;
      return undefined;
    });
    await expect(createOpeningSourceRepository(db.sql).markParseState(scope, S, "ready")).rejects.toBe(failure);
  });

  it.each([job, scope] satisfies OpeningScope[])("keeps valid-gate missing source typed (%j)", async input => {
    const db = database(({ query }) => query.startsWith("UPDATE opening_sources") ? [] : undefined);
    const work = createOpeningSourceRepository(db.sql).markParseState(input, S, "ready");
    await expect(work).rejects.toBeInstanceOf(OpeningSourceError);
    await expect(work).rejects.toMatchObject({ code: "NOT_FOUND", message: `Source not found: ${S}` });
  });
});
