import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { GradingEvaluationDataset, GradingEvaluationRun } from "@aistudy/contracts";
import { evaluateGradingRun } from "./grading-evaluation";

const input = { question: "求 f(x)=x² 的导数。", answer: "2x", referenceText: "f'(x)=2x", imageEvidenceRef: null };
const reviewed = (outcome: "correct" | "incorrect" | "unverified") => ({ status: "human_reviewed" as const,
  reviewerId: "unit-test-only", reviewedAt: "2026-10-21T12:00:00.000Z", outcome, rationale: "合成测试标签，不是真实人工评测。" });
const testCase = (id: string, expected: "correct" | "incorrect" | "unverified"): GradingEvaluationDataset["cases"][number] => ({
  id, version: "1", group: "equivalent_solution", modality: "text", input, candidateOutcome: "correct", candidateRationale: "待核对的候选标签。", review: reviewed(expected),
});
const dataset = (cases: GradingEvaluationDataset["cases"]): GradingEvaluationDataset => ({ protocolVersion: "grading-evaluation-v1", datasetId: "test", datasetVersion: "1", cases });
const prediction = (caseId: string, outcome: "correct" | "incorrect" | "unverified"): GradingEvaluationRun["results"][number] => ({
  caseId, caseVersion: "1", input, rawOutput: JSON.stringify({ outcome, confidence: 0.99, questionMatch: true, feedback: "测试反馈",
    criteria: [{ label: "求导", verdict: outcome, feedback: "测试步骤" }] }),
});
const run = (results: GradingEvaluationRun["results"]): GradingEvaluationRun => ({ datasetId: "test", datasetVersion: "1", modelLabel: "test-fixture",
  completedAt: "2026-10-21T13:00:00.000Z", provenance: "test_fixture",
  sourceCommit: "unknown", instructionVersion: "synthetic-v1", rubricVersion: "synthetic-v1",
  protocolVersion: "grading-evaluation-v1", promptDigest: "unknown", results });

it("rejects missing run metadata and mismatched protocols instead of backfilling current versions", () => {
  for (const key of ["sourceCommit", "instructionVersion", "rubricVersion", "protocolVersion", "promptDigest"] as const) {
    const legacy: Partial<GradingEvaluationRun> = { ...run([]) };
    delete legacy[key];
    expect(() => evaluateGradingRun(dataset([testCase("a", "correct")]), legacy)).toThrow();
  }
  expect(() => evaluateGradingRun(dataset([testCase("a", "correct")]), { ...run([]), protocolVersion: "other-v1" }))
    .toThrow("protocol version mismatch");
});

it("reports exact one-sided 95% bounds for zero, interior and all events across strata", () => {
  const cases = Array.from({ length: 10 }, (_, index) => testCase(`c-${index}`, "correct"));
  const report = evaluateGradingRun(dataset(cases), run(cases.map((test, index) => prediction(test.id, index ? "correct" : "incorrect"))));
  for (const metrics of [report.summary, report.groups.equivalent_solution!, report.byReviewSource.humanReviewed]) {
    expect(metrics.decisionRates.falseIncorrectOnCorrect.upper95).toBeCloseTo(0.3941633024365047, 10);
    expect(metrics.decisionRates.abstentionOnGradeable.upper95).toBeCloseTo(0.2588655508930523, 10);
    expect(metrics.rawModel.decisionRates.falseIncorrectOnCorrect.upper95).toBeCloseTo(0.3941633024365047, 10);
  }
  expect(report.byReviewSource.programVerified.decisionRates.falseIncorrectOnCorrect.upper95).toBeNull();
  const all = evaluateGradingRun(dataset(cases), run(cases.map(test => prediction(test.id, "unverified"))));
  expect(all.summary.decisionRates.abstentionOnGradeable.upper95).toBe(1);
  expect(all.summary.decisionRates.binaryCoverageOnGradeable.upper95).toBeCloseTo(0.2588655508930523, 10);
  expect(report).toMatchObject({ sourceCommit: "unknown", instructionVersion: "synthetic-v1", rubricVersion: "synthetic-v1",
    promptDigest: "unknown", calibrated: false, learningEffectMeasured: false });
});

