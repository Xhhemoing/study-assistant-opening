import { describe, expect, it } from "vitest";
import { learningObservationSchema, spanPrerequisiteQualificationSchema, type CourseRequirement, type SpanRepairRequirementIdentity } from "@aistudy/contracts";
import { qualifySpanPrerequisiteRepair, type SpanPrerequisiteQualificationInput } from "./span-prerequisite-repair";
import { getSpanTeachingProblem } from "./span-heldout-catalog";
import { SPAN_REQUIREMENT_KEY, spanProblemStem } from "./span-teaching-catalog";
import { verifySpanAnswer } from "./span-verifier";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = "2026-11-09T20:31:00.000Z";
const targetBinding: SpanRepairRequirementIdentity = { id: id(1), revision: 2, stableSkillId: id(2), requirementKey: "target:span-application" };
const prerequisiteBinding: SpanRepairRequirementIdentity = { id: id(3), revision: 4, stableSkillId: id(4), requirementKey: SPAN_REQUIREMENT_KEY };
const problem = getSpanTeachingProblem("span-reserved-generated-teaching-consistent-3d-1729-0", "1")!;
function requirement(binding: SpanRepairRequirementIdentity, prerequisiteIds: string[]): CourseRequirement {
  return { ...binding, courseId: id(5), knowledgeNodeId: null, title: "same ambiguous title", position: 0,
    mandatory: true, goalIds: [], prerequisiteIds, sourceRefs: [{ sourceId: id(6), sourceVersion: 1, chunkId: id(7) }],
    verification: { kind: "exact", status: "ready", exerciseKeys: [problem.id], rubric: null, missingReasons: [] },
    lifecycle: "active", origin: "confirmed", approvedAt: now };
}
/** Synthetic contract/algorithm fixture only; not proof of a real course binding or learner success. */
function fixture(): SpanPrerequisiteQualificationInput {
  const answer = JSON.stringify({ membership: "in_span", coefficients: ["999", "999"],
    equation: { vectors: problem.vectors, target: problem.target } });
  const verified = verifySpanAnswer(problem, answer);
  const evaluation = { evaluatorVersion: "span-exact-v1" as const, specVersion: "span-v1" as const,
    observationId: id(8), attemptId: id(9), problemId: id(10), itemVersionId: id(11), requirementKey: SPAN_REQUIREMENT_KEY,
    decision: "incorrect" as const, outcome: "incorrect" as const, evaluatedAt: now, reasonCodes: ["exact_incorrect"],
    skills: verified.skills, coreEvidenceComplete: verified.coreEvidenceComplete, membershipOutcome: verified.membershipOutcome };
  return { courseId: id(5), targetBinding: { ...targetBinding }, prerequisiteBinding: { ...prerequisiteBinding },
    requirements: [requirement(targetBinding, [prerequisiteBinding.id]), requirement(prerequisiteBinding, [])],
    sources: new Map([[id(6), 1]]), chunks: [{ id: id(7), sourceId: id(6), sourceVersion: 1, page: null }],
    evidence: { observation: learningObservationSchema.parse({ id: id(8), workspaceId: id(12), sessionId: id(13), courseId: id(5),
      attemptId: id(9), problemId: id(10), itemVersionId: id(11), requirementKey: SPAN_REQUIREMENT_KEY,
      skillLabel: "not an authority", sourceIds: [id(6)], sourceVersions: { [id(6)]: 1 }, answer,
      assistance: "independent", outcome: "incorrect", verdictSource: "deterministic", clientKey: "fixture-only",
      referenceSourceId: null, occurredAt: now, sourceTurnIds: [], serverEvaluation: evaluation }),
      root: { id: id(8), effectiveHeadId: id(8) },
      attempt: { id: id(9), courseId: id(5), sessionId: id(13), problemId: id(10), itemVersionId: id(11),
        observationId: id(8), sourceIds: [id(6)], sourceVersions: { [id(6)]: 1 }, requirementKey: SPAN_REQUIREMENT_KEY,
        courseRequirement: { ...prerequisiteBinding }, stemSnapshot: spanProblemStem(problem) },
      evaluationSpec: { kind: "span", specVersion: "span-v1", problemId: problem.id, version: Number(problem.version),
        familyId: problem.familyId, requirementKey: SPAN_REQUIREMENT_KEY, knowledgeComponents: problem.knowledgeComponents, transfer: problem.transfer ?? null },
      context: { serverEvaluation: evaluation, version: { applicability: "exact", currentItemVersionId: id(11) } } } };
}
const expectReason = (input: SpanPrerequisiteQualificationInput, reasonCode: string, status = "unknown") =>
  expect(qualifySpanPrerequisiteRepair(input)).toEqual({ status, reasonCode });
