import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { failOpeningJob } from "./opening-job-failure";

const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const SOURCE = "00000000-0000-4000-8000-000000000003";

describe("opening parse job failure projection", () => {
  it("projects a current parse failure without treating workspace epoch as source version", async () => {
    const queries: string[] = [];
    const sql = ((parts: TemplateStringsArray, ..._values: unknown[]) => {
      const query = parts.join("?").replace(/\s+/g, " ").trim();
      queries.push(query);
      if (query.startsWith("SELECT w.id")) return Promise.resolve([{ id: WORKSPACE, owner_user_id: "user-1", privacy_epoch: 7 }]);
      if (query.startsWith("UPDATE opening_jobs")) return Promise.resolve([{ kind: "parse", owner_user_id: "user-1", payload: { sourceId: SOURCE }, privacy_epoch: 7 }]);
      if (query.startsWith("UPDATE opening_sources")) return Promise.resolve([]);
      throw new Error(`unexpected query: ${query}`);
    }) as unknown as Sql;
    sql.json = ((value: unknown) => value) as never;
    sql.begin = (async (callback: (tx: Sql) => Promise<unknown>) => callback(sql)) as Sql["begin"];

    await expect(failOpeningJob(sql, "job-1", { error: "failed" })).resolves.toBe(true);
    expect(queries.at(-1)).not.toContain("s.version");
  });

  it("marks a stale parse source failed so it cannot remain pending forever", async () => {
    const queries: string[] = [];
    const sql = ((parts: TemplateStringsArray, ..._values: unknown[]) => {
      const query = parts.join("?").replace(/\s+/g, " ").trim();
      queries.push(query);
      if (query.startsWith("SELECT w.id")) return Promise.resolve([{ id: WORKSPACE, owner_user_id: "user-1", privacy_epoch: 7 }]);
      if (query.startsWith("UPDATE opening_jobs")) return Promise.resolve([{ kind: "parse", owner_user_id: "user-1", payload: { sourceId: SOURCE }, privacy_epoch: 6 }]);
      if (query.startsWith("UPDATE opening_sources")) return Promise.resolve([]);
      throw new Error(`unexpected query: ${query}`);
    }) as unknown as Sql;
    sql.json = ((value: unknown) => value) as never;
    sql.begin = (async (callback: (tx: Sql) => Promise<unknown>) => callback(sql)) as Sql["begin"];

    await expect(failOpeningJob(sql, "job-1", { error: "stale" })).resolves.toBe(true);
    expect(queries.filter((query) => query.startsWith("UPDATE opening_sources") && query.includes("parse_state = 'failed'")).length).toBe(2);
  });
});

