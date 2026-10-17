import type { TransactionSql } from "postgres";
import type { ExamCourseBinding, ExamPack, ExamSourceRecord, Scope } from "@aistudy/contracts";
import { assertExamMaterialAvailable } from "./opening-exam-integration-binding";
import { createExamSession } from "./opening-exam-integration-session";
import { examSkillLabel } from "./opening-exam-integration-facts";
import { learningError } from "./opening-learning-facts";
import { insertOpeningLearningObservationInTx } from "./opening-learning-observations";
import { linkOpeningSkillEvidenceInTx } from "./opening-skill-evidence";

/** Paper registration is a self-report; duration never invents a server presentation time. */
export async function projectExamSourceRecord(tx: TransactionSql, scope: Scope, sprintId: string, pack: ExamPack,
  binding: ExamCourseBinding | null, record: ExamSourceRecord, now: string): Promise<void> {
  const sourceItem = pack.sourceItems.find(item => item.id === record.sourceId)!;
  const reference = binding?.materials.find(material => material.sourceTitle === sourceItem.sourceTitle);
  let workVersion: number | null = null;
  if (record.workSourceId) {
    const [work] = await tx`SELECT version FROM opening_sources WHERE id=${record.workSourceId} AND workspace_id=${scope.workspaceId}`;
    if (!work) throw learningError("NOT_FOUND", "作答材料不存在");
    workVersion = record.workSourceVersion ?? Number(work.version);
    await assertExamMaterialAvailable(tx, scope, record.workSourceId, workVersion);
  }
  if (record.reviewId) {
    const [review] = await tx`SELECT r.id FROM opening_exam_reviews r JOIN workspaces w ON w.id=r.workspace_id AND w.owner_user_id=r.owner_user_id
      WHERE r.id=${record.reviewId} AND r.sprint_id=${sprintId} AND r.privacy_epoch=w.privacy_epoch
      AND r.workspace_id=${scope.workspaceId} AND r.owner_user_id=${scope.ownerUserId} AND r.source_item_id=${record.sourceId}
      AND r.answer_text=${record.answerText ?? ""}
      AND r.work_source_id=${record.workSourceId ?? null} AND r.work_source_version=${record.workSourceVersion ?? null}
      AND r.reference_source_id IS NOT DISTINCT FROM ${reference?.sourceId ?? null}::uuid
      AND r.reference_source_version IS NOT DISTINCT FROM ${reference?.sourceVersion ?? null}::int AND r.status='ready'`;
    if (!review) throw learningError("CONFLICT", "检查建议与本题、作答材料版本或参考材料不一致");
  }
  if (record.referenceChecked && (!reference || reference.sourceId === record.workSourceId
    || (record.workSourceId && record.workSourceVersion === undefined))) {
    throw learningError("VALIDATION", "整题核对需要明确的参考材料及作答版本，学生作品不能作为答案依据");
  }
  if (reference) await assertExamMaterialAvailable(tx, scope, reference.sourceId, reference.sourceVersion);
  if (!binding || record.outcome === "read") return;
  const [mapping] = await tx`SELECT skill_ids FROM opening_exam_source_mappings WHERE sprint_id=${sprintId} AND source_item_id=${record.sourceId}`;
  const skills = ((mapping?.skill_ids ?? []) as string[]).flatMap(id => binding.skills.find(skill => skill.skillId === id) ?? []);
  if (!skills.length) return; // Unknown mapping remains unknown; do not guess a course skill from a chapter title.
  const [previous] = await tx`SELECT observation_id FROM opening_exam_source_observations WHERE sprint_id=${sprintId} AND source_record_id=${record.id}`;
  if (previous) return;
  const sourceIds = [...new Set([binding.packSourceId, ...(reference ? [reference.sourceId] : []), ...(record.workSourceId ? [record.workSourceId] : [])])];
  // A historical uploaded version can be retained as an attachment, but current formal
  // attribution cannot silently pretend it is the reference the learner checked.
  if (record.referenceChecked && reference) {
    const [current] = await tx`SELECT version FROM opening_sources WHERE id=${reference.sourceId} AND workspace_id=${scope.workspaceId}`;
    if (Number(current?.version) !== reference.sourceVersion) throw learningError("CONFLICT", "参考材料已更新，请重新确认整题核对的版本");
  }
  const currentSources = await tx`SELECT id,version FROM opening_sources WHERE workspace_id=${scope.workspaceId} AND id=ANY(${sourceIds}::uuid[])`;
  const capturedSourceVersions = Object.fromEntries(currentSources.map(source => [String(source.id), Number(source.version)]));
  if (reference) capturedSourceVersions[reference.sourceId] = reference.sourceVersion;
  if (record.workSourceId && workVersion !== null) capturedSourceVersions[record.workSourceId] = workVersion;
  const first = skills[0]!, skillLabel = examSkillLabel(pack, first.skillId);
  const { sessionId, activityId } = await createExamSession(tx, scope, { sprintId, courseId: binding.courseId, sourceIds,
    skillLabel, identity: record.id, now });
  const observation = await insertOpeningLearningObservationInTx(tx, scope, {
    sessionId, courseId: binding.courseId, skillLabel, sourceIds,
    answer: record.answerText || `原题学习登记：${sourceItem.label}\n${record.note}`,
    outcome: record.outcome === "correct" ? "correct" : record.outcome === "incorrect" ? "incorrect" : "unverified",
    assistance: record.assistance === "solution" ? "revealed" : record.assistance === "hint" ? "hinted" : "unknown",
    clientKey: `exam-source:${sprintId}:${record.id}`.slice(0, 200),
    verdictSource: "self_report",
    ...(record.referenceChecked && reference ? { referenceSourceId: reference.sourceId, referenceCheck: {
      referenceSourceId: reference.sourceId, method: "用户确认已使用绑定的参考材料核对整题；作答时间与独立性未经服务器测量", scope: "whole_answer" as const,
    } } : {}), nodeId: first.nodeId, dimension: "procedure",
  }, { requirementKey: first.requirementKey, capturedSourceVersions });
  for (const skill of skills.slice(1)) await linkOpeningSkillEvidenceInTx(tx, scope, {
    courseId: binding.courseId, nodeId: skill.nodeId, observationId: observation.id, dimension: "procedure",
  });
  await tx`INSERT INTO opening_exam_source_observations(sprint_id,source_record_id,skill_ids,observation_id)
    VALUES(${sprintId},${record.id},${skills.map(skill => skill.skillId)},${observation.id})`;
  await tx`UPDATE opening_teaching_activities SET status='completed',updated_at=${now}
    WHERE id=${activityId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
}
