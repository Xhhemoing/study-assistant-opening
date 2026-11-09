import { randomUUID } from "node:crypto";
import { readOpeningCourseSpanDecisionInTx } from "./opening-span-tutor-context";
import { readOpeningSpanReservedChoice } from "./opening-span-reserved-selection";
import { createOpeningLearningAttemptInTx } from "./opening-learning-attempts";
import { COURSE_SPAN_START_POLICY, readOpeningSpanCourseBinding, readOpeningSpanCourseScope } from "./opening-span-course-binding";
import { assertLearningGoalAction } from "./opening-learning-goals";
import { lockSpanTutorAuthorization, readSpanTutorAuthorization } from "./opening-span-tutor-grant";
import { reserveSpanTutorActivityBudget } from "./opening-span-tutor-budget";
import { recordOpeningLearningDecision } from "./opening-learning-decisions";
import { readOpeningLearnerState } from "./opening-learner-state-read";
import { assertOpeningSpanRepairTransition } from "./opening-span-repair";
import { isDeepStrictEqual } from "node:util";
import type { Sql, TransactionSql } from "postgres";
import { courseRouteStartSchema, spanLessonCreateInputSchema, spanLessonSaveInputSchema, spanLessonSnapshotSchema,
  type Scope, type SpanHintLevel, type SpanLessonCreateInput, type SpanLessonSaveInput, type SpanLessonSnapshot, type SpanCourseBinding } from "@aistudy/contracts";
import { DEFAULT_STUDY_SESSION_INTENT, createSpanTeachingSequence, spanModeForIntent, SPAN_REQUIREMENT_KEY, SPAN_SKILL_LABEL } from "@aistudy/domain";
import { admitLearningSources, learningError, learningIso, lockLearningOwner,
  lockWorkspaceLearningHistory, nextWorkspaceLearningHistoryRevision } from "./opening-learning-facts";

const protocol = "span-lesson-v1";
type Row = Record<string, unknown>;
function snapshot(row: Row): SpanLessonSnapshot {
  const checkpoint = row.checkpoint_json as { spanLesson?: Record<string, unknown> } | null;
  const state = checkpoint?.spanLesson ?? {};
  return spanLessonSnapshotSchema.parse({
    activityId: row.id, sessionId: row.session_id, courseId: row.course_id, sourceIds: row.source_ids,
    intent: state.intent, moveId: state.moveId, retestId: state.retestId ?? null,
    status: row.status, revision: Number(row.path_version), createdAt: learningIso(row.created_at), updatedAt: learningIso(row.updated_at),
  });
}
function assertMove(input: Pick<SpanLessonSaveInput, "intent" | "moveId">, retestId: string | null) {
  const mode = spanModeForIntent(input.intent), reserved = `${mode}-reserved`;
  if (input.moveId !== reserved && (retestId || !createSpanTeachingSequence(mode).some(move => move.id === input.moveId))) {
    throw learningError("VALIDATION", "教学步骤不属于本次学习目的。");
  }
}
async function retestReferences(sql: Sql | TransactionSql, scope: Scope, courseId: string, id: string): Promise<string[]> {
  const rows = await sql`SELECT id,candidate_id,candidate_reference_id FROM opening_retest_activities
    WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND course_id=${courseId}
      AND requirement_key=${SPAN_REQUIREMENT_KEY} AND skill_label=${SPAN_SKILL_LABEL}
      AND (id=${id} OR candidate_id=${id} OR candidate_reference_id=${id})`;
  if (rows.length !== 1) throw learningError("CONFLICT", "复测身份缺失或不唯一，不能用新会话覆盖原进度。");
  return [rows[0]!.id, rows[0]!.candidate_id, rows[0]!.candidate_reference_id]
    .filter((value): value is string => typeof value === "string").map(value => value.toLowerCase());
}
async function admitCourseSources(tx: TransactionSql, scope: Scope, courseId: string, sourceIds: string[]) {
  const [course] = await tx`SELECT id FROM courses WHERE id=${courseId} AND workspace_id=${scope.workspaceId}
    AND archived_at IS NULL FOR SHARE`;
  if (!course) throw learningError("NOT_FOUND", "course not found");
  await admitLearningSources(tx, scope, sourceIds);
  const memberships = await tx`SELECT asset_id FROM course_asset_memberships
    WHERE workspace_id=${scope.workspaceId} AND course_id=${courseId} AND asset_type='source'
      AND asset_id IN ${tx(sourceIds)} FOR SHARE`;
  if (memberships.length !== sourceIds.length) throw learningError("VALIDATION", "学习材料不属于当前课程。");
}
async function read(sql: Sql | TransactionSql, scope: Scope, activityId: string, lock = false): Promise<Row | null> {
  const rows = await sql`SELECT a.*,s.id AS session_id FROM opening_teaching_activities a
    JOIN opening_learning_sessions s ON s.id::text=a.checkpoint_json->'spanLesson'->>'sessionId'
      AND s.activity_id=a.id AND s.course_id=a.course_id AND s.workspace_id=a.workspace_id AND s.owner_user_id=a.owner_user_id
    JOIN workspaces w ON w.id=a.workspace_id AND w.owner_user_id=a.owner_user_id
    WHERE a.id=${activityId} AND a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId}
      AND a.create_intent->>'protocol'=${protocol}
    ${lock ? sql`FOR UPDATE OF a` : sql``}`;
  return rows[0] ?? null;
}

