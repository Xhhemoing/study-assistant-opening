import { courseRequirementSchema, courseRouteActivityContextSchema, teachingBlockRefSchema, teachingSourceRefSchema,
  type CourseRequirementProgress, type Scope } from "@aistudy/contracts";
import { projectCourseCitationCoverage } from "../../../domain/src/opening/course-citation-coverage";
import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";
import { learningIso } from "./opening-learning-facts";

type Result = { coverage?: NonNullable<CourseRequirementProgress["citationCoverage"]>; reason?: string };
const unknown = (reason: string): Result => ({ reason: `引用覆盖未知：${reason}` });
const blocksSchema = z.array(z.object({ id: z.string().uuid(), type: z.string(), content: z.record(z.string(), z.unknown()) }).passthrough());
const sourceIdsSchema = z.array(z.string().uuid()).min(1);
const bindingRefsSchema = z.array(z.object({ sourceId: z.string().uuid(), sourceVersion: z.number().int().nonnegative(),
  chunkId: z.string().uuid(), page: z.number().int().positive().nullable() }).strict());

/** One SELECT / MVCC snapshot, no locks or writes. Never return private revision bodies.
 * Population protocol: latest matching activity's CURRENT spec-pinned revision,
 * including rejected verification; never library head, older spec or fallback activity.
 */
