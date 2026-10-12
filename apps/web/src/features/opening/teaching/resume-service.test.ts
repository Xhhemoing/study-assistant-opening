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
  // (0058_opening_turn_clarify.sql); anything else after 0057 would be a violation.
  it("T18 no resume migration invented; only LAB-U01 0058 follows 0057", () => {
    const migrDir = resolve(
      __dirname,
      "../../../../../../packages/database/src/migrations",
    );
    const numbered = readdirSync(migrDir)
      .filter((f) => f.endsWith(".sql") && /^\d{4}_/.test(f))
      .sort();
    expect(numbered.filter((f) => f >= "0058")).toEqual(["0058_opening_turn_clarify.sql"]);
    expect(numbered.some((f) => /resume/i.test(f))).toBe(false);
  });
});