it("never turns assistant draft labels or self-reported confidence into accuracy", () => {
  const report = evaluateGradingRun(dataset([{ ...testCase("a", "correct"), review: { status: "pending" } }]), run([prediction("a", "correct")]));
  expect(report.summary).toMatchObject({ humanReviewed: 0, acceptedAccuracy: null, coverage: null });
  expect(report.summary.expectedCounts).toEqual({ correct: 0, incorrect: 0, unverified: 0 });
  for (const metric of Object.values(report.summary.decisionRates)) {
    expect(metric).toEqual({ numerator: 0, denominator: 0, rate: null, upper95: null });
  }
  expect(report.calibrated).toBe(false);
});

it("keeps missing and malformed results in coverage and separates wrong grades from unsafe certainty", () => {
  const report = evaluateGradingRun(dataset([testCase("a", "correct"), testCase("b", "incorrect"), testCase("c", "unverified"),
    testCase("d", "correct"), testCase("e", "correct"), testCase("f", "correct")]), run([
    prediction("a", "incorrect"), prediction("b", "correct"), prediction("c", "correct"), prediction("d", "unverified"),
    { ...prediction("e", "correct"), rawOutput: "invalid JSON" },
  ]));
  expect(report.summary).toMatchObject({ humanReviewed: 6, validResults: 4, missingOrInvalidResults: 2, acceptedBinary: 3,
    coverage: 0.5, acceptedAccuracy: 0, falseCorrect: 1, falseIncorrect: 1, unsafeBinaryOnUnverifiable: 1, abstentions: 1 });
  expect(report.summary.decisionRates).toMatchObject({
    falseCorrectOnIncorrect: { numerator: 1, denominator: 1, rate: 1 },
    falseIncorrectOnCorrect: { numerator: 1, denominator: 4, rate: 0.25 },
    binaryCoverageOnGradeable: { numerator: 2, denominator: 5, rate: 0.4 },
    abstentionOnGradeable: { numerator: 1, denominator: 5, rate: 0.2 },
    missingOrInvalidOnGradeable: { numerator: 2, denominator: 5, rate: 0.4 },
  });
});

it("reports class-specific denominators when correct answers dominate the dataset", () => {
  const correctCases = Array.from({ length: 9 }, (_, index) => testCase(`correct-${index}`, "correct"));
  const unknownCases = ["unknown-0", "unknown-1"].map(id => ({ ...testCase(id, "unverified"), group: "question_mismatch" as const }));
  const report = evaluateGradingRun(dataset([...correctCases, testCase("wrong", "incorrect"), ...unknownCases]), run([
    ...correctCases.map((test, index) => prediction(test.id, index === 0 ? "incorrect" : index === 1 ? "correct" : "unverified")),
    prediction("wrong", "correct"), prediction("unknown-0", "unverified"), prediction("unknown-1", "correct"),
  ]));
  expect(report.summary.expectedCounts).toEqual({ correct: 9, incorrect: 1, unverified: 2 });
  expect(report.summary.decisionRates).toMatchObject({
    falseCorrectOnIncorrect: { numerator: 1, denominator: 1, rate: 1 },
    falseIncorrectOnCorrect: { numerator: 1, denominator: 9, rate: 1 / 9 },
    binaryCoverageOnGradeable: { numerator: 3, denominator: 10, rate: 0.3 },
    abstentionOnGradeable: { numerator: 7, denominator: 10, rate: 0.7 },
    correctAbstentionOnUnverifiable: { numerator: 1, denominator: 2, rate: 0.5 },
    unsafeBinaryOnUnverifiable: { numerator: 1, denominator: 2, rate: 0.5 },
  });
  expect(report.groups.question_mismatch?.decisionRates.binaryCoverageOnGradeable)
    .toMatchObject({ numerator: 0, denominator: 0, rate: null });
  expect(report.groups.question_mismatch?.decisionRates.correctAbstentionOnUnverifiable)
    .toMatchObject({ numerator: 1, denominator: 2, rate: 0.5 });
  expect(report.byReviewSource.humanReviewed.decisionRates).toEqual(report.summary.decisionRates);
  expect(report.byReviewSource.programVerified.decisionRates.falseCorrectOnIncorrect)
    .toMatchObject({ numerator: 0, denominator: 0, rate: null });
});

