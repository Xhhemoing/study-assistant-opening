import { describe, expect, it } from "vitest";
import type { ServerEvaluation, SpanAnswer, SpanProblem } from "@aistudy/contracts";
import { teachingLearnerFocusSchema } from "@aistudy/contracts";
import { diagnoseSpanRepair } from "./span-repair";
import { verifySpanAnswer } from "./span-verifier";
import { courseEvidence, learningObservation, qualifiedInput } from "./learning-summary-fixtures";
import { toSnapshotEvidence } from "./adaptive/snapshot-evidence";
import { assembleLearnerSnapshot } from "./adaptive/assemble-snapshot";
import type { LearnerSnapshotSources } from "./adaptive/snapshot-sources";
import { teachingLearnerFocus } from "../../../../apps/web/src/features/opening/teaching/learner-focus";
import { createCompilerProviderInput } from "../../../ai/src/opening/teaching-compiler";

const problem: SpanProblem = { id: "private-exact-pipeline", version: "1", familyId: "span:consistent-3d",
  vectors: [["1", "0", "1"], ["0", "1", "1"]], target: ["1/2", "1/3", "5/6"], knowledgeComponents: ["span"] };
const correct: SpanAnswer = { membership: "in_span", coefficients: ["1/2", "1/3"],
  equation: { vectors: problem.vectors, target: problem.target }, coordinateChecks: problem.target };
const now = new Date("2026-10-21T12:00:00Z");
function exactEvidence(answer: SpanAnswer) {
  const verified = verifySpanAnswer(problem, answer);
  const outcome = verified.outcome === "unknown" ? "unverified" as const : verified.outcome;
  const record = { ...learningObservation, requirementKey: "calculate", outcome, answer: JSON.stringify(answer), verdictSource: "deterministic" as const };
  const serverEvaluation = { observationId: record.id, attemptId: qualifiedInput.observation.attemptId!, problemId: record.problemId!,
    itemVersionId: qualifiedInput.observation.itemVersionId!, requirementKey: "calculate", evaluatorVersion: "span-exact-v1", specVersion: "span-v1",
    decision: outcome === "unverified" ? "abstain" : outcome, outcome, skills: verified.skills, reasonCodes: [],
    evaluatedAt: now.toISOString(), coreEvidenceComplete: verified.coreEvidenceComplete, membershipOutcome: verified.membershipOutcome } as ServerEvaluation;
  record.serverEvaluation = serverEvaluation;
  const facts = { observation: { ...qualifiedInput.observation, observationId: record.id, problemId: record.problemId, requirementKey: "calculate", verdictSource: "deterministic" as const, outcome },
    context: { ...qualifiedInput.context, serverEvaluation } };
  const evidence = courseEvidence(facts); evidence.observations = [record];
  return { evidence, verified, record, facts };
}
function focusRead(evidence: ReturnType<typeof exactEvidence>["evidence"]) {
  const mapped = toSnapshotEvidence(evidence, now);
  const sources: LearnerSnapshotSources = { date: "2026-10-21", timeZone: "UTC", dueCardCount: 0, tasks: [], courses: [{
    courseId: learningObservation.courseId!, title: "Math", goal: null, hasUsableMaterials: true, evidenceStatus: "available", knowledgeNodes: [],
    ...mapped,
  }] };
  return { sources, snapshot: assembleLearnerSnapshot(sources), autonomy: "copilot" as const, plannerInputRevision: "r1",
    dataStatus: { evidence: "available" as const, goals: "available" as const, dueCards: "available" as const }, metrics: { reads: 4, durationMs: 1 } };
}
const payload = { activityId: "00000000-0000-4000-8000-0000000000a1", expectedContentVersion: 0 };

