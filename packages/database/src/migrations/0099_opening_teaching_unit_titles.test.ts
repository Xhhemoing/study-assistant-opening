import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { listMigrationFiles } from "../migrate";

describe("0099_opening_teaching_unit_titles migration", () => {
  const sql = readFileSync(resolve(__dirname, "0099_opening_teaching_unit_titles.sql"), "utf8");
  const statements = sql.replace(/--[^\n]*/g, "");

  it("is the next contiguous migration", async () => {
    const files = await listMigrationFiles();
    expect(files.at(-1)).toBe("0099_opening_teaching_unit_titles.sql");
  });

  it("only renames the exact worker placeholder and never a learner-edited title", () => {
    expect(statements).toMatch(/d\.title ~ '\^Teaching draft \[0-9a-f\]\{8\}\$'/);
    expect(statements).toMatch(/AND d\.title = b\.old_title/);
    expect(statements).toMatch(/AND u\.title = b\.old_title/);
  });

  it("uses the worker's title rule: first intent_summary line, trimmed, 120 chars, 学习讲义 fallback", () => {
    expect(statements).toMatch(/split_part\(r\.intent_summary, E'\\n', 1\)/);
    expect(statements).toMatch(/NULLIF\(left\(regexp_replace\(split_part\(.*, 120\), ''\)/);
    expect(statements).toContain("'学习讲义'");
  });

  it("resolves the activity through the published spec before the placeholder id prefix", () => {
    expect(statements).toMatch(/JOIN opening_teaching_activity_specs s\s+ON s\.teaching_unit_id = p\.unit_id/);
    expect(statements).toMatch(/HAVING count\(\*\) = 1/);
  });

  it("is data-only: no DDL, no append-only revision writes, no updated_at bump", () => {
    expect(statements).not.toMatch(/\b(CREATE|ALTER|DROP|TRUNCATE|DELETE)\b/i);
    expect(statements).not.toMatch(/UPDATE\s+library_revisions/i);
    expect(statements).not.toMatch(/updated_at\s*=/i);
    expect(statements.match(/\bUPDATE\s+\w+/gi)).toEqual([
      "UPDATE library_documents",
      "UPDATE opening_teaching_units",
    ]);
  });
});
