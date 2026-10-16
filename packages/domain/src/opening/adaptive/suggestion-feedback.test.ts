import { expect, it } from "vitest";
import type { LearnerSnapshot } from "./types";
import { proposeAdaptiveTasks } from "./propose-tasks";
import { suggestionFeedbackIdentity, withOpeningSuggestionFeedback } from "./suggestion-feedback";
const courseId = "00000000-0000-4000-8000-000000000001";
const item = { id: courseId, key: "stable-key", kind: "weak_skill" as const, courseId, skillLabel: "Linear Algebra",
  requirementKey: "prove", title: "Practice", minutes: 25, reasonCode: "weak_skill" as const, reason: "Review" };

it("normalizes display aliases while keeping requirement, course and kind scope independent", () => {
  const identity = suggestionFeedbackIdentity(item);
  expect(identity).toBe(suggestionFeedbackIdentity({ ...item, skillLabel: " ｌｉｎｅａｒalgebra " }));
  for (const change of [{ requirementKey: "calculate" }, { requirementKey: null }, { courseId: null }, { kind: "new_skill" }] as const) {
    expect(suggestionFeedbackIdentity({ ...item, ...change })).not.toBe(identity);
  }
});

it("preserves the stored draft and projects rejected keys without turning them into skipped tasks", () => {
  const draft = { id: courseId, date: "2026-10-16", version: 0, baseVersion: 0, status: "draft" as const,
    blocks: [], unscheduledTaskIds: [], suggestedTasks: [item] };
  const result = withOpeningSuggestionFeedback(draft, [suggestionFeedbackIdentity(item)]);
  expect(result.rejectedSuggestedKeys).toEqual([item.key]);
  expect(result.suggestedTasks).toEqual([item]);
  expect(draft).not.toHaveProperty("rejectedSuggestedKeys");
  expect(withOpeningSuggestionFeedback(draft, [])).toBe(draft);
});

it("suppresses an explicit identity before the daily suggestion budget, preserving other requirements", () => {
  const snapshot: LearnerSnapshot = { date: "2026-10-16", timeZone: "Etc/UTC", dueCardCount: 0, plannerHistory: [],
    courses: [{ courseId, title: "Math", goal: null, minutesThisWeek: 0, nextSkills: [], hasUsableMaterials: true,
      skills: ["prove", "calculate"].map(requirementKey => ({ skillLabel: "ｌｉｎｅａｒalgebra", requirementKey,
        status: "needs_review", lastObservedAt: null, recentAssistance: [] })) }] };
  const options = { autonomy: "copilot" as const, capacityMinutes: 180, committedMinutes: 0, pendingTasks: [], idFor: (key: string) => key };
  expect(proposeAdaptiveTasks(snapshot, { ...options, suppressedSuggestionIdentities: [suggestionFeedbackIdentity(item)] })
    .suggestions.map(s => s.requirementKey)).toEqual(["calculate"]);
  expect(proposeAdaptiveTasks({ ...snapshot, date: "2026-10-17" }, { ...options, suppressedSuggestionIdentities: [] }).suggestions).toHaveLength(2);
});
