// 仅按节点身份并使用批准后的作答投影，禁止按文本匹配。
import { z } from "zod";
import { examQuestionPartsSchema, questionPartEvaluationSchema, type CourseRequirement, type Scope } from "@aistudy/contracts";
import { evaluateExamQuestionParts, examAttemptExposureQualification } from "@aistudy/domain";
import { isDeepStrictEqual } from "node:util";
import { parseExamSprintSnapshot } from "./opening-exam-sprint-snapshot";
import type { CourseRouteObservation } from "@aistudy/domain";
import type { Sql, TransactionSql } from "postgres";
import { openingCurrentKnowledgeNodesQuery } from "./opening-exam-skill-identity";

const partRequirementSchema = z.object({ partId: z.string(), identityRefId: z.string().uuid(), requirementKey: z.string(),
  id: z.string().uuid(), revision: z.number().int().positive(), stableSkillId: z.string().uuid(), nodeId: z.string().uuid().nullable() }).strict();
export type ExamCoursePartEvidence = z.infer<typeof questionPartEvaluationSchema> & z.infer<typeof partRequirementSchema> & { identityCurrent: boolean };
export type ExamCourseEvidenceLink = { observationId: string; nodeId: string; requirementKey: string; capturedAt: string | null; identityCurrent: boolean;
  /** Present (even empty) suppresses whole-question projection. Absent means legacy. */
  parts?: ExamCoursePartEvidence[]; questionIdentityRefId?: string };
export type ExamPartFocus = { questionIdentityRefId: string; partId: string; identityRefId: string; requirementKey: string };
export type ExamCourseRouteObservation = CourseRouteObservation & { examPartFocus?: ExamPartFocus };

export function projectExamCourseEvidence(observations: readonly CourseRouteObservation[], roots: ReadonlyMap<string, string>, requirements: readonly CourseRequirement[], links: readonly ExamCourseEvidenceLink[]): ExamCourseRouteObservation[] {
  const byRoot = new Map(links.map(link => [link.observationId, link]));
  return observations.flatMap(observation => {
    const link = byRoot.get(roots.get(observation.id) ?? observation.id);
    if (link?.parts !== undefined) {
      if (!link.identityCurrent || !link.capturedAt || !link.questionIdentityRefId || observation.usableForCurrentVersion !== "yes") return [];
      // One immutable question supplies at most ONE check for a requirement, even if
      // several declared parts address it. Never let order or a successful sibling
      // hide a failure/unknown. Private stored part facts remain unchanged.
      return requirements.flatMap(requirement => {
        const parts = link.parts!.filter(part => part.id === requirement.id);
        if (!parts.length || requirement.lifecycle !== "active" || !requirement.approvedAt
          || !(Date.parse(link.capturedAt!) > Date.parse(requirement.approvedAt))
          || parts.some(part => !part.identityCurrent || part.revision !== requirement.revision
            || part.stableSkillId !== requirement.stableSkillId || part.requirementKey !== requirement.requirementKey
            || part.nodeId !== requirement.knowledgeNodeId)) return [];
        const incorrect = parts.filter(part => part.outcome === "incorrect").sort((a, b) => a.partId.localeCompare(b.partId));
        const verifiedCorrect = incorrect.length ? "no" as const : parts.some(part => part.outcome === "unknown") ? "unknown" as const : "yes" as const;
        const assistance = parts.some(part => part.assistance === "revealed") ? "revealed" as const
          : parts.some(part => part.assistance === "hinted") ? "hinted" as const
            : parts.some(part => part.assistance === "unknown") ? "unknown" as const : "independent" as const;
        const focus = incorrect[0];
        return [{ ...observation, requirementKey: requirement.requirementKey, verifiedCorrect, assistance,
          independentAttempt: assistance === "independent" && verifiedCorrect !== "unknown" && observation.independentAttempt === "yes" ? "yes" as const : "no" as const,
          questionIdentity: link.questionIdentityRefId,
          ...(focus ? { examPartFocus: { questionIdentityRefId: link.questionIdentityRefId, partId: focus.partId,
            identityRefId: focus.identityRefId, requirementKey: focus.requirementKey } } : {}),
          courseRequirement: { id: requirement.id, revision: requirement.revision, stableSkillId: requirement.stableSkillId, requirementKey: requirement.requirementKey } }];
      });
    }
    if (observation.courseRequirement || observation.sharedFor) return [observation];
    if (!link?.identityCurrent || !link.capturedAt) return [observation];
    const matches = requirements.filter(row => row.lifecycle === "active" && row.knowledgeNodeId === link.nodeId);
    if (matches.length !== 1) return [observation];
    const requirement = matches[0]!;
    if (!requirement.approvedAt || !(Date.parse(link.capturedAt) > Date.parse(requirement.approvedAt))) return [observation];
    return [{ ...observation, requirementKey: requirement.requirementKey, courseRequirement: { id: requirement.id, revision: requirement.revision, stableSkillId: requirement.stableSkillId, requirementKey: requirement.requirementKey } }];
  });
}

