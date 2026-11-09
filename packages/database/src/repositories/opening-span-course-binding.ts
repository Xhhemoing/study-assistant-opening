import { isDeepStrictEqual } from "node:util";
import { courseRequirementSchema, courseRouteActivityContextSchema, spanCourseBindingSchema,
  type Scope, type SpanCourseBinding } from "@aistudy/contracts";
import { courseRequirementSourcesAvailable, SPAN_SKILL_LABEL } from "@aistudy/domain";
import type { Sql, TransactionSql } from "postgres";
import { learningError, learningIso } from "./opening-learning-facts";
import { readLearningGoal } from "./opening-learning-goals";
import { readConfirmedCourseSpanExerciseKeys } from "./opening-course-route-verification-policy";
import { parseOpeningSpanExercise } from "./opening-span-attempt";
import { spanProblemStem } from "@aistudy/domain";

type Db = Sql | TransactionSql;
type Row = Record<string, unknown>;
export const COURSE_SPAN_START_POLICY = "course-span-start-1";
const conflict = () => Object.assign(learningError("CONFLICT", "课程 span 绑定、目标、材料或原始回执已变化；原记录保留。"),
  { reasonCode: "SPAN_COURSE_BINDING_CHANGED" });
const record = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};

/** Public generic creation is never a server execution entry, even with feature switches off. */
export function assertPublicTeachingActivityIntent(input: { goalJson?: Row; createIntent: Row; clientKey: string }): void {
  const reserved = ["spanCourseBinding", "spanPrerequisiteRepair", "courseRoute", "spanRepair", "tutorNextAction", "tutorBudget", "learningBudget", "reservedStart"];
  const executionKey = /^(?:span-lesson:|span-tutor-|span-repair:|span-prerequisite:|course-route-|course-span-start:)/;
  if (reserved.some(key => Object.hasOwn(input.goalJson ?? {}, key) || Object.hasOwn(input.createIntent, key))
    || Object.hasOwn(input.createIntent, "courseSpanRequest")
    || input.createIntent.protocol === "span-lesson-v1" || input.createIntent.kind === "course_route"
    || executionKey.test(input.clientKey) || typeof input.createIntent.operationId === "string" && executionKey.test(input.createIntent.operationId)) {
    throw learningError("VALIDATION", "服务端课程与 span 执行身份不能通过通用教学创建提交。");
  }
}

/** A marker is enough to deny generic mutation, but never enough to grant execution. */
export function hasOpeningSpanCourseBinding(goal: unknown, intent?: unknown): boolean {
  return Object.hasOwn(record(goal), "spanCourseBinding") || Object.hasOwn(record(intent), "courseSpanRequest");
}

/** Read current owned goal/requirement/catalogue/source authority, not client labels or protocol prefixes. */
export async function readOpeningSpanCourseScope(db: Db, scope: Scope, binding: SpanCourseBinding) {
  if (binding.returnTarget || binding.relationSource) throw conflict(); // R2 is not enabled.
  const [row] = await db`SELECT r.* FROM course_requirements r
    JOIN courses c ON c.id=r.course_id AND c.workspace_id=r.workspace_id AND c.archived_at IS NULL
    JOIN workspaces w ON w.id=r.workspace_id AND w.owner_user_id=r.owner_user_id
    WHERE r.id=${binding.requirement.id} AND r.course_id=${binding.courseId}
      AND r.workspace_id=${scope.workspaceId} AND r.owner_user_id=${scope.ownerUserId}`;
  if (!row) throw conflict();
  const parsed = courseRequirementSchema.safeParse({ id: row.id, courseId: row.course_id, stableSkillId: row.stable_skill_id,
    knowledgeNodeId: row.knowledge_node_id, requirementKey: row.requirement_key, title: row.title, position: Number(row.position),
    mandatory: row.mandatory, goalIds: row.goal_ids, prerequisiteIds: row.prerequisite_ids, sourceRefs: row.source_refs,
    verification: row.verification, revision: Number(row.revision), lifecycle: row.lifecycle, origin: row.origin,
    approvedAt: learningIso(row.approved_at) });
  if (!parsed.success) throw conflict();
  const requirement = parsed.data;
  const identity = { id: requirement.id, revision: requirement.revision, stableSkillId: requirement.stableSkillId, requirementKey: requirement.requirementKey };
  const goal = await readLearningGoal(db, scope, binding.goalId);
  const allowedExerciseKeys = readConfirmedCourseSpanExerciseKeys(requirement.requirementKey, requirement.verification);
  if (!isDeepStrictEqual(identity, binding.requirement) || requirement.lifecycle !== "active" || !requirement.approvedAt
    || !allowedExerciseKeys || !goal || goal.revision !== binding.goalRevision || !["active", "maintenance", "reduced"].includes(goal.lifecycle)
    || !goal.courseIds.includes(binding.courseId) || requirement.goalIds.length && !requirement.goalIds.includes(goal.id)) throw conflict();
  const sources = await db`SELECT s.id,s.version FROM opening_sources s JOIN course_asset_memberships m
    ON m.workspace_id=s.workspace_id AND m.asset_id=s.id AND m.asset_type='source' AND m.course_id=${binding.courseId}
    WHERE s.workspace_id=${scope.workspaceId} AND s.upload_state='uploaded' AND s.parse_state='ready'
      AND (m.purpose IS NULL OR m.purpose='teaching')
      AND NOT EXISTS(SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id)`;
  const chunks = await db`SELECT ch.id,ch.source_id,ch.source_version,ch.page FROM opening_source_chunks ch
    WHERE ch.source_id=ANY(${sources.map(s => String(s.id))}::uuid[])
      AND (length(btrim(ch.text))>0 OR ch.image_object_key IS NOT NULL)`;
  if (!courseRequirementSourcesAvailable(requirement, new Map(sources.map(s => [String(s.id), Number(s.version)])),
    chunks.map(ch => ({ id: String(ch.id), sourceId: String(ch.source_id), sourceVersion: Number(ch.source_version), page: ch.page == null ? null : Number(ch.page) })))) throw conflict();
  return { requirement, goal, allowedExerciseKeys };
}

