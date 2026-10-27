import { learningMaintenanceStartSchema, type Scope } from "@aistudy/contracts";
import { readLearningGoal } from "@aistudy/database";
import type { Sql } from "postgres";
import { createCourseRouteService } from "../teaching/course-route-service";

/** Real maintenance tasks enter the ordinary course route and keep its source/question guards. */
export function createLongTermMaintenanceService(sql: Sql, env: Record<string, string | undefined> = process.env) {
  return { async start(scope: Scope, raw: unknown) {
    const input = learningMaintenanceStartSchema.parse(raw);
    const [task] = await sql`SELECT * FROM opening_tasks WHERE id=${input.taskId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
    const match = task && /^planner:\d{4}-\d{2}-\d{2}:maintenance:([a-f0-9-]{36}):([a-f0-9-]{36})$/.exec(String(task.client_key));
    if (!task || !match || !task.course_id) throw Object.assign(new Error("保持抽查任务不存在。"), { code: "NOT_FOUND" });
    const goal = await readLearningGoal(sql, scope, match[1]!);
    if (!goal) throw Object.assign(new Error("原目标不可读取。"), { code: "NOT_FOUND" });
    const [requirement] = await sql`SELECT revision FROM course_requirements WHERE id=${match[2]!} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND course_id=${task.course_id}`;
    if (!requirement) throw Object.assign(new Error("原课程要求不可读取。"), { code: "NOT_FOUND" });
    return createCourseRouteService(sql, env).start(scope, String(task.course_id), { goalId: goal.id, expectedGoalRevision: goal.revision,
      requirementId: match[2]!, expectedRequirementRevision: Number(requirement.revision), taskId: input.taskId, expectedTaskVersion: input.expectedVersion,
      clientKey: `maintenance:${input.taskId}`, minutes: Number(task.minutes) });
  } };
}
