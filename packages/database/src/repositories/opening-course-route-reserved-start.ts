import { z } from "zod";
import { courseRouteActivityContextSchema, type CourseRequirement, type CourseRouteNext, type CourseRouteStart, type OpeningMaterialPurposePin, type Scope } from "@aistudy/contracts";
import type { Sql, TransactionSql } from "postgres";
import { createOpeningCourseReadySourcesRepository } from "./opening-course-ready-sources";
import { assertCourseRouteCourse, readCourseRequirements } from "./opening-course-route-read";
import { assertOpeningCourseRouteCurrent } from "./opening-course-route-origin";
import { reserveOpeningCourseQuestion, issueOpeningReservedQuestion } from "./opening-course-reserved-selection";
import { learningError } from "./opening-learning-facts";

// Persisted server JSON is a trust boundary. This receipt is not an HTTP input
// or an exposure/coverage claim; it preserves the ORIGINAL material-use pin.
const receiptSchema = z.object({
  taskId: z.string().uuid(), taskVersion: z.number().int().positive(),
  purposePin: z.object({ courseId: z.string().uuid(), materialUse: z.literal("practice"),
    sources: z.array(z.object({ sourceId: z.string().uuid(), sourceVersion: z.number().int().nonnegative(),
      membershipId: z.string().uuid(), purposeRevision: z.string().min(1),
      purpose: z.enum(["teaching", "practice", "mock_exam", "reference"]).nullable(),
    }).strict()).min(1),
  }).strict(),
}).strict();
export type CourseReservedStart = { taskId: string; taskVersion: number; purposePin: OpeningMaterialPurposePin };

/** Capture before the write transaction; no network or provider under DB locks.
 * Only the supported private arithmetic delayed-task path changes behavior.
 * Admission/timing/current protocol are still rechecked by the route transaction.
 */
export async function prepareCourseReservedStart(sql: Sql, scope: Scope, courseId: string, input: CourseRouteStart): Promise<CourseReservedStart | undefined> {
  if (!input.taskId) return;
  await assertCourseRouteCourse(sql, scope, courseId);
  const [retest] = await sql`SELECT id FROM opening_retest_activities WHERE task_id=${input.taskId}
    AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND course_id=${courseId}
    AND learning_protocol->>'protocolId'='course-route-delayed-v1'`;
  if (!retest) return;
  const requirement = (await readCourseRequirements(sql, scope, courseId)).find(row => row.id === input.requirementId);
  if (requirement?.requirementKey !== "arithmetic" || requirement.verification.kind !== "exact") return;
  const [existing] = await sql`SELECT id FROM opening_teaching_activities WHERE workspace_id=${scope.workspaceId}
    AND owner_user_id=${scope.ownerUserId} AND client_key=${`course-route-task:${input.taskId.toLowerCase()}`}`;
  if (existing) return; // The transaction validates the persisted ORIGINAL receipt, never recaptures its pin.
  const purposePin = await createOpeningCourseReadySourcesRepository(sql).readMaterialPurposePin(scope, {
    courseId, materialUse: "practice", sourceIds: requirement.sourceRefs.map(ref => ref.sourceId),
  });
  return { taskId: input.taskId.toLowerCase(), taskVersion: input.expectedTaskVersion!, purposePin };
}

export async function assertCourseReservedStartPin(sql: Sql, tx: TransactionSql, scope: Scope, raw: unknown, requirement: CourseRequirement) {
  const parsed = receiptSchema.safeParse(raw);
  if (!parsed.success) throw learningError("CONFLICT", "保留复测缺少原始用途回执，请重新核对任务。");
  const receipt = parsed.data, pin = receipt.purposePin;
  if (pin.courseId !== requirement.courseId || pin.sources.length !== new Set(requirement.sourceRefs.map(ref => ref.sourceId)).size
    || requirement.sourceRefs.some(ref => !pin.sources.some(source => source.sourceId === ref.sourceId && source.sourceVersion === ref.sourceVersion)))
    throw learningError("CONFLICT", "保留复测的原始材料快照已变化。");
  await createOpeningCourseReadySourcesRepository(sql).assertMaterialPurposePin(scope, pin, tx);
  return receipt;
}

