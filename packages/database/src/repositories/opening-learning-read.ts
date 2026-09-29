import type { LearningObservation, Scope } from "@aistudy/contracts";
import { evaluateEvidenceEligibility, type CourseEvidence } from "@aistudy/domain";
import type { Sql } from "postgres";
import { mapLearningObservation } from "./opening-learning-facts";
import { readOpeningLearningEvidenceContext } from "./opening-learning-evidence-context";

/** Read the head projection once; original and replaced rows never compete as new evidence. */
async function readCourseHeads(sql: Sql, scope: Scope, courseId: string, includeRetracted: boolean): Promise<CourseEvidence> {
  return sql.begin("isolation level repeatable read read only", async (tx) => {
    const rows = await tx`SELECT o.* FROM opening_learning_observations o
      JOIN opening_learning_observations root ON root.id=COALESCE(o.root_observation_id,o.id)
        AND root.workspace_id=o.workspace_id AND root.owner_user_id=o.owner_user_id AND COALESCE(root.effective_head_id,root.id)=o.id
      JOIN courses c ON c.id=o.course_id AND c.workspace_id=o.workspace_id
      WHERE o.workspace_id=${scope.workspaceId} AND o.owner_user_id=${scope.ownerUserId}
        AND o.course_id=${courseId} AND c.archived_at IS NULL
        AND (${includeRetracted} OR COALESCE(o.revision_kind,'original') <> 'retract')
      ORDER BY o.occurred_at ASC,root.id ASC`;
    const observations: CourseEvidence["observations"] = [];
    const evidenceContexts: CourseEvidence["evidenceContexts"] = {};
    for (const row of rows) {
      const observation = mapLearningObservation(row);
      const evidence = await readOpeningLearningEvidenceContext(tx, scope, observation);
      // Privacy exclusion overrides legacy unknown qualification before facts reach any consumer.
      if (evidence.context.version?.applicability === "privacy_excluded") continue;
      observations.push(observation);
      evidenceContexts[observation.id] = evidence;
    }
    return { observations, evidenceContexts };
  }) as Promise<CourseEvidence>;
}

export function readOpeningCourseEvidence(sql: Sql, scope: Scope, courseId: string): Promise<CourseEvidence> {
  return readCourseHeads(sql, scope, courseId, false);
}

/** Includes tombstone heads so users can inspect withdrawal history without counting it as evidence. */
export async function readOpeningCourseObservationHeads(sql: Sql, scope: Scope, courseId: string): Promise<LearningObservation[]> {
  const { observations, evidenceContexts } = await readCourseHeads(sql, scope, courseId, true);
  return observations.map((observation) => {
    const evidence = evidenceContexts[observation.id]!;
    return { ...observation, eligibility: evaluateEvidenceEligibility(evidence.observation, evidence.context) };
  });
}
