import type { CourseLearningPreferencesUpdate, LearningPreferences } from "@aistudy/contracts";
import type { CourseSummary } from "./course-model";

export function courseRestrictionDraft(overrides: CourseLearningPreferencesUpdate = {}): LearningPreferences {
  return {
    assessmentEnabled: overrides.assessmentEnabled !== false,
    retestSuggestionsEnabled: overrides.retestSuggestionsEnabled !== false,
    automaticRemindersEnabled: overrides.automaticRemindersEnabled !== false,
  };
}

export function courseRestrictionUpdate(draft: LearningPreferences): CourseLearningPreferencesUpdate {
  return Object.fromEntries(Object.entries(draft).filter(([, enabled]) => !enabled));
}

export function filterCourses(courses: CourseSummary[], query: string, state: "active" | "archived"): CourseSummary[] {
  const needle = query.trim().toLocaleLowerCase();
  return courses.filter((course) => Boolean(course.archivedAt) === (state === "archived")
    && `${course.title} ${course.description}`.toLocaleLowerCase().includes(needle));
}
