import { randomUUID } from "node:crypto";
import type { LearningGoal, Scope, SuggestedTask, TaskItem } from "@aistudy/contracts";
import type { Sql, TransactionSql } from "postgres";
import { readOpeningCourseRoute, readCourseRouteObservations } from "./opening-course-route-read";
import { readOpeningLearnerSnapshotCourses } from "./opening-learner-snapshot-read";
import { createCardRepository } from "./cards";
import { addLocalDays, localDateKeyInZone, resolveLocalDayBounds } from "@aistudy/domain";

export function learningMaintenanceDue(goal: Pick<LearningGoal, "lifecycle" | "maintenanceIntervalDays">, lastAt: string | null, now: Date, timeZone = "UTC"): boolean {
  if (!["maintenance", "reduced"].includes(goal.lifecycle) || goal.maintenanceIntervalDays === null) return false;
  return lastAt === null || addLocalDays(localDateKeyInZone(new Date(lastAt), timeZone), goal.maintenanceIntervalDays) <= localDateKeyInZone(now, timeZone);
}
/** Suggestions retain real requirement/card identities; none is a scored learning fact. */
export async function buildLongTermSuggestions(db: Sql | TransactionSql, scope: Scope, input: { date: string; timeZone: string; now: Date; goals: LearningGoal[]; tasks: TaskItem[] }) {
  const suggestions: SuggestedTask[] = [], snapshots: Record<string, unknown> = {};
  const courses = await db`SELECT id FROM courses WHERE workspace_id=${scope.workspaceId} AND archived_at IS NULL`;
  const activeCourses = new Set(courses.map(row => String(row.id)));
  const pending = await db`SELECT client_key FROM opening_tasks WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND status='pending'`;
  for (const goal of input.goals.filter(row => ["maintenance", "reduced"].includes(row.lifecycle)).slice(0, 200)) {
    if (goal.maintenanceIntervalDays === null) continue;
    if (pending.some(row => String(row.client_key).includes(`:maintenance:${goal.id}:`))) continue;
    for (const courseId of goal.courseIds) {
      if (!activeCourses.has(courseId)) continue;
      const route = await readOpeningCourseRoute(db, scope, courseId);
      if (route.scopeState !== "confirmed") continue;
      const observations = (await readCourseRouteObservations(db, scope, courseId)).projected;
      const row = route.requirements.find(row => row.requirement.lifecycle === "active" && row.sourcesAvailable && row.requirement.verification.status === "ready"
        && (!row.requirement.goalIds.length || row.requirement.goalIds.includes(goal.id)) && learningMaintenanceDue(goal,
          observations.filter(observation => ((observation.courseRequirement?.id === row.requirement.id && observation.courseRequirement.revision === row.requirement.revision
            && observation.courseRequirement.stableSkillId === row.requirement.stableSkillId) || row.sharedEvidence?.some(ref => ref.observationId === observation.id)) && observation.usableForCurrentVersion === "yes" && observation.independentAttempt === "yes" && observation.verifiedCorrect === "yes")
            .sort((a, b) => Date.parse(b.attemptedAt) - Date.parse(a.attemptedAt))[0]?.attemptedAt ?? null, resolveLocalDayBounds(input.date, input.timeZone).dayStart, input.timeZone));
      if (!row) continue;
      const key = `planner:${input.date}:maintenance:${goal.id}:${row.requirement.id}`;
      suggestions.push({ id: randomUUID(), key, kind: "new_skill", title: `保持抽查：${row.requirement.title}`.slice(0, 240), minutes: 10,
        courseId, skillLabel: row.requirement.title, requirementKey: row.requirement.requirementKey,
        reasonCode: "goal_priority", reason: `目标处于${goal.lifecycle === "reduced" ? "降低频率" : "保持"}模式，间隔 ${goal.maintenanceIntervalDays} 天。一次独立抽查后按真实结果决定纠偏，不能代替长期保持结论。` });
      break;
    }
    if (suggestions.length >= 8) break;
  }
  const cards = await createCardRepository(db as Sql).listQueue({ ...scope, mode: "auto", now: input.now, today: input.date, timeZone: input.timeZone });
  const usedCards = new Set<string>();
  for (const entry of cards) {
    if (usedCards.has(entry.card.id)) continue;
    const courseId = entry.card.courseId;
    if (courseId && !activeCourses.has(courseId)) continue;
    if (courseId && input.goals.some(goal => goal.courseIds.includes(courseId)) && !input.goals.some(goal => goal.courseIds.includes(courseId) && ["active", "maintenance", "reduced"].includes(goal.lifecycle))) continue;
    if (input.tasks.some(task => task.status === "pending" && task.suggestionKind === "review_cards" && (task.courseId ?? null) === courseId)
      || suggestions.some(task => task.kind === "review_cards" && task.courseId === courseId)) continue;
    const group = cards.filter(row => row.card.courseId === courseId && !usedCards.has(row.card.id)).slice(0, 50);
    for (const row of group) usedCards.add(row.card.id);
    const key = `planner:${input.date}:review_cards:${courseId ?? "none"}:long-term`;
    suggestions.push({ id: randomUUID(), key, kind: "review_cards", title: "到期卡片复习（有界会话）", minutes: Math.min(10, Math.max(2, group.length * 2)), courseId,
      skillLabel: null, reasonCode: "review_cards", reason: `${group.length} 张实际到期卡片；时长为候选估计，开始后按真实停止点记录用时，不能冒充课程独立抽查。` });
    snapshots[key] = { cardIds: group.map(row => row.card.id) };
    if (suggestions.length >= 10) break;
  }
  const materials = await readOpeningLearnerSnapshotCourses(db, scope);
  return { suggestions, tasks: suggestions.map((row): TaskItem => ({ id: row.id, version: 1, title: row.title, minutes: row.minutes, dueAt: null, priority: 2, status: "pending", ...(row.courseId ? { courseId: row.courseId } : {}), ...(row.skillLabel ? { skillLabel: row.skillLabel } : {}), requirementKey: row.requirementKey ?? null })),
    snapshot: { learningManagementSuggestions: snapshots, courseMaterialRevisions: Object.fromEntries(materials.map(row => [row.courseId, row.materialRevision])) } };
}