/** Internal R1 writer: one original route history/authorization/budget transaction. */
export async function createOpeningCourseSpanSessionInTx(tx: TransactionSql, scope: Scope, input: {
  courseId: string; goalId: string; expectedGoalRevision: number; requirementId: string;
  expectedRequirementRevision: number; clientKey: string; minutes: number;
}): Promise<SpanLessonSnapshot> {
  const { courseId: _courseId, ...request } = input;
  courseRouteStartSchema.parse(request);
  await lockWorkspaceLearningHistory(tx, scope);
  await assertLearningGoalAction(tx, scope, input.goalId, input.expectedGoalRevision);
  const priorAuthorization = await readSpanTutorAuthorization(tx, scope, input.courseId);
  if (!priorAuthorization.grant) throw learningError("CONFLICT", "导师工具尚未授权。");
  const authorization = await lockSpanTutorAuthorization(tx, scope, input.courseId, priorAuthorization.grant.revision);
  if (!authorization.authorized || !authorization.grant) throw learningError("CONFLICT", "导师工具尚未授权，未创建课程 span 活动。");
  const key = `course-route-start:${input.courseId}:${input.clientKey}`;
  const [existing] = await tx`SELECT id,create_intent FROM opening_teaching_activities
    WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND client_key=${key}`;
  const createIntent = { protocol, kind: "course_route", courseSpanRequest: input };
  if (existing) {
    if (!isDeepStrictEqual(existing.create_intent, createIntent)) throw learningError("CONFLICT", "课程 span 请求身份已改变。");
    if (!await readOpeningSpanCourseBinding(tx, scope, String(existing.id))) throw learningError("CONFLICT", "原课程 span 绑定已不可用。");
    const current = await read(tx, scope, String(existing.id));
    if (!current) throw learningError("CONFLICT", "课程 span 会话身份不完整。");
    return snapshot(current);
  }
  const [requirement] = await tx`SELECT stable_skill_id,requirement_key FROM course_requirements
    WHERE id=${input.requirementId} AND course_id=${input.courseId} AND workspace_id=${scope.workspaceId}
      AND owner_user_id=${scope.ownerUserId}`;
  if (!requirement) throw learningError("CONFLICT", "课程要求已变化。");
  const activityId = randomUUID(), sessionId = randomUUID();
  const binding: SpanCourseBinding = { version: 1, origin: "confirmed_course_route", courseId: input.courseId,
    routeActivityId: activityId, goalId: input.goalId, goalRevision: input.expectedGoalRevision,
    requirement: { id: input.requirementId, revision: input.expectedRequirementRevision,
      stableSkillId: String(requirement.stable_skill_id), requirementKey: String(requirement.requirement_key) } };
  const current = await readOpeningSpanCourseScope(tx, scope, binding);
  const sourceIds = [...new Set(current.requirement.sourceRefs.map(ref => ref.sourceId))].sort();
  await admitCourseSources(tx, scope, input.courseId, sourceIds);
  const memberships = await tx`SELECT asset_id FROM course_asset_memberships WHERE workspace_id=${scope.workspaceId}
    AND course_id=${input.courseId} AND asset_type='source' AND asset_id=ANY(${sourceIds}::uuid[])
    AND (purpose IS NULL OR purpose='teaching') FOR SHARE`;
  if (memberships.length !== sourceIds.length) throw learningError("CONFLICT", "课程材料用途已变化。");
  // Recheck versions/chunks after acquiring the existing source and membership shares.
  await readOpeningSpanCourseScope(tx, scope, binding);
  const intent = spanLessonCreateInputSchema.shape.intent.parse({ ...DEFAULT_STUDY_SESSION_INTENT, purpose: "self_study", timeBudgetMinutes: input.minutes });
  const versions = Object.fromEntries(current.requirement.sourceRefs.map(ref => [ref.sourceId, ref.sourceVersion]));
  const { decision, decisionInput } = await readOpeningCourseSpanDecisionInTx(tx, scope, binding, sourceIds, versions, intent);
  // R1 does not create A repair or recurse into T/P repair; those decisions remain explicit refusals.
  if (decision.activityKind === "targeted_explain" || decision.reasonCode === "remediation_limit")
    throw learningError("CONFLICT", "本要求需要另行明确的纠偏执行；R1 未创建替代活动。");
  const moveId = decision.activityKind === "full_explain" ? "self-example"
    : decision.activityKind === "reduced_help_practice" ? "self-faded" : "self_study-reserved";
  const reserved = moveId.endsWith("-reserved")
    ? await readOpeningSpanReservedChoice(tx, scope, "self_study", "validation", undefined, current.allowedExerciseKeys) : null;
  if (reserved?.kind === "unavailable") throw learningError("CONFLICT", "本要求范围内未见题不可用；未创建活动或消耗预算。");
  const courseRoute = { goalId: input.goalId, goalRevision: input.expectedGoalRevision, requirementId: input.requirementId,
    requirementRevision: input.expectedRequirementRevision, stableSkillId: binding.requirement.stableSkillId,
    requirementKey: binding.requirement.requirementKey, action: decision.activityKind };
  const checkpoint = { spanLesson: { sessionId, intent, moveId, retestId: null } };
  await tx`INSERT INTO opening_teaching_activities
    (id,workspace_id,owner_user_id,course_id,status,generate_status,intent_kind,intent_summary,source_ids,goal_json,
      path_version,content_version,checkpoint_json,client_key,create_intent)
    VALUES (${activityId},${scope.workspaceId},${scope.ownerUserId},${input.courseId},'active','ready','goal',
      ${current.requirement.title},${sourceIds},${tx.json({ sessionIntent: intent, spanCourseBinding: binding, courseRoute })},
      1,0,${tx.json(checkpoint)},${key},${tx.json(createIntent)})`;
  await tx`INSERT INTO opening_learning_sessions(id,workspace_id,owner_user_id,course_id,activity_id,skill_label,source_ids)
    VALUES (${sessionId},${scope.workspaceId},${scope.ownerUserId},${input.courseId},${activityId},${SPAN_SKILL_LABEL},${sourceIds})`;
  await reserveSpanTutorActivityBudget(tx, scope, { courseId: input.courseId, activityId, minutes: input.minutes,
    expectedGrantRevision: authorization.grant.revision });
  await nextWorkspaceLearningHistoryRevision(tx, scope);
  const state = await readOpeningLearnerState(tx, scope, { courseId: input.courseId });
  const sourceVersions = Object.fromEntries(current.requirement.sourceRefs.map(ref => [ref.sourceId, [ref.sourceVersion]]));
  const evidenceRefs = current.requirement.sourceRefs.map(ref => `source:${ref.sourceId}:v${ref.sourceVersion}`);
  await recordOpeningLearningDecision(tx, scope, { layer: "activity", targetId: activityId,
    stateVersion: state.stateVersion, dataAsOf: state.dataAsOf, goalVersion: `goal:${input.goalId}:v${input.expectedGoalRevision}`,
    intentVersion: JSON.stringify({ courseBinding: binding, courseRoute, sessionId, sourceIds, ruleDecision: decision, decisionInput }), policyVersion: COURSE_SPAN_START_POLICY,
    sourceVersions, invalidationConditions: ["state_changed", "goal_changed", "source_changed", "intent_changed", "policy_changed"],
    selectedAction: "create:course-span", reasonCodes: ["explicit_confirmed_requirement"], evidenceRefs,
    candidates: [{ action: "create:course-span", eligible: true, reasonCodes: ["explicit_confirmed_requirement"], evidenceRefs }] },
  `course-span-start:${activityId}`);
  await readOpeningSpanCourseBinding(tx, scope, activityId);
  if (reserved?.kind === "available") await createOpeningLearningAttemptInTx(tx, scope, { sessionId,
    clientKey: `course-span-start:${activityId}:issue`, spanExercise: { sourceId: sourceIds[0]!,
      problemId: reserved.problem.id, version: Number(reserved.problem.version) } });
  return snapshot((await read(tx, scope, activityId))!);
}

