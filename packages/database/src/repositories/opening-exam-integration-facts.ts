import type { TransactionSql } from "postgres";
import { type ExamPack, type ExamSprintState, type Scope } from "@aistudy/contracts";
import { evaluateEvidenceEligibility, resolveEvidenceAssistance } from "@aistudy/domain";
import { learningError, lockLearningHistory, mapLearningObservation } from "./opening-learning-facts";
import { readOpeningLearningEvidenceContexts } from "./opening-learning-evidence-context";
import { readExamBinding, readCurrentExamNodeIds } from "./opening-exam-skill-identity";
export { parseExamBinding, readExamBinding, readCurrentExamNodeIds } from "./opening-exam-skill-identity";
export async function packWithExamSourceMappings(tx: TransactionSql, sprintId: string, pack: ExamPack): Promise<ExamPack> {
  const rows = await tx`SELECT source_item_id,skill_ids FROM opening_exam_source_mappings WHERE sprint_id=${sprintId}`;
  return { ...pack, sourceItems: pack.sourceItems.map(item => ({ ...item,
    skills: (rows.find(row => row.source_item_id === item.id)?.skill_ids ?? []) as string[] })) };
}
/** Workspace-history and owner are locked first by every caller. */
export async function lockExamCourse(tx: TransactionSql, scope: Scope, courseId: string): Promise<void> {
  const rows = await tx`SELECT id FROM courses WHERE id=${courseId} AND workspace_id=${scope.workspaceId}
    AND archived_at IS NULL FOR SHARE`;
  if (!rows.length) throw learningError("NOT_FOUND", "课程不存在或已归档");
  await lockLearningHistory(tx, scope, courseId);
}
export async function lockBoundExamCourse(tx: TransactionSql, scope: Scope): Promise<void> {
  const [row] = await tx`SELECT b.course_id FROM opening_exam_bindings b JOIN opening_exam_sprints s ON s.id=b.sprint_id
    WHERE s.workspace_id=${scope.workspaceId} AND s.owner_user_id=${scope.ownerUserId}`;
  if (row) await lockExamCourse(tx, scope, String(row.course_id));
}
/** Score and display current formal heads without rewriting the immutable exam capture. */
export async function readExamEvidenceState(tx: TransactionSql, scope: Scope, sprintId: string, state: ExamSprintState) {
  const binding = await readExamBinding(tx, sprintId);
  const nodeIds = binding ? await readCurrentExamNodeIds(tx, scope, binding) : new Set<string>();
  const rows = await tx`SELECT o.*,l.exam_attempt_id,l.node_id AS exam_node_id,l.requirement_key AS exam_requirement_key FROM opening_exam_attempt_links l
    JOIN opening_exam_sprints s ON s.id=l.sprint_id
    JOIN opening_learning_observations root ON root.id=l.observation_id
      AND root.workspace_id=s.workspace_id AND root.owner_user_id=s.owner_user_id
    JOIN opening_learning_observations o ON o.id=COALESCE(root.effective_head_id,root.id)
      AND o.workspace_id=root.workspace_id AND o.owner_user_id=root.owner_user_id
    WHERE l.sprint_id=${sprintId} AND s.workspace_id=${scope.workspaceId} AND s.owner_user_id=${scope.ownerUserId}
      AND l.publication='published'`;
  const contexts = await readOpeningLearningEvidenceContexts(tx, scope, rows.map(mapLearningObservation));
  const bktEligibleAttemptIds: string[] = [];
  const ruleEvidence: Record<string, { usable: boolean; correct: boolean | null; independent: boolean; assisted: boolean }> = {};
  const unpublished = await tx`SELECT l.exam_attempt_id FROM opening_exam_attempt_links l
    JOIN opening_exam_sprints s ON s.id=l.sprint_id
    WHERE l.sprint_id=${sprintId} AND s.workspace_id=${scope.workspaceId} AND s.owner_user_id=${scope.ownerUserId}
      AND l.publication<>'published'`;
  for (const link of unpublished) ruleEvidence[String(link.exam_attempt_id)] = { usable: false, correct: null, independent: false, assisted: false };
  for (const row of rows) {
    const attemptId = String(row.exam_attempt_id), attempt = state.attempts.find(item => item.id === attemptId), facts = contexts[String(row.id)];
    if (!attempt || !facts) continue;
    const eligibility = evaluateEvidenceEligibility(facts.observation, facts.context);
    const assistance = resolveEvidenceAssistance(facts.observation, facts.context);
    const assisted = assistance === "hinted" || assistance === "revealed";
    const verified = eligibility.verifiedCorrect !== "unknown";
    const identityCurrent = binding?.skills.some(skill => skill.nodeId === row.exam_node_id
      && skill.requirementKey === row.exam_requirement_key && skill.requirementKey === row.requirement_key && nodeIds.has(skill.nodeId));
    const usable = identityCurrent === true && row.revision_kind !== "retract" && (verified || assisted) && eligibility.usableForCurrentVersion === "yes";
    const unchanged = attempt.answer === row.answer && (attempt.correct ? "correct" : "incorrect") === row.outcome;
    const independent = usable && unchanged && eligibility.independentAttempt === "yes";
    ruleEvidence[attemptId] = { usable, correct: usable && verified ? row.outcome === "correct" : null, independent, assisted };
    if (independent && verified) bktEligibleAttemptIds.push(attemptId);
  }
  const sourceRecordEligibility: Record<string, boolean> = {};
  const sourceCoverageEligibility: Record<string, boolean> = {};
  if (binding && state.sourceRecords.length) {
    for (const record of state.sourceRecords) sourceRecordEligibility[record.id] = false;
    const sourceRows = await tx`SELECT o.*,l.source_record_id,l.skill_ids AS captured_skill_ids,
      ARRAY(SELECT e.node_id FROM opening_skill_evidence e WHERE e.observation_id=l.observation_id
        AND e.workspace_id=${scope.workspaceId} AND e.owner_user_id=${scope.ownerUserId}) AS captured_node_ids FROM opening_exam_source_observations l
      JOIN opening_learning_observations root ON root.id=l.observation_id
        AND root.workspace_id=${scope.workspaceId} AND root.owner_user_id=${scope.ownerUserId}
      JOIN opening_learning_observations o ON o.id=COALESCE(root.effective_head_id,root.id)
        AND o.workspace_id=root.workspace_id AND o.owner_user_id=root.owner_user_id WHERE l.sprint_id=${sprintId}`;
    const sourceContexts = await readOpeningLearningEvidenceContexts(tx, scope, sourceRows.map(mapLearningObservation));
    const mappings = await tx`SELECT source_item_id,skill_ids FROM opening_exam_source_mappings WHERE sprint_id=${sprintId}`;
    for (const row of sourceRows) {
      const record = state.sourceRecords.find(item => item.id === row.source_record_id), facts = sourceContexts[String(row.id)];
      if (!record || !facts) continue;
      const sourceVersions = row.source_versions as Record<string, number> | null;
      const sourcesInvalid = facts.dependencies.sourceStates.some(source => !source.uploaded
        || source.historicalUnavailable || (sourceVersions?.[source.sourceId] !== undefined && source.version !== sourceVersions[source.sourceId]));
      if (row.revision_kind === "retract" || facts.context.version?.applicability === "privacy_excluded" || sourcesInvalid) {
        sourceCoverageEligibility[record.id] = false;
        continue;
      }
      const mapped = (mappings.find(mapping => mapping.source_item_id === record.sourceId)?.skill_ids ?? []) as string[];
      const captured = row.captured_skill_ids as string[];
      const capturedNodes = row.captured_node_ids as string[];
      const identityCurrent = captured.every(id => {
        const skill = binding.skills.find(item => item.skillId === id);
        return skill && nodeIds.has(skill.nodeId) && capturedNodes.includes(skill.nodeId);
      });
      const outcome = record.outcome === "correct" ? "correct" : record.outcome === "incorrect" ? "incorrect" : "unverified";
      sourceRecordEligibility[record.id] = identityCurrent && row.outcome === outcome && mapped.length === captured.length && mapped.every(id => captured.includes(id))
        && facts.dependencies.sourceStates.length > 0 && facts.dependencies.sourceStates.every(source => source.version === sourceVersions?.[source.sourceId]);
    }
    // Unmapped and pre-binding self-reports still count as completed paper work.
    // Exclude an attached work source only when its loss, exclusion or version change is known.
    const workIds = [...new Set(state.sourceRecords.flatMap(record => record.workSourceId ? [record.workSourceId] : []))];
    const workSources = workIds.length ? await tx`SELECT s.id,s.version,s.upload_state,
      EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id) AS excluded
      FROM opening_sources s WHERE s.workspace_id=${scope.workspaceId} AND s.id=ANY(${workIds}::uuid[])` : [];
    for (const record of state.sourceRecords) {
      if (!record.workSourceId) continue;
      const source = workSources.find(item => item.id === record.workSourceId);
      if (!source || source.excluded || source.upload_state !== "uploaded"
        || (record.workSourceVersion !== undefined && Number(source.version) !== record.workSourceVersion)) {
        sourceRecordEligibility[record.id] = false;
        sourceCoverageEligibility[record.id] = false;
      }
    }
  }
  return { bktEligibleAttemptIds, ruleEvidence, sourceRecordEligibility, sourceCoverageEligibility };
}
export async function readExamEligibleAttemptIds(tx: TransactionSql, scope: Scope, sprintId: string, state: ExamSprintState): Promise<string[]> {
  return (await readExamEvidenceState(tx, scope, sprintId, state)).bktEligibleAttemptIds;
}

export function examSkillLabel(pack: ExamPack, skillId: string): string {
  const question = pack.questions.find(item => item.skillId === skillId);
  return pack.lessons.find(lesson => lesson.id === question?.lessonId)?.title.slice(0, 200) ?? skillId;
}
