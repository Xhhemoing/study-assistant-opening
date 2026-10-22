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
  completedAt: "2026-10-21T13:00:00.000Z", provenance: "test_fixture", results });

it("never turns assistant draft labels or self-reported confidence into accuracy", () => {
  const report = evaluateGradingRun(dataset([{ ...testCase("a", "correct"), review: { status: "pending" } }]), run([prediction("a", "correct")]));
  expect(report.summary).toMatchObject({ humanReviewed: 0, acceptedAccuracy: null, coverage: null });
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
