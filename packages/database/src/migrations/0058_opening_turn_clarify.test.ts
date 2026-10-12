import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(resolve(__dirname, name), "utf8");
const statusList = (sql: string) =>
  [...sql.matchAll(/^\s*CHECK \(status IN \(([^)]*)\)\);/gm)].map((m) =>
    m[1]!.split(",").map((v) => v.trim().replace(/^'|'$/g, "")));

describe("0058_opening_turn_clarify migration (LAB-U01)", () => {
  const sql = read("0058_opening_turn_clarify.sql");

  it("re-creates opening_turns_status_check idempotently (DROP IF EXISTS + ADD)", () => {
    expect(sql).toMatch(/ALTER TABLE opening_turns\s+DROP CONSTRAINT IF EXISTS opening_turns_status_check;/);
    expect(sql).toMatch(/ALTER TABLE opening_turns\s+ADD CONSTRAINT opening_turns_status_check/);
    expect(sql).not.toMatch(/^\s*(UPDATE|DELETE|INSERT)\b/im);
  });

  it("only appends 'clarify' to the current 0026 values", () => {
    const [current] = statusList(read("0026_opening_turn_outcome_unknown.sql"));
    const [next] = statusList(sql);
    expect(current).toEqual(["pending", "complete", "failed", "outcome_unknown"]);
    expect(new Set(next)).toEqual(new Set([...current!, "clarify"]));
    expect(next).toHaveLength(current!.length + 1);
  });

  it("keeps the rollback comment", () => {
    expect(sql).toMatch(/-- Rollback \(only after no row uses 'clarify'\)/);
    expect(sql).toMatch(/--\s+CHECK \(status IN \('pending', 'complete', 'failed', 'outcome_unknown'\)\);/);
  });
});
