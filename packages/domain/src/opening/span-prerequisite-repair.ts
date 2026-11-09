import type {
  CourseRequirement, LearningAttempt, LearningObservation, SpanPrerequisiteQualification,
  SpanPrerequisiteReason, SpanRepairRequirementIdentity,
} from "@aistudy/contracts";
import { courseRequirementSourcesAvailable, type CourseRouteSourceChunk } from "./course-route";
import { evaluateEvidenceEligibility, type EvidenceEligibilityContext } from "./evidence-eligibility";
import { getSpanReservedProblem, getSpanTeachingProblem } from "./span-heldout-catalog";
import { SPAN_REQUIREMENT_KEY, spanProblemStem } from "./span-teaching-catalog";
import { verifySpanAnswer } from "./span-verifier";

type BoundAttempt = Pick<LearningAttempt, "id" | "courseId" | "sessionId" | "problemId" | "itemVersionId"
  | "observationId" | "sourceIds" | "sourceVersions" | "requirementKey" | "courseRequirement" | "stemSnapshot">;
/** Adapter supplies owned, current records and the existing frozen evaluation spec.
 * Labels, projected progress, model conclusions and target errors are intentionally not inputs.
 * The attempt's optional courseRequirement must come from a trusted exact bridge; no such
 * bridge is synthesized here. This module has no I/O and does not authorize a detour.
 */
export type SpanPrerequisiteQualificationInput = {
  courseId: string;
  targetBinding: SpanRepairRequirementIdentity | null;
  prerequisiteBinding: SpanRepairRequirementIdentity | null;
  requirements: readonly CourseRequirement[];
  sources: ReadonlyMap<string, number>;
  chunks: readonly CourseRouteSourceChunk[];
  evidence: {
    observation: LearningObservation;
    root: Pick<LearningObservation, "id" | "effectiveHeadId">;
    attempt: BoundAttempt;
    evaluationSpec: unknown;
    context: EvidenceEligibilityContext;
  } | null;
};
const unknown = (reasonCode: SpanPrerequisiteReason): SpanPrerequisiteQualification => ({ status: "unknown", reasonCode });
const clarify = (reasonCode: SpanPrerequisiteReason): SpanPrerequisiteQualification => ({ status: "needs_clarification", reasonCode });
function sameBinding(a: SpanRepairRequirementIdentity | undefined, b: SpanRepairRequirementIdentity) {
  return a?.id === b.id && a.revision === b.revision && a.stableSkillId === b.stableSkillId && a.requirementKey === b.requirementKey;
}
function currentRequirement(input: SpanPrerequisiteQualificationInput, binding: SpanRepairRequirementIdentity) {
  const matches = input.requirements.filter(row => row.id === binding.id);
  const row = matches[0];
  // Even a supported graph node is not a unique binding when the course identities conflict.
  return matches.length === 1 && row && row.courseId === input.courseId && row.lifecycle === "active"
    && sameBinding(row, binding) && input.requirements.filter(item => item.stableSkillId === row.stableSkillId).length === 1
    && input.requirements.filter(item => item.requirementKey === row.requirementKey).length === 1 ? row : null;
}
function sameVersions(a: Record<string, number>, b: Record<string, number>) {
  const ids = Object.keys(a);
  return ids.length === Object.keys(b).length && ids.every(id => a[id] === b[id]);
}
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, i) => sameJson(value, b[i]));
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) || Array.isArray(b)) return false;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  return Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(key => Object.hasOwn(right, key) && sameJson(left[key], right[key]));
}

/** Narrow B admission: a confirmed direct relation AND the prerequisite's own current exact failure.
 * Missing bridges remain unknown; unsupported scoring/content requires clarification. No recursive
 * label search, mastery promotion, plan mutation, budget reservation or GET-time reselection.
 */
