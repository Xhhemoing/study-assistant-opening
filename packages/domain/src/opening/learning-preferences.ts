import type { CourseLearningPreferencesUpdate, LearningPreferences } from "@aistudy/contracts";

export function resolveLearningPreferences(
  account: LearningPreferences,
  course: CourseLearningPreferencesUpdate,
  archived: boolean,
): LearningPreferences {
  const assessmentEnabled = !archived && account.assessmentEnabled && course.assessmentEnabled !== false;
  return {
    assessmentEnabled,
    retestSuggestionsEnabled: assessmentEnabled && account.retestSuggestionsEnabled && course.retestSuggestionsEnabled !== false,
    automaticRemindersEnabled: assessmentEnabled && account.automaticRemindersEnabled && course.automaticRemindersEnabled !== false,
  };
}