/** Static span lessons keep one owned activity/session; facts stay in the existing evidence tables. */
export function createOpeningSpanSessionRepository(sql: Sql) {
  return {
    async create(scope: Scope, raw: SpanLessonCreateInput): Promise<SpanLessonSnapshot> {
      const input = spanLessonCreateInputSchema.parse(raw), sourceIds = [...input.sourceIds].sort();
      const createIntent = { protocol, courseId: input.courseId, sourceIds, intent: input.intent, retestId: input.retestId ?? null };
      return sql.begin(async tx => {
        await lockWorkspaceLearningHistory(tx, scope);
        await lockLearningOwner(tx, scope);
        const clientKey = `span-lesson:${input.clientKey}`;
        const [existing] = await tx`SELECT id,create_intent FROM opening_teaching_activities
          WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND client_key=${clientKey} FOR UPDATE`;
        if (existing) {
          if (!isDeepStrictEqual(existing.create_intent, createIntent)) throw learningError("CONFLICT", "本次学习请求已改变，不能覆盖原会话。");
          const row = await read(tx, scope, String(existing.id));
          if (!row) throw learningError("CONFLICT", "本次学习会话身份不完整，请保留原请求。");
          return snapshot(row);
        }
        await admitCourseSources(tx, scope, input.courseId, sourceIds);
        if (input.retestId) {
          const retests = await tx`SELECT id FROM opening_retest_activities WHERE workspace_id=${scope.workspaceId}
            AND owner_user_id=${scope.ownerUserId} AND course_id=${input.courseId} AND requirement_key=${SPAN_REQUIREMENT_KEY}
            AND (id=${input.retestId} OR candidate_id=${input.retestId} OR candidate_reference_id=${input.retestId}) AND status IN ('accepted','in_progress') FOR SHARE`;
          if (retests.length !== 1) throw learningError("VALIDATION", "延迟复测不属于本课程、尚未接受或身份不唯一。");
        }
        const activityId = randomUUID(), sessionId = randomUUID(), mode = spanModeForIntent(input.intent);
        const moveId = input.retestId ? `${mode}-reserved` : createSpanTeachingSequence(mode)[0]!.id;
        const checkpoint = { spanLesson: { sessionId, intent: input.intent, moveId, retestId: input.retestId ?? null } };
        await tx`INSERT INTO opening_teaching_activities
          (id,workspace_id,owner_user_id,course_id,status,generate_status,intent_kind,intent_summary,source_ids,goal_json,
            path_version,content_version,checkpoint_json,client_key,create_intent)
          VALUES (${activityId},${scope.workspaceId},${scope.ownerUserId},${input.courseId},'active','ready','course_continue',
            '线性组合与 span',${sourceIds},${tx.json({ sessionIntent: input.intent })},1,0,${tx.json(checkpoint)},${clientKey},${tx.json(createIntent)})`;
        await tx`INSERT INTO opening_learning_sessions(id,workspace_id,owner_user_id,course_id,activity_id,skill_label,source_ids)
          VALUES (${sessionId},${scope.workspaceId},${scope.ownerUserId},${input.courseId},${activityId},${SPAN_SKILL_LABEL},${sourceIds})`;
        await nextWorkspaceLearningHistoryRevision(tx, scope);
        return snapshot((await read(tx, scope, activityId))!);
      }) as Promise<SpanLessonSnapshot>;
    },
    async get(scope: Scope, activityId: string): Promise<SpanLessonSnapshot | null> {
      const row = await read(sql, scope, activityId);
      return row ? snapshot(row) : null;
    },
    async matchesRetestReference(scope: Scope, courseId: string, storedId: string | null, requestedId: string | null): Promise<boolean> {
      if (storedId === null || requestedId === null) return storedId === requestedId;
      const stored = await retestReferences(sql, scope, courseId, storedId);
      const requested = await retestReferences(sql, scope, courseId, requestedId);
      return stored[0] === requested[0];
    },
    /** Restore only exact receipts already released in this lesson; reading never releases help. */
    async deliveredHintLevels(scope: Scope, activityId: string): Promise<Record<string, SpanHintLevel[]>> {
      const rows = await sql`SELECT DISTINCT p.id AS attempt_id,
        CASE e.release_key
          WHEN 'span-hint-v1:' || p.id::text || ':1' THEN 1
          WHEN 'span-hint-v1:' || p.id::text || ':2' THEN 2
          WHEN 'span-hint-v1:' || p.id::text || ':3' THEN 3
          ELSE 4 END AS hint_level
        FROM opening_teaching_activities a
        JOIN workspaces w ON w.id=a.workspace_id AND w.owner_user_id=a.owner_user_id
        JOIN opening_learning_sessions s ON s.id::text=a.checkpoint_json->'spanLesson'->>'sessionId'
          AND s.activity_id=a.id AND s.course_id=a.course_id AND s.workspace_id=a.workspace_id AND s.owner_user_id=a.owner_user_id
        JOIN opening_learning_attempts p ON p.session_id=s.id AND p.activity_id=a.id AND p.course_id=a.course_id
          AND p.workspace_id=a.workspace_id AND p.owner_user_id=a.owner_user_id
        JOIN opening_help_exposures e ON e.attempt_id=p.id AND e.session_id=s.id AND e.activity_id=a.id
          AND e.course_id=a.course_id AND e.workspace_id=a.workspace_id AND e.owner_user_id=a.owner_user_id
        WHERE a.id=${activityId} AND a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId}
          AND a.create_intent->>'protocol'=${protocol} AND e.delivered=TRUE AND e.released_at IS NOT NULL
          AND ((e.exposure_origin='assistant' AND e.support_domain='math' AND e.kind='hint' AND e.level='hinted'
            AND e.release_key IN ('span-hint-v1:' || p.id::text || ':1', 'span-hint-v1:' || p.id::text || ':2', 'span-hint-v1:' || p.id::text || ':3'))
          OR (e.exposure_origin='history_solution' AND e.support_domain<>'language' AND e.kind='solution' AND e.level='revealed'
            AND e.release_key='span-feedback:' || p.id::text))
        ORDER BY attempt_id,hint_level`;
      const levels: Record<string, SpanHintLevel[]> = {};
      for (const row of rows) {
        const attemptLevels = levels[String(row.attempt_id)] ??= [], level = Number(row.hint_level) as SpanHintLevel;
        if (!attemptLevels.includes(level)) attemptLevels.push(level);
      }
      return levels;
    },
    async latest(scope: Scope, courseId: string, retestId?: string | null): Promise<SpanLessonSnapshot | null> {
      const references = retestId ? await retestReferences(sql, scope, courseId, retestId) : null;
      const rows = await sql`SELECT a.id FROM opening_teaching_activities a JOIN workspaces w ON w.id=a.workspace_id AND w.owner_user_id=a.owner_user_id
        WHERE a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId} AND a.course_id=${courseId}
          AND a.create_intent->>'protocol'=${protocol} AND a.status IN ('active','paused')
          AND ${references ? sql`lower(a.checkpoint_json->'spanLesson'->>'retestId')=ANY(${references}::text[])`
            : sql`(a.checkpoint_json->'spanLesson'->>'retestId') IS NULL`}
        ORDER BY a.updated_at DESC,a.id DESC LIMIT 1`;
      if (!rows[0]) return null;
      const row = await read(sql, scope, String(rows[0].id));
      return row ? snapshot(row) : null;
    },
    async save(scope: Scope, activityId: string, raw: SpanLessonSaveInput): Promise<SpanLessonSnapshot> {
      const input = spanLessonSaveInputSchema.parse(raw);
      return sql.begin(async tx => {
        await lockWorkspaceLearningHistory(tx, scope);
        await lockLearningOwner(tx, scope);
        const row = await read(tx, scope, activityId, true);
        if (!row) throw learningError("NOT_FOUND", "本次学习不存在。");
        const current = snapshot(row);
        assertMove(input, current.retestId);
        const unchanged = current.moveId === input.moveId && current.status === input.status && isDeepStrictEqual(current.intent, input.intent);
        if (current.revision !== input.expectedRevision) {
          if (current.revision === input.expectedRevision + 1 && unchanged) return current;
          throw learningError("CONFLICT", "另一页面已更新学习进度，请重新读取后继续。");
        }
        if (unchanged) return current;
        if (current.status === "completed") throw learningError("CONFLICT", "已结束的学习保留为小结，请开始新会话。");
        if (Object.hasOwn((row.goal_json ?? {}) as object, "spanCourseBinding")
          || Object.hasOwn((row.create_intent ?? {}) as object, "courseSpanRequest")) {
          const pause = input.status === "paused" && input.moveId === current.moveId && isDeepStrictEqual(input.intent, current.intent);
          if (!pause) {
            await readOpeningSpanCourseBinding(tx, scope, activityId);
            if (!isDeepStrictEqual(input.intent, current.intent) || current.retestId || input.status === "completed"
              || !["self-example", "self-faded", "self_study-reserved"].includes(input.moveId))
              throw learningError("CONFLICT", "课程 span 仅允许原目的内的学习步骤；未开启递归或课程返回执行。");
          }
        }
        await assertOpeningSpanRepairTransition(tx, scope, current, input);
        const preservingRepairPause = (Object.hasOwn((row.goal_json ?? {}) as object, "spanRepair")
          || Object.hasOwn((row.goal_json ?? {}) as object, "spanCourseBinding")
          || Object.hasOwn((row.create_intent ?? {}) as object, "courseSpanRequest"))
          && input.status === "paused" && input.moveId === current.moveId && isDeepStrictEqual(input.intent, current.intent);
        if (!preservingRepairPause) await admitCourseSources(tx, scope, current.courseId, current.sourceIds);
        const previous = row.checkpoint_json as Record<string, unknown>;
        const checkpoint = { ...previous, spanLesson: { sessionId: current.sessionId, intent: input.intent, moveId: input.moveId, retestId: current.retestId } };
        await tx`UPDATE opening_teaching_activities SET checkpoint_json=${tx.json(checkpoint)},
          goal_json=COALESCE(goal_json,'{}'::jsonb) || ${tx.json({ sessionIntent: input.intent })}::jsonb,
          status=${input.status},path_version=path_version+1,updated_at=now()
          WHERE id=${activityId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
            AND path_version=${input.expectedRevision}`;
        await nextWorkspaceLearningHistoryRevision(tx, scope);
        return snapshot((await read(tx, scope, activityId))!);
      }) as Promise<SpanLessonSnapshot>;
    },
  };
}
