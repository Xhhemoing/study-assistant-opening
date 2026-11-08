import type { Scope } from "@aistudy/contracts";
import { compareCurrentLearningActivities, selectCurrentLearningActivity } from "@aistudy/domain";
import type { Sql, TransactionSql } from "postgres";

type Db = Sql | TransactionSql;
/** Server-side identities only; never pass browser-provided task projections here. */
export type OpeningCurrentLearningReference = { activityId?: string | null; sessionId?: string | null; taskId?: string | null };
export type OpeningCurrentLearningActivity = { activityId: string; sessionId: string | null; courseId: string };
type CandidateOptions = { spanOnly?: boolean; retestReferences?: string[] | null; references?: string[]; sessionId?: string | null };
async function candidates(db: Db, scope: Scope, courseId: string | null, options: CandidateOptions = {}) {
  const rows = await db`SELECT a.id,a.course_id,a.status,a.updated_at,a.content_version,a.intent_kind,a.create_intent,s.id AS session_id
    FROM opening_teaching_activities a
    JOIN workspaces w ON w.id=a.workspace_id AND w.owner_user_id=a.owner_user_id
    JOIN courses c ON c.id=a.course_id AND c.workspace_id=a.workspace_id AND c.archived_at IS NULL
    LEFT JOIN opening_learning_sessions s ON s.id::text=COALESCE(a.checkpoint_json->'spanLesson'->>'sessionId',${options.sessionId ?? null}::text)
      AND s.activity_id=a.id AND s.course_id=a.course_id AND s.workspace_id=a.workspace_id AND s.owner_user_id=a.owner_user_id
    WHERE a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId}
      AND (${courseId}::uuid IS NULL OR a.course_id=${courseId}) AND a.status IN ('active','paused')
      AND a.create_intent->>'protocol' IS DISTINCT FROM 'card-review-session-v1'
      AND COALESCE(a.create_intent->>'legacy','false')<>'true'
      AND ${options.spanOnly ? db`a.create_intent->>'protocol'='span-lesson-v1'` : db`true`}
      AND ${options.retestReferences ? db`lower(a.checkpoint_json->'spanLesson'->>'retestId')=ANY(${options.retestReferences}::text[])`
        : options.spanOnly ? db`a.checkpoint_json->'spanLesson'->>'retestId' IS NULL` : db`true`}
      AND ${options.references?.length ? db`a.id::text=ANY(${options.references}::text[])` : db`true`}`;
  return rows.map(row => {
    const span = row.create_intent?.protocol === "span-lesson-v1";
    return { id: String(row.id), courseId: String(row.course_id), status: String(row.status),
      updatedAt: new Date(row.updated_at).toISOString(), sessionId: row.session_id ? String(row.session_id) : null,
      // Static lessons own persisted session content; zero compiled blocks alone
      // does not make them legacy placeholders.
      placeholder: span ? !row.session_id : row.intent_kind === "course_continue" && Number(row.content_version) === 0 };
  });
}
/** Read-only identity owner. Content, authorization and receipts stay with their existing readers. */
export async function readOpeningCurrentLearningActivity(db: Db, scope: Scope, courseId: string,
  reference: OpeningCurrentLearningReference = {}, options: { spanOnly?: boolean; retestId?: string } = {}): Promise<OpeningCurrentLearningActivity | null> {
  const references: string[] = [];
  let retestReferences: string[] | null = null;
  if (options.retestId) {
    const retests = await db`SELECT id,candidate_id,candidate_reference_id FROM opening_retest_activities
      WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND course_id=${courseId}
        AND (id::text=${options.retestId} OR candidate_id::text=${options.retestId} OR candidate_reference_id::text=${options.retestId})`;
    if (retests.length !== 1) return null;
    retestReferences = [retests[0]!.id, retests[0]!.candidate_id, retests[0]!.candidate_reference_id]
      .filter((id): id is string => typeof id === "string").map(id => id.toLowerCase());
  }
  if (reference.activityId != null) references.push(reference.activityId);
  if (reference.sessionId != null) {
    const [session] = await db`SELECT s.activity_id FROM opening_learning_sessions s
      JOIN opening_teaching_activities a ON a.id=s.activity_id AND a.course_id=s.course_id
        AND a.workspace_id=s.workspace_id AND a.owner_user_id=s.owner_user_id
      JOIN workspaces w ON w.id=s.workspace_id AND w.owner_user_id=s.owner_user_id
      WHERE s.id::text=${reference.sessionId} AND s.workspace_id=${scope.workspaceId}
        AND s.owner_user_id=${scope.ownerUserId} AND s.course_id=${courseId}`;
    if (!session) return null;
    references.push(String(session.activity_id));
  }
  if (reference.taskId != null) {
    // Do not filter closed activities here: a closed explicit binding must block
    // fallback. Task-looking client keys alone are not binding evidence.
    const tasks = await db`SELECT t.id,t.client_key,t.origin,a.id AS activity_id FROM opening_tasks t
      JOIN workspaces w ON w.id=t.workspace_id AND w.owner_user_id=t.owner_user_id
      LEFT JOIN opening_teaching_activities a ON a.workspace_id=t.workspace_id AND a.owner_user_id=t.owner_user_id
        AND ((a.create_intent->>'source'='task' AND lower(a.create_intent->>'taskId')=t.id::text)
          OR (t.origin IN ('manual','course_seed') AND t.client_key='first-learning-activity:' || a.id::text
            AND a.create_intent->>'source'='onboarding' AND a.client_key LIKE 'first-learning:%'))
      WHERE t.id::text=${reference.taskId} AND t.workspace_id=${scope.workspaceId}
        AND t.owner_user_id=${scope.ownerUserId} AND t.course_id=${courseId} AND t.status='pending'`;
    if (!tasks.length) return null;
    const ids = [...new Set(tasks.flatMap(row => {
      const onboardingId = ["manual", "course_seed"].includes(String(row.origin)) && typeof row.client_key === "string"
        && row.client_key.startsWith("first-learning-activity:") ? row.client_key.slice("first-learning-activity:".length) : null;
      return [...(row.activity_id ? [String(row.activity_id)] : []), ...(onboardingId !== null ? [onboardingId] : [])];
    }))];
    if (ids.length > 1) return null;
    references.push(...ids);
  }
  const selected = selectCurrentLearningActivity(await candidates(db, scope, courseId,
    { ...options, retestReferences, references, sessionId: reference.sessionId }), courseId, references);
  if (!selected || reference.sessionId != null && selected.sessionId !== reference.sessionId) return null;
  return { activityId: selected.id, sessionId: selected.sessionId, courseId };
}
/** Cross-course management chooses among course-owned candidates with the same
 * ordering, then uses that exact identity for both its recovery link and agenda. */
export async function readOpeningCurrentLearningRecovery(db: Db, scope: Scope): Promise<OpeningCurrentLearningActivity | null> {
  const rows = await candidates(db, scope, null);
  const current = [...new Set(rows.map(row => row.courseId))]
    .flatMap(courseId => selectCurrentLearningActivity(rows, courseId) ?? []).sort(compareCurrentLearningActivities)[0];
  return current ? { activityId: current.id, sessionId: current.sessionId, courseId: current.courseId } : null;
}
