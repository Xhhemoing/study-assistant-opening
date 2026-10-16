import type { Scope } from "@aistudy/contracts";
import { evaluateMatrixAnswer, matrixExerciseRequirement, matrixExerciseStem, parseCanonicalMatrixExercise, type MatrixEvaluation } from "@aistudy/domain";
import type { TransactionSql } from "postgres";
type OpeningMatrixEvaluation = MatrixEvaluation & { priorFeedback: boolean };

/** Only the original fact transaction invokes this adapter; HTTP never supplies a verdict. */
export async function evaluateOpeningMatrixAttempt(tx: TransactionSql, scope: Scope,
  attempt: Record<string, unknown> | undefined, answer: string, admittedSources: readonly Record<string, unknown>[],
): Promise<OpeningMatrixEvaluation | null> {
  if (!attempt?.item_version_id || !(Boolean((attempt.create_intent as { matrixExercise?: unknown } | null)?.matrixExercise)
    || String(attempt.requirement_key ?? "").startsWith("matrix:matrix-arithmetic-v1:"))) return null;
  const items = await tx`SELECT v.evaluation_spec,v.source_id,v.source_version,v.stem_snapshot,
      p.stem_snapshot AS current_stem,p.source_version AS current_source_version
    FROM opening_learning_item_versions v
    JOIN opening_problem_refs p ON p.problem_id=v.problem_id AND p.workspace_id=v.workspace_id
    WHERE v.id=${String(attempt.item_version_id)} AND v.problem_id=${String(attempt.problem_id)}
      AND v.workspace_id=${scope.workspaceId} AND v.owner_user_id=${scope.ownerUserId}
    FOR SHARE OF v,p`;
  const item = items[0];
  const abstain = (reason: string): OpeningMatrixEvaluation => ({ decision: "abstain", outcome: "unverified", reasonCodes: [reason], evaluatorVersion: "matrix-exact-v1", priorFeedback: false });
  const spec = parseCanonicalMatrixExercise(item?.evaluation_spec);
  if (!item || !spec) return abstain("missing_or_unsupported_spec");
  if (attempt.requirement_key !== matrixExerciseRequirement(spec) || item.stem_snapshot !== matrixExerciseStem(spec)) return abstain("spec_identity_mismatch");
  const captured = attempt.source_versions as Record<string, number>;
  if (admittedSources.some(source => captured[String(source.id)] !== Number(source.version))
    || Number(item.current_source_version) !== Number(item.source_version) || item.current_stem !== item.stem_snapshot) return abstain("version_changed");
  // Persisted feedback remains retrievable even after an observation correction.
  // Repeating a known catalogue question is practice, not a new unaided diagnostic.
  const prior = await tx`SELECT o.id FROM opening_learning_observations o
    JOIN opening_learning_item_versions v ON v.id=o.item_version_id AND v.workspace_id=o.workspace_id AND v.owner_user_id=o.owner_user_id
    WHERE o.workspace_id=${scope.workspaceId} AND o.owner_user_id=${scope.ownerUserId} AND o.course_id=${String(attempt.course_id)}
      AND v.evaluation_spec=${tx.json(spec)}
      AND o.attempt_id<>${String(attempt.id)} AND o.verdict_source='deterministic'
      AND o.server_evaluation->>'decision' IN ('correct','incorrect')
      AND o.recorded_at<=clock_timestamp() LIMIT 1`;
  return { ...evaluateMatrixAnswer(spec, answer), priorFeedback: prior.length > 0 };
}
