import type { TransactionSql } from "postgres";
import type { HelpExposure, Scope } from "@aistudy/contracts";
import { admitLearningSources, learningError, learningIso, lockLearningHistory, lockLearningSession, nextLearningHistoryRevision } from "./opening-learning-facts";

/** Called after the completed assistant turn is persisted, in that same transaction. */
export async function insertOpeningDeliveredHelp(tx: TransactionSql, scope: Scope, input: Omit<HelpExposure, "createdAt"> & { createdAt?: string }): Promise<HelpExposure> {
  if (input.delivered !== true) throw learningError("VALIDATION", "help must be persisted and retrievable");
  const session = await lockLearningSession(tx, scope, input.sessionId);
  await lockLearningHistory(tx, scope, String(session.course_id));
  await admitLearningSources(tx, scope, session.source_ids as string[]);
  const turns = await tx`SELECT t.id FROM opening_turns t JOIN opening_conversations c ON c.id=t.conversation_id AND c.workspace_id=t.workspace_id
    WHERE t.id=${input.turnId} AND t.workspace_id=${scope.workspaceId} AND c.owner_user_id=${scope.ownerUserId}
      AND t.role='assistant' AND t.status='complete' AND t.learning_session_id=${input.sessionId} FOR SHARE OF t`;
  if (!turns.length) throw learningError("VALIDATION", "delivered help requires a retrievable completed assistant turn");
  const existing = await tx`SELECT * FROM opening_help_exposures WHERE id=${input.id} AND workspace_id=${scope.workspaceId}`;
  if (existing[0]) return { ...input, createdAt: learningIso(existing[0].created_at)!, deliveredAt: learningIso(existing[0].delivered_at), historyRevision: Number(existing[0].history_revision) };
  const attempts = input.attemptId ? await tx`SELECT * FROM opening_learning_attempts WHERE id=${input.attemptId}
    AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND session_id=${input.sessionId} FOR UPDATE` : [];
  if (input.attemptId && !attempts[0]) throw learningError("VALIDATION", "help attempt does not belong to session");
  const problemId = attempts[0]?.problem_id as string | null ?? input.problemId;
  if (attempts[0] && input.problemId && input.problemId !== problemId) throw learningError("VALIDATION", "help problem does not match attempt");
  const revision = await nextLearningHistoryRevision(tx, scope, String(session.course_id));
  const rows = await tx`INSERT INTO opening_help_exposures(id,workspace_id,session_id,problem_id,turn_id,level,delivered,attempt_id,delivered_at,history_revision)
    VALUES (${input.id},${scope.workspaceId},${input.sessionId},${problemId},${input.turnId},${input.level},TRUE,${input.attemptId ?? null},clock_timestamp(),${revision}) RETURNING *`;
  return { ...input, problemId, createdAt: learningIso(rows[0]!.created_at)!, deliveredAt: learningIso(rows[0]!.delivered_at), historyRevision: revision };
}
