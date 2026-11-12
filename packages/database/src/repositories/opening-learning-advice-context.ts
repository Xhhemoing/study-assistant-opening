import { isDeepStrictEqual } from "node:util";
import { spanLessonSnapshotSchema, type Scope } from "@aistudy/contracts";
import { SPAN_REQUIREMENT_KEY, SPAN_SKILL_LABEL } from "@aistudy/domain";
import type { NextLearningStep } from "@aistudy/domain";
import type { Sql } from "postgres";
import { learningError, learningIso } from "./opening-learning-facts";
import { readOpeningSpanCourseAttempt, readOpeningSpanCourseBinding } from "./opening-span-course-binding";
import { readSpanTutorAuthorization } from "./opening-span-tutor-grant";
import { readOpeningStudyIntentInTx } from "./opening-study-intent-events";
import { createOpeningRetestActivityRepository } from "./opening-retest-activities";
import { readOpeningSpanAdviceDecisionInTx } from "./opening-span-tutor-context";

export type OpeningLearningAdviceAnchor = { activityId: string; attemptId: string; expectedRevision: number };
export type OpeningLearningAdviceContext = { ruleDecision: Pick<NextLearningStep, "activityKind" | "reasonCode"> } | null;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const notFound = () => learningError("NOT_FOUND", "learning advice resource unavailable");

