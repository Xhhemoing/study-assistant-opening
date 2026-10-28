import { learningGoalSchema, openingAdaptivePrefsSchema, learningManagementSettingsSchema, courseRequirementSchema, courseMilestoneSchema } from "@aistudy/contracts";
import { validateBackupLearningLinks } from "./backup-learning-links";
type Row = Record<string, unknown>;
/** New inventories are optional for old archives; references are never optional once present. */
export function validateBackupLearningGoals(tables: Record<string, Row[]>, errors: string[], ownerUserId?: string) {
  validateBackupLearningLinks(tables, errors, ownerUserId);
  const courses = new Map((tables.courses ?? []).map(row => [row.id, row]));
  const goals = new Map((tables.course_goals ?? []).map(row => [row.id, row]));
  const links = tables.course_goal_links ?? [];
  const date = (value: unknown) => value == null ? null : value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
  const iso = (value: unknown) => value instanceof Date ? value.toISOString() : value;
  const courseIdsFor = (row: Row) => [...new Set([row.course_id, ...links.filter(link => link.goal_id === row.id).map(link => link.course_id)])];
  for (const row of goals.values()) {
    const courseIds = courseIdsFor(row);
    if (!learningGoalSchema.safeParse({ id: row.id, workspaceId: row.workspace_id, courseIds, title: row.title, kind: row.kind,
      targetDate: date(row.target_date), examDate: date(row.exam_date), revision: row.revision, weeklyMinutes: row.weekly_minutes,
      priority: row.priority, learningMode: row.learning_mode, successCriteria: row.success_criteria, lifecycle: row.lifecycle,
      maintenanceIntervalDays: row.maintenance_interval_days, milestones: row.milestones, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }).success) errors.push("formal learning goal is invalid");
    if (courseIds.some(id => courses.get(id)?.workspace_id !== row.workspace_id)) errors.push("learning goal course is not included in its workspace");
    const milestones = courseMilestoneSchema.array().safeParse(row.milestones);
    if (milestones.success) for (const milestone of milestones.data) for (const ref of milestone.evidenceRefs) {
      const table = ref.kind === "attempt" ? "opening_learning_attempts" : ref.kind === "observation" ? "opening_learning_observations" : "opening_teaching_activities";
      const evidence = tables[table]?.find(record => record.id === ref.id);
      if (!evidence || evidence.workspace_id !== row.workspace_id || !courseIds.includes(evidence.course_id)
        || (ownerUserId && evidence.owner_user_id !== ownerUserId)) errors.push("formal goal milestone evidence is missing or outside its owner and courses");
    }
  }
  for (const row of links) if (goals.get(row.goal_id)?.workspace_id !== row.workspace_id || courses.get(row.course_id)?.workspace_id !== row.workspace_id) errors.push("learning goal link is outside the backup workspace");
  for (const row of tables.goal_time_windows ?? []) if (goals.get(row.goal_id)?.workspace_id !== row.workspace_id) errors.push("goal time window goal is missing");
  const requirements = new Map((tables.course_requirements ?? []).map(row => [row.id, row]));
  const sources = new Set((tables.opening_sources ?? []).map(row => row.id));
  for (const row of requirements.values()) {
    if (ownerUserId && row.owner_user_id !== ownerUserId) errors.push("course requirement owner does not match the restore owner");
    const parsed = courseRequirementSchema.safeParse({ id: row.id, courseId: row.course_id, stableSkillId: row.stable_skill_id,
      knowledgeNodeId: row.knowledge_node_id, requirementKey: row.requirement_key, title: row.title, position: row.position,
      mandatory: row.mandatory, goalIds: row.goal_ids, prerequisiteIds: row.prerequisite_ids, sourceRefs: row.source_refs,
      verification: row.verification, ...(row.evidence_conditions == null ? {} : { evidenceConditions: row.evidence_conditions }), revision: row.revision, lifecycle: row.lifecycle, origin: row.origin, approvedAt: row.approved_at == null ? null : iso(row.approved_at) });
    if (!parsed.success) { errors.push("course requirement is invalid"); continue; }
    if (courses.get(row.course_id)?.workspace_id !== row.workspace_id
      || parsed.data.goalIds.some(id => !goals.has(id) || !courseIdsFor(goals.get(id)!).includes(row.course_id))
      || parsed.data.prerequisiteIds.some(id => requirements.get(id)?.course_id !== row.course_id)
      || parsed.data.sourceRefs.some(ref => !sources.has(ref.sourceId))) errors.push("course requirement references are incomplete");
  }
  for (const row of tables.workspace_preferences ?? []) {
    if (row.learning_management != null && !learningManagementSettingsSchema.safeParse(row.learning_management).success) errors.push("learning management settings are invalid");
    const parsed = openingAdaptivePrefsSchema.safeParse(row.adaptive_planning);
    if (!parsed.success) continue;
    for (const [courseId, goalId] of Object.entries(parsed.data.courseGoalRefs ?? {})) {
      const goal = goals.get(goalId);
      if (!goal || !courseIdsFor(goal).includes(courseId)) errors.push("selected learning goal is not included for its course");
    }
  }
}

/** Keep definitions while excluding evidence removed by the backup privacy inventory. */
export function projectBackupFormalGoalReferences(tables: Record<string, Row[]>) {
  const included = {
    attempt: new Set((tables.opening_learning_attempts ?? []).map(row => row.id)),
    observation: new Set((tables.opening_learning_observations ?? []).map(row => row.id)),
    teaching_activity: new Set((tables.opening_teaching_activities ?? []).map(row => row.id)),
  };
  return (tables.course_goals ?? []).map(row => {
    const parsed = courseMilestoneSchema.array().safeParse(row.milestones);
    if (!parsed.success) return row;
    const milestones = structuredClone(parsed.data);
    for (const milestone of milestones) for (const version of [...milestone.history, milestone]) {
      version.evidenceRefs = version.evidenceRefs.filter(ref => included[ref.kind].has(ref.id));
    }
    return { ...row, milestones };
  });
}