/** Explicit POST owns the activity transaction. GET never reserves or issues.
 * No port comes from the request: the existing durable exposure reader owns eligibility.
 */
export async function startCourseReservedQuestion(sql: Sql, tx: TransactionSql, scope: Scope, requirement: CourseRequirement,
  activityId: string, receipt: CourseReservedStart) {
  await assertCourseReservedStartPin(sql, tx, scope, receipt, requirement);
  await reserveOpeningCourseQuestion(tx, scope, requirement, activityId, { kind: "new_family", excludedFamilyIds: [] });
  await assertCourseReservedStartPin(sql, tx, scope, receipt, requirement);
  await issueOpeningReservedQuestion(tx, scope, activityId);
}

/** Both recovery entrances must recognize pre-receipt arithmetic delayed activities
 * from server bindings. A missing original pin can never be reconstructed safely. */
export async function assertCourseReservedRecovery(sql: Sql, tx: TransactionSql, scope: Scope, courseId: string,
  row: Record<string, unknown>, input: CourseRouteStart | CourseRouteNext, requirements: CourseRequirement[]) {
  const goal = row.goal_json as { reservedStart?: unknown; courseRoute?: unknown };
  let required = goal.reservedStart !== undefined;
  const context = courseRouteActivityContextSchema.parse(goal.courseRoute);
  const requirement = requirements.find(item => item.id === context.requirementId);
  const taskId = (row.create_intent as { taskId?: string } | undefined)?.taskId;
  if (!required && taskId && requirement?.requirementKey === "arithmetic" && requirement.verification.kind === "exact") {
    const [retest] = await tx`SELECT id FROM opening_retest_activities WHERE task_id=${taskId}
      AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND course_id=${courseId}
      AND learning_protocol->>'protocolId'='course-route-delayed-v1'`;
    required = !!retest || context.retestId !== undefined;
  }
  if (!required) return;
  if (!("requirementId" in input)) throw learningError("CONFLICT", "保留复测必须沿原任务恢复。");
  await assertCourseReservedReplay(sql, tx, scope, courseId, row, input);
}

export async function assertCourseReservedReplay(sql: Sql, tx: TransactionSql, scope: Scope, courseId: string,
  row: Record<string, unknown>, input: CourseRouteStart) {
  const context = await assertOpeningCourseRouteCurrent(tx, scope, String(row.id));
  const requirement = (await readCourseRequirements(tx, scope, courseId)).find(item => item.id === context?.requirementId);
  if (!context || !requirement) throw learningError("CONFLICT", "保留复测课程要求不可用。");
  const receipt = await assertCourseReservedStartPin(sql, tx, scope,
    (row.goal_json as { reservedStart?: unknown }).reservedStart, requirement);
  if (receipt.taskId !== input.taskId?.toLowerCase() || receipt.taskVersion !== input.expectedTaskVersion
    || context.requirementId !== input.requirementId || context.requirementRevision !== input.expectedRequirementRevision
    || context.goalRevision !== input.expectedGoalRevision
    || (row.goal_json as { learningBudget?: { minutes?: number } }).learningBudget?.minutes !== input.minutes)
    throw learningError("CONFLICT", "同一次保留复测的任务或版本已变化。");
  const [task] = await tx`SELECT version FROM opening_tasks WHERE id=${receipt.taskId}
    AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
  if (!task || Number(task.version) !== receipt.taskVersion) throw learningError("CONFLICT", "原保留复测任务版本已变化。");
  const [issued] = await tx`SELECT id FROM opening_course_reserved_questions WHERE workspace_id=${scope.workspaceId}
    AND owner_user_id=${scope.ownerUserId} AND reserved_activity_id=${String(row.id)} AND state='issued'`;
  if (!issued) throw learningError("CONFLICT", "原保留复测尚未完整发题，不能自动换题。");
}
