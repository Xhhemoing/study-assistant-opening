import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  mapGenerateStatusToJobGate,
  mergeCheckpointResumePatch,
  deriveOpenProblems,
} from "@aistudy/domain";

describe("resume-service surface (V2-14)", () => {
  it("T6 assemble path does not import summarizeLearning / read-service", () => {
    const src = readFileSync(resolve(__dirname, "resume-service.ts"), "utf8");
    expect(src).not.toMatch(/from ["'].*read-service["']/);
    expect(src).not.toMatch(/\bsummarizeLearning\s*\(/);
    expect(src).toMatch(/assertResumeIndependentOfSummary/);
    expect(src).toMatch(/resumeSummarySkipped/);
    expect(src).toMatch(/createOpeningTeachingResumeService/);
  });

  it("T3/T5/T9 helpers used by assemble", () => {
    expect(mapGenerateStatusToJobGate("unknown")).toBe("unknown");
    const merged = mergeCheckpointResumePatch(
      {
        interventionPrefs: { a: 1 },
        commandLog: [],
        branchStack: [],
      },
      { interactionParams: {} },
    );
    expect(merged.interventionPrefs).toEqual({ a: 1 });
    expect(merged.commandLog).toEqual([]);
    expect(
      deriveOpenProblems({
        attempts: [],
        observationHeads: [
          {
            problemId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            itemVersionId: null,
            outcome: "unverified",
          },
        ],
      })[0]?.reason,
    ).toBe("unverified_unresolved");
  });

  // T18: the resume surface must not invent a migration. 0058 is now taken by LAB-U01
  // (0058_opening_turn_clarify.sql); keep the known later migrations explicit.
  it("T18 no resume migration invented among known migrations after 0057", () => {
    const migrDir = resolve(
      __dirname,
      "../../../../../../packages/database/src/migrations",
    );
    const numbered = readdirSync(migrDir)
      .filter((f) => f.endsWith(".sql") && /^\d{4}_/.test(f))
      .sort();
    // PR-D: 0059_opening_budget_reconcile (budget ledger); PR-E: 0060_opening_retest_accept_key (retest accept key);
    // 0061 planning; 0062 model routing + card evidence; 0063 quick setup idempotency;
    // 0064 card source lineage; 0065 task requirement scope; 0066 BKT measurement; 0067 planning feedback. Still no teaching/resume migration.
    expect(numbered.filter((f) => f >= "0058")).toEqual([
      "0058_opening_turn_clarify.sql", "0059_opening_budget_reconcile.sql", "0060_opening_retest_accept_key.sql",
      "0061_opening_adaptive_planning.sql", "0062_opening_model_routing_and_card_evidence.sql", "0063_opening_model_quick_setup.sql", "0064_card_source_lineage.sql",
      "0065_opening_task_requirement.sql", "0066_opening_measurement.sql", "0067_opening_plan_feedback.sql",
    ]);
    expect(numbered.some((f) => /resume/i.test(f))).toBe(false);
  });
});
