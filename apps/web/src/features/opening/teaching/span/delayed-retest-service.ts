import { z } from "zod";
import type { Scope } from "@aistudy/contracts";
import { createOpeningLearningRepository, createOpeningRetestRepository, lockWorkspaceLearningHistory, nextWorkspaceLearningHistoryRevision } from "@aistudy/database";
import { SPAN_REQUIREMENT_KEY, SPAN_SKILL_LABEL, suggestRetestAt } from "@aistudy/domain";
import type { Sql } from "postgres";
import { createOpeningRetestService } from "../../learning/retest-service";
const inputSchema = z.object({ observationId: z.string().uuid(), clientKey: z.string().min(8).max(160) }).strict();

/** Explicit acceptance reuses the existing candidate → task → retest lifecycle. */
export function createSpanDelayedRetestService(sql: Sql) {
  return { async schedule(scope: Scope, raw: unknown) {
    const input = inputSchema.parse(raw);
    const history = await createOpeningLearningRepository(sql).observationHistory(scope, input.observationId);
    const head = history.revisions.find(row => row.id === history.headObservationId);
    if (!head || head.revisionKind === "retract" || head.requirementKey !== SPAN_REQUIREMENT_KEY || !head.attemptId
      || head.serverEvaluation?.evaluatorVersion !== "span-exact-v1" || head.serverEvaluation.decision === "abstain") {
      throw Object.assign(new Error("请先完成并核对一道 span 题；未确定判分或已撤回的记录不能直接安排此复测。"), { code: "VALIDATION" });
    }
    const dueAt = suggestRetestAt(head.recordedAt ?? head.occurredAt, 3);
    const existing = await sql`SELECT a.candidate_id,a.task_id,a.not_before_at,j.payload FROM opening_retest_activities a JOIN opening_jobs j ON j.id=a.candidate_id AND j.workspace_id=a.workspace_id AND j.owner_user_id=a.owner_user_id WHERE a.workspace_id=${scope.workspaceId}
      AND a.owner_user_id=${scope.ownerUserId} AND a.course_id=${head.courseId} AND a.requirement_key=${SPAN_REQUIREMENT_KEY}
      AND a.status IN ('proposed','accepted','in_progress') ORDER BY a.created_at LIMIT 1`;
    const protocol = { protocolId: "span-delayed-3d-v1", baselineObservationId: head.id, baselineRootId: head.rootObservationId ?? head.id, priorAnswerPolicy: "require_unseen_problem" };
    if (existing[0]) {
      const prior = (existing[0].payload as { spanDelayedProtocol?: typeof protocol }).spanDelayedProtocol;
      if (!prior || prior.protocolId !== protocol.protocolId || prior.baselineObservationId !== head.id || prior.baselineRootId !== protocol.baselineRootId) throw Object.assign(new Error("已有另一条 span 复测任务，未将它改成这次的 3 天保持检查。请先查看或结束原任务。"), { code: "CONFLICT" });
    }
    const candidateId = existing[0]?.candidate_id ? String(existing[0].candidate_id) : head.id;
    if (!existing.length) {
      const saved = await createOpeningRetestRepository(sql).saveCandidates(scope, [{ id: candidateId, courseId: head.courseId, skillLabel: SPAN_SKILL_LABEL,
        requirementKey: SPAN_REQUIREMENT_KEY, prompt: "线性组合与 span 延迟复测：离开示范，独立完成服务器发放的新题，建立等式并检查全部坐标。", sourceIds: head.sourceIds,
        dueAt, accepted: false, evidenceObservationIds: [head.id], evidenceRootIds: [head.rootObservationId ?? head.id], kind: "task" }]);
      if (!saved.length) throw Object.assign(new Error("复测建议目前关闭或记录资格已变化，尚未创建任务。请在课程设置核对，原答案保留。"), { code: "CONFLICT" });
    }
    await sql.begin(async tx => {
      await lockWorkspaceLearningHistory(tx, scope);
      const [baseline] = await tx`SELECT o.id FROM opening_learning_observations o JOIN opening_learning_observations root
        ON root.id=COALESCE(o.root_observation_id,o.id) AND root.workspace_id=o.workspace_id AND root.owner_user_id=o.owner_user_id
        WHERE o.id=${head.id} AND o.workspace_id=${scope.workspaceId} AND o.owner_user_id=${scope.ownerUserId}
          AND COALESCE(root.effective_head_id,root.id)=o.id AND COALESCE(o.revision_kind,'original')<>'retract' FOR SHARE OF root`;
      if (!baseline) throw Object.assign(new Error("用于安排复测的原记录已修订，请重新核对后再安排。"), { code: "CONFLICT" });
      const changed = await tx`UPDATE opening_retest_activities SET not_before_at=GREATEST(COALESCE(not_before_at,${dueAt}::timestamptz),${dueAt}::timestamptz),version=version+1,updated_at=now()
        WHERE candidate_id=${candidateId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
          AND status IN ('proposed','accepted','in_progress') AND (not_before_at IS NULL OR not_before_at<${dueAt}::timestamptz) RETURNING id`;
      const protocolChanged = await tx`UPDATE opening_jobs SET payload=payload || ${tx.json({ spanDelayedProtocol: protocol })}::jsonb,updated_at=now()
        WHERE id=${candidateId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND kind='retest'
          AND payload->'spanDelayedProtocol' IS DISTINCT FROM ${tx.json(protocol)}::jsonb RETURNING id`;
      if (changed.length || protocolChanged.length) await nextWorkspaceLearningHistoryRevision(tx, scope);
    });
    const accepted = await createOpeningRetestService(sql).accept(scope, candidateId, input.clientKey);
    const [activity] = await sql`SELECT id,not_before_at FROM opening_retest_activities WHERE candidate_id=${candidateId}
      AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
    return { candidateId, taskId: accepted.taskId, activityId: String(activity!.id), courseId: head.courseId,
      notBeforeAt: new Date(activity!.not_before_at as Date).toISOString(),
      href: `/opening/courses/${head.courseId}/study/span?retest=${candidateId}` };
  } };
}
