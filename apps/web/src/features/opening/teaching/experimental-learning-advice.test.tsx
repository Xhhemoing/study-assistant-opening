// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LearnerStateFeature, NextLearningStepInput, SnapshotObservation } from "@aistudy/domain";
import { captureNextLearningStep, nextLearningStep } from "../../../../../../packages/domain/src/opening/adaptive/next-learning-step";
import { nextLearningStepWithExperimentalBkt, type ExperimentalBktAdviceInput } from "../../../../../../packages/domain/src/opening/adaptive/experimental-bkt-advice";
import { createExperimentalLearningAdvicePort, type ExperimentalLearningAdvicePort } from "./experimental-learning-advice-port";
import { ExperimentalLearningAdvice } from "./experimental-learning-advice";

// Synthetic effective heads only; no real learner/source/answer data.
const cutoff = "2026-11-10T00:00:00Z";
function fixture(outcomes = [true, true, true, true, true]) {
  const features: LearnerStateFeature[] = outcomes.map((correct, index) => ({
    observationId: `observation-${index}`, attemptId: `attempt-${index}`, courseId: "course", requirementKey: "skill",
    itemVersionId: `version-${index}`, skillLabel: "synthetic-skill", attemptedAt: `2026-11-0${index + 1}T00:00:00Z`,
    recordedAt: `2026-11-0${index + 1}T00:01:00Z`, sourceIds: ["private-source-id"], sourceVersions: { "private-source-id": 1 },
    eligibility: { independentAttempt: "yes", verifiedCorrect: correct ? "yes" : "no", usableForCurrentVersion: "yes",
      usableForDelayedCheck: "unknown", reasonCodes: [correct ? "deterministic_correct" : "deterministic_incorrect"], policyVersion: "opening-evidence-v4" },
    availability: "available", views: ["independent"], transfer: { usable: "unknown", knowledgeComponents: [], reasonCodes: [] },
    retention: { protocolId: null, earliestAt: null, recordedIntervalSupportCount: null, intervalExposureComplete: null },
    gaps: [], outcome: correct ? "correct" : "incorrect", ordinal: index,
  }));
  const observations = features.map((row, index): SnapshotObservation => ({
    id: row.observationId, skillLabel: row.skillLabel, requirementKey: row.requirementKey, itemVersionId: row.itemVersionId,
    attemptedAt: row.attemptedAt, assistance: "independent", independentAttempt: "yes", usableForCurrentVersion: "yes",
    verifiedCorrect: row.eligibility.verifiedCorrect, problemId: `problem-${index}`,
  })).reverse();
  const input: NextLearningStepInput = { status: "needs_check", observations, wantsFullExplanation: false };
  const experiment: ExperimentalBktAdviceInput = { enabled: true, features, cutoff,
    target: { courseId: "course", requirementKey: "skill", problemId: "new-problem", itemVersionId: "new-version" }, excludedProblemIds: [] };
  return { input, experiment };
}
function port(input: NextLearningStepInput, experiment: ExperimentalBktAdviceInput) {
  return createExperimentalLearningAdvicePort({ ruleDecision: nextLearningStep(input), experimentEnabled: true,
    provideExperimentalResult: () => nextLearningStepWithExperimentalBkt(input, experiment) });
}
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("This display must not fetch"); }));
  vi.spyOn(Storage.prototype, "setItem");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function render(advice: ExperimentalLearningAdvicePort) {
  await act(async () => root.render(<ExperimentalLearningAdvice advice={advice} />));
}
async function toggle() {
  await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
}
function expectReadOnly() {
  expect(fetch).not.toHaveBeenCalled();
  expect(Storage.prototype.setItem).not.toHaveBeenCalled();
  expect(host.querySelectorAll("button,a,form,select")).toHaveLength(0);
  expect(host.textContent).not.toMatch(/private-source-id|observation-\d|version-\d|problem-\d|synthetic-skill|概率|%/);
}

