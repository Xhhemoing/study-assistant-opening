import { openingAdaptivePrefsSchema } from "@aistudy/contracts";
import { isUuid } from "./backup-validation";

type Tables = Record<string, Record<string, unknown>[]>;

/** Validate preference-held learning links at the restore boundary. */
export function validateBackupCourseMilestones(tables: Tables, errors: string[], expectedOwnerUserId?: string): void {
  const courses = new Map((tables.courses ?? []).filter(row => isUuid(row.id)).map(row => [String(row.id).toLowerCase(), row]));
  const refs = {
    attempt: new Map((tables.opening_learning_attempts ?? []).map(row => [String(row.id).toLowerCase(), row])),
    observation: new Map((tables.opening_learning_observations ?? []).map(row => [String(row.id).toLowerCase(), row])),
    teaching_activity: new Map((tables.opening_teaching_activities ?? []).map(row => [String(row.id).toLowerCase(), row])),
  };
  for (const row of tables.workspace_preferences ?? []) {
    if (row.adaptive_planning == null) continue;
    const parsed = openingAdaptivePrefsSchema.safeParse(row.adaptive_planning);
    if (!parsed.success) { errors.push("workspace adaptive planning preferences are invalid"); continue; }
    for (const [courseId, goal] of Object.entries(parsed.data.courseGoals)) {
      if (!goal.milestones?.length) continue;
      const course = courses.get(courseId.toLowerCase());
      if (!course || course.workspace_id !== row.workspace_id) errors.push("course milestone course is not included in the same workspace");
      const ids = new Set<string>();
      for (const milestone of goal.milestones) {
        if (ids.has(milestone.id)) errors.push("course milestone identity is duplicated");
        ids.add(milestone.id);
        const versions = [...milestone.history, milestone];
        if (versions.some((version, index) => version.id !== milestone.id || version.revision !== index + 1
          || (version.status === "confirmed_by_learner") !== (version.confirmedAt !== null))) {
          errors.push("course milestone history is inconsistent");
        }
        for (const version of versions) for (const ref of version.evidenceRefs) {
          const evidence = refs[ref.kind].get(ref.id.toLowerCase());
          // Deleted historical records remain historical identities, never active evidence.
          if (!evidence && version !== milestone) continue;
          if (!evidence || evidence.workspace_id !== row.workspace_id || evidence.course_id !== courseId
            || !isUuid(evidence.owner_user_id) || (expectedOwnerUserId !== undefined && evidence.owner_user_id !== expectedOwnerUserId)) {
            errors.push("course milestone evidence is missing or outside its course and owner");
          }
        }
      }
      if (goal.revision === undefined || (parsed.data.courseGoalRevisions?.[courseId] ?? goal.revision) !== goal.revision) {
        errors.push("course milestone goal revision is inconsistent");
      }
    }
  }
}

/** Privacy filtering can remove evidence after the goal was saved. Export only remaining links. */
export function projectBackupCourseMilestoneReferences(tables: Tables): Record<string, unknown>[] {
  const included = {
    attempt: new Set((tables.opening_learning_attempts ?? []).map(row => String(row.id).toLowerCase())),
    observation: new Set((tables.opening_learning_observations ?? []).map(row => String(row.id).toLowerCase())),
    teaching_activity: new Set((tables.opening_teaching_activities ?? []).map(row => String(row.id).toLowerCase())),
  };
  return (tables.workspace_preferences ?? []).map(row => {
    const parsed = openingAdaptivePrefsSchema.safeParse(row.adaptive_planning);
    if (!parsed.success || !Object.values(parsed.data.courseGoals).some(goal => goal.milestones?.length)) return row;
    const prefs = structuredClone(parsed.data);
    for (const goal of Object.values(prefs.courseGoals)) for (const milestone of goal.milestones ?? []) {
      for (const version of [...milestone.history, milestone]) version.evidenceRefs = version.evidenceRefs.filter(ref => included[ref.kind].has(ref.id.toLowerCase()));
    }
    return { ...row, adaptive_planning: prefs };
  });
}
