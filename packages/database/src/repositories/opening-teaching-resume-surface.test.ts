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
  // invariant is restated below with the known later migrations, and no
  // teaching/resume migration was invented.
  it("T18 resume surface adds no migration (0058 is LAB-U01 clarify only)", () => {
    const files = readdirSync(resolve(__dirname, "../migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    // PR-D: 0059_opening_budget_reconcile (budget ledger); PR-E: 0060_opening_retest_accept_key (retest accept key);
    // 0061 planning; 0062 model routing + card evidence; 0063 quick setup idempotency;
    // 0064 card source lineage; 0065 task requirement scope; 0066 BKT measurement; 0067 planning feedback. Still no teaching/resume migration.
    expect(files.filter((f) => f >= "0058")).toEqual([
      "0058_opening_turn_clarify.sql", "0059_opening_budget_reconcile.sql", "0060_opening_retest_accept_key.sql",
      "0061_opening_adaptive_planning.sql", "0062_opening_model_routing_and_card_evidence.sql", "0063_opening_model_quick_setup.sql", "0064_card_source_lineage.sql",
      "0065_opening_task_requirement.sql", "0066_opening_measurement.sql", "0067_opening_plan_feedback.sql", "0068_opening_plan_control.sql", "0069_opening_matrix_evaluation.sql",
    ]);
    expect(files.some((f) => /resume/i.test(f))).toBe(false);
  });
});