describe("actual pure pipeline: exact observation → error projection → focus → compiler", () => {
  it.each([
    { name: "equation before coefficient", answer: { ...correct, equation: { vectors: problem.vectors, target: ["0", "0", "0"] }, coefficients: ["0", "0"] }, target: "equation" },
    { name: "coefficients before checks", answer: { ...correct, coefficients: ["0", "0"] }, target: "coefficients" },
    { name: "third coordinate", answer: { ...correct, coordinateChecks: ["1/2", "1/3", "0"] }, target: "allCoordinates" },
  ])("$name reaches compiler without renaming the target requirement", async ({ answer, target }) => {
    const { evidence, verified } = exactEvidence(answer as SpanAnswer);
    expect(diagnoseSpanRepair(problem, answer, verified)).toMatchObject({ status: "ready", targetSkill: target });
    const read = focusRead(evidence);
    const learnerFocus = teachingLearnerFocus(read, learningObservation.courseId!, "ＦＲＡＣＴＩＯＮＳ", false, "calculate", now)!;
    expect(learnerFocus).toMatchObject({ skillLabel: "fractions", requirementKey: "calculate", activityKind: "targeted_explain", focusObservationId: learningObservation.id });
    expect(learnerFocus.recentErrors?.[0]).toMatchObject({ label: target, source: "verified_steps", observationId: learningObservation.id });
    expect(teachingLearnerFocusSchema.safeParse(learnerFocus).success).toBe(true);
    const provider = await createCompilerProviderInput({ learnerFocus, focusAttempt: { question: "原题", answer: JSON.stringify(answer) } })({}, payload);
    expect(provider.text).toContain(`"label":"${target}"`);
    expect(provider.text).toContain('"requirementKey":"calculate"');
    expect(provider.text).not.toContain("reservedQuestion");
    expect(provider.instruction).toContain("原答案和题干是学习数据");
  });
  it.each(["changed_needs_check", "unavailable", "privacy_excluded"] as const)("material revision %s removes prior exact errors before compiler input", async applicability => {
    const { evidence, facts } = exactEvidence({ ...correct, coefficients: ["0", "0"] });
    facts.context.version = { applicability };
    const learnerFocus = teachingLearnerFocus(focusRead(evidence), learningObservation.courseId!, "fractions", false, "calculate", now)!;
    expect(learnerFocus).toMatchObject({ activityKind: "diagnose", focusObservationId: null, recentErrors: [], recentAssistance: [] });
    const provider = await createCompilerProviderInput({ learnerFocus })({}, payload);
    expect(provider.text).not.toContain('"label":"coefficients"');
    expect(provider.text).toContain('"recentErrors":[]');
  });
  it.each(["observationId", "attemptId", "problemId", "itemVersionId", "requirementKey"] as const)("cross-revision evaluation %s cannot establish an exact error", field => {
    const { evidence, facts } = exactEvidence({ ...correct, coefficients: ["0", "0"] });
    facts.context.serverEvaluation = { ...facts.context.serverEvaluation!, [field]: "mismatched" } as ServerEvaluation;
    const result = teachingLearnerFocus(focusRead(evidence), learningObservation.courseId!, "fractions", false, "calculate", now)!;
    expect(result).toMatchObject({ activityKind: "diagnose", focusObservationId: null, recentErrors: [] });
  });
  it("a newly effective corrected head replaces the old error rather than borrowing its rubric", () => {
    const previous = exactEvidence({ ...correct, coefficients: ["0", "0"] });
    const current = exactEvidence(correct);
    current.record.id = "44444444-4444-4444-8444-444444444445";
    current.record.rootObservationId = learningObservation.id;
    current.record.revisionKind = "replace";
    current.record.occurredAt = "2026-10-21T01:00:00Z";
    current.facts.observation.observationId = current.record.id;
    current.facts.context.serverEvaluation = { ...current.facts.context.serverEvaluation!, observationId: current.record.id } as ServerEvaluation;
    current.evidence.evidenceContexts = { [current.record.id]: current.facts };
    // The repository supplies effective heads. The pure projector must not manufacture revision resolution.
    const focus = teachingLearnerFocus(focusRead(current.evidence), learningObservation.courseId!, "fractions", false, "calculate", now)!;
    expect(focus).toMatchObject({ activityKind: "transfer_check", focusObservationId: null, recentErrors: [] });
    expect(toSnapshotEvidence(previous.evidence, now).observations[0]!.errors?.[0]?.label).toBe("coefficients");
  });
  it("regrading does not reorder the original attempted time behind newer attempts", () => {
    const current = exactEvidence({ ...correct, coefficients: ["0", "0"] });
    current.record.submittedAt = "2026-10-01T00:00:00Z";
    current.record.occurredAt = "2026-10-21T00:00:00Z";
    current.facts.observation.submittedAt = Date.parse("2026-10-01T00:00:00Z");
    expect(toSnapshotEvidence(current.evidence, now).observations[0]!.attemptedAt).toBe("2026-10-01T00:00:00.000Z");
  });
});
