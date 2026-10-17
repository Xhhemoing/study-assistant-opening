import { isDeepStrictEqual } from "node:util";
import { uuidSchema, type CourseGoal, type CourseGoalUpdate, type CourseMilestone, type CourseMilestoneEvidenceRef, type CourseMilestoneUpdate, type Scope } from "@aistudy/contracts";
import type { TransactionSql } from "postgres";
import { OpeningPlanError } from "./opening-plan-error";

function definition(item: CourseMilestoneUpdate) {
  return { id: item.id, title: item.title, successCriteria: item.successCriteria, targetDate: item.targetDate,
    evidenceRefs: [...item.evidenceRefs].sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)) };
}

/** Called after the owning workspace is locked. Missing milestones are preserved. */
export function mergeCourseGoal(current: CourseGoal | undefined, input: CourseGoalUpdate, expectedRevision: number | undefined, now: string): CourseGoal {
  const revision = current?.revision ?? 0;
  if (expectedRevision !== undefined && expectedRevision !== revision) {
    throw new OpeningPlanError("CONFLICT", "课程目标已更新，请重新读取后再保存。");
  }
  const milestones = [...(current?.milestones ?? [])];
  for (const change of input.milestones ?? []) {
    const value = definition(change);
    const index = milestones.findIndex(item => item.id === change.id);
    const previous = index >= 0 ? milestones[index]! : undefined;
    const changed = previous === undefined || !isDeepStrictEqual(definition(previous), value);
    if (changed && change.confirm) throw new OpeningPlanError("VALIDATION", "请先保存成功标准，再确认阶段成果。");
    const status = changed ? "planned" : change.confirm === undefined ? previous!.status
      : change.confirm ? "confirmed_by_learner" : "planned";
    if (!changed && status === previous!.status) continue;
    if (previous && previous.history.length >= 50) {
      throw new OpeningPlanError("CONFLICT", "该成果已保留50次历史修改，请新建阶段成果。");
    }
    const { history, ...previousVersion } = previous ?? { history: [] };
    const next: CourseMilestone = { ...value, revision: (previous?.revision ?? 0) + 1, status,
      confirmedAt: status === "confirmed_by_learner" ? now : null,
      history: previous ? [...history, previousVersion as Omit<CourseMilestone, "history">] : [] };
    if (index < 0) milestones.push(next);
    else milestones[index] = next;
  }
  if (milestones.length > 8) throw new OpeningPlanError("VALIDATION", "每个课程最多保留8个阶段成果。");
  const result: CourseGoal = { targetDate: input.targetDate, weeklyMinutes: input.weeklyMinutes,
    ...(input.learningMode !== undefined || current?.learningMode !== undefined ? { learningMode: input.learningMode ?? current!.learningMode } : {}),
    ...(input.priority !== undefined || current?.priority !== undefined ? { priority: input.priority ?? current!.priority } : {}),
    ...(milestones.length ? { milestones } : current?.milestones !== undefined || input.milestones !== undefined ? { milestones: [] } : {}) };
  // Keep the historical response shape until versioned milestones or goal policy are used.
  if (current?.revision !== undefined || input.milestones !== undefined || input.learningMode !== undefined || input.priority !== undefined || expectedRevision !== undefined) result.revision = revision + 1;
  return result;
}

/** Links identify owned records; they do not assert that those records prove mastery. */
export async function assertCourseMilestoneEvidence(tx: TransactionSql, scope: Scope, courseId: string, refs: readonly CourseMilestoneEvidenceRef[]) {
  for (const ref of refs) {
    const rows = ref.kind === "attempt"
      ? await tx`SELECT source_ids, source_versions FROM opening_learning_attempts WHERE id=${ref.id}
          AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND course_id=${courseId} FOR SHARE`
      : ref.kind === "observation"
        ? await tx`SELECT o.source_ids, o.source_versions, o.reference_source_id, o.reference_check, COALESCE(o.root_observation_id,o.id) AS root_id FROM opening_learning_observations o
            JOIN opening_learning_observations root ON root.id=COALESCE(o.root_observation_id,o.id)
              AND root.workspace_id=o.workspace_id AND root.owner_user_id=o.owner_user_id
            WHERE o.id=${ref.id} AND o.workspace_id=${scope.workspaceId} AND o.owner_user_id=${scope.ownerUserId}
              AND o.course_id=${courseId} AND COALESCE(root.effective_head_id,root.id)=o.id
              AND COALESCE(o.revision_kind,'original')<>'retract' FOR SHARE OF o, root`
        : await tx`SELECT source_ids FROM opening_teaching_activities WHERE id=${ref.id}
            AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND course_id=${courseId} FOR SHARE`;
    const record = rows[0];
    if (!record) throw new OpeningPlanError("NOT_FOUND", "学习记录不存在或不属于本课程。");
    const versions = record.source_versions as Record<string, number> | null | undefined;
    const reference = record.reference_check as { referenceId?: string } | null | undefined;
    const sources = [...new Set([...(record.source_ids as string[]), ...Object.keys(versions ?? {}),
      ...(typeof record.reference_source_id === "string" ? [record.reference_source_id] : []), ...(reference?.referenceId ? [reference.referenceId] : [])])];
    if (!uuidSchema.array().safeParse(sources).success) throw new OpeningPlanError("CONFLICT", "学习记录的材料归属无法核对。");
    if (ref.kind === "observation") {
      const lineage = await tx`SELECT source_ids,source_versions,reference_source_id,reference_check FROM opening_learning_observations
        WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
          AND COALESCE(root_observation_id,id)=${String(record.root_id)}::uuid`;
      const privacyIds = [...new Set(lineage.flatMap(row => [
        ...(row.source_ids as string[]), ...Object.keys((row.source_versions ?? {}) as Record<string, number>),
        ...(typeof row.reference_source_id === "string" ? [row.reference_source_id] : []),
        ...(typeof (row.reference_check as { referenceId?: unknown } | null)?.referenceId === "string"
          ? [(row.reference_check as { referenceId: string }).referenceId] : []),
      ]))];
      if (!uuidSchema.array().safeParse(privacyIds).success) throw new OpeningPlanError("CONFLICT", "学习记录的历史材料归属无法核对。");
      if (privacyIds.length) {
        const excluded = await tx`SELECT source_id FROM opening_privacy_exclusions WHERE workspace_id=${scope.workspaceId}
          AND source_id=ANY(${privacyIds}::uuid[]) LIMIT 1`;
        if (excluded.length) throw new OpeningPlanError("CONFLICT", "学习记录的历史材料已被排除，请选择其他记录。");
      }
    }
    if (!sources.length) continue;
    const admitted = await tx`SELECT s.id,s.version FROM opening_sources s
      WHERE s.id IN ${tx(sources)} AND s.workspace_id=${scope.workspaceId} AND s.upload_state='uploaded'
        AND EXISTS (SELECT 1 FROM opening_source_chunks k WHERE k.source_id=s.id AND k.source_version=s.version)
        AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id)
      ORDER BY s.id FOR SHARE`;
    if (admitted.length !== sources.length || admitted.some(source => versions?.[String(source.id)] !== undefined
      && versions[String(source.id)] !== Number(source.version))) {
      throw new OpeningPlanError("CONFLICT", "学习记录的材料已改变或不再可用，请选择当前记录。");
    }
  }
}
