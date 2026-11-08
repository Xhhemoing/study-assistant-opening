import type { Sql, TransactionSql } from "postgres";
import { courseSourcePurposeAllows, type CourseSourcePurpose, type CourseSourceUse } from "@aistudy/contracts";
import type { OpeningScope } from "./opening-sources";
import { OpeningKnowledgeError } from "./opening-knowledge";

/** Tutor / cite pool: max sourceIds accepted on a turn (contracts + Package B). */
export const READY_COURSE_SOURCE_IDS_CAP = 32;

export type OpeningCourseReadySourcesRepository = {
  listReadySourceIdsForCourse(scope: OpeningScope, courseId: string, use?: CourseSourceUse): Promise<string[]>;
  /** Uncapped live admission for explicit sourceIds; never treats selection as authorization. */
  admitSourceIds(scope: OpeningScope, courseId: string, sourceIds: readonly string[], use: CourseSourceUse): Promise<string[]>;
};

async function assertOwnedCourse(sql: Sql | TransactionSql, scope: OpeningScope, courseId: string): Promise<void> {
  const rows = await sql`
    SELECT c.id FROM courses c
    JOIN workspaces w ON w.id = c.workspace_id
    WHERE c.id = ${courseId}
      AND c.workspace_id = ${scope.workspaceId}
      AND w.owner_user_id = ${scope.ownerUserId}
      AND c.archived_at IS NULL`;
  if (!rows.length) throw new OpeningKnowledgeError("NOT_FOUND", "course not found");
}

/**
 * Course-scoped ready source pool for cite Package B.
 * Membership sources that are uploaded+parse-ready, privacy-excluded filtered, capped at 32.
 * Deterministic: membership sort_order, created_at, then source id.
 */
export async function listReadySourceIdsForCourse(
  sql: Sql,
  scope: OpeningScope,
  courseId: string,
  use: CourseSourceUse = "teaching",
): Promise<string[]> {
  await assertOwnedCourse(sql, scope, courseId);

  const rows = await sql`
    SELECT s.id AS id
    FROM course_asset_memberships m
    JOIN opening_sources s
      ON s.id = m.asset_id
      AND s.workspace_id = m.workspace_id
    WHERE m.course_id = ${courseId}
      AND m.workspace_id = ${scope.workspaceId}
      AND m.asset_type = 'source'
      AND (m.purpose IS NULL OR m.purpose = 'teaching'
        OR (${use === "practice" || use === "citation"} AND m.purpose = 'practice')
        OR (${use === "citation"} AND m.purpose = 'reference'))
      AND s.workspace_id = ${scope.workspaceId}
      AND s.upload_state = 'uploaded'
      AND s.parse_state = 'ready'
      AND NOT EXISTS (
        SELECT 1 FROM opening_privacy_exclusions e
        WHERE e.workspace_id = s.workspace_id AND e.source_id = s.id
      )
    ORDER BY m.sort_order ASC, m.created_at ASC, s.id ASC
    LIMIT ${READY_COURSE_SOURCE_IDS_CAP}`;

  return rows.map((row) => String((row as { id: string }).id));
}

export function createOpeningCourseReadySourcesRepository(
  sql: Sql,
): OpeningCourseReadySourcesRepository {
  return {
    listReadySourceIdsForCourse: (scope, courseId, use) =>
      listReadySourceIdsForCourse(sql, scope, courseId, use),
    async admitSourceIds(scope, courseId, sourceIds, use) {
      await assertOwnedCourse(sql, scope, courseId);
      if (!sourceIds.length) return [];
      const rows = await sql`SELECT s.id,m.purpose FROM course_asset_memberships m
        JOIN opening_sources s ON s.id=m.asset_id AND s.workspace_id=m.workspace_id
        WHERE m.workspace_id=${scope.workspaceId} AND m.course_id=${courseId} AND m.asset_type='source'
          AND s.id IN ${sql([...new Set(sourceIds)])} AND s.upload_state='uploaded' AND s.parse_state='ready'
          AND NOT EXISTS(SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id)`;
      const allowed = new Set(rows.filter(row => courseSourcePurposeAllows(row.purpose as CourseSourcePurpose | null, use)).map(row => String(row.id)));
      return [...new Set(sourceIds)].filter(id => allowed.has(id));
    },
  };
}
