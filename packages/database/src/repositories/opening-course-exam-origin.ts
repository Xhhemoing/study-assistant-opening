import { courseExamSnapshotSchema, type Scope } from "@aistudy/contracts";
import type { Sql, TransactionSql } from "postgres";
import { learningError } from "./opening-learning-facts";

type ActivityIdentity = { id: string; clientKey: string };

const unavailable = () => learningError("CONFLICT", "组卷原件或引用已不可用，请重新选择；已发题的作答与历史保留。");

/** The activity key only narrows the lookup. The private paper owns the binding. */
export async function readOpeningCourseExamOrigin(
  db: Sql | TransactionSql, scope: Scope, activity: ActivityIdentity,
) {
  if (!activity.clientKey.startsWith("course-exam:")) return null;
  const rows = await db`SELECT s.course_id,a.id AS activity_id,a.course_id AS activity_course_id,s.pack_snapshot
    FROM opening_exam_sprints s JOIN opening_teaching_activities a
      ON a.workspace_id=s.workspace_id AND a.owner_user_id=s.owner_user_id AND a.id=${activity.id}
    WHERE s.workspace_id=${scope.workspaceId} AND s.owner_user_id=${scope.ownerUserId}
      AND s.course_id IS NOT NULL
      AND s.pack_snapshot @> jsonb_build_object('requests',
        jsonb_build_array(jsonb_build_object('activityId',a.id::text,'referenceMode','exam-only')))`;
  if (rows.length === 0) return null;
  const [row] = rows;
  if (rows.length !== 1 || row!.activity_course_id !== row!.course_id) throw unavailable();
  const snapshot = courseExamSnapshotSchema.safeParse(row!.pack_snapshot);
  if (!snapshot.success) throw unavailable();
  const requests = snapshot.data.requests.filter(request => request.activityId === row!.activity_id && request.referenceMode === "exam-only");
  const [request] = requests;
  if (requests.length !== 1 || request?.status !== "ready" || !request.proposal) throw unavailable();
  return { courseId: String(row!.course_id), sourceId: request.input.sourceId, sourceVersion: request.sourceVersion,
    firstPage: request.input.firstPage ?? null, lastPage: request.input.lastPage ?? null,
    evidenceChunkIds: [...new Set([...request.proposal.topics, ...request.proposal.questions].flatMap(item => item.evidenceChunkIds))] };
}

/** Verify current origin without returning original text to generic learning consumers. */
export async function assertOpeningCourseExamSourceCurrent(
  db: Sql | TransactionSql, scope: Scope, activity: ActivityIdentity, options: { readOnly?: boolean } = {},
) {
  const origin = await readOpeningCourseExamOrigin(db, scope, activity);
  if (!origin) return;
  const [source] = await db`SELECT s.id FROM courses c
    JOIN workspaces w ON w.id=c.workspace_id AND w.owner_user_id=${scope.ownerUserId}
    JOIN course_asset_memberships m ON m.course_id=c.id AND m.workspace_id=c.workspace_id
      AND m.asset_type='source' AND m.asset_id=${origin.sourceId} AND m.purpose='mock_exam'
    JOIN opening_sources s ON s.id=m.asset_id AND s.workspace_id=m.workspace_id
    JOIN opening_source_versions v ON v.source_id=s.id AND v.workspace_id=s.workspace_id AND v.version=s.version
    WHERE c.id=${origin.courseId} AND c.workspace_id=${scope.workspaceId} AND c.archived_at IS NULL
      AND s.version=${origin.sourceVersion} AND s.upload_state='uploaded' AND s.parse_state='ready'
      AND v.availability='available'
      AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id)
    ${options.readOnly ? db`` : db`FOR SHARE OF c,w,m,s,v`}`;
  if (!source) throw unavailable();
  const chunks = await db`SELECT id FROM opening_source_chunks
    WHERE source_id=${origin.sourceId} AND source_version=${origin.sourceVersion}
      AND (${origin.firstPage}::integer IS NULL OR page>=${origin.firstPage})
      AND (${origin.lastPage}::integer IS NULL OR page<=${origin.lastPage})
      AND id=ANY(${origin.evidenceChunkIds}::uuid[]) AND text ~ '[^[:space:]]'
    ${options.readOnly ? db`` : db`FOR SHARE`}`;
  if (chunks.length !== origin.evidenceChunkIds.length) throw unavailable();
}
