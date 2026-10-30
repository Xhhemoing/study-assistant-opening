import { z } from "zod";
import { controlledLearningTools, spanDelayedRetestInputSchema, retestCandidateSchema, spanTutorAutomationSchema, type Scope, type SpanTutorBudget } from "@aistudy/contracts";
import { cancelOwnedSpanTutorRetests, assertSpanTutorRetestBudget, createOpeningLearningRepository, createOpeningRetestRepository, lockLearningPreferences, lockOpeningRetestReviewCandidate, lockWorkspaceLearningHistory, nextWorkspaceLearningHistoryRevision, readOpeningLearningEvidenceContext } from "@aistudy/database";
import { SPAN_REQUIREMENT_KEY, SPAN_SKILL_LABEL, suggestRetestAt } from "@aistudy/domain";
import type { Sql, TransactionSql } from "postgres";
import { createOpeningRetestService } from "../../learning/retest-service";
const inputSchema = spanDelayedRetestInputSchema;
const automaticInputSchema = controlledLearningTools.schedule_retest.input;
const delayedPrompt = "线性组合与 span 延迟复测：离开示范，独立完成服务器发放的新题，建立等式并检查全部坐标。";
const conflict = (message: string) => Object.assign(new Error(message), { code: "CONFLICT" });
const protocolSchema = z.object({ protocolId: z.literal("span-delayed-3d-v1"), baselineObservationId: z.string().uuid(),
  baselineRootId: z.string().uuid(), priorAnswerPolicy: z.literal("require_unseen_problem"),
  tutorAutomation: spanTutorAutomationSchema.optional() }).strict();