/** Rule-only current read. No experiment permission, BKT port, chooser or writer. */
export function createOpeningLearningAdviceContextRepository(sql: Sql) {
  return {
    async read(scope: Scope, anchor: OpeningLearningAdviceAnchor): Promise<OpeningLearningAdviceContext> {
      return sql.begin("isolation level repeatable read read only", async tx => {
        const [activity] = await tx`SELECT a.*,s.id AS session_id,s.source_ids AS session_source_ids,
            s.skill_label AS session_skill_label
          FROM opening_teaching_activities a
          JOIN workspaces w ON w.id=a.workspace_id AND w.owner_user_id=a.owner_user_id
          JOIN courses c ON c.id=a.course_id AND c.workspace_id=a.workspace_id AND c.archived_at IS NULL
          JOIN opening_learning_sessions s ON s.id::text=a.checkpoint_json->'spanLesson'->>'sessionId'
            AND s.activity_id=a.id AND s.course_id=a.course_id
            AND s.workspace_id=a.workspace_id AND s.owner_user_id=a.owner_user_id
          WHERE a.id=${anchor.activityId} AND a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId}`;
        if (!activity) throw notFound();
        if (Number(activity.path_version) !== anchor.expectedRevision) throw learningError("CONFLICT", "learning advice revision changed");
        // Resolve the requested anchor before unsupported-branch exits: a foreign attempt is never accepted.
        const [attempt] = await tx`SELECT p.id,p.workspace_id,p.owner_user_id,p.course_id,p.session_id,p.activity_id,
            p.problem_id,p.item_version_id,p.requirement_key,p.skill_label,p.source_ids,p.source_versions,p.create_intent
          FROM opening_learning_attempts p
          WHERE p.id=${anchor.attemptId} AND p.workspace_id=${scope.workspaceId} AND p.owner_user_id=${scope.ownerUserId}
            AND p.course_id=${String(activity.course_id)} AND p.session_id=${String(activity.session_id)} AND p.activity_id=${anchor.activityId}`;
        if (!attempt) throw notFound();
        const goal = record(activity.goal_json), create = record(activity.create_intent);
        if (activity.status !== "active" || create.protocol !== "span-lesson-v1" || create.kind !== "course_route"
          || !Object.hasOwn(goal, "spanCourseBinding")
          || ["spanRepair", "spanPrerequisiteRepair", "tutorNextAction", "reservedStart"].some(key => Object.hasOwn(goal, key))) return null;
        const state = record(record(activity.checkpoint_json).spanLesson);
        // Missing persisted facts are not equivalent to a default intent or 'no retest'.
        if (!Object.hasOwn(state, "retestId") || state.retestId !== null
          || activity.session_skill_label !== SPAN_SKILL_LABEL || !isDeepStrictEqual(activity.source_ids, activity.session_source_ids)) return null;
        const parsed = spanLessonSnapshotSchema.safeParse({ activityId: activity.id, sessionId: activity.session_id,
          courseId: activity.course_id, sourceIds: activity.source_ids, intent: state.intent, moveId: state.moveId,
          retestId: state.retestId, status: activity.status, revision: Number(activity.path_version),
          createdAt: learningIso(activity.created_at), updatedAt: learningIso(activity.updated_at) });
        if (!parsed.success) return null;
        const session = parsed.data;
        const latestIntent = await readOpeningStudyIntentInTx(tx, scope, session.sessionId);
        if (latestIntent) {
          if (latestIntent.activityId !== anchor.activityId || latestIntent.action !== "continue"
            || goal.sessionIntentEventId !== latestIntent.id || goal.sessionIntentVersion !== latestIntent.version
            || !isDeepStrictEqual(goal.sessionIntent, latestIntent.intent)) return null;
        } else if (Object.hasOwn(goal, "sessionIntentEventId") || Object.hasOwn(goal, "sessionIntentVersion")
          || !isDeepStrictEqual(goal.sessionIntent, session.intent)) return null;
        const intent = latestIntent?.intent ?? session.intent;
        // Other purposes need their own complete priority/continuation proof; do not infer them here.
        if (intent.purpose !== "self_study") return null;
        const authority = await readOpeningSpanCourseBinding(tx, scope, anchor.activityId);
        if (!authority || authority.binding.returnTarget || authority.sessionId !== session.sessionId) return null;
        await readOpeningSpanCourseAttempt(tx, scope, attempt, authority);
        const authorization = await readSpanTutorAuthorization(tx, scope, session.courseId);
        if (!authorization.authorized) return null;
        const due = await createOpeningRetestActivityRepository(tx).listDue(scope, session.courseId, new Date().toISOString());
        // The existing due reader does not prove a bound requirement ID. Keep that branch unavailable.
        if (due.some(row => row.requirementKey === SPAN_REQUIREMENT_KEY && row.skillLabel === SPAN_SKILL_LABEL)) return null;
        // facts owns observation-backed assistance, but does not prove every later delivered help's priority.
        // Keep the entire course-help branch unavailable rather than silently dropping those facts.
        // Historical nullable scope resolves through the same scoped session as the evidence reader.
        // Owner-known receipts with neither course nor session cannot safely exclude this course.
        const deliveredHelp = await tx`SELECT h.id FROM opening_help_exposures h
          LEFT JOIN opening_learning_sessions l ON l.id=h.session_id AND l.workspace_id=h.workspace_id
            AND l.owner_user_id=${scope.ownerUserId}
          WHERE h.workspace_id=${scope.workspaceId} AND COALESCE(h.owner_user_id,l.owner_user_id)=${scope.ownerUserId}
            AND (COALESCE(h.course_id,l.course_id)=${session.courseId} OR (h.course_id IS NULL AND h.session_id IS NULL))
            AND h.delivered=TRUE AND h.support_domain<>'language'
          LIMIT 1`;
        if (deliveredHelp.length) return null;
        const sources = authority.requirement.sourceRefs;
        const sourceIds = [...new Set(sources.map(ref => ref.sourceId))].sort();
        const sourceVersions = Object.fromEntries(sources.map(ref => [ref.sourceId, ref.sourceVersion]));
        const { decision } = await readOpeningSpanAdviceDecisionInTx(tx, scope, authority.binding,
          sourceIds, sourceVersions, intent, null);
        return { ruleDecision: { activityKind: decision.activityKind, reasonCode: decision.reasonCode } };
      }) as Promise<OpeningLearningAdviceContext>;
    },
  };
}