export function qualifySpanPrerequisiteRepair(input: SpanPrerequisiteQualificationInput): SpanPrerequisiteQualification {
  const { targetBinding, prerequisiteBinding, evidence } = input;
  if (!targetBinding || !prerequisiteBinding) return unknown("prerequisite_binding_missing");
  const target = currentRequirement(input, targetBinding), prerequisite = currentRequirement(input, prerequisiteBinding);
  if (!target || !prerequisite) return unknown("requirement_changed");
  if (target.id === prerequisite.id || target.stableSkillId === prerequisite.stableSkillId
    || !target.approvedAt || !prerequisite.approvedAt || !target.prerequisiteIds.includes(prerequisite.id)) return unknown("relation_unconfirmed");
  if (![target, prerequisite].every(row => courseRequirementSourcesAvailable(row, input.sources, input.chunks))) return unknown("source_unavailable");
  if (!evidence) return unknown("prerequisite_evidence_missing");
  const { observation, root, attempt, context } = evidence;
  if ((observation.rootObservationId ?? observation.id) !== root.id || (root.effectiveHeadId ?? root.id) !== observation.id
    || observation.revisionKind === "retract") return unknown("prerequisite_evidence_changed");
  if (!sameBinding(attempt.courseRequirement, prerequisiteBinding) || observation.courseId !== input.courseId || attempt.courseId !== input.courseId
    || observation.attemptId !== attempt.id || observation.sessionId !== attempt.sessionId
    || !attempt.problemId || !attempt.itemVersionId || observation.problemId !== attempt.problemId || observation.itemVersionId !== attempt.itemVersionId
    || attempt.observationId !== root.id && attempt.observationId !== observation.id
    || attempt.requirementKey !== prerequisite.requirementKey || observation.requirementKey !== prerequisite.requirementKey)
    return unknown("prerequisite_identity_mismatch");
  const versions = observation.sourceVersions;
  if (!versions || !observation.sourceIds.length || !sameVersions(versions, attempt.sourceVersions)
    || new Set(observation.sourceIds).size !== observation.sourceIds.length
    || new Set(attempt.sourceIds).size !== attempt.sourceIds.length
    || observation.sourceIds.length !== attempt.sourceIds.length || observation.sourceIds.some(id => !attempt.sourceIds.includes(id))
    || Object.keys(versions).length !== observation.sourceIds.length
    || observation.sourceIds.some(id => versions[id] === undefined || input.sources.get(id) !== versions[id])
    || prerequisite.sourceRefs.some(ref => versions[ref.sourceId] !== ref.sourceVersion)) return unknown("source_unavailable");
  if (context.version?.applicability !== "exact" || context.version.currentItemVersionId !== observation.itemVersionId)
    return unknown("prerequisite_evidence_changed");

  const spec = evidence.evaluationSpec as { problemId?: unknown; version?: unknown } | null;
  const problem = spec && typeof spec.problemId === "string" && (typeof spec.version === "number" || typeof spec.version === "string")
    ? getSpanTeachingProblem(spec.problemId, spec.version) ?? getSpanReservedProblem(spec.problemId, spec.version) : null;
  if (!problem || prerequisite.requirementKey !== SPAN_REQUIREMENT_KEY || prerequisite.verification.kind !== "exact"
    || prerequisite.verification.status !== "ready" || !prerequisite.verification.exerciseKeys.includes(problem.id))
    return clarify("prerequisite_content_unavailable");
  // Keep the current span scoring spec byte-shape: never invent binding fields in it.
  if (!sameJson(evidence.evaluationSpec, { kind: "span", specVersion: "span-v1", problemId: problem.id, version: Number(problem.version),
    familyId: problem.familyId, requirementKey: SPAN_REQUIREMENT_KEY, knowledgeComponents: problem.knowledgeComponents,
    transfer: problem.transfer ?? null }) || attempt.stemSnapshot !== spanProblemStem(problem))
    return clarify("prerequisite_content_unavailable");
  const evaluation = observation.serverEvaluation;
  if (observation.verdictSource !== "deterministic" || evaluation?.evaluatorVersion !== "span-exact-v1"
    || !sameJson(context.serverEvaluation, evaluation)) return clarify("prerequisite_verification_mismatch");
  const eligibility = evaluateEvidenceEligibility({ observationId: observation.id, courseId: observation.courseId,
    requirementKey: observation.requirementKey, attemptId: observation.attemptId, problemId: observation.problemId,
    itemVersionId: observation.itemVersionId, outcome: observation.outcome, verdictSource: observation.verdictSource }, context);
  if (eligibility.usableForCurrentVersion !== "yes" || eligibility.verifiedCorrect === "unknown") return clarify("prerequisite_verification_mismatch");
  const verified = verifySpanAnswer(problem, observation.answer);
  if (verified.outcome === "unknown" || evaluation.outcome !== verified.outcome || evaluation.decision !== verified.outcome
    || !sameJson(evaluation.skills, verified.skills) || evaluation.coreEvidenceComplete !== verified.coreEvidenceComplete
    || evaluation.membershipOutcome !== verified.membershipOutcome) return clarify("prerequisite_verification_mismatch");
  if (eligibility.verifiedCorrect !== "no" || verified.outcome !== "incorrect") return unknown("prerequisite_not_verified_weak");
  return { status: "verified_weak", courseId: input.courseId, targetRequirement: { ...targetBinding },
    prerequisiteRequirement: { ...prerequisiteBinding }, relationSource: "confirmed_course_requirement",
    returnToRequirementId: target.id, evaluatedContent: { problemId: problem.id, version: problem.version },
    basis: { observationId: observation.id, rootObservationId: root.id, attemptId: attempt.id,
      problemId: attempt.problemId, itemVersionId: attempt.itemVersionId,
      sourceRefs: observation.sourceIds.map(sourceId => ({ sourceId, sourceVersion: versions[sourceId]! })),
      evaluatorVersion: "span-exact-v1", specVersion: "span-v1" } };
}
