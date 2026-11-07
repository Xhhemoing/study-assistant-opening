// 仅按节点身份并使用批准后的作答投影，禁止按文本匹配。
import type { CourseRequirement, Scope } from "@aistudy/contracts";
import type { CourseRouteObservation } from "@aistudy/domain";
import type { Sql, TransactionSql } from "postgres";
import { openingCurrentKnowledgeNodesQuery } from "./opening-exam-skill-identity";

export type ExamCourseEvidenceLink = { observationId: string; nodeId: string; requirementKey: string; capturedAt: string | null; identityCurrent: boolean };

export function projectExamCourseEvidence(observations: readonly CourseRouteObservation[], roots: ReadonlyMap<string, string>, requirements: readonly CourseRequirement[], links: readonly ExamCourseEvidenceLink[]): CourseRouteObservation[] {
  const byRoot = new Map(links.map(link => [link.observationId, link]));
  return observations.map(observation => {
    if (observation.courseRequirement || observation.sharedFor) return observation;
    const link = byRoot.get(roots.get(observation.id) ?? observation.id);
    if (!link?.identityCurrent || !link.capturedAt) return observation;
    const matches = requirements.filter(row => row.lifecycle === "active" && row.knowledgeNodeId === link.nodeId);
    if (matches.length !== 1) return observation;
    const requirement = matches[0]!;
    if (!requirement.approvedAt || !(Date.parse(link.capturedAt) > Date.parse(requirement.approvedAt))) return observation;
    return { ...observation, requirementKey: requirement.requirementKey, courseRequirement: { id: requirement.id, revision: requirement.revision, stableSkillId: requirement.stableSkillId, requirementKey: requirement.requirementKey } };
  });
}

export async function readExamCourseEvidenceLinks(db: Sql | TransactionSql, scope: Scope, courseId: string): Promise<ExamCourseEvidenceLink[]> {
  const rows = await db`WITH current_nodes AS (${openingCurrentKnowledgeNodesQuery(db, scope, courseId)})
    SELECT l.observation_id,l.node_id,l.requirement_key,l.captured_at,
      EXISTS(SELECT 1 FROM jsonb_array_elements(b.binding->'skills') skill JOIN current_nodes n
        ON n.course_id=b.course_id AND n.node_id::text=skill->>'nodeId'
        WHERE skill->>'nodeId'=l.node_id::text AND skill->>'requirementKey'=l.requirement_key) AS identity_current
    FROM opening_exam_attempt_links l JOIN opening_learning_attempts a ON a.id=l.learning_attempt_id
    JOIN opening_exam_sprints s ON s.id=l.sprint_id
    JOIN opening_exam_bindings b ON b.sprint_id=s.id AND b.course_id=a.course_id
    WHERE a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId} AND a.course_id=${courseId}
      AND s.workspace_id=${scope.workspaceId} AND s.owner_user_id=${scope.ownerUserId} AND l.publication='published' AND l.observation_id IS NOT NULL`;
  return rows.map(row => ({ observationId: String(row.observation_id), nodeId: String(row.node_id), requirementKey: String(row.requirement_key),
    capturedAt: row.captured_at == null ? null : new Date(row.captured_at as string | Date).toISOString(), identityCurrent: row.identity_current === true }));
}
