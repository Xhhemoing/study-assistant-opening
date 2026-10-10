import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { createOpeningJobRepository } from "./opening-jobs";

const SOURCE = "00000000-0000-4000-8000-000000000003";
const WORKSPACE = "00000000-0000-4000-8000-000000000001";

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

describe("opening job claim projects parse running", () => {
  it("sets source parse_state=running when claiming a parse job", async () => {
    const recorded: { query: string; values: unknown[] }[] = [];
    const sql = ((parts: TemplateStringsArray, ...values: unknown[]) => {
      const query = parts.join("?").replace(/\s+/g, " ").trim();
      recorded.push({ query, values });
      if (query.startsWith("UPDATE opening_jobs SET state = 'running'")) {
        return Promise.resolve([{
          id: "job-1",
          workspace_id: WORKSPACE,
          owner_user_id: "user-1",
          key: "parse:1",
          kind: "parse",
          payload: { sourceId: SOURCE, sourceVersion: 1 },
          result: null,
          state: "running",
          privacy_epoch: 7,
        }]);
      }
      if (query.startsWith("UPDATE opening_sources")) return Promise.resolve([]);
      throw new Error(`unexpected query: ${query}`);
    }) as unknown as Sql;
    const repo = createOpeningJobRepository(sql);

    const claimed = await repo.claim("job-1");
    expect(claimed?.state).toBe("running");
    expect(claimed?.kind).toBe("parse");
    const sourceUpdate = recorded.find((r) => r.query.startsWith("UPDATE opening_sources"));
    expect(sourceUpdate).toBeDefined();
    expect(sourceUpdate!.query).toContain("parse_state = 'running'");
    expect(sourceUpdate!.values).toContain(SOURCE);
    expect(sourceUpdate!.values).toContain(1);
  });

  it("sets source running for parse-media claim", async () => {
    const recorded: { query: string; values: unknown[] }[] = [];
    const sql = ((parts: TemplateStringsArray, ...values: unknown[]) => {
      const query = parts.join("?").replace(/\s+/g, " ").trim();
      recorded.push({ query, values });
      if (query.startsWith("UPDATE opening_jobs SET state = 'running'")) {
        return Promise.resolve([{
          id: "job-m",
          workspace_id: WORKSPACE,
          owner_user_id: "user-1",
          key: "parse-media:1",
          kind: "parse-media",
          payload: { sourceId: SOURCE },
          result: null,
          state: "running",
          privacy_epoch: 7,
        }]);
      }
      if (query.startsWith("UPDATE opening_sources")) return Promise.resolve([]);
      throw new Error(`unexpected query: ${query}`);
    }) as unknown as Sql;
    const repo = createOpeningJobRepository(sql);

    await expect(repo.claim("job-m")).resolves.toMatchObject({ kind: "parse-media", state: "running" });
    const sourceUpdate = recorded.find((r) => r.query.startsWith("UPDATE opening_sources"));
    expect(sourceUpdate!.query).toContain("parse_state = 'running'");
  });

  it("does not touch sources when claim loses the race", async () => {
    const recorded: { query: string }[] = [];
    const sql = ((parts: TemplateStringsArray) => {
      const query = parts.join("?").replace(/\s+/g, " ").trim();
      recorded.push({ query });
      if (query.startsWith("UPDATE opening_jobs SET state = 'running'")) return Promise.resolve([]);
      throw new Error(`unexpected query: ${query}`);
    }) as unknown as Sql;
    const repo = createOpeningJobRepository(sql);

    await expect(repo.claim("missing")).resolves.toBeNull();
    expect(recorded.some((r) => r.query.startsWith("UPDATE opening_sources"))).toBe(false);
  });
});
