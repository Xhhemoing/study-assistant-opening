import type { Sql, TransactionSql } from "postgres";
import { courseSourcePurposeAllows, type CourseSourcePurpose, type CourseSourceUse } from "@aistudy/contracts";
import type { OpeningScope } from "./opening-sources";
import { OpeningKnowledgeError } from "./opening-knowledge";

/** Tutor / cite pool: max sourceIds accepted on a turn (contracts + Package B). */
export const READY_COURSE_SOURCE_IDS_CAP = 32;

/** Server-owned snapshot, not client/model input. Revision preserves PostgreSQL microseconds. */
export type OpeningSourcePurposePin = {
  activityId: string;
  courseId: string | null;
  materialUse: CourseSourceUse;
  sources: Array<{
    sourceId: string;
    sourceVersion: number;
    membershipId: string | null;
    purposeRevision: string | null;
    purpose: CourseSourcePurpose | null;
  }>;
};

export type OpeningCourseReadySourcesRepository = {
  listReadySourceIdsForCourse(scope: OpeningScope, courseId: string, use?: CourseSourceUse): Promise<string[]>;
  /** Uncapped live admission for explicit sourceIds; never treats selection as authorization. */
  admitSourceIds(scope: OpeningScope, courseId: string, sourceIds: readonly string[], use: CourseSourceUse): Promise<string[]>;
  readSourcePurposePin(scope: OpeningScope, input: { activityId: string; sourceIds?: readonly string[]; materialUse?: CourseSourceUse }): Promise<OpeningSourcePurposePin>;
  /** Pass the publication transaction; locks remain held until that transaction commits. */
  assertSourcePurposePin(scope: OpeningScope, pin: OpeningSourcePurposePin, tx?: Sql | TransactionSql): Promise<void>;
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

async function readSourcePurposePinInTx(
  tx: Sql | TransactionSql, scope: OpeningScope,
  input: { activityId: string; sourceIds?: readonly string[]; materialUse?: CourseSourceUse },
): Promise<OpeningSourcePurposePin> {
  // Match purpose updates and publication's workspace-first lock order.
  const owner = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR SHARE`;
  if (!owner.length) throw new OpeningKnowledgeError("NOT_FOUND", "workspace not found");
  const [activity] = await tx`SELECT course_id,source_ids FROM opening_teaching_activities
    WHERE id=${input.activityId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR SHARE`;
  if (!activity) throw new OpeningKnowledgeError("NOT_FOUND", "activity not found");
  const courseId = activity.course_id as string | null;
  const materialUse = input.materialUse ?? "teaching";
  const ids = [...new Set(input.sourceIds ?? activity.source_ids as string[])].sort();
  if (courseId) {
    const course = await tx`SELECT id FROM courses WHERE id=${courseId} AND workspace_id=${scope.workspaceId}
      AND archived_at IS NULL FOR SHARE`;
    if (!course.length) throw new OpeningKnowledgeError("CONFLICT", "course is no longer available");
  } else if (ids.some(id => !(activity.source_ids as string[]).includes(id))) {
    throw new OpeningKnowledgeError("CONFLICT", "source selection changed outside the activity");
  }
  const sources: OpeningSourcePurposePin["sources"] = [];
  if (ids.length) {
    const rows = await tx`SELECT s.id,s.version FROM opening_sources s
      WHERE s.workspace_id=${scope.workspaceId} AND s.id=ANY(${ids}::uuid[])
        AND s.upload_state='uploaded' AND s.parse_state='ready'
        AND NOT EXISTS(SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id)
      ORDER BY s.id FOR SHARE OF s`;
    if (rows.length !== ids.length) throw new OpeningKnowledgeError("CONFLICT", "source material unavailable or excluded");
    const memberships = courseId ? await tx`SELECT id,asset_id,purpose,
        to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS purpose_revision
      FROM course_asset_memberships WHERE workspace_id=${scope.workspaceId} AND course_id=${courseId}
        AND asset_type='source' AND asset_id=ANY(${ids}::uuid[]) ORDER BY asset_id FOR SHARE` : [];
    const bySource = new Map(memberships.map(row => [String(row.asset_id), row]));
    for (const row of rows) {
      const membership = bySource.get(String(row.id));
      if (courseId && (!membership || !courseSourcePurposeAllows(membership.purpose as CourseSourcePurpose | null, materialUse))) {
        throw new OpeningKnowledgeError("CONFLICT", "source purpose no longer permits this use");
      }
      sources.push({ sourceId: String(row.id), sourceVersion: Number(row.version),
        membershipId: membership ? String(membership.id) : null,
        purposeRevision: membership ? String(membership.purpose_revision) : null,
        purpose: (membership?.purpose ?? null) as CourseSourcePurpose | null });
    }
  }
  return { activityId: input.activityId, courseId, materialUse, sources };
}

export function createOpeningCourseReadySourcesRepository(
  sql: Sql,
): OpeningCourseReadySourcesRepository {
  return {
    listReadySourceIdsForCourse: (scope, courseId, use) =>
      listReadySourceIdsForCourse(sql, scope, courseId, use),
    readSourcePurposePin: (scope, input) => sql.begin(tx => readSourcePurposePinInTx(tx, scope, input)) as Promise<OpeningSourcePurposePin>,
    async assertSourcePurposePin(scope, pin, tx) {
      const check = async (db: Sql | TransactionSql) => {
        const current = await readSourcePurposePinInTx(db, scope, {
          activityId: pin.activityId, sourceIds: pin.sources.map(source => source.sourceId), materialUse: pin.materialUse,
        });
        if (current.courseId !== pin.courseId || current.sources.length !== pin.sources.length
          || current.sources.some((source, index) => {
            const expected = pin.sources[index]!;
            return source.sourceId !== expected.sourceId || source.sourceVersion !== expected.sourceVersion
              || source.membershipId !== expected.membershipId || source.purposeRevision !== expected.purposeRevision
              || source.purpose !== expected.purpose;
          })) throw new OpeningKnowledgeError("CONFLICT", "source purpose/version changed during generation; regenerate from current materials");
      };
      if (tx) await check(tx);
      else await sql.begin(check);
    },
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
