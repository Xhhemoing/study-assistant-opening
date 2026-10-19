import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Sql, TransactionSql } from "postgres";
import { studyIntentEventInputSchema, studyIntentEventSchema, studyIntentChangeSchema, studySessionIntentSchema,
  type Scope, type StudyIntentEvent, type StudyIntentEventInput } from "@aistudy/contracts";
import { DEFAULT_STUDY_SESSION_INTENT, applyExplicitStudyIntent, applyStudySessionSignal, updateStudySessionIntent, type StudySessionSignal } from "@aistudy/domain";
import { learningError, lockWorkspaceLearningHistory, nextWorkspaceLearningHistoryRevision } from "./opening-learning-facts";
import { invalidateOpeningLearningEligibility } from "./opening-learning-eligibility";
function map(row: Record<string, unknown>): StudyIntentEvent {
  const { signals, ...change } = row.payload as Record<string, unknown>;
  return studyIntentEventSchema.parse({ id: row.id, sessionId: row.session_id, activityId: row.activity_id,
    attemptId: row.attempt_id, version: Number(row.version), change: studyIntentChangeSchema.parse(change),
    intent: row.resulting_intent, signals, action: row.action, createdAt: new Date(row.created_at as Date).toISOString() });
}
export async function readOpeningStudyIntentInTx(tx: TransactionSql, scope: Scope, sessionId: string): Promise<StudyIntentEvent | null> {
  const [row] = await tx`SELECT * FROM opening_study_intent_events WHERE session_id=${sessionId}
    AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} ORDER BY version DESC LIMIT 1`;
  return row ? map(row) : null;
}
/** Append under the same semantic lock as answer submission. Prior declarations cannot be erased. */
export async function appendOpeningStudyIntentInTx(tx: TransactionSql, scope: Scope, raw: StudyIntentEventInput): Promise<StudyIntentEvent> {
  const input = studyIntentEventInputSchema.parse(raw);
  await lockWorkspaceLearningHistory(tx, scope);
  const [session] = await tx`SELECT id,activity_id FROM opening_learning_sessions WHERE id=${input.sessionId}
    AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR SHARE`;
  if (!session) throw learningError("NOT_FOUND", "learning session not found");
  if (input.attemptId) {
    const [attempt] = await tx`SELECT id FROM opening_learning_attempts WHERE id=${input.attemptId} AND session_id=${input.sessionId}
      AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR SHARE`;
    if (!attempt) throw learningError("VALIDATION", "signal attempt does not belong to this session");
  }
  const [replay] = await tx`SELECT * FROM opening_study_intent_events WHERE workspace_id=${scope.workspaceId}
    AND owner_user_id=${scope.ownerUserId} AND client_key=${input.clientKey}`;
  if (replay) {
    const event = map(replay);
    if (event.sessionId !== input.sessionId || event.attemptId !== (input.attemptId ?? null) || !isDeepStrictEqual(event.change, input.change)) throw learningError("CONFLICT", "study intent key reused for another event");
    return event;
  }
  const latest = await readOpeningStudyIntentInTx(tx, scope, input.sessionId);
  const current = latest?.intent ?? DEFAULT_STUDY_SESSION_INTENT;
  let intent = current, signals: StudySessionSignal[] = [], action: StudyIntentEvent["action"] = "continue";
  if (input.change.kind === "preference") intent = updateStudySessionIntent(current, input.change.intent);
  else if (input.change.kind === "signal") {
    signals = [input.change.signal];
    const applied = applyStudySessionSignal(current, input.change.signal); intent = applied.intent; action = applied.action;
  } else {
    const applied = applyExplicitStudyIntent(current, input.change.text); intent = applied.intent; signals = applied.signals;
    action = applied.needsConfirmation ? "clarify_intent" : signals.includes("confused") ? "diagnose" : signals.includes("too_easy") ? "increase_challenge" : "continue";
  }
  if (!input.attemptId && signals.some(signal => signal === "copied_answer" || signal === "guessed")) throw learningError("VALIDATION", "answer-condition reports require the actual attempt");
  const id = randomUUID();
  const [row] = await tx`INSERT INTO opening_study_intent_events(id,workspace_id,owner_user_id,session_id,activity_id,attempt_id,client_key,version,event_kind,payload,resulting_intent,action)
    VALUES (${id},${scope.workspaceId},${scope.ownerUserId},${input.sessionId},${String(session.activity_id)},${input.attemptId ?? null},${input.clientKey},${(latest?.version ?? 0) + 1},
      ${input.change.kind},${tx.json({ ...input.change, signals })},${tx.json(studySessionIntentSchema.parse(intent))},${action}) RETURNING *`;
  await tx`UPDATE opening_teaching_activities SET goal_json=goal_json || ${tx.json({ sessionIntent: intent, sessionIntentEventId: id, sessionIntentVersion: (latest?.version ?? 0) + 1 })}::jsonb
    WHERE id=${String(session.activity_id)} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
  if (input.attemptId && signals.some(signal => signal === "copied_answer" || signal === "guessed")) {
    const roots = await tx`SELECT DISTINCT COALESCE(root_observation_id,id) AS id FROM opening_learning_observations
      WHERE attempt_id=${input.attemptId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
    await invalidateOpeningLearningEligibility(tx, scope, { rootIds: roots.map(root => String(root.id)) });
  }
  await nextWorkspaceLearningHistoryRevision(tx, scope);
  return map(row!);
}
export function createOpeningStudyIntentRepository(sql: Sql) {
  return { forCourse: (scope: Scope, eventId: string, courseId: string): Promise<StudyIntentEvent | null> => sql.begin("isolation level repeatable read read only", async tx => {
      const [row] = await tx`SELECT e.* FROM opening_study_intent_events e JOIN opening_learning_sessions s
        ON s.id=e.session_id AND s.workspace_id=e.workspace_id AND s.owner_user_id=e.owner_user_id
        WHERE e.id=${eventId} AND e.workspace_id=${scope.workspaceId} AND e.owner_user_id=${scope.ownerUserId} AND s.course_id=${courseId}`;
      return row ? readOpeningStudyIntentInTx(tx, scope, String(row.session_id)) : null;
    }) as Promise<StudyIntentEvent | null>, append: (scope: Scope, input: StudyIntentEventInput): Promise<StudyIntentEvent> => sql.begin(tx => appendOpeningStudyIntentInTx(tx, scope, input)) as Promise<StudyIntentEvent>,
    latest: (scope: Scope, sessionId: string): Promise<StudyIntentEvent | null> => sql.begin("isolation level repeatable read read only", tx => readOpeningStudyIntentInTx(tx, scope, sessionId)) as Promise<StudyIntentEvent | null> };
}
