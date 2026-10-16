import { expect, it } from "vitest";
import { validateBackupCourseMilestones } from "./backup-course-milestones";
const workspace = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", course = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const owner = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const prefs = { autonomy: "copilot", coachBudgetMinutes: 60, courseGoals: { [course]: { targetDate: null, weeklyMinutes: 120, revision: 1,
  milestones: [{ id, title: "Outcome", successCriteria: "Solve a new problem independently", targetDate: null,
    evidenceRefs: [{ kind: "attempt", id }], revision: 1, status: "planned", confirmedAt: null, history: [] }] } } };
function errors(extra: Record<string, unknown> = {}, expectedOwner = owner) {
  const result: string[] = [];
  validateBackupCourseMilestones({ workspace_preferences: [{ workspace_id: workspace, adaptive_planning: prefs }],
    courses: [{ id: course, workspace_id: workspace }],
    opening_learning_attempts: [{ id, workspace_id: workspace, owner_user_id: owner, course_id: course, ...extra }] }, result, expectedOwner);
  return result;
}
it("accepts old preference absence and same-owner course links", () => {
  const result: string[] = [];
  validateBackupCourseMilestones({}, result);
  expect(result).toEqual([]);
  expect(errors()).toEqual([]);
});
it.each([{ id: owner }, { course_id: workspace }, { workspace_id: owner }, { owner_user_id: id }])("rejects foreign or missing milestone records %j", patch => {
  expect(errors(patch)).toContain("course milestone evidence is missing or outside its course and owner");
});

it("removes privacy-filtered current and historical links only in the exported projection", async () => {
  const { projectBackupCourseMilestoneReferences } = await import("./backup-course-milestones");
  const original = { workspace_id: workspace, adaptive_planning: structuredClone(prefs) };
  const result = projectBackupCourseMilestoneReferences({ workspace_preferences: [original] });
  expect(JSON.stringify(result)).not.toContain(`"kind":"attempt","id":"${id}"`);
  expect(original.adaptive_planning.courseGoals[course]!.milestones[0]!.evidenceRefs).toEqual([{ kind: "attempt", id }]);
  const projected = result[0]!.adaptive_planning as typeof prefs;
  expect(projected.courseGoals[course]!.milestones[0]).toMatchObject({ title: "Outcome", revision: 1, evidenceRefs: [] });
});
