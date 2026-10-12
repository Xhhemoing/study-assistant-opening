import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("V2-14 teaching resume database surfaces", () => {
  it("setStatus exists on activities repo", () => {
    const src = readFileSync(
      resolve(__dirname, "opening-teaching-activities.ts"),
      "utf8",
    );
    expect(src).toMatch(/async setStatus\(/);
    expect(src).toMatch(/status: "active" \| "paused"/);
  });

  it("saveCheckpoint merges via mergeCheckpointResumePatch + CAS", () => {
    const src = readFileSync(
      resolve(__dirname, "opening-teaching-content.ts"),
      "utf8",
    );
    expect(src).toMatch(/async saveCheckpoint\(/);
    expect(src).toMatch(/mergeCheckpointResumePatch/);
    expect(src).toMatch(/stale activity content version for checkpoint save/);
    expect(src).toMatch(/draft_anchor_lost/);
  });

  it("activity-scoped help + attempt + observation head lists exist", () => {
    const help = readFileSync(
      resolve(__dirname, "opening-learning-help.ts"),
      "utf8",
    );
    const attempts = readFileSync(
      resolve(__dirname, "opening-learning-attempts.ts"),
      "utf8",
    );
    const obs = readFileSync(
      resolve(__dirname, "opening-learning-observations.ts"),
      "utf8",
    );
    const facts = readFileSync(
      resolve(__dirname, "opening-learning-facts.ts"),
      "utf8",
    );
    expect(help).toMatch(/listDeliveredHelpByActivity/);
    expect(attempts).toMatch(/listByActivity/);
    expect(obs).toMatch(/listObservationHeadsByActivity/);
    expect(facts).toMatch(/probeLearningSourcesAvailability/);
  });

  // T18 originally asserted "no 0058" to prove the teaching resume surface needs no
  // migration. 0058 is now taken by LAB-U01 (0058_opening_turn_clarify.sql), so the
  // invariant is restated: the only migration after 0057 is the clarify one, and no
  // teaching/resume migration was invented.
  it("T18 resume surface adds no migration (0058 is LAB-U01 clarify only)", () => {
    const files = readdirSync(resolve(__dirname, "../migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    // PR-D: 0059_opening_budget_reconcile (budget ledger) is the only addition
    // after PR-C's clarify migration; still no teaching/resume migration.
    expect(files.filter((f) => f >= "0058")).toEqual(["0058_opening_turn_clarify.sql", "0059_opening_budget_reconcile.sql"]);
    expect(files.some((f) => /resume/i.test(f))).toBe(false);
  });
});
