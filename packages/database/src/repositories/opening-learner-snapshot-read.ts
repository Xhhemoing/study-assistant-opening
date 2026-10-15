import type { Scope, TaskItem } from "@aistudy/contracts";
import type { Sql } from "postgres";

/** One unarchived course with the planning facts that do not depend on evidence. */
export type LearnerSnapshotCourseRow = {
  courseId: string;
  title: string;
  /** At least one linked source is uploaded, parsed and not privacy-excluded. */
  hasUsableMaterials: boolean;
  /** Raw stored knowledge snapshot (unvalidated JSONB); null when the course has none. */
  knowledgeSnapshot: unknown;
};

export type LearnerSnapshotTaskRow = {
  clientKey: string | null;
  status: TaskItem["status"];
  minutes: number;
  courseId: string | null;
  /** Last change; for a closed task this is when it became done or skipped. */
  updatedAt: string;
};

export type LearnerSnapshotBaseRows = {
  courses: LearnerSnapshotCourseRow[];
  tasks: LearnerSnapshotTaskRow[];
};

/**
 * Evidence-independent planning rows for one owner, read in one consistent snapshot.
 * Course evidence is read per course by readOpeningCourseEvidence so one course
 * failing does not hide the others.
 */
export function readOpeningLearnerSnapshotBase(sql: Sql, scope: Scope): Promise<LearnerSnapshotBaseRows> {
  return sql.begin("isolation level repeatable read read only", async (tx) => {
    const courseRows = await tx`
      SELECT c.id, c.title, k.snapshot AS knowledge_snapshot,
        EXISTS (
          SELECT 1 FROM course_asset_memberships m
          JOIN opening_sources s ON s.id = m.asset_id AND s.workspace_id = m.workspace_id
          WHERE m.course_id = c.id AND m.workspace_id = c.workspace_id AND m.asset_type = 'source'
            AND s.upload_state = 'uploaded' AND s.parse_state = 'ready'
            AND NOT EXISTS (
              SELECT 1 FROM opening_privacy_exclusions e
              WHERE e.workspace_id = s.workspace_id AND e.source_id = s.id
            )
        ) AS has_usable_materials
      FROM courses c
      JOIN workspaces w ON w.id = c.workspace_id
      LEFT JOIN opening_course_knowledge k
        ON k.course_id = c.id AND k.workspace_id = c.workspace_id AND k.owner_user_id = ${scope.ownerUserId}
      WHERE c.workspace_id = ${scope.workspaceId}
        AND w.owner_user_id = ${scope.ownerUserId}
        AND c.archived_at IS NULL
      ORDER BY c.created_at ASC, c.id ASC`;
    const taskRows = await tx`
      SELECT client_key, status, minutes, course_id, updated_at
      FROM opening_tasks
      WHERE workspace_id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
      ORDER BY created_at ASC, id ASC`;
    return {
      courses: courseRows.map((row) => ({
        courseId: String(row.id),
        title: String(row.title),
        hasUsableMaterials: Boolean(row.has_usable_materials),
        knowledgeSnapshot: row.knowledge_snapshot ?? null,
      })),
      tasks: taskRows.map((row) => ({
        clientKey: typeof row.client_key === "string" ? row.client_key : null,
        status: row.status as TaskItem["status"],
        minutes: Number(row.minutes),
        courseId: typeof row.course_id === "string" ? row.course_id : null,
        updatedAt: new Date(row.updated_at as string | Date).toISOString(),
      })),
    };
  }) as Promise<LearnerSnapshotBaseRows>;
}
