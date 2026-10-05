import { invalidateOpeningLearningEligibility } from "./opening-learning-eligibility";
import type { TransactionSql } from "postgres";
import type { HelpExposure, Scope } from "@aistudy/contracts";
import { admitLearningSources, learningError, learningIso, lockLearningHistory, lockLearningSession, nextLearningHistoryRevision, nextWorkspaceLearningHistoryRevision } from "./opening-learning-facts";

function mapDeliveredHelp(row: Record<string, unknown>): HelpExposure {
  return {
    id: String(row.id), sessionId: String(row.session_id),
    attemptId: (row.attempt_id ?? null) as string | null,
    problemId: row.problem_id as string | null, turnId: String(row.turn_id),
    level: row.level as HelpExposure["level"], delivered: true,
    createdAt: learningIso(row.created_at)!, deliveredAt: learningIso(row.delivered_at),
    historyRevision: Number(row.history_revision),
  };
}

/** Called after the completed assistant turn is persisted, in that same transaction. */
export async function insertOpeningDeliveredHelp(tx: TransactionSql, scope: Scope, input: Omit<HelpExposure, "createdAt"> & { createdAt?: string }): Promise<HelpExposure> {
  if (input.delivered !== true) throw learningError("VALIDATION", "help must be persisted and retrievable");
  const session = await lockLearningSession(tx, scope, input.sessionId);
  await lockLearningHistory(tx, scope, String(session.course_id));
  await admitLearningSources(tx, scope, session.source_ids as string[]);
  const turns = await tx`SELECT t.id FROM opening_turns t JOIN opening_conversations c ON c.id=t.conversation_id AND c.workspace_id=t.workspace_id
    WHERE t.id=${input.turnId} AND t.workspace_id=${scope.workspaceId} AND c.owner_user_id=${scope.ownerUserId}
      AND t.role='assistant' AND t.status='complete' AND t.learning_session_id=${input.sessionId}
      AND t.attempt_id IS NOT DISTINCT FROM ${input.attemptId ?? null}::uuid FOR SHARE OF t`;
  if (!turns.length) throw learningError("VALIDATION", "delivered help requires a retrievable completed assistant turn with the same attempt");
  const attempts = input.attemptId ? await tx`SELECT * FROM opening_learning_attempts WHERE id=${input.attemptId}
    AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND session_id=${input.sessionId} FOR UPDATE` : [];
  if (input.attemptId && !attempts[0]) throw learningError("VALIDATION", "help attempt does not belong to session");
  const problemId = attempts[0] ? attempts[0].problem_id as string | null : input.problemId;
  if (attempts[0] && input.problemId && input.problemId !== problemId) throw learningError("VALIDATION", "help problem does not match attempt");
  const existing = await tx`SELECT * FROM opening_help_exposures WHERE id=${input.id} AND workspace_id=${scope.workspaceId}`;
  if (existing[0]) {
    const saved = mapDeliveredHelp(existing[0]);
    if (saved.sessionId !== input.sessionId || saved.turnId !== input.turnId || saved.level !== input.level
      || saved.attemptId !== (input.attemptId ?? null) || saved.problemId !== problemId) {
      throw learningError("CONFLICT", "help exposure ID payload conflict");
    }
    return saved;
  }
  const revision = await nextLearningHistoryRevision(tx, scope, String(session.course_id));
  const rows = await tx`INSERT INTO opening_help_exposures(id,workspace_id,session_id,problem_id,turn_id,level,delivered,attempt_id,delivered_at,history_revision)
    VALUES (${input.id},${scope.workspaceId},${input.sessionId},${problemId},${input.turnId},${input.level},TRUE,${input.attemptId ?? null},clock_timestamp(),${revision}) RETURNING *`;
  await nextWorkspaceLearningHistoryRevision(tx, scope);
  const affected = await tx`SELECT DISTINCT COALESCE(o.root_observation_id,o.id) AS root_id FROM opening_learning_observations o
    JOIN opening_learning_sessions origin ON origin.id=o.session_id AND origin.workspace_id=o.workspace_id AND origin.owner_user_id=o.owner_user_id
    WHERE o.workspace_id=${scope.workspaceId} AND o.owner_user_id=${scope.ownerUserId} AND origin.course_id=${session.course_id}
      AND (o.attempt_id=${input.attemptId ?? null} OR o.problem_id=${problemId}
        OR (${input.attemptId == null && problemId == null} AND o.session_id=${input.sessionId}))`;
  await invalidateOpeningLearningEligibility(tx, scope, { rootIds: affected.map(row => String(row.root_id)) });
  return mapDeliveredHelp(rows[0]!);
}