it("renders the real component off by default and keeps its rule first, without a provider call when disabled", async () => {
  const { input } = fixture();
  const provider = vi.fn(() => { throw new Error("must remain disabled"); });
  const advice = createExperimentalLearningAdvicePort({ ruleDecision: nextLearningStep(input), provideExperimentalResult: provider });
  await render(advice);
  expect(host.querySelector("section")?.firstElementChild?.getAttribute("aria-label")).toBe("当前规则建议");
  expect(host.querySelector<HTMLInputElement>("input")?.checked).toBe(false);
  expect(host.querySelector('[aria-label="未校准实验建议"]')).toBeNull();
  expect(host.textContent).toContain("规则建议 · 当前使用");
  const ruleBefore = host.querySelector('[aria-label="当前规则建议"]')?.textContent;
  await toggle();
  expect(host.textContent).toContain("服务尚未开放实验展示");
  expect(host.textContent).toContain("未校准实验建议 · 只读对照");
  expect(host.querySelector('[aria-label="当前规则建议"]')?.textContent).toBe(ruleBefore);
  expect(provider).not.toHaveBeenCalled();
  expectReadOnly();
});

it("explicit false also skips the provider and local opt-in never changes that permission", async () => {
  const provider = vi.fn(() => { throw new Error("forbidden"); });
  const { input } = fixture();
  await render(createExperimentalLearningAdvicePort({ ruleDecision: nextLearningStep(input), experimentEnabled: false, provideExperimentalResult: provider }));
  await toggle(); await toggle(); await toggle();
  expect(provider).not.toHaveBeenCalled(); expectReadOnly();
});

it("does not pretend an enabled host without a provider has connected qualification data", async () => {
  const { input } = fixture();
  await render(createExperimentalLearningAdvicePort({ ruleDecision: nextLearningStep(input), experimentEnabled: true }));
  await toggle();
  expect(host.textContent).toContain("实验资格数据尚未接入，仍使用规则建议");
  expectReadOnly();
});

it.each([0, 1, 4])("shows insufficient independent records with %i samples, while preserving the rule receipt", async count => {
  const { input, experiment } = fixture();
  experiment.features = experiment.features.slice(0, count);
  const before = structuredClone({ input, experiment });
  const receipt = captureNextLearningStep(input);
  const advice = port(input, experiment);
  expect(advice.status).toBe("fallback");
  await render(advice); await toggle();
  expect(host.textContent).toContain("无足够独立记录，仍用规则建议");
  expect(captureNextLearningStep(input)).toEqual(receipt);
  expect({ input, experiment }).toEqual(before); expectReadOnly();
});

const disqualifiers: Array<[string, (row: LearnerStateFeature, head: SnapshotObservation) => void]> = [
  ["AI grading", row => { row.eligibility.reasonCodes.push("ai_graded_correct"); }],
  ["not independent", row => { row.eligibility.independentAttempt = "no"; }],
  ["unknown independence", row => { row.eligibility.independentAttempt = "unknown"; }],
  ["unknown correctness", row => { row.eligibility.verifiedCorrect = "unknown"; }],
  ["old qualification", row => { row.eligibility.usableForCurrentVersion = "no"; }],
  ["unknown version", row => { row.eligibility.usableForCurrentVersion = "unknown"; }],
  ["stale", row => { row.availability = "stale"; }],
  ["unavailable", row => { row.availability = "unavailable"; }],
  ["help view", row => { row.views.push("help"); }],
  ["wrong skill", row => { row.requirementKey = "other"; }],
  ["wrong course", row => { row.courseId = "other"; }],
  ["old item version", row => { row.itemVersionId = "old"; }],
  ["hinted head", (_row, head) => { head.assistance = "hinted"; }],
  ["missing problem", (_row, head) => { head.problemId = null; }],
  ["missing version", (_row, head) => { head.itemVersionId = null; }],
  ["future", (row, head) => { row.attemptedAt = head.attemptedAt = "2026-11-11T00:00:00Z"; }],
  ["late recording", row => { row.recordedAt = cutoff; }],
  ["missing recording", row => { row.recordedAt = null; }],
  ["invalid recording", row => { row.recordedAt = "bad"; }],
];
it.each(disqualifiers)("renders the actual frozen-wrapper fallback for %s", async (_name, change) => {
  const { input, experiment } = fixture();
  const feature = experiment.features[0]!;
  change(feature, input.observations.find(row => row.id === feature.observationId)!);
  const rule = nextLearningStep(input), receipt = captureNextLearningStep(input);
  const advice = port(input, experiment);
  expect(advice).toMatchObject({ status: "fallback", reason: "insufficient_samples",
    ruleDecision: { activityKind: rule.activityKind, reasonCode: rule.reasonCode } });
  await render(advice); await toggle();
  expect(host.textContent).toContain("无足够独立记录，仍用规则建议");
  expect(captureNextLearningStep(input)).toEqual(receipt); expectReadOnly();
});