it("shows low effective coverage even when abstaining makes accepted accuracy perfect", () => {
  const cases = Array.from({ length: 20 }, (_, index) => testCase(`correct-${index}`, "correct"));
  const report = evaluateGradingRun(dataset(cases), run(cases.map((test, index) => prediction(test.id, index ? "unverified" : "correct"))));
  expect(report.summary.acceptedAccuracy).toBe(1);
  expect(report.summary.decisionRates.binaryCoverageOnGradeable).toMatchObject({ numerator: 1, denominator: 20, rate: 0.05 });
  expect(report.summary.decisionRates.abstentionOnGradeable).toMatchObject({ numerator: 19, denominator: 20, rate: 0.95 });
  expect(report.summary.decisionRates.correctAbstentionOnUnverifiable).toMatchObject({ numerator: 0, denominator: 0, rate: null });
});

it("does not count missing results as abstentions or successful handling", () => {
  const report = evaluateGradingRun(dataset([testCase("right", "correct"), testCase("wrong", "incorrect"), testCase("unknown", "unverified")]), run([]));
  expect(report.summary).toMatchObject({ validResults: 0, missingOrInvalidResults: 3, acceptedAccuracy: null, coverage: 0 });
  expect(report.summary.decisionRates).toMatchObject({
    falseCorrectOnIncorrect: { numerator: 0, denominator: 1, rate: 0 },
    falseIncorrectOnCorrect: { numerator: 0, denominator: 1, rate: 0 },
    binaryCoverageOnGradeable: { numerator: 0, denominator: 2, rate: 0 },
    abstentionOnGradeable: { numerator: 0, denominator: 2, rate: 0 },
    missingOrInvalidOnGradeable: { numerator: 2, denominator: 2, rate: 1 },
    correctAbstentionOnUnverifiable: { numerator: 0, denominator: 1, rate: 0 },
    missingOrInvalidOnUnverifiable: { numerator: 1, denominator: 1, rate: 1 },
  });
  expect(report.summary.rawModel.decisionRates).toEqual(report.summary.decisionRates);
});

it("refuses results for a different input, version, duplicate or unknown case", () => {
  const d = dataset([testCase("a", "correct")]), p = prediction("a", "correct");
  expect(evaluateGradingRun(d, run([{ ...p, input: { ...input, answer: "别的答案" } }])).cases[0]?.reason).toBe("case_input_mismatch");
  expect(evaluateGradingRun(d, run([{ ...p, caseVersion: "2" }])).summary.validResults).toBe(0);
  expect(() => evaluateGradingRun(d, run([p, p]))).toThrow();
  expect(() => evaluateGradingRun(d, run([prediction("b", "correct")]))).toThrow("Unknown grading case");
  expect(() => evaluateGradingRun(d, { ...run([p]), datasetVersion: "2" })).toThrow("version mismatch");
});

it("does not score a placeholder photo as an actual reviewed image", () => {
  const photo = { ...testCase("a", "unverified"), modality: "photo" as const, review: { status: "pending" as const } };
  expect(evaluateGradingRun(dataset([photo]), run([prediction("a", "correct")])).cases[0]?.reason).toBe("photo_evidence_missing");
  expect(() => evaluateGradingRun(dataset([{ ...photo, review: reviewed("unverified") }]), run([]))).toThrow();
});

