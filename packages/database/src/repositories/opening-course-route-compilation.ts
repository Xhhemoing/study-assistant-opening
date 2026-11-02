import { courseRouteActivityContextSchema, courseRequirementProgressSchema, type CourseRequirementProgress, type Scope } from "@aistudy/contracts";
import type { Sql, TransactionSql } from "postgres";

/** Current matching activity only; body/answer data never leaves this query. */
export async function readCourseRouteCompilation(db: Sql | TransactionSql, scope: Scope, courseId: string, progress: CourseRequirementProgress[]) {
  const rows = await db`SELECT a.id,a.goal_json,a.generate_status,a.content_version,
    s.document_id,s.revision_number,s.verification_status,
    (s.version=a.content_version AND a.content_version>0 AND jsonb_array_length(s.block_order)>0
      AND r.id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(s.block_order) b
        WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r.blocks) rb WHERE rb->>'id'=b->>'blockId'))
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(s.source_refs) ref
        WHERE NOT EXISTS (SELECT 1 FROM opening_sources src
          JOIN course_asset_memberships m ON m.asset_id=src.id AND m.workspace_id=src.workspace_id
            AND m.asset_type='source' AND m.course_id=a.course_id
          WHERE src.id::text=ref->>'sourceId' AND src.workspace_id=a.workspace_id
            AND src.version::text=ref->>'version' AND src.upload_state='uploaded' AND src.parse_state='ready'
            AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=src.workspace_id AND e.source_id=src.id)))) AS saved
    FROM opening_teaching_activities a
    LEFT JOIN opening_teaching_activity_specs s ON s.activity_id=a.id AND s.workspace_id=a.workspace_id AND s.owner_user_id=a.owner_user_id
    LEFT JOIN library_revisions r ON r.workspace_id=s.workspace_id AND r.document_id=s.document_id AND r.revision_number=s.revision_number
    WHERE a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId} AND a.course_id=${courseId}
      AND a.status IN ('active','paused','completed') AND a.generate_status NOT IN ('cancelled','stale')
      AND a.goal_json ? 'courseRoute'
      AND NOT EXISTS (SELECT 1 FROM opening_learning_observations o JOIN opening_learning_observations root
        ON root.id=COALESCE(o.root_observation_id,o.id) AND root.workspace_id=o.workspace_id AND root.owner_user_id=o.owner_user_id
        WHERE o.id::text=a.goal_json->'courseRoute'->>'originObservationId' AND o.workspace_id=a.workspace_id
          AND o.owner_user_id=a.owner_user_id AND COALESCE(root.effective_head_id,root.id)<>o.id)
    ORDER BY a.updated_at DESC,a.id DESC`;
  for (const item of progress) {
    const row = rows.find(row => {
      const parsed = courseRouteActivityContextSchema.safeParse((row.goal_json as { courseRoute?: unknown }).courseRoute);
      const requirement = item.requirement;
      return parsed.success && parsed.data.requirementId === requirement.id && parsed.data.requirementRevision === requirement.revision
        && parsed.data.stableSkillId === requirement.stableSkillId && parsed.data.requirementKey === requirement.requirementKey;
    });
    const saved = !!row && row.saved === true && item.sourcesAvailable;
    item.compilation = courseRequirementProgressSchema.shape.compilation.parse({
      activityId: row ? String(row.id) : null, generateStatus: row?.generate_status ?? null,
      contentVersion: row ? Number(row.content_version) : 0, saved,
      documentId: saved ? String(row!.document_id) : null, revisionNumber: saved ? Number(row!.revision_number) : null,
      verificationStatus: saved ? row!.verification_status : null,
    });
  }
}
