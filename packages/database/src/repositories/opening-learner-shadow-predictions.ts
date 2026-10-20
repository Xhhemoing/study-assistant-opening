import type { Scope } from "@aistudy/contracts";
import { compareLearnerShadow, predictLearnerShadow, type LearnerShadowPrediction } from "@aistudy/domain";
import type { Sql, TransactionSql } from "postgres";
import { learningError } from "./opening-learning-facts";
import { readOpeningLearnerState } from "./opening-learner-state-read";

/** Called only by canonical attempt-start, in its transaction before returning the new item. */
export async function captureOpeningLearnerShadowPredictions(tx: TransactionSql, scope: Scope, attemptId: string): Promise<void> {
  const [attempt] = await tx`SELECT a.*,v.evaluation_spec FROM opening_learning_attempts a LEFT JOIN opening_learning_item_versions v
    ON v.id=a.item_version_id AND v.workspace_id=a.workspace_id AND v.owner_user_id=a.owner_user_id
    WHERE a.id=${attemptId} AND a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId} FOR UPDATE OF a`;
  if (!attempt) throw learningError("NOT_FOUND", "attempt not found");
  const [existing] = await tx`SELECT attempt_id FROM opening_learning_shadow_predictions WHERE attempt_id=${attemptId}
    AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
  if (existing) return;
  if (attempt.submitted_at != null || attempt.observation_id != null) throw learningError("CONFLICT", "cannot predict an answered attempt");
  const state = await readOpeningLearnerState(tx, scope);
  const [clock] = await tx`SELECT clock_timestamp() AS cutoff`;
  const cutoff = new Date(clock!.cutoff as Date).toISOString();
  const spec = attempt.evaluation_spec as Record<string, unknown> | null;
  // A family is never inferred from a new UUID or matching skill label.
  const familyKey = typeof spec?.familyId === "string" ? spec.familyId : null;
  const problemRows = familyKey ? await tx`SELECT DISTINCT o.id FROM opening_learning_observations o
    JOIN opening_learning_item_versions v ON v.id=o.item_version_id AND v.workspace_id=o.workspace_id AND v.owner_user_id=o.owner_user_id
    WHERE o.workspace_id=${scope.workspaceId} AND o.owner_user_id=${scope.ownerUserId}
      AND (v.evaluation_spec->>'familyId'=${familyKey} OR o.problem_id=${attempt.problem_id as string | null})`
    : await tx`SELECT id FROM opening_learning_observations WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
      AND problem_id=${attempt.problem_id as string | null}`;
  const previousFamily = familyKey ? await tx`SELECT a.id FROM opening_learning_attempts a
    JOIN opening_learning_item_versions v ON v.id=a.item_version_id AND v.workspace_id=a.workspace_id AND v.owner_user_id=a.owner_user_id
    WHERE a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId}
      AND a.id<>${attemptId} AND a.started_at<=${attempt.started_at as Date}
      AND v.evaluation_spec->>'familyId'=${familyKey} LIMIT 1` : [];
  const knownTarget = typeof attempt.requirement_key === "string" && typeof attempt.course_id === "string" && familyKey !== null;
  const result = knownTarget ? predictLearnerShadow({ features: state.features, courseId: String(attempt.course_id),
    requirementKey: String(attempt.requirement_key), cutoff, excludedProblemIds: problemRows.map(row => String(row.id)) }) : null;
  const spanValidation = (attempt.create_intent as { spanValidation?: { firstFamilyExposure?: boolean } } | null)?.spanValidation;
  const receipt = { mode: "shadow", calibrated: false, target: "next_independent_verified_correct",
    familyKey, familySeenBefore: spanValidation?.firstFamilyExposure === false || previousFamily.length > 0, familySplit: "exclude_target_family", timeSplit: "strictly_before_input_cutoff",
    unavailableReason: knownTarget ? null : "canonical_family_or_requirement_unavailable", ...result };
  await tx`INSERT INTO opening_learning_shadow_predictions(attempt_id,workspace_id,owner_user_id,course_id,requirement_key,family_key,input_cutoff,state_version,receipt)
    VALUES (${attemptId},${scope.workspaceId},${scope.ownerUserId},${attempt.course_id as string | null},${attempt.requirement_key as string | null},${familyKey},${cutoff},${state.stateVersion},${tx.json(receipt as never)})`;
}

/** Live eligibility invalidates retracted/assisted/version-changed outcomes and histories without writing repairs. */
export function createOpeningLearnerShadowPredictionsRepository(sql: Sql) {
  return { compare: (scope: Scope, options: { advanceThreshold?: number; courseId?: string } = {}) => sql.begin("isolation level repeatable read read only", async tx => {
    const state = await readOpeningLearnerState(tx, scope, { courseId: options.courseId });
    const rows = await tx`SELECT p.*,a.observation_id,a.submitted_at FROM opening_learning_shadow_predictions p
      JOIN opening_learning_attempts a ON a.id=p.attempt_id AND a.workspace_id=p.workspace_id AND a.owner_user_id=p.owner_user_id
      WHERE p.workspace_id=${scope.workspaceId} AND p.owner_user_id=${scope.ownerUserId}
        AND ${options.courseId ? tx`p.course_id=${options.courseId}` : tx`TRUE`} ORDER BY p.input_cutoff,p.attempt_id`;
    const excluded: Record<string, number> = {};
    const scored: Array<{ predictions: LearnerShadowPrediction[]; correct: boolean; familyKey: string; predictedAt: string }> = [];
    for (const row of rows) {
      const receipt = row.receipt as { predictions?: LearnerShadowPrediction[]; evidenceObservationIds?: string[]; familySeenBefore?: boolean };
      const outcome = state.features.find(feature => feature.observationId === row.observation_id || feature.attemptId === row.attempt_id);
      const cutoff = new Date(row.input_cutoff as Date).getTime();
      let reason: string | null = !receipt.predictions ? "missing_family_or_target" : receipt.familySeenBefore ? "family_previously_seen" : !outcome ? "pending_or_retracted" : null;
      if (!reason && outcome && (outcome.eligibility.independentAttempt !== "yes" || outcome.eligibility.verifiedCorrect === "unknown"
        || outcome.eligibility.usableForCurrentVersion !== "yes")) reason = "outcome_ineligible";
      if (!reason && (!row.submitted_at || cutoff >= new Date(row.submitted_at as Date).getTime())) reason = "prediction_not_before_answer";
      if (!reason && receipt.evidenceObservationIds?.some(id => { const feature = state.features.find(row => row.observationId === id);
        return !feature || feature.eligibility.independentAttempt !== "yes" || feature.eligibility.usableForCurrentVersion !== "yes"
          || feature.eligibility.verifiedCorrect === "unknown" || Date.parse(feature.attemptedAt) >= cutoff; })) reason = "invalidated_history";
      if (reason) excluded[reason] = (excluded[reason] ?? 0) + 1;
      else scored.push({ predictions: receipt.predictions!, correct: outcome!.eligibility.verifiedCorrect === "yes", familyKey: String(row.family_key), predictedAt: new Date(cutoff).toISOString() });
    }
    return { ...compareLearnerShadow(scored, options), excluded, dataAsOf: state.dataAsOf };
  }) };
}