export async function readExamCourseEvidenceLinks(db: Sql | TransactionSql, scope: Scope, courseId: string): Promise<ExamCourseEvidenceLink[]> {
  const rows = await db`WITH current_nodes AS (${openingCurrentKnowledgeNodesQuery(db, scope, courseId)})
    SELECT l.observation_id,l.node_id,l.requirement_key,l.captured_at,l.exam_attempt_id,l.first_family_exposure,
      s.pack_snapshot,s.state,a.create_intent,o.id AS head_id,o.assistance AS head_assistance,o.revision_kind,
      ARRAY(SELECT node_id::text FROM current_nodes WHERE course_id=a.course_id) AS current_node_ids,
      NOT EXISTS(SELECT 1 FROM unnest(a.source_ids) source(id) WHERE NOT EXISTS(
        SELECT 1 FROM opening_sources src JOIN opening_source_versions sv ON sv.source_id=src.id AND sv.workspace_id=src.workspace_id AND sv.version=src.version
        JOIN course_asset_memberships m ON m.asset_id=src.id AND m.asset_type='source' AND m.course_id=a.course_id AND m.workspace_id=a.workspace_id
        WHERE src.id=source.id AND src.workspace_id=a.workspace_id AND src.version::text=a.source_versions->>src.id::text
          AND src.upload_state='uploaded' AND src.parse_state='ready' AND sv.availability='available'
          AND NOT EXISTS(SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=src.workspace_id AND e.source_id=src.id))) AS sources_current,
      EXISTS(SELECT 1 FROM jsonb_array_elements(b.binding->'skills') skill JOIN current_nodes n
        ON n.course_id=b.course_id AND n.node_id::text=skill->>'nodeId'
        WHERE skill->>'nodeId'=l.node_id::text AND skill->>'requirementKey'=l.requirement_key) AS identity_current
    FROM opening_exam_attempt_links l JOIN opening_learning_attempts a ON a.id=l.learning_attempt_id
    JOIN opening_exam_sprints s ON s.id=l.sprint_id
    JOIN opening_exam_bindings b ON b.sprint_id=s.id AND b.course_id=a.course_id
    JOIN opening_learning_observations root ON root.id=l.observation_id AND root.workspace_id=a.workspace_id AND root.owner_user_id=a.owner_user_id AND root.course_id=a.course_id
    JOIN opening_learning_observations o ON o.id=COALESCE(root.effective_head_id,root.id) AND o.workspace_id=root.workspace_id AND o.owner_user_id=root.owner_user_id AND o.course_id=root.course_id
    WHERE a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId} AND a.course_id=${courseId}
      AND s.workspace_id=${scope.workspaceId} AND s.owner_user_id=${scope.ownerUserId} AND l.publication='published' AND l.observation_id IS NOT NULL`;
  return rows.map(row => {
    const link: ExamCourseEvidenceLink = { observationId: String(row.observation_id), nodeId: String(row.node_id), requirementKey: String(row.requirement_key),
      capturedAt: row.captured_at == null ? null : new Date(row.captured_at as string | Date).toISOString(), identityCurrent: row.identity_current === true };
    const { pack, state } = parseExamSprintSnapshot(row.pack_snapshot, row.state);
    const attempt = state.attempts.find(item => item.id === row.exam_attempt_id);
    const question = pack.questions.find(item => item.id === attempt?.questionId);
    if (!question?.partSnapshot) return link;
    link.parts = [];
    link.questionIdentityRefId = question.partSnapshot.questionIdentityRefId;
    if (!attempt?.answeredAt || !attempt.answer || row.head_id !== row.observation_id || row.revision_kind === "retract"
      || row.sources_current !== true || !link.identityCurrent) return link;
    const qualification = examAttemptExposureQualification(attempt, state, pack);
    const assistance = attempt.help.some(item => item.kind === "solution") ? "revealed"
      : attempt.help.length || qualification.lessonAssistance === true || qualification.partialExample === true ? "hinted"
        : qualification.lessonAssistance === false && qualification.firstFamilyExposure === true && row.first_family_exposure === true ? "independent" : "unknown";
    const expected = evaluateExamQuestionParts(question, pack, attempt.answer, link.observationId, assistance);
    const stored = attempt.resultMetadata?.questionEvaluation;
    const byPart = (parts: NonNullable<typeof expected>["parts"]) => [...parts].sort((a, b) => a.partId.localeCompare(b.partId));
    if (!expected || !stored || expected.evaluationRefId !== stored.evaluationRefId || expected.questionIdentityRefId !== stored.questionIdentityRefId
      || !isDeepStrictEqual(byPart(expected.parts), byPart(stored.parts)) || row.head_assistance !== assistance) return link;
    const intent = row.create_intent as { examSprint?: { partRequirements?: unknown; partSnapshot?: unknown } } | null;
    const pinned = examQuestionPartsSchema.safeParse(intent?.examSprint?.partSnapshot);
    const normalize = (snapshot: NonNullable<typeof question.partSnapshot>) => ({ ...snapshot, parts: [...snapshot.parts].sort((a, b) => a.partId.localeCompare(b.partId)) });
    if (!pinned.success || !isDeepStrictEqual(normalize(pinned.data), normalize(question.partSnapshot))) return link;
    const parsed = z.array(partRequirementSchema).safeParse(intent?.examSprint?.partRequirements);
    if (!parsed.success || parsed.data.length !== expected.parts.length || new Set(parsed.data.map(part => part.partId)).size !== parsed.data.length) return link;
    link.parts = expected.parts.flatMap(part => {
      const binding = parsed.data.find(item => item.partId === part.partId && item.identityRefId === part.identityRefId && item.requirementKey === part.requirementKey);
      return binding ? [{ ...binding, ...part, identityCurrent: binding.nodeId !== null && (row.current_node_ids as string[]).includes(binding.nodeId) }] : [];
    });
    return link;
  });
}