/** Execution reader. No chooser, writes, history backfill, or fallback to a different identity. */
export async function readOpeningSpanCourseBinding(db: Db, scope: Scope, activityId: string, options: { lockSources?: true } = {}) {
  const [activity] = await db`SELECT a.*,s.id AS session_id,s.source_ids AS session_source_ids,s.skill_label AS session_skill_label FROM opening_teaching_activities a
    JOIN workspaces w ON w.id=a.workspace_id AND w.owner_user_id=a.owner_user_id
    LEFT JOIN opening_learning_sessions s ON s.id::text=a.checkpoint_json->'spanLesson'->>'sessionId'
      AND s.activity_id=a.id AND s.course_id=a.course_id AND s.workspace_id=a.workspace_id AND s.owner_user_id=a.owner_user_id
    WHERE a.id=${activityId} AND a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId}`;
  if (!activity) throw learningError("NOT_FOUND", "teaching activity not found");
  if (!hasOpeningSpanCourseBinding(activity.goal_json, activity.create_intent)) return null;
  const parsed = spanCourseBindingSchema.safeParse(record(activity.goal_json).spanCourseBinding);
  if (!parsed.success || !activity.session_id || record(activity.create_intent).protocol !== "span-lesson-v1") throw conflict();
  const binding = parsed.data;
  // R1 roots only. Child execution authority is an R2 decision, not inferred here.
  if (binding.routeActivityId !== activityId || binding.courseId !== activity.course_id
    || activity.session_skill_label !== SPAN_SKILL_LABEL) throw conflict();
  const route = courseRouteActivityContextSchema.safeParse(record(activity.goal_json).courseRoute);
  const request = record(record(activity.create_intent).courseSpanRequest);
  if (request.courseId !== binding.courseId || request.goalId !== binding.goalId || request.expectedGoalRevision !== binding.goalRevision
    || request.requirementId !== binding.requirement.id || request.expectedRequirementRevision !== binding.requirement.revision
    || record(activity.create_intent).kind !== "course_route"
    || activity.client_key !== `course-route-start:${binding.courseId}:${request.clientKey}`) throw conflict();
  if (!route.success || route.data.goalId !== binding.goalId || route.data.goalRevision !== binding.goalRevision
    || route.data.requirementId !== binding.requirement.id || route.data.requirementRevision !== binding.requirement.revision
    || route.data.stableSkillId !== binding.requirement.stableSkillId || route.data.requirementKey !== binding.requirement.requirementKey
    || route.data.returnTo || route.data.originActivityId || route.data.retestId) throw conflict();
  const [decision] = await db`SELECT d.receipt FROM opening_learning_decisions d
    JOIN workspaces w ON w.id=d.workspace_id AND w.owner_user_id=d.owner_user_id
    WHERE d.workspace_id=${scope.workspaceId} AND d.owner_user_id=${scope.ownerUserId} AND d.layer='activity'
      AND d.target_id=${binding.routeActivityId} AND d.client_key=${`course-span-start:${binding.routeActivityId}`}`;
  const receipt = record(decision?.receipt);
  let captured: Row;
  try { captured = record(JSON.parse(String(receipt.intentVersion))); } catch { throw conflict(); }
  if (receipt.policyVersion !== COURSE_SPAN_START_POLICY || receipt.targetId !== activityId || receipt.layer !== "activity"
    || receipt.goalVersion !== `goal:${binding.goalId}:v${binding.goalRevision}`
    || !isDeepStrictEqual(captured.courseBinding, binding) || !isDeepStrictEqual(captured.courseRoute, route.data)
    || captured.sessionId !== activity.session_id || !isDeepStrictEqual(captured.sourceIds, activity.source_ids)
    || !isDeepStrictEqual(activity.source_ids, activity.session_source_ids)) throw conflict();
  if (options.lockSources) {
    await db`SELECT m.asset_id FROM course_asset_memberships m WHERE m.workspace_id=${scope.workspaceId}
      AND m.course_id=${binding.courseId} AND m.asset_type='source' AND m.asset_id=ANY(${activity.source_ids as string[]}::uuid[])
      ORDER BY m.asset_id FOR SHARE`;
  }
  const current = await readOpeningSpanCourseScope(db, scope, binding);
  const expectedSources = [...new Set(current.requirement.sourceRefs.map(ref => ref.sourceId))].sort();
  const expectedVersions = Object.fromEntries(current.requirement.sourceRefs.map(ref => [ref.sourceId, [ref.sourceVersion]]));
  if (!isDeepStrictEqual(expectedSources, activity.source_ids) || !isDeepStrictEqual(receipt.sourceVersions, expectedVersions)) throw conflict();
  return { binding, sessionId: String(activity.session_id), ...current };
}

