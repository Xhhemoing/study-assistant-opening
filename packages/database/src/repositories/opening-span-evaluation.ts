import { getSpanReservedProblem } from "@aistudy/domain/span-heldout-catalog";
import type { Scope } from "@aistudy/contracts";
import { getSpanProblem, spanProblemStem, verifySpanAnswer, SPAN_REQUIREMENT_KEY } from "@aistudy/domain";
import type { TransactionSql } from "postgres";
import { readOpeningSpanExposureHistory } from "./opening-span-attempt";

export type OpeningSpanEvaluation = {
  evaluatorVersion: "span-exact-v1"; specVersion: "span-v1";
  decision: "correct" | "incorrect" | "abstain"; outcome: "correct" | "incorrect" | "unverified";
  reasonCodes: string[]; priorFeedback: boolean;
  skills?: ReturnType<typeof verifySpanAnswer>["skills"]; coreEvidenceComplete?: boolean; membershipOutcome?: "correct" | "incorrect" | "unobserved";
};

/** The frozen item, never a client supplied operand or verdict, chooses the exact verifier. */
export async function evaluateOpeningSpanAttempt(tx: TransactionSql, scope: Scope,
  attempt: Record<string, unknown> | undefined, answer: string, admittedSources: readonly Record<string, unknown>[],
): Promise<OpeningSpanEvaluation | null> {
  if (!attempt?.item_version_id || !((attempt.create_intent as { spanExercise?: unknown } | null)?.spanExercise
    || String(attempt.requirement_key ?? "").startsWith("span:"))) return null;
  const abstain = (reason: string): OpeningSpanEvaluation => ({ evaluatorVersion: "span-exact-v1", specVersion: "span-v1", decision: "abstain", outcome: "unverified", reasonCodes: [reason], priorFeedback: (attempt.create_intent as { spanExercise?: { problemId?: string } } | null)?.spanExercise?.problemId === "span-faded-3d" });
  const rows = await tx`SELECT v.evaluation_spec,v.source_id,v.source_version,v.stem_snapshot,
      p.stem_snapshot AS current_stem,p.source_version AS current_source_version
    FROM opening_learning_item_versions v JOIN opening_problem_refs p ON p.problem_id=v.problem_id AND p.workspace_id=v.workspace_id
    WHERE v.id=${String(attempt.item_version_id)} AND v.problem_id=${String(attempt.problem_id)}
      AND v.workspace_id=${scope.workspaceId} AND v.owner_user_id=${scope.ownerUserId} FOR SHARE OF v,p`;
  const item = rows[0];
  const spec = item?.evaluation_spec as { kind?: string; specVersion?: string; problemId?: string; version?: number | string } | null;
  if (!spec || spec.kind !== "span" || spec.specVersion !== "span-v1" || typeof spec.problemId !== "string") return abstain("missing_or_unsupported_spec");
  const problem = getSpanProblem(spec.problemId, spec.version) ?? getSpanReservedProblem(spec.problemId, spec.version);
  if (!problem) return abstain("missing_or_unsupported_spec");
  if (item!.stem_snapshot !== spanProblemStem(problem) || attempt.requirement_key !== SPAN_REQUIREMENT_KEY) return abstain("spec_identity_mismatch");
  const captured = attempt.source_versions as Record<string, number>;
  if (admittedSources.some(source => captured[String(source.id)] !== Number(source.version))
    || Number(item!.source_version) !== Number(item!.current_source_version) || item!.stem_snapshot !== item!.current_stem) return abstain("version_changed");
  let parsed: unknown;
  try { parsed = JSON.parse(answer); } catch { return abstain("unparseable_structure"); }
  const result = verifySpanAnswer(problem, parsed);
  // Same item feedback is remembered after correction/retraction too. A retry is practice.
  const prior = await tx`SELECT o.id FROM opening_learning_observations o
    JOIN opening_learning_item_versions v ON v.id=o.item_version_id AND v.workspace_id=o.workspace_id AND v.owner_user_id=o.owner_user_id
    WHERE o.workspace_id=${scope.workspaceId} AND o.owner_user_id=${scope.ownerUserId} AND o.course_id=${String(attempt.course_id)}
      AND v.evaluation_spec=${tx.json(spec)} AND o.attempt_id<>${String(attempt.id)}
      AND o.server_evaluation->>'evaluatorVersion'='span-exact-v1'
      AND o.server_evaluation->>'decision' IN ('correct','incorrect') LIMIT 1`;
  // Imported records cannot authorize a score, but their old exposure cannot be
  // forgotten when a new canonical item version is issued after restoration.
  const history = await readOpeningSpanExposureHistory(tx, scope);
  const verified = result.outcome === "correct" && result.coreEvidenceComplete;
  return { evaluatorVersion: "span-exact-v1", specVersion: "span-v1",
    decision: result.outcome === "incorrect" ? "incorrect" : verified ? "correct" : "abstain",
    outcome: result.outcome === "incorrect" ? "incorrect" : verified ? "correct" : "unverified",
    reasonCodes: [result.outcome === "correct" && !result.coreEvidenceComplete ? "core_steps_unobserved" : result.reason],
    skills: result.skills, coreEvidenceComplete: result.coreEvidenceComplete,
    membershipOutcome: result.membershipOutcome,
    priorFeedback: prior.length > 0 || problem.id === "span-faded-3d" || history.uncertainProblemIds.has(problem.id) || history.unknownHistory };
}