export async function readOpeningCourseCitationCoverage(db: Sql | TransactionSql, scope: Scope, courseId: string,
  progress: readonly CourseRequirementProgress[]): Promise<Map<string, Result>> {
  const rows = await db`WITH owned_course AS (
      SELECT c.id,c.workspace_id FROM courses c JOIN workspaces w ON w.id=c.workspace_id
      WHERE c.id=${courseId} AND c.workspace_id=${scope.workspaceId} AND w.owner_user_id=${scope.ownerUserId} AND c.archived_at IS NULL
    ), live_sources AS (
      SELECT src.id,src.version,COALESCE((SELECT jsonb_agg(jsonb_build_object('id',ch.id,'page',ch.page))
        FROM opening_source_chunks ch WHERE ch.source_id=src.id AND ch.source_version=src.version
          AND (length(btrim(ch.text))>0 OR ch.image_object_key IS NOT NULL)), '[]'::jsonb) AS chunks
      FROM owned_course c JOIN course_asset_memberships m ON m.course_id=c.id AND m.workspace_id=c.workspace_id AND m.asset_type='source'
      JOIN opening_sources src ON src.id=m.asset_id AND src.workspace_id=m.workspace_id
      WHERE src.upload_state='uploaded' AND src.parse_state='ready'
        AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=src.workspace_id AND e.source_id=src.id)
        AND NOT EXISTS (SELECT 1 FROM opening_source_versions v WHERE v.workspace_id=src.workspace_id AND v.source_id=src.id
          AND v.version=src.version AND v.availability<>'available')
    ) SELECT q.id AS requirement_id,to_jsonb(q) AS requirement,a.id AS activity_id,a.goal_json,a.source_ids,a.content_version,a.generate_status,
      s.version AS spec_version,s.verification_status,s.block_order,s.source_refs,
      access.authorized AS sources_authorized,CASE WHEN access.authorized THEN r.blocks END AS blocks,
      EXISTS (SELECT 1 FROM opening_learning_observations o JOIN opening_learning_observations root
        ON root.id=COALESCE(o.root_observation_id,o.id) AND root.workspace_id=o.workspace_id AND root.owner_user_id=o.owner_user_id
        WHERE o.id::text=a.goal_json->'courseRoute'->>'originObservationId' AND o.workspace_id=a.workspace_id
          AND o.owner_user_id=a.owner_user_id AND COALESCE(root.effective_head_id,root.id)<>o.id) AS stale_origin,
      COALESCE((SELECT jsonb_agg(to_jsonb(src)) FROM live_sources src),'[]'::jsonb) AS sources
    FROM owned_course c JOIN course_requirements q ON q.course_id=c.id AND q.workspace_id=c.workspace_id
      AND q.owner_user_id=${scope.ownerUserId} AND q.lifecycle='active'
    LEFT JOIN LATERAL (SELECT a.* FROM opening_teaching_activities a WHERE a.workspace_id=q.workspace_id
      AND a.owner_user_id=q.owner_user_id AND a.course_id=q.course_id
      AND a.goal_json->'courseRoute'->>'requirementId'=q.id::text
      AND a.status IN ('active','paused','completed') ORDER BY a.updated_at DESC,a.id DESC LIMIT 1) a ON true
    LEFT JOIN opening_teaching_activity_specs s ON s.activity_id=a.id AND s.workspace_id=a.workspace_id AND s.owner_user_id=a.owner_user_id
    LEFT JOIN opening_teaching_units u ON u.id=s.teaching_unit_id AND u.workspace_id=s.workspace_id
      AND u.owner_user_id=s.owner_user_id AND u.document_id=s.document_id
    LEFT JOIN library_documents d ON d.id=u.document_id AND d.workspace_id=u.workspace_id AND d.deleted_at IS NULL
    CROSS JOIN LATERAL (SELECT (
      cardinality(a.source_ids)>0 AND NOT EXISTS (SELECT 1 FROM unnest(a.source_ids) id
        WHERE NOT EXISTS (SELECT 1 FROM live_sources src WHERE src.id=id))
      AND jsonb_array_length(q.source_refs)>0 AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(q.source_refs) ref
        WHERE NOT EXISTS (SELECT 1 FROM live_sources src WHERE src.id::text=ref->>'sourceId' AND src.version::text=ref->>'sourceVersion'
          AND ((ref->>'chunkId' IS NULL AND ref->>'page' IS NULL) OR EXISTS (SELECT 1 FROM jsonb_array_elements(src.chunks) ch
            WHERE (ref->>'chunkId' IS NULL OR ch->>'id'=ref->>'chunkId') AND (ref->>'page' IS NULL OR ch->>'page'=ref->>'page')))))
      AND jsonb_array_length(CASE WHEN jsonb_typeof(s.source_refs)='array' THEN s.source_refs ELSE '[]'::jsonb END)>0
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.source_refs)='array' THEN s.source_refs ELSE '[]'::jsonb END) ref
        WHERE NOT EXISTS (SELECT 1 FROM live_sources src WHERE src.id::text=ref->>'sourceId' AND src.version::text=ref->>'version'
          AND ((ref->>'chunkId' IS NULL AND ref->>'page' IS NULL) OR EXISTS (SELECT 1 FROM jsonb_array_elements(src.chunks) ch
            WHERE (ref->>'chunkId' IS NULL OR ch->>'id'=ref->>'chunkId') AND (ref->>'page' IS NULL OR ch->>'page'=ref->>'page')))))
    ) AS authorized) access
    LEFT JOIN library_revisions r ON access.authorized AND q.approved_at IS NOT NULL
      AND a.goal_json->'courseRoute'->>'requirementRevision'=q.revision::text
      AND a.goal_json->'courseRoute'->>'stableSkillId'=q.stable_skill_id::text
      AND a.goal_json->'courseRoute'->>'requirementKey'=q.requirement_key
      AND a.generate_status NOT IN ('cancelled','stale') AND s.verification_status<>'stale'
      AND s.version=a.content_version AND a.content_version>0
      AND r.document_id=d.id AND r.workspace_id=d.workspace_id AND r.revision_number=s.revision_number`;
  const results = new Map<string, Result>();
  for (const item of progress) {
    const row = rows.find(row => row.requirement_id === item.requirement.id);
    if (!row) { results.set(item.requirement.id, unknown("课程范围或要求已变化")); continue; }
    if (!row.activity_id) continue; // No activity is absence, not 0/100.
    const result = projectAuthorized(row, item);
    results.set(item.requirement.id, result);
  }
  return results;
}

