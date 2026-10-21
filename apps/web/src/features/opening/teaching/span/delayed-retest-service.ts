import { z } from "zod";
import { retestCandidateSchema, type Scope } from "@aistudy/contracts";
import { createOpeningLearningRepository, createOpeningRetestRepository, lockLearningPreferences, lockOpeningRetestReviewCandidate, lockWorkspaceLearningHistory, nextWorkspaceLearningHistoryRevision, readOpeningLearningEvidenceContext } from "@aistudy/database";
import { SPAN_REQUIREMENT_KEY, SPAN_SKILL_LABEL, suggestRetestAt } from "@aistudy/domain";
import type { Sql, TransactionSql } from "postgres";
import { createOpeningRetestService } from "../../learning/retest-service";
const inputSchema = z.object({ observationId: z.string().uuid(), clientKey: z.string().min(8).max(160) }).strict();
const delayedPrompt = "线性组合与 span 延迟复测：离开示范，独立完成服务器发放的新题，建立等式并检查全部坐标。";
const conflict = (message: string) => Object.assign(new Error(message), { code: "CONFLICT" });

/** Keep the repositories' admission, receipts and task writes in the scheduling transaction. */
function transactionClient(tx: TransactionSql): Sql {
  return new Proxy(tx, { get(target, key, receiver) {
    if (key === "begin") return (...args: unknown[]) => {
      const execute = args.at(-1) as (nested: TransactionSql) => Promise<unknown>;
      return target.savepoint(nested => execute(nested));
    };
    return Reflect.get(target, key, receiver);
  } }) as unknown as Sql;
}

