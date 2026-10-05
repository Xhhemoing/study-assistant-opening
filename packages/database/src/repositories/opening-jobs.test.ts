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
