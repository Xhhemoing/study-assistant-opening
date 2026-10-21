import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Sql, TransactionSql } from "postgres";
import { spanLessonCreateInputSchema, spanLessonSaveInputSchema, spanLessonSnapshotSchema,
  type Scope, type SpanHintLevel, type SpanLessonCreateInput, type SpanLessonSaveInput, type SpanLessonSnapshot } from "@aistudy/contracts";
import { createSpanTeachingSequence, spanModeForIntent, SPAN_REQUIREMENT_KEY, SPAN_SKILL_LABEL } from "@aistudy/domain";
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
        await admitCourseSources(tx, scope, current.courseId, current.sourceIds);
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
