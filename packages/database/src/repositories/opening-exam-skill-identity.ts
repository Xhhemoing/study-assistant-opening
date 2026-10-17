import { z } from "zod";
import type { ExamCourseBinding, Scope } from "@aistudy/contracts";
import { learningError, type LearningSql } from "./opening-learning-facts";

const bindingSchema: z.ZodType<ExamCourseBinding> = z.object({
  courseId: z.string().uuid(), milestoneId: z.string().uuid().nullable(), packSourceId: z.string().uuid(), boundAt: z.string().datetime(),
  skills: z.array(z.object({ skillId: z.string(), nodeId: z.string().uuid(), requirementKey: z.string().min(1) }).strict()),
  materials: z.array(z.object({ sourceTitle: z.string(), sourceId: z.string().uuid(), sourceVersion: z.number().int().nonnegative() }).strict()),
}).strict();

export function parseExamBinding(value: unknown): ExamCourseBinding {
  const parsed = bindingSchema.safeParse(value);
  if (!parsed.success) throw learningError("CONFLICT", "课程绑定无法校验，请保留记录并联系维护者");
  return parsed.data;
}
export async function readExamBinding(db: LearningSql, sprintId: string): Promise<ExamCourseBinding | null> {
  const [row] = await db`SELECT binding FROM opening_exam_bindings WHERE sprint_id=${sprintId}`;
  return row ? parseExamBinding(row.binding) : null;
}

/** One live owner for node identity and its complete, currently authorized material basis. */
export function openingCurrentKnowledgeNodesQuery(db: LearningSql, scope: Scope, courseId?: string) {
  return db`SELECT g.course_id,(node->>'id')::uuid AS node_id
    FROM opening_course_knowledge g CROSS JOIN LATERAL jsonb_array_elements(g.snapshot->'nodes') node
    WHERE g.workspace_id=${scope.workspaceId} AND g.owner_user_id=${scope.ownerUserId}
      AND ${courseId ? db`g.course_id=${courseId}` : db`TRUE`}
      AND node->>'courseId'=g.course_id::text AND node->>'status'='supported'
      AND jsonb_array_length(node->'evidenceChunkIds')>0
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(node->'evidenceChunkIds') evidence(chunk_id)
        WHERE NOT EXISTS (SELECT 1 FROM opening_source_chunks c JOIN opening_sources s ON s.id=c.source_id
          JOIN opening_source_versions v ON v.source_id=s.id AND v.workspace_id=s.workspace_id AND v.version=c.source_version
          WHERE c.id::text=evidence.chunk_id AND s.workspace_id=g.workspace_id
            AND s.upload_state='uploaded' AND s.parse_state='ready' AND s.version=c.source_version AND v.availability='available'
            AND g.source_versions->>s.id::text=c.source_version::text
            AND (c.text ~ '[^[:space:]]' OR (c.image_object_key IS NOT NULL AND c.image_object_key<>''))
            AND EXISTS(SELECT 1 FROM course_asset_memberships m WHERE m.workspace_id=g.workspace_id
              AND m.course_id=g.course_id AND m.asset_type='source' AND m.asset_id=s.id)
            AND NOT EXISTS(SELECT 1 FROM opening_privacy_exclusions p WHERE p.workspace_id=g.workspace_id AND p.source_id=s.id)))`;
}

export async function readCurrentExamNodeIds(db: LearningSql, scope: Scope, binding: ExamCourseBinding): Promise<Set<string>> {
  const rows = await openingCurrentKnowledgeNodesQuery(db, scope, binding.courseId);
  return new Set(rows.map(row => String(row.node_id)));
}

/**
 * Immutable capture must still name the current explicit binding and supported node.
 * Shared by canonical readers and the projection's live dependency comparison, so
 * graph edits/material loss cannot leave a previously cached qualification current.
 */
export function openingExamIdentityStateQuery(db: LearningSql, scope: Scope) {
  return db`WITH current_nodes AS (${openingCurrentKnowledgeNodesQuery(db, scope)})
    SELECT e.learning_attempt_id AS attempt_id,e.observation_id,e.requirement_key,
      EXISTS(SELECT 1 FROM jsonb_array_elements(b.binding->'skills') skill
        JOIN current_nodes n ON n.course_id=b.course_id AND n.node_id::text=skill->>'nodeId'
        WHERE skill->>'nodeId'=e.node_id::text AND skill->>'requirementKey'=e.requirement_key) AS identity_current
    FROM opening_exam_attempt_links e JOIN opening_exam_sprints s ON s.id=e.sprint_id
    LEFT JOIN opening_exam_bindings b ON b.sprint_id=s.id
    WHERE s.workspace_id=${scope.workspaceId} AND s.owner_user_id=${scope.ownerUserId}
    UNION ALL
    SELECT NULL::uuid,l.observation_id,o.requirement_key,
      b.sprint_id IS NOT NULL AND cardinality(l.skill_ids)>0
      AND EXISTS(SELECT 1 FROM opening_exam_source_mappings m WHERE m.sprint_id=l.sprint_id
        AND m.source_item_id=r.source_item_id AND m.skill_ids @> l.skill_ids AND m.skill_ids <@ l.skill_ids)
      AND NOT EXISTS(SELECT 1 FROM unnest(l.skill_ids) captured(skill_id)
        WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(b.binding->'skills') skill
          JOIN current_nodes n ON n.course_id=b.course_id AND n.node_id::text=skill->>'nodeId'
          JOIN opening_skill_evidence evidence ON evidence.node_id=n.node_id AND evidence.observation_id=l.observation_id
            AND evidence.workspace_id=${scope.workspaceId} AND evidence.owner_user_id=${scope.ownerUserId}
            AND evidence.course_id=b.course_id
          WHERE skill->>'skillId'=captured.skill_id)) AS identity_current
    FROM opening_exam_source_observations l JOIN opening_exam_sprints s ON s.id=l.sprint_id
    LEFT JOIN opening_exam_bindings b ON b.sprint_id=s.id
    JOIN opening_learning_observations o ON o.id=l.observation_id AND o.workspace_id=s.workspace_id AND o.owner_user_id=s.owner_user_id
    LEFT JOIN LATERAL (SELECT record->>'sourceId' AS source_item_id FROM jsonb_array_elements(s.state->'sourceRecords') record
      WHERE record->>'id'=l.source_record_id::text) r ON TRUE
    WHERE s.workspace_id=${scope.workspaceId} AND s.owner_user_id=${scope.ownerUserId}`;
}