it("scores the same arithmetic abstention policy used by persistence, while keeping raw model outcome", () => {
  const arithmetic = { ...input, question: "1/2+1/2?", answer: "2/2" };
  const report = evaluateGradingRun(dataset([{ ...testCase("a", "correct"), input: arithmetic }]),
    run([{ ...prediction("a", "incorrect"), input: arithmetic }]));
  expect(report.cases[0]).toMatchObject({ modelOutcome: "incorrect", acceptedOutcome: "unverified" });
  expect(report.summary).toMatchObject({ falseIncorrect: 0, abstentions: 1, acceptedAccuracy: null });
  expect(report.summary.rawModel).toMatchObject({ accuracy: 0, falseIncorrect: 1 });
  expect(report.summary.decisionRates.abstentionOnGradeable).toMatchObject({ numerator: 1, denominator: 1, rate: 1 });
  expect(report.summary.rawModel.decisionRates.falseIncorrectOnCorrect).toMatchObject({ numerator: 1, denominator: 1, rate: 1 });
});

it("verifies objective labels at evaluation time without calling them human reviews", () => {
  const objectiveInput = { ...input, question: "计算 1/3+1/6", answer: "0.5", referenceText: "1/2" };
  const objective = { ...testCase("a", "correct"), input: objectiveInput,
    review: { status: "program_verified" as const, checker: "exact-arithmetic-v1" as const,
      verifiedAt: "2026-10-22T00:00:00.000Z", outcome: "correct" as const, rationale: "BigInt rational arithmetic, not human review." } };
  const result = { ...prediction("a", "correct"), input: objectiveInput };
  expect(evaluateGradingRun(dataset([objective]), run([result])).summary).toMatchObject({
    verified: 1, programVerified: 1, humanReviewed: 0, acceptedAccuracy: 1,
  });
  expect(() => evaluateGradingRun(dataset([{ ...objective, review: { ...objective.review, outcome: "incorrect" } }]), run([result])))
    .toThrow("Objective grading label could not be verified");
  expect(() => evaluateGradingRun(dataset([{ ...objective, input }]), run([])))
    .toThrow("Objective grading label could not be verified");
  expect(() => evaluateGradingRun(dataset([{ ...objective, modality: "photo", input: { ...objectiveInput, imageEvidenceRef: "photo-v1" } }]), run([])))
    .toThrow();
});

it("runs the objective development fixture and identifies deliberate synthetic model errors", () => {
  const load = (file: string) => JSON.parse(readFileSync(new URL(`../../../../tests/fixtures/opening/grading/${file}`, import.meta.url), "utf8"));
  const report = evaluateGradingRun(load("objective-arithmetic.json"), load("objective-synthetic-run.json"));
  expect(report.provenance).toBe("test_fixture");
  expect(report).toMatchObject({ sourceCommit: "unknown", instructionVersion: "unknown", rubricVersion: "unknown", promptDigest: "unknown" });
  expect(report.summary).toMatchObject({ total: 8, humanReviewed: 0, programVerified: 8,
    validResults: 8, acceptedBinary: 6, abstentions: 2, coverage: 0.75, acceptedAccuracy: 1,
    rawModel: { accuracy: 0.75, falseCorrect: 1, falseIncorrect: 1 } });
});

it("ships review candidates without claiming human-reviewed or real-provider measurements", () => {
  const draft = JSON.parse(readFileSync(new URL("../../../../tests/fixtures/opening/grading/review-candidates.json", import.meta.url), "utf8"));
  const report = evaluateGradingRun(draft, { ...run([]), datasetId: draft.datasetId, datasetVersion: draft.datasetVersion });
  expect(report.summary).toMatchObject({ total: 12, humanReviewed: 0, acceptedAccuracy: null });
  expect(Object.keys(report.groups)).toHaveLength(6);
});
