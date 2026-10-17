import type { PlanDraft, SuggestedTask } from "@aistudy/contracts";
import { normalizeSkillLabelKey } from "./skill-identity";

/** Full tuple avoids treating a short legacy key hash collision as the learner's preference. */
export function suggestionFeedbackIdentity(suggestion: Pick<SuggestedTask, "kind" | "courseId" | "skillLabel" | "requirementKey">): string {
  return JSON.stringify([suggestion.kind, suggestion.courseId,
    suggestion.skillLabel === null ? null : normalizeSkillLabelKey(suggestion.skillLabel), suggestion.requirementKey ?? null]);
}

/** Read-only projection: preserving the original proposal does not make a declined suggestion selectable. */
export function withOpeningSuggestionFeedback(draft: PlanDraft, suppressedIdentities: readonly string[]): PlanDraft {
  const suppressed = new Set(suppressedIdentities);
  const rejectedSuggestedKeys = (draft.suggestedTasks ?? []).filter(item => suppressed.has(suggestionFeedbackIdentity(item))).map(item => item.key);
  if (!rejectedSuggestedKeys.length && !draft.rejectedSuggestedKeys?.length) return draft;
  return { ...draft, rejectedSuggestedKeys };
}