function projectAuthorized(row: Record<string, unknown>, item: CourseRequirementProgress): Result {
  const q = row.requirement as Record<string, unknown>;
  const requirement = courseRequirementSchema.safeParse({ ...item.requirement, revision: q.revision, stableSkillId: q.stable_skill_id,
    requirementKey: q.requirement_key, sourceRefs: q.source_refs, approvedAt: learningIso(q.approved_at) });
  const context = courseRouteActivityContextSchema.safeParse((row.goal_json as { courseRoute?: unknown } | null)?.courseRoute);
  if (!requirement.success || !context.success || !requirement.data.approvedAt
    || requirement.data.revision !== item.requirement.revision || requirement.data.stableSkillId !== item.requirement.stableSkillId
    || requirement.data.requirementKey !== item.requirement.requirementKey || context.data.requirementRevision !== requirement.data.revision
    || context.data.stableSkillId !== requirement.data.stableSkillId || context.data.requirementKey !== requirement.data.requirementKey || row.stale_origin === true)
    return unknown("活动与当前要求版本不一致");
  if (row.spec_version !== row.content_version || Number(row.content_version) < 1
    || ["cancelled", "stale"].includes(String(row.generate_status)) || row.verification_status === "stale")
    return unknown("当前活动内容版本不可确认");
  if (row.sources_authorized !== true) return unknown("当前来源授权、版本或位置不可用");
  const order = z.array(teachingBlockRefSchema).min(1).safeParse(row.block_order);
  const blocks = blocksSchema.safeParse(row.blocks);
  if (!order.success || !blocks.success || new Set(order.data.map(ref => ref.blockId)).size !== order.data.length
    || new Set(blocks.data.map(block => block.id)).size !== blocks.data.length
    || order.data.some(ref => !blocks.data.some(block => block.id === ref.blockId && block.type === ref.blockType))
    || blocks.data.some(block => !order.data.some(ref => ref.blockId === block.id)))
    return unknown("缺少完整的当前修订图");
  const ids = sourceIdsSchema.safeParse(row.source_ids);
  const refs = z.array(teachingSourceRefSchema).min(1).safeParse(row.source_refs);
  const sources = row.sources as { id: string; version: number; chunks: { id: string; page: number | null }[] }[];
  const available = (id: string, version?: number, chunkId?: string | null, page?: number | null) => sources.some(source =>
    source.id === id && (version === undefined || source.version === version)
    && (chunkId == null && page == null || source.chunks.some(chunk => (chunkId == null || chunk.id === chunkId) && (page == null || chunk.page === page))));
  if (!ids.success || !refs.success || !requirement.data.sourceRefs.length
    || ids.data.some(id => !available(id))
    || requirement.data.sourceRefs.some(ref => !available(ref.sourceId, ref.sourceVersion, ref.chunkId, ref.page))
    || refs.data.some(ref => ref.version == null || !Number.isInteger(Number(ref.version))
      || !available(ref.sourceId, Number(ref.version), ref.chunkId, ref.page)))
    return unknown("当前来源授权、版本或位置不可用");
  // Bindings cannot grant authority: independently check all their locations against
  // this snapshot's live course memberships. Malformed/legacy bindings stay unknown.
  for (const block of blocks.data) {
    const binding = block.content.citationBinding as { refs?: unknown } | null | undefined;
    const parsed = bindingRefsSchema.safeParse(binding?.refs);
    if (parsed.success && parsed.data.some(ref => !available(ref.sourceId, ref.sourceVersion, ref.chunkId, ref.page)))
      return unknown("当前来源授权、版本或位置不可用");
  }
  const coverage = projectCourseCitationCoverage({ blockOrder: order.data, blocks: blocks.data });
  if (!coverage.total) return unknown("当前修订未提供可统计内容");
  return { coverage, ...(coverage.unknown ? { reason: "引用覆盖未知：部分历史绑定缺失或无效" } : {}) };
}
