import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("0057_opening_help_exposure_kind migration (V2-13 T15/T18)", () => {
  const sql = readFileSync(
    resolve(__dirname, "0057_opening_help_exposure_kind.sql"),
    "utf8",
  );

  it("adds kind CHECK + backfills hint only; no independent/correct/transfer backfill", () => {
    expect(sql).toMatch(/kind TEXT/);
    expect(sql).toMatch(/CHECK \(kind IN \('instruction', 'hint', 'solution'\)\)/);
    expect(sql).toMatch(/SET kind = 'hint'/);
    expect(sql).toMatch(/activity_id UUID NULL/);
    expect(sql).toMatch(/item_version_id UUID NULL/);
    // Backfill assignment must be hint-only (comments may mention forbidden words).
    const sets = [...sql.matchAll(/SET\s+kind\s*=\s*'([^']+)'/g)].map((m) => m[1]);
    expect(sets).toEqual(["hint"]);
    expect(sql).not.toMatch(/CREATE TABLE\s+opening_teaching_mastery/i);
    expect(sql).not.toMatch(/CREATE TABLE\s+opening_\w*mastery/i);
  });
});