/** The saved attempt, not a reusable item or a mapper field, owns this issuance's course identity. */
export async function readOpeningSpanCourseAttempt(db: Db, scope: Scope, attempt: Row,
  current?: Awaited<ReturnType<typeof readOpeningSpanCourseBinding>>) {
  const authority = current === undefined ? await readOpeningSpanCourseBinding(db, scope, String(attempt.activity_id)) : current;
  const intent = record(attempt.create_intent);
  if (!authority) {
    if (Object.hasOwn(intent, "spanCourseBinding")) throw conflict();
    return null;
  }
  const { binding, sessionId, allowedExerciseKeys } = authority;
  const sources = [...new Set(authority.requirement.sourceRefs.map(ref => ref.sourceId))].sort();
  const versions = Object.fromEntries(authority.requirement.sourceRefs.map(ref => [ref.sourceId, ref.sourceVersion]));
  const requested = record(intent.spanExercise);
  if (!attempt.item_version_id) throw conflict();
  const [item] = await db`SELECT v.* FROM opening_learning_item_versions v WHERE v.id=${String(attempt.item_version_id)}
    AND v.workspace_id=${scope.workspaceId} AND v.owner_user_id=${scope.ownerUserId} AND v.course_id=${binding.courseId}`;
  const problem = parseOpeningSpanExercise(item?.evaluation_spec);
  const canonicalSpec = problem ? { kind: "span", specVersion: "span-v1", problemId: problem.id, version: Number(problem.version),
    familyId: problem.familyId, requirementKey: binding.requirement.requirementKey, knowledgeComponents: problem.knowledgeComponents,
    transfer: problem.transfer ?? null } : null;
  if (!isDeepStrictEqual(item?.evaluation_spec, canonicalSpec) || !isDeepStrictEqual(intent.spanCourseBinding, binding) || attempt.workspace_id !== scope.workspaceId
    || attempt.owner_user_id !== scope.ownerUserId || attempt.session_id !== sessionId || attempt.course_id !== binding.courseId
    || attempt.activity_id !== binding.routeActivityId || attempt.requirement_key !== binding.requirement.requirementKey
    || attempt.skill_label !== SPAN_SKILL_LABEL || !isDeepStrictEqual(attempt.source_ids, sources)
    || !isDeepStrictEqual(attempt.source_versions, versions) || intent.sessionId !== sessionId
    || intent.requirementKey !== binding.requirement.requirementKey
    || !problem || !allowedExerciseKeys.includes(problem.id) || requested.problemId !== problem.id
    || requested.version !== Number(problem.version) || requested.sourceId !== item?.source_id
    || !sources.includes(String(item?.source_id)) || versions[String(item?.source_id)] !== Number(item?.source_version)
    || item?.problem_id !== attempt.problem_id || item?.stem_snapshot !== spanProblemStem(problem)) throw conflict();
  return authority;
}