const iso = (value: unknown) => new Date(value as string | Date).toISOString();
const at = (value: unknown) => value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : NaN;

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
export function createSpanDelayedRetestService(sql: Sql, now: () => Date = () => new Date()) {
  async function schedule(scope: Scope, raw: unknown, automatic?: { expectedGrantRevision: number }) {
    const input = inputSchema.parse(raw);
    return sql.begin(async tx => {
      // The scanner takes this same lock before checking the one-active-cycle constraint.
      // Keep it until acceptance commits so a proposed conversion is never half visible.
      await lockWorkspaceLearningHistory(tx, scope);
      // Restore does not trust imported scoring authority. An existing acceptance
      // is still replayable from its immutable intent, task and baseline identity.
      const receipts = await tx`SELECT r.id AS replay_activity_id,r.candidate_reference_id,r.learning_protocol,
          r.task_id,r.accepted_at,r.not_before_at,r.course_id,r.status AS activity_status,t.status AS task_status,t.id AS replay_task_id,
          b.id AS baseline_id,COALESCE(b.root_observation_id,b.id) AS baseline_root_id,b.submitted_at,b.recorded_at
        FROM opening_retest_activities r
        LEFT JOIN opening_tasks t ON t.id=r.task_id AND t.workspace_id=r.workspace_id AND t.owner_user_id=r.owner_user_id
          AND t.course_id=r.course_id AND t.skill_label=r.skill_label AND t.requirement_key IS NOT DISTINCT FROM r.requirement_key
        LEFT JOIN opening_learning_observations b ON b.id::text=r.learning_protocol->>'baselineObservationId'
          AND b.workspace_id=r.workspace_id AND b.owner_user_id=r.owner_user_id AND b.course_id=r.course_id
          AND b.skill_label=r.skill_label AND b.requirement_key IS NOT DISTINCT FROM r.requirement_key
        WHERE r.workspace_id=${scope.workspaceId} AND r.owner_user_id=${scope.ownerUserId} AND r.accept_client_key=${input.clientKey}
          AND r.purpose='retest' AND r.skill_label=${SPAN_SKILL_LABEL} AND r.requirement_key=${SPAN_REQUIREMENT_KEY}
        FOR UPDATE OF r`;
      if (receipts.length) {
        const receipt = receipts[0]!, protocol = protocolSchema.safeParse(receipt.learning_protocol);
        const baselineAt = Math.max(at(receipt.submitted_at), at(receipt.recorded_at));
        const earliestAt = at(receipt.not_before_at);
        if (receipts.length !== 1 || !protocol.success || protocol.data.baselineObservationId !== input.observationId
          || receipt.baseline_id !== input.observationId || protocol.data.baselineRootId !== receipt.baseline_root_id
          || !receipt.replay_task_id || !receipt.accepted_at || !z.string().uuid().safeParse(receipt.candidate_reference_id).success
          || !Number.isFinite(baselineAt) || !Number.isFinite(earliestAt) || earliestAt < baselineAt + 72 * 60 * 60 * 1000) {
          throw conflict("原复测回执与这次请求不一致或基线已不可用，请重新核对原任务。");
        }
        return { candidateId: String(receipt.candidate_reference_id), taskId: String(receipt.task_id), activityId: String(receipt.replay_activity_id),
          courseId: String(receipt.course_id), notBeforeAt: iso(receipt.not_before_at),
          taskStatus: String(receipt.task_status), activityStatus: String(receipt.activity_status),
          href: `/opening/courses/${receipt.course_id}/study/span?retest=${receipt.replay_activity_id}` };
      }
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
      let tutorBudget: SpanTutorBudget | undefined;
      if (automatic) {
        const cancelled = await tx`SELECT id FROM opening_retest_activities WHERE workspace_id=${scope.workspaceId}
          AND owner_user_id=${scope.ownerUserId} AND course_id=${head.courseId} AND skill_label=${SPAN_SKILL_LABEL}
          AND requirement_key=${SPAN_REQUIREMENT_KEY} AND status IN ('cancelled','declined') LIMIT 1`;
        if (cancelled.length) throw conflict("你已取消过这项复测。新答案已保存，请明确接受后再安排，刷新不会自动恢复。");
        tutorBudget = await assertSpanTutorRetestBudget(tx, scope, { courseId: head.courseId, notBeforeAt: dueAt,
          minutes: 20, expectedGrantRevision: automatic.expectedGrantRevision }, now());
      }
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
      if (existing.length && !existing[0]!.candidate_id) {
        throw conflict("已有恢复的复测任务。请从原任务继续；旧备份缺少正式协议时不能把它改成新的保持检查。");
      }
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
      const [createdTask] = automatic ? await tx`SELECT version,status FROM opening_tasks WHERE id=${accepted.taskId}
        AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE` : [];
      if (automatic && (!createdTask || !Number.isInteger(Number(createdTask.version)) || Number(createdTask.version) < 1)) throw conflict("自动复测任务回执不完整，请保留原请求核对。");
      const learningProtocol = tutorBudget ? { ...protocol, tutorAutomation: { ...tutorBudget, createdTaskVersion: Number(createdTask!.version) } } : protocol;
      const [scheduled] = await tx`UPDATE opening_retest_activities SET learning_protocol=${tx.json(learningProtocol)},
          candidate_reference_id=${candidateId},accept_client_key=${input.clientKey},version=version+1,updated_at=now()
        WHERE candidate_id=${candidateId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
          AND task_id=${accepted.taskId} AND accepted_at IS NOT NULL AND (accept_client_key IS NULL OR accept_client_key=${input.clientKey})
        RETURNING id,not_before_at`;
      if (!scheduled) throw conflict("复测接受回执未完整保存，原请求尚未确认。");
      await nextWorkspaceLearningHistoryRevision(tx, scope);
      return { candidateId, taskId: accepted.taskId, activityId: String(scheduled!.id), courseId: head.courseId,
        notBeforeAt: new Date(scheduled!.not_before_at as Date).toISOString(),
        taskStatus: createdTask ? String(createdTask.status) : "pending", activityStatus: "accepted",
        href: `/opening/courses/${head.courseId}/study/span?retest=${scheduled.id}` };
    });
  }
  return { schedule: (scope: Scope, raw: unknown) => schedule(scope, raw),
    async cancelAutomatic(scope: Scope, raw: unknown) {
      const input = controlledLearningTools.cancel_retest.input.parse(raw);
      return sql.begin(async tx => {
        await lockWorkspaceLearningHistory(tx, scope);
        const [activity] = await tx`SELECT id,status FROM opening_retest_activities WHERE id=${input.activityId}
          AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
          AND learning_protocol ? 'tutorAutomation' FOR UPDATE`;
        if (!activity) throw Object.assign(new Error("自动复测不存在。"), { code: "NOT_FOUND" });
        const closedTaskIds = await cancelOwnedSpanTutorRetests(tx, scope, { activityIds: [input.activityId], reason: "learner_undo_automatic" });
        return controlledLearningTools.cancel_retest.output.parse({ activityId: input.activityId,
          cancelled: activity.status === "cancelled" || closedTaskIds.length > 0, closedTaskIds });
      });
    },
    scheduleAutomatic: (scope: Scope, raw: unknown) => {
      const { expectedGrantRevision, ...input } = automaticInputSchema.parse(raw);
      return schedule(scope, input, { expectedGrantRevision });
    } };
}
