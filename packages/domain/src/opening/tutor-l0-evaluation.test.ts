import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { teachingLearnerFocusSchema } from "@aistudy/contracts";
import { evaluateTutorL0, executeTutorL0Case, judgeTutorL0Output, parseTutorL0Fixture, tutorL0MeasurementSkeleton } from "./tutor-l0-evaluation";

const fixture = () => JSON.parse(readFileSync(new URL("../../../../tests/fixtures/opening/tutor-l0-cases.json", import.meta.url), "utf8"));

describe("offline synthetic L0", () => {
  const evidenceCase = () => structuredClone(fixture().cases.find((row: { caseId: string }) => row.caseId === "next-repeated-assisted-error"));
  const parseCase = (row: unknown) => parseTutorL0Fixture({ synthetic: true, offline: true, cases: [row] });

  it("replays new evidence and phase gold through the real rule and rejects regressed outputs", () => {
    const data = parseTutorL0Fixture(fixture());
    for (const caseId of ["next-repeated-assisted-error", "next-independent-success-resolves-errors", "next-due-retest", "next-explicit-consolidate"]) {
      const row = data.cases.find(row => row.caseId === caseId)!;
      const output = executeTutorL0Case(row);
      expect(judgeTutorL0Output(row, output)).toEqual({ status: "pass", violations: [] });
      for (const path of Object.keys(row.gold.allowed)) {
        const mutated = structuredClone(output) as { decision: Record<string, unknown> };
        delete mutated.decision[path.split(".")[1]!];
        expect(judgeTutorL0Output(row, mutated).status).toBe("fail");
      }
    }
    const repeated = data.cases.find(row => row.caseId === "next-repeated-assisted-error")!;
    const resolved = data.cases.find(row => row.caseId === "next-independent-success-resolves-errors")!;
    expect(judgeTutorL0Output(resolved, executeTutorL0Case(repeated)).status).toBe("fail");
    if (repeated.entry !== "nextLearningStep") throw new Error("Expected nextLearningStep fixture");
    const feedbackOnly = structuredClone(repeated);
    for (const observation of feedbackOnly.input.observations) {
      for (const error of observation.errors ?? []) error.source = "ai_feedback";
    }
    expect(executeTutorL0Case(feedbackOnly)).toMatchObject({ decision: { activityKind: "targeted_explain", reasonCode: "verified_incorrect" } });
    for (const caseId of ["next-due-retest", "next-explicit-consolidate"]) {
      const row = structuredClone(data.cases.find(row => row.caseId === caseId)!);
      if (row.entry !== "nextLearningStep") throw new Error("Expected nextLearningStep fixture");
      row.input.dueRetest = false;
      delete row.input.learningPhase;
      delete row.input.phaseSource;
      expect(executeTutorL0Case(row)).toMatchObject({ decision: { activityKind: "diagnose", reasonCode: "no_evidence", phase: "explore", phaseSource: "automatic" } });
    }
  });

  it("accepts bounded observation errors using the shared consumer schema", () => {
    const row = evidenceCase();
    const error = row.input.observations[0].errors[0];
    row.input.observations[0].errors = Array.from({ length: 3 }, () => ({ ...error,
      label: "x".repeat(200), feedback: "x".repeat(1000), misconceptionId: "a".repeat(80) }));
    expect(teachingLearnerFocusSchema.shape.recentErrors.safeParse(row.input.observations[0].errors).success).toBe(true);
    expect(() => parseCase(row)).not.toThrow();
    for (const source of ["verified_steps", "ai_feedback"]) {
      row.input.observations[0].errors = [{ ...error, source }];
      expect(() => parseCase(row)).not.toThrow();
    }
    row.input.observations[0].errors = [];
    expect(() => parseCase(row)).not.toThrow();
  });

  it.each([
    null, "bad", [{ observationId: "not-a-uuid", label: "step", feedback: "", source: "verified_steps" }],
    ...[{ label: "" }, { label: "x".repeat(201) }, { feedback: "x".repeat(1001) },
      { source: "model" }, { misconceptionId: "A" }, { misconceptionId: "a".repeat(81) }, { extra: true }]
      .map(change => [{ observationId: "11111111-1111-4111-8111-111111111111", label: "step", feedback: "", source: "verified_steps", ...change }]),
  ])("rejects malformed observation errors %#", errors => {
    const row = evidenceCase();
    row.input.observations[0].errors = errors;
    expect(() => parseCase(row)).toThrow();
  });

  it("rejects oversized error arrays and missing required error fields", () => {
    const row = evidenceCase();
    const error = row.input.observations[0].errors[0];
    row.input.observations[0].errors = Array(4).fill(error);
    expect(() => parseCase(row)).toThrow();
    for (const key of ["observationId", "label", "feedback", "source"]) {
      const incomplete = { ...error };
      delete incomplete[key];
      row.input.observations[0].errors = [incomplete];
      expect(() => parseCase(row)).toThrow();
    }
  });

  it("accepts only actual phase controls on nextLearningStep", () => {
    for (const learningPhase of ["explore", "new_learning", "consolidate", "maintain"]) {
      for (const phaseSource of ["automatic", "explicit"]) {
        const row = evidenceCase();
        Object.assign(row.input, { learningPhase, phaseSource, dueRetest: false });
        expect(() => parseCase(row)).not.toThrow();
      }
    }
    for (const change of [{ learningPhase: "review" }, { phaseSource: "learner" }, { dueRetest: "true" },
      { learningPhase: null }, { phaseSource: null }, { dueRetest: null }]) {
      const row = evidenceCase();
      Object.assign(row.input, change);
      expect(() => parseCase(row)).toThrow();
    }
    for (const entry of ["tutor.thin", "tutor.adaptive", "courseRouteRetestOutcome", "evaluateEvidenceEligibility"]) {
      for (const change of [{ errors: [] }, { dueRetest: true }, { learningPhase: "consolidate" }, { phaseSource: "explicit" }]) {
        const row = structuredClone(fixture().cases.find((row: { entry: string }) => row.entry === entry));
        Object.assign(row.input, change);
        expect(() => parseCase(row)).toThrow();
      }
    }
    const retest = structuredClone(fixture().cases.find((row: { entry: string; input: { observation?: unknown } }) => row.entry === "courseRouteRetestOutcome" && row.input.observation));
    retest.input.observation.errors = [];
    expect(() => parseCase(retest)).toThrow();
  });
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
    expect(report.summary).toMatchObject({ denominator: 76, passed: 0, failed: 76, missing: 76 });
  });
  it("does not fabricate receipts or turn synthetic results into learning gains", () => {
    const report = evaluateTutorL0(fixture());
    expect(report.cases).toHaveLength(76);
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
    const invalidStop = fixture();
    invalidStop.cases[0].gold.stopAt = "arbitrary text";
    expect(() => parseTutorL0Fixture(invalidStop)).toThrow();
    const invalidWaiting = fixture();
    invalidWaiting.cases[0].gold.waitingFor = "arbitrary text";
    expect(() => parseTutorL0Fixture(invalidWaiting)).toThrow();
  });
  it("preserves execution errors and never treats an exception as a pass", () => {
    const report = evaluateTutorL0(fixture(), () => { throw new Error("synthetic failure"); });
    expect(report.summary).toMatchObject({ denominator: 76, passed: 0, failed: 76, errors: 76 });
    expect(report.cases[0]?.error).toBe("synthetic failure");
  });
  it("keeps both tutor policy overloads separately attributable", () => {
    const report = evaluateTutorL0(fixture());
    expect(new Set(report.cases.map(row => row.entrypoint)).size).toBe(5);
    const thin = report.cases.find(row => row.caseId === "thin-hint-offer");
    expect(thin?.actualOutput).toMatchObject({ kind: "worked_example" });
    expect(thin?.scope.toolSideEffects).toBe("unknown");
  });
  it("keeps rule replay identical when the model is explicitly disabled", () => {
    const data = parseTutorL0Fixture(fixture());
    const baseline = evaluateTutorL0(data);
    const modelDisabled = evaluateTutorL0(data, row => executeTutorL0Case(row));
    expect(modelDisabled.summary).toEqual(baseline.summary);
    expect(modelDisabled.cases.map(row => row.actualOutput)).toEqual(baseline.cases.map(row => row.actualOutput));
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
