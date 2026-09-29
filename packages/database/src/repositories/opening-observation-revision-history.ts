import type { LearningObservation, ObservationHistory, Scope } from "@aistudy/contracts";
import { evaluateEvidenceEligibility } from "@aistudy/domain";
import type { Sql } from "postgres";
import { learningError, mapLearningObservation, type LearningSql } from "./opening-learning-facts";
import { readOpeningLearningEvidenceContext } from "./opening-learning-evidence-context";

export async function qualifyObservationRevision(db: LearningSql, scope: Scope, row: Record<string, unknown>): Promise<LearningObservation> {
  const observation = mapLearningObservation(row);
  const evidence = await readOpeningLearningEvidenceContext(db, scope, observation);
  if (evidence.context.version?.applicability === "privacy_excluded") throw learningError("NOT_FOUND", "observation history unavailable");
  return { ...observation, eligibility: evaluateEvidenceEligibility(evidence.observation, evidence.context) };
}
/** Follow the persisted links: course-local watermarks and wall clocks do not order a cross-course chain. */
export function orderObservationHistory(rows: LearningObservation[], rootId: string, headId: string): LearningObservation[] {
  const root = rows.find(row => row.id === rootId), ordered: LearningObservation[] = [];
  const successors = new Map(rows.filter(row => row.revisesObservationId).map(row => [row.revisesObservationId, row]));
  let current = root;
  while (current && ordered.length < rows.length) {
    ordered.push(current);
    if (current.id === headId) break;
    current = successors.get(current.id);
  }
  if (ordered.length !== rows.length || ordered.at(-1)?.id !== headId) throw learningError("CONFLICT", "observation history chain is incomplete");
  return ordered;
}
export async function readOpeningObservationHistory(sql: Sql, scope: Scope, id: string): Promise<ObservationHistory> {
  return sql.begin("isolation level repeatable read read only", async tx => {
    const roots = await tx`SELECT root.* FROM opening_learning_observations o
      JOIN opening_learning_observations root ON root.id=COALESCE(o.root_observation_id,o.id)
        AND root.workspace_id=o.workspace_id AND root.owner_user_id=o.owner_user_id
      JOIN workspaces w ON w.id=o.workspace_id AND w.owner_user_id=o.owner_user_id
      WHERE o.id=${id} AND o.workspace_id=${scope.workspaceId} AND o.owner_user_id=${scope.ownerUserId}`;
    const root = roots[0];
    if (!root) throw learningError("NOT_FOUND", "observation not found");
    const rows = await tx`SELECT * FROM opening_learning_observations WHERE workspace_id=${scope.workspaceId}
      AND owner_user_id=${scope.ownerUserId} AND COALESCE(root_observation_id,id)=${root.id}`;
    const revisions: LearningObservation[] = [];
    for (const row of rows) revisions.push(await qualifyObservationRevision(tx, scope, row));
    const headId = String(root.effective_head_id ?? root.id);
    return { rootObservationId: String(root.id), headObservationId: headId, revisions: orderObservationHistory(revisions, String(root.id), headId) };
  }) as Promise<ObservationHistory>;
}