describe("narrow prerequisite qualification (not runtime routing)", () => {
  it("requires both confirmed exact relation and the prerequisite's own exact failure, without mutating inputs", () => {
    const input = fixture(), before = structuredClone(input);
    const result = qualifySpanPrerequisiteRepair(input);
    expect(result).toMatchObject({ status: "verified_weak", targetRequirement: targetBinding, prerequisiteRequirement: prerequisiteBinding,
      returnToRequirementId: targetBinding.id, evaluatedContent: { problemId: problem.id, version: "1" }, basis: { observationId: id(8) } });
    expect(spanPrerequisiteQualificationSchema.parse(result)).toEqual(result);
    expect(input).toEqual(before);
  });
  it("does not infer a bridge from a title, skill label, target error or supported-looking node", () => {
    for (const key of ["targetBinding", "prerequisiteBinding"] as const) {
      const input = fixture(); input[key] = null;
      input.requirements[0]!.knowledgeNodeId = id(99);
      expectReason(input, "prerequisite_binding_missing");
    }
    const input = fixture(); input.evidence = null;
    expectReason(input, "prerequisite_evidence_missing");
  });
  it.each(["revision", "stableSkillId", "requirementKey", "courseId", "lifecycle", "duplicate", "ambiguousSkill", "ambiguousKey"])("rejects changed/ambiguous requirement: %s", field => {
    const input = fixture(), row = input.requirements[1]!;
    if (field === "revision") row.revision++;
    if (field === "stableSkillId") row.stableSkillId = id(90);
    if (field === "requirementKey") row.requirementKey = "other";
    if (field === "courseId") row.courseId = id(90);
    if (field === "lifecycle") row.lifecycle = "archived";
    if (field === "duplicate") input.requirements = [...input.requirements, { ...row }];
    if (field === "ambiguousSkill") input.requirements[0]!.stableSkillId = row.stableSkillId;
    if (field === "ambiguousKey") input.requirements[0]!.requirementKey = row.requirementKey;
    expectReason(input, "requirement_changed");
  });
  it.each(["unapprovedTarget", "unapprovedPrerequisite", "absent", "reverse", "self"])("rejects unconfirmed or wrong direct relation: %s", change => {
    const input = fixture();
    if (change === "unapprovedTarget") input.requirements[0]!.approvedAt = null;
    if (change === "unapprovedPrerequisite") input.requirements[1]!.approvedAt = null;
    if (change === "absent" || change === "reverse") input.requirements[0]!.prerequisiteIds = [];
    if (change === "reverse") input.requirements[1]!.prerequisiteIds = [targetBinding.id];
    if (change === "self") input.prerequisiteBinding = input.targetBinding;
    expectReason(input, "relation_unconfirmed");
  });
  it.each(["source", "chunk", "page", "attemptSources", "extraSource", "missingVersion"])("refuses unavailable or changed provenance: %s", change => {
    const input = fixture(), evidence = input.evidence!;
    if (change === "source") input.sources = new Map([[id(6), 2]]);
    if (change === "chunk") input.chunks = [];
    if (change === "page") input.requirements[1]!.sourceRefs[0]!.page = 4;
    if (change === "attemptSources") evidence.attempt.sourceVersions = { [id(6)]: 2 };
    if (change === "extraSource") evidence.observation.sourceVersions![id(90)] = 1;
    if (change === "missingVersion") evidence.observation.sourceVersions = null;
    expectReason(input, "source_unavailable");
  });
  it.each(["head", "root", "retract", "equivalent", "currentItem"])("never reuses stale/retracted/equivalent evidence: %s", change => {
    const input = fixture(), evidence = input.evidence!;
    if (change === "head") evidence.root.effectiveHeadId = id(90);
    if (change === "root") evidence.observation.rootObservationId = id(90);
    if (change === "retract") evidence.observation.revisionKind = "retract";
    if (change === "equivalent") evidence.context.version!.applicability = "equivalent_confirmed";
    if (change === "currentItem") evidence.context.version!.currentItemVersionId = id(90);
    expectReason(input, "prerequisite_evidence_changed");
  });
  it("accepts a current exact replacement only with the same proven root/attempt lineage", () => {
    const input = fixture(), evidence = input.evidence!;
    evidence.root = { id: id(90), effectiveHeadId: id(8) };
    evidence.observation.rootObservationId = id(90); evidence.observation.revisionKind = "replace";
    evidence.attempt.observationId = id(90);
    expect(qualifySpanPrerequisiteRepair(input)).toMatchObject({ status: "verified_weak", basis: { rootObservationId: id(90) } });
  });
  it.each(["binding", "attempt", "problem", "item", "course", "session", "attemptHead", "key"])("requires exact prerequisite evidence identity: %s", change => {
    const input = fixture(), evidence = input.evidence!;
    if (change === "binding") evidence.attempt.courseRequirement = { ...targetBinding };
    if (change === "attempt") evidence.observation.attemptId = id(90);
    if (change === "problem") evidence.observation.problemId = id(90);
    if (change === "item") evidence.observation.itemVersionId = id(90);
    if (change === "course") evidence.observation.courseId = id(90);
    if (change === "session") evidence.observation.sessionId = id(90);
    if (change === "attemptHead") evidence.attempt.observationId = id(90);
    if (change === "key") evidence.observation.requirementKey = targetBinding.requirementKey;
    expectReason(input, "prerequisite_identity_mismatch");
  });
  it.each(["self_report", "model_suggestion", "ai_graded", "reference_checked"] as const)("does not trust %s, even with a copied exact evaluation", verdict => {
    const input = fixture(); input.evidence!.observation.verdictSource = verdict;
    expectReason(input, "prerequisite_verification_mismatch", "needs_clarification");
  });
  it.each(["answer", "skills", "evaluationIdentity", "context", "spec", "research", "rubric", "unlisted", "stem"])("requires actual supported scoring content: %s", change => {
    const input = fixture(), evidence = input.evidence!;
    if (change === "answer") evidence.observation.answer = "model says weak";
    if (change === "skills") {
      evidence.observation.serverEvaluation = { ...evidence.observation.serverEvaluation!, evaluatorVersion: "span-exact-v1", specVersion: "span-v1", skills: { equation: "correct", coefficients: "correct", allCoordinates: "correct" }, coreEvidenceComplete: true };
      evidence.context.serverEvaluation = evidence.observation.serverEvaluation;
    }
    if (change === "evaluationIdentity") {
      evidence.observation.serverEvaluation = { ...evidence.observation.serverEvaluation!, attemptId: id(90) };
      evidence.context.serverEvaluation = evidence.observation.serverEvaluation;
    }
    if (change === "context") evidence.context.serverEvaluation = null;
    if (change === "spec") evidence.evaluationSpec = { ...(evidence.evaluationSpec as object), courseRequirement: prerequisiteBinding };
    if (change === "research") evidence.evaluationSpec = { ...(evidence.evaluationSpec as object), problemId: "span-reserved-generated-research-consistent-3d-1729-0" };
    if (change === "rubric") input.requirements[1]!.verification.kind = "rubric";
    if (change === "unlisted") input.requirements[1]!.verification.exerciseKeys = [];
    if (change === "stem") evidence.attempt.stemSnapshot = "fabricated operands";
    expectReason(input, ["spec", "research", "rubric", "unlisted", "stem"].includes(change)
      ? "prerequisite_content_unavailable" : "prerequisite_verification_mismatch", "needs_clarification");
  });
  it("does not let matching incorrect labels replace rerunning the frozen answer", () => {
    const input = fixture(), evidence = input.evidence!;
    evidence.observation.answer = JSON.stringify({ membership: "in_span", coefficients: ["999", "999"], recognition: "uncertain" });
    expectReason(input, "prerequisite_verification_mismatch", "needs_clarification");
  });
  it("does not equate assisted correct work with a verified weak prerequisite", () => {
    const input = fixture(), evidence = input.evidence!;
    const answer = { membership: "in_span", coefficients: ["0", "0"] };
    const solution = verifySpanAnswer(problem, answer).solution;
    if (solution.kind !== "unique") throw new Error("fixture must have a unique solution");
    evidence.observation.answer = JSON.stringify({ ...answer, coefficients: solution.coefficients,
      equation: { vectors: problem.vectors, target: problem.target }, coordinateChecks: problem.target });
    const verified = verifySpanAnswer(problem, evidence.observation.answer);
    evidence.observation.outcome = "correct"; evidence.observation.assistance = "revealed";
    evidence.observation.serverEvaluation = { ...evidence.observation.serverEvaluation!, evaluatorVersion: "span-exact-v1", specVersion: "span-v1",
      decision: "correct", outcome: "correct", skills: verified.skills, coreEvidenceComplete: true, membershipOutcome: verified.membershipOutcome };
    evidence.context.serverEvaluation = evidence.observation.serverEvaluation;
    expectReason(input, "prerequisite_not_verified_weak");
  });
});