/** Explicit acceptance reuses the existing candidate → task → retest lifecycle. */
export function createSpanDelayedRetestService(sql: Sql) {
  return { async schedule(scope: Scope, raw: unknown) {
    const input = inputSchema.parse(raw);
    return sql.begin(async tx => {
      // The scanner takes this same lock before checking the one-active-cycle constraint.
      // Keep it until acceptance commits so a proposed conversion is never half visible.
      await lockWorkspaceLearningHistory(tx, scope);
      const db = transactionClient(tx);
      const history = await createOpeningLearningRepository(db).observationHistory(scope, input.observationId);
      const head = history.revisions.find(row => row.id === history.headObservationId);
      if (!head || head.id !== input.observationId || head.revisionKind === "retract"
        || head.requirementKey !== SPAN_REQUIREMENT_KEY || head.skillLabel !== SPAN_SKILL_LABEL || !head.attemptId
        || head.serverEvaluation?.evaluatorVersion !== "span-exact-v1" || head.serverEvaluation.decision === "abstain") {
        throw Object.assign(new Error("请先完成并核对一道 span 题；未确定判分或已撤回的记录不能直接安排此复测。"), { code: "VALIDATION" });
      }
      const evidence = await readOpeningLearningEvidenceContext(tx, scope, head);
      if (evidence.context.version?.applicability !== "exact") {
        throw conflict("用于安排复测的题目或资料版本已变化，请重新核对后再安排。");
      }
      // Both timestamps are server facts; never start the 72-hour interval before sealing.
      const submittedAt = Date.parse(head.submittedAt ?? ""), recordedAt = Date.parse(head.recordedAt ?? "");
      if (!Number.isFinite(submittedAt) || !Number.isFinite(recordedAt)) {
        throw conflict("原答案缺少可信的提交时间，尚不能安排正式 3 天复测。");
      }
      const dueAt = suggestRetestAt(new Date(Math.max(submittedAt, recordedAt)).toISOString(), 3);
      const protocol = { protocolId: "span-delayed-3d-v1", baselineObservationId: head.id,
        baselineRootId: head.rootObservationId ?? head.id, priorAnswerPolicy: "require_unseen_problem" };
      const sameBaseline = (prior: Partial<typeof protocol> | undefined) => prior?.protocolId === protocol.protocolId
        && prior.baselineObservationId === head.id && prior.baselineRootId === protocol.baselineRootId
        && prior.priorAnswerPolicy === protocol.priorAnswerPolicy;
      const [receipt] = await tx`SELECT id AS replay_candidate_id,payload FROM opening_jobs
        WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND kind='retest'
          AND COALESCE(payload->>'acceptClientKey',result->>'clientKey')=${input.clientKey}`;
      if (receipt && !sameBaseline((receipt.payload as { spanDelayedProtocol?: typeof protocol }).spanDelayedProtocol)) {
        throw conflict("此提交标识已用于另一条复测安排，请重新核对原任务。");
      }
      const existing = await tx`SELECT candidate_id FROM opening_retest_activities
        WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND course_id=${head.courseId}
          AND skill_label=${SPAN_SKILL_LABEL} AND requirement_key=${SPAN_REQUIREMENT_KEY} AND purpose='retest'
          AND status IN ('proposed','accepted','in_progress') ORDER BY created_at LIMIT 1`;
      const candidateId = receipt ? String(receipt.replay_candidate_id)
        : existing[0]?.candidate_id ? String(existing[0].candidate_id) : head.id;
      const canonicalCandidate = { id: candidateId, courseId: head.courseId, skillLabel: SPAN_SKILL_LABEL,
        requirementKey: SPAN_REQUIREMENT_KEY, prompt: delayedPrompt, sourceIds: head.sourceIds, dueAt, accepted: false,
        evidenceObservationIds: [head.id], evidenceRootIds: [protocol.baselineRootId], kind: "task" as const };
      if (!receipt && !existing.length) {
        const saved = await createOpeningRetestRepository(db).saveCandidates(scope, [canonicalCandidate]);
        if (!saved.length) throw conflict("复测建议目前关闭或记录资格已变化，尚未创建任务。请在课程设置核对，原答案保留。");
      }
      // Match the normal accept lock order: owner → course history → job → activity.
      const locked = await lockOpeningRetestReviewCandidate(tx, scope, candidateId);
      const candidate = retestCandidateSchema.passthrough().parse(locked);
      const [activity] = await tx`SELECT id,status,task_id,not_before_at FROM opening_retest_activities
        WHERE candidate_id=${candidateId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
          AND course_id=${head.courseId} AND skill_label=${SPAN_SKILL_LABEL} AND requirement_key=${SPAN_REQUIREMENT_KEY}
          AND purpose='retest' FOR UPDATE`;
      if (!activity || (!receipt && !["proposed", "accepted", "in_progress"].includes(String(activity.status)))
        || candidate.courseId !== head.courseId || candidate.skillLabel !== SPAN_SKILL_LABEL
        || candidate.requirementKey !== SPAN_REQUIREMENT_KEY || candidate.discarded || candidate.invalidated || candidate.evidenceChanged) {
        throw conflict("复测候选已变化，请重新核对后再安排。");
      }
      const prior = candidate.spanDelayedProtocol as Partial<typeof protocol> | undefined;
      const sameProtocol = sameBaseline(prior);
      if (receipt && (!sameProtocol || !candidate.accepted || candidate.acceptClientKey !== input.clientKey)) {
        throw conflict("原复测回执与这次请求不一致，请重新核对原任务。");
      }
      if (!sameProtocol && (prior != null || activity.status !== "proposed" || activity.task_id != null || candidate.accepted)) {
        throw conflict("已有另一条 span 复测任务，未将它改成这次的 3 天保持检查。请先查看或结束原任务。");
      }
      if (!sameProtocol) {
        const preferences = await lockLearningPreferences(tx, scope, head.courseId);
        if (!preferences.retestSuggestionsEnabled) throw conflict("复测建议目前关闭，尚未创建任务。请在课程设置核对，原答案保留。");
        // Explicitly replace the still-unaccepted scanner proposal with this baseline's
        // intent. Accepted payloads stay immutable so their acceptance hashes replay.
        await tx`UPDATE opening_jobs SET payload=${tx.json({ ...canonicalCandidate, spanDelayedProtocol: protocol })}::jsonb,updated_at=now()
          WHERE id=${candidateId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND kind='retest'`;
        await tx`UPDATE opening_retest_activities SET recommended_at=${dueAt}::timestamptz,
          not_before_at=GREATEST(COALESCE(not_before_at,${dueAt}::timestamptz),${dueAt}::timestamptz),version=version+1,updated_at=now()
          WHERE id=${activity.id} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
        await nextWorkspaceLearningHistoryRevision(tx, scope);
      } else if (!activity.not_before_at || new Date(activity.not_before_at as Date).getTime() < Date.parse(dueAt)) {
        throw conflict("原复测任务的时间约束与这次记录不一致，请重新核对后再安排。");
      }
      const accepted = await createOpeningRetestService(db).accept(scope, candidateId, input.clientKey);
      const [scheduled] = await tx`SELECT id,not_before_at FROM opening_retest_activities WHERE candidate_id=${candidateId}
        AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
      return { candidateId, taskId: accepted.taskId, activityId: String(scheduled!.id), courseId: head.courseId,
        notBeforeAt: new Date(scheduled!.not_before_at as Date).toISOString(),
        href: `/opening/courses/${head.courseId}/study/span?retest=${candidateId}` };
    });
  } };
}