it.each(["target", "held-out", "duplicate", "repeated-problem"] as const)("does not invent samples for %s", async mode => {
  const { input, experiment } = fixture();
  if (mode === "target") experiment.target.problemId = input.observations[0]!.problemId;
  if (mode === "held-out") experiment.excludedProblemIds = [input.observations[0]!.id];
  if (mode === "duplicate") experiment.features = [...experiment.features, experiment.features[0]!];
  if (mode === "repeated-problem") input.observations[0]!.problemId = input.observations[1]!.problemId;
  await render(port(input, experiment)); await toggle();
  expect(host.textContent).toContain("无足够独立记录，仍用规则建议"); expectReadOnly();
});

it.each(["target", "cutoff", "priority", "wrapper-disabled"] as const)("labels %s fallback without replacing the rule", async mode => {
  const { input, experiment } = fixture();
  if (mode === "target") experiment.target.itemVersionId = null;
  if (mode === "cutoff") experiment.cutoff = "bad";
  if (mode === "priority") input.dueRetest = true;
  if (mode === "wrapper-disabled") experiment.enabled = false;
  const expected = { target: "身份或版本不完整", cutoff: "记录时间无法核实", priority: "规则优先", "wrapper-disabled": "尚未开放实验展示" };
  const advice = port(input, experiment);
  const rule = nextLearningStep(input);
  expect(advice.ruleDecision).toEqual({ activityKind: rule.activityKind, reasonCode: rule.reasonCode });
  await render(advice); await toggle();
  expect(host.textContent).toContain(expected[mode]); expectReadOnly();
});

it.each([true, false])("renders real %s-outcome comparison as uncalibrated, never an action or mastery claim", async correct => {
  const { input, experiment } = fixture(correct ? undefined : [false, false, false, false, true]);
  const advice = port(input, experiment);
  expect(advice.status).toBe("compared");
  expect(advice.experimentalAdvice?.kind).toBe(correct ? "continue_rule" : "supported_practice");
  expect(Object.keys(advice).sort()).toEqual(["experimentalAdvice", "ruleDecision", "status"]);
  await render(advice);
  const ruleBefore = host.querySelector('[aria-label="当前规则建议"]')?.textContent;
  await toggle();
  expect(host.textContent).toContain(correct ? "保留当前规则建议" : "可考虑增加有支持的练习");
  expect(host.textContent).toContain("实验尚未校准，不代表掌握程度");
  expect(host.textContent).toContain("不改变晋级、考试或正式资格，不自动选题");
  expect(host.querySelector('[aria-label="当前规则建议"]')?.textContent).toBe(ruleBefore);
  await toggle();
  expect(host.querySelector('[aria-label="未校准实验建议"]')).toBeNull(); expectReadOnly();
});

it("keeps selection component-local, not across mounts", async () => {
  const { input, experiment } = fixture();
  const advice = port(input, experiment);
  await render(advice); await toggle();
  await act(async () => root.render(<ExperimentalLearningAdvice key="new-mount" advice={advice} />));
  expect(host.querySelector<HTMLInputElement>("input")?.checked).toBe(false); expectReadOnly();
});

it("does not swallow a provider failure as a successful experimental comparison", () => {
  const { input } = fixture();
  expect(() => createExperimentalLearningAdvicePort({ ruleDecision: nextLearningStep(input), experimentEnabled: true,
    provideExperimentalResult: () => { throw new Error("qualification unavailable"); } })).toThrow("qualification unavailable");
});
