import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { readOpeningBackupRecords } from "./opening-backup-records";

const workspaceId = "a1000000-0000-4000-8000-000000000001";
const ownerUserId = "b2000000-0000-4000-8000-000000000001";
type Call = { query: string; values: unknown[] };

function flatten(value: unknown, values: unknown[]): string {
  if (value && typeof value === "object" && "fragment" in value) {
    const nested = value as unknown as { strings: TemplateStringsArray; values: unknown[] };
    return nested.strings.reduce((sql, part, index) => {
      const next = index < nested.strings.length - 1 ? flatten(nested.values[index], values) : "";
      return sql + part + next;
    }, "");
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

function queryFor(calls: Call[], table: string): string {
  return calls.find((call) => call.query.includes(`FROM ${table}`))?.query ?? "";
}

function existsBlocks(sql: string): string[] {
  const blocks: string[] = [];
  for (const match of sql.matchAll(/\b(?:NOT\s+)?EXISTS\s*\(/gi)) {
    let depth = 1;
    let index = (match.index ?? 0) + match[0].length;
    for (; index < sql.length && depth > 0; index += 1) {
      if (sql[index] === "(") depth += 1;
      else if (sql[index] === ")") depth -= 1;
    }
    blocks.push(sql.slice(match.index ?? 0, index));
  }
  return blocks;
}

function assertDirectOuterAlias(sql: string, outer: "t" | "p") {
  const column = outer === "t" ? "id" : "problem_id";
  const table = outer === "t" ? "opening_turns" : "opening_problem_refs";
  expect(existsBlocks(sql).filter((block) => new RegExp(`FROM ${table} ${outer}\\b`).test(block))).toEqual([]);
  expect(sql).toMatch(new RegExp(`\\b${outer}\\.${column}\\b`));
  expect(sql).not.toMatch(new RegExp(`\\b${outer}\\.${column} = ${outer}\\.${column}\\b`));
  expect(sql).toMatch(/owner_user_id/);
}

describe("opening backup record lineage filters", () => {
  it("owner-scopes derived rows and excludes locators/deleted memories", async () => {
    const sql = fakeSql((call) => call.query.includes("FROM workspaces") ? [{ privacy_epoch: 1 }] : []);
    await readOpeningBackupRecords(sql, { workspaceId, ownerUserId });
    const query = (table: string) => queryFor(sql.calls, table);
    expect(query("opening_turns")).toMatch(/opening_conversations|owner_user_id/);
    expect(query("opening_problem_refs")).toMatch(/opening_learning_sessions|owner_user_id/);
    expect(query("opening_help_exposures")).toMatch(/opening_learning_sessions|owner_user_id/);
    expect(query("opening_plan_acceptances")).toMatch(/JOIN opening_plan_drafts/);
    expect(query("opening_memories")).toMatch(/status <> 'deleted'/);
    expect(query("opening_memories")).toMatch(/opening_privacy_exclusions|memory_id/);
    for (const call of sql.calls) expect(call.query).not.toMatch(/image_object_key/);
  });

  it("binds direct turn and problem reads to outer rows", async () => {
    const sql = fakeSql((call) => call.query.includes("FROM workspaces") ? [{ privacy_epoch: 1 }] : []);
    await readOpeningBackupRecords(sql, { workspaceId, ownerUserId });
    assertDirectOuterAlias(queryFor(sql.calls, "opening_turns"), "t");
    assertDirectOuterAlias(queryFor(sql.calls, "opening_problem_refs"), "p");
  });

  it("scans JSONB citations and rejects invalid source versions", async () => {
    const sql = fakeSql((call) => call.query.includes("FROM workspaces") ? [{ privacy_epoch: 1 }] : []);
    await readOpeningBackupRecords(sql, { workspaceId, ownerUserId });
    const turns = queryFor(sql.calls, "opening_turns");
    expect(turns).toMatch(/jsonb_typeof\(\s*t\.citations\s*\)/);
    expect(turns).toMatch(/jsonb_array_elements|sourceId|sourceVersion/);
    expect(turns).toMatch(/jsonb_typeof\(\s*t\.source_versions\s*\) = 'object'/);
    expect(turns).toMatch(/jsonb_typeof\([^)]*\) <> 'number'/);
    expect(turns).not.toMatch(/NULLIF\(\s*t\.citations/);
  });

  it("correlates nested help, observations, candidates, and memories", async () => {
    const sql = fakeSql((call) => call.query.includes("FROM workspaces") ? [{ privacy_epoch: 1 }] : []);
    await readOpeningBackupRecords(sql, { workspaceId, ownerUserId });
    const help = queryFor(sql.calls, "opening_help_exposures");
    expect(help).toMatch(/h\.turn_id|h\.problem_id|opening_privacy_exclusions|owner_user_id/);
    const observations = queryFor(sql.calls, "opening_learning_observations");
    expect(observations).toMatch(/ref\.turn_id|o\.problem_id/);
    const candidates = queryFor(sql.calls, "opening_assistant_candidates");
    expect(candidates).toMatch(/a\.source_turn_id/);
    const memories = queryFor(sql.calls, "opening_memories");
    expect(memories).toMatch(/ref\.turn_id|memory_id|owner_user_id/);
    for (const query of [help, observations, candidates, memories]) {
      expect(query).not.toMatch(/\bt\.id = t\.id\b|\bp\.problem_id = p\.problem_id\b/);
    }
  });

  it("omits excluded or missing lineage in help, problems, and memories", async () => {
    const sql = fakeSql((call) => call.query.includes("FROM workspaces") ? [{ privacy_epoch: 1 }] : []);
    await readOpeningBackupRecords(sql, { workspaceId, ownerUserId });
    const help = queryFor(sql.calls, "opening_help_exposures");
    expect(help).toMatch(/opening_learning_sessions|opening_problem_refs|opening_turns/);
    expect(help).toMatch(/upload_state = 'uploaded'|source_version|chunk_id/);
    const problems = queryFor(sql.calls, "opening_problem_refs");
    expect(problems).toMatch(/opening_sources|opening_source_chunks|upload_state = 'uploaded'/);
    const memories = queryFor(sql.calls, "opening_memories");
    expect(memories).toMatch(/jsonb_array_elements_text|opening_turns|NOT EXISTS/);
  });
});
