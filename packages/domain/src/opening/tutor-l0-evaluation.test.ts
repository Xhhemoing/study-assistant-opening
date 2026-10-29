import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluateTutorL0, judgeTutorL0Output, parseTutorL0Fixture, tutorL0MeasurementSkeleton } from "./tutor-l0-evaluation";

const fixture = () => JSON.parse(readFileSync(new URL("../../../../tests/fixtures/opening/tutor-l0-cases.json", import.meta.url), "utf8"));

describe("offline synthetic L0", () => {
  it("CLI rejects bad options and refuses overwriting its fixture", () => {
    const root = fileURLToPath(new URL("../../../../", import.meta.url));
    const run = (args: string[]) => spawnSync(process.execPath,
      ["--import", "tsx", "scripts/evaluate-tutor-l0.ts", ...args], { cwd: root, encoding: "utf8", timeout: 20_000 });
    expect(run(["--unknown", "x"]).status).toBe(1);
    const result = run(["--fixture", "tests/fixtures/opening/tutor-l0-cases.json", "--output", "tests/fixtures/opening/tutor-l0-cases.json"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must not overwrite");
    expect(run(["--help"]).status).toBe(0);
  }, 60_000);
  it("keeps missing and violating outputs in the denominator", () => {
    const data = parseTutorL0Fixture(fixture());
    const first = data.cases[0]!;
    expect(judgeTutorL0Output(first, undefined).status).toBe("missing_output");
    expect(judgeTutorL0Output(first, { decision: { activityKind: "full_explain" } }).status).toBe("fail");
    const forbidden = { ...first, gold: { ...first.gold, forbidden: { "decision.activityKind": ["diagnose"] } } };
    expect(judgeTutorL0Output(forbidden, { decision: { activityKind: "diagnose", reasonCode: "no_evidence" } }))
      .toEqual({ status: "fail", violations: ["forbidden:decision.activityKind"] });
    expect(judgeTutorL0Output(first, { decision: { reasonCode: "no_evidence" } }).status).toBe("fail");
    const report = evaluateTutorL0(data, () => undefined);
    expect(report.summary).toMatchObject({ denominator: 48, passed: 0, failed: 48, missing: 48 });
  });
  it("does not fabricate receipts or turn synthetic results into learning gains", () => {
    const report = evaluateTutorL0(fixture());
    expect(report.cases).toHaveLength(48);
    expect(report.summary.failed, JSON.stringify(report.cases.filter(row => row.judgment.status !== "pass"))).toBe(0);
    for (const row of report.cases) {
      expect(row.scope).toEqual({ toolSideEffects: "unknown", teachingSemantics: "unknown", humanLearningEffect: "unknown" });
      expect(row.entrypoint).toBeTruthy();
      expect(row.policyVersion).toBeTruthy();
      expect(row.actualOutput).toBeDefined();
      expect(JSON.stringify(row.actualOutput)).not.toContain('"saved":true');
    }
  });
  it("rejects malformed external input, duplicate IDs, and incomplete gold", () => {
    expect(() => parseTutorL0Fixture({ cases: [] })).toThrow();
    const invalid = fixture();
    invalid.cases[0].input.observations = "bad";
    expect(() => parseTutorL0Fixture(invalid)).toThrow();
    const duplicate = fixture();
    duplicate.cases[1].caseId = duplicate.cases[0].caseId;
    expect(() => parseTutorL0Fixture(duplicate)).toThrow();
    const noGold = fixture();
    noGold.cases[0].gold.allowed = [];
    expect(() => parseTutorL0Fixture(noGold)).toThrow();
  });
  it("preserves execution errors and never treats an exception as a pass", () => {
    const report = evaluateTutorL0(fixture(), () => { throw new Error("synthetic failure"); });
    expect(report.summary).toMatchObject({ denominator: 48, passed: 0, failed: 48, errors: 48 });
    expect(report.cases[0]?.error).toBe("synthetic failure");
  });
  it("keeps both tutor policy overloads separately attributable", () => {
    const report = evaluateTutorL0(fixture());
    expect(new Set(report.cases.map(row => row.entrypoint)).size).toBe(5);
    const thin = report.cases.find(row => row.caseId === "thin-hint-offer");
    expect(thin?.actualOutput).toMatchObject({ kind: "worked_example" });
    expect(thin?.scope.toolSideEffects).toBe("unknown");
  });
  it("retains five dimensions, day 7/30 and all unobserved denominators", () => {
    const measurement = tutorL0MeasurementSkeleton();
    expect(new Set(measurement.groups.map(row => row.dimension)).size).toBe(5);
    expect(measurement.groups.filter(row => row.dimension === "unaided_application").map(row => row.timepoint)).toEqual(["day_7", "day_30"]);
    for (const group of measurement.groups) {
      expect(group.metric.value).toBeNull();
      expect(group.metric.dataStatus).toBe("unknown");
      expect(group.metric.denominator).toBe(2);
      expect(group.metric.excludedReasonCounts).toEqual({ not_observed: 2, synthetic_material: 2 });
    }
    expect(measurement.legacyPredictionReport.presented).toBe(0);
    expect(measurement.legacyPredictionReport.models.every(model => model.brier === null)).toBe(true);
    expect(measurement.realBenefit).toBe("unknown");
  });
});
