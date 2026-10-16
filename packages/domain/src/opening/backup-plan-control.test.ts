import { expect, it } from "vitest";
import { validateBackupPlanControl } from "./backup-plan-control";
import { suggestionFeedbackIdentity } from "./adaptive/suggestion-feedback";
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", workspace = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", draftId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", taskId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const suggestion = { id: taskId, key: "planner-suggestion", kind: "course_pace" as const, title: "Plan", minutes: 20,
  courseId: null, skillLabel: null, requirementKey: null, reasonCode: "course_pace" as const, reason: "Progress" };
const draft = { id: draftId, workspace_id: workspace, owner_user_id: owner, day: "2026-10-16", origin: "auto_draft", base_version: 0, suggested_tasks: [suggestion] };
const event = { id: taskId, workspace_id: workspace, owner_user_id: owner, draft_id: draftId, day: "2026-10-16", suggestion_key: suggestion.key,
  identity: suggestionFeedbackIdentity(suggestion), suggestion_kind: suggestion.kind, course_id: null, requirement_key: null, reason: "time_short", recorded_at: "2026-10-16T10:00:00Z",
  client_key: "feedback-client", intent: { draftId, expectedDraftVersion: 0, suggestionKey: suggestion.key, reason: "time_short" } };
function validate(tables: Record<string, Record<string, unknown>[]>) { const errors: string[] = []; validateBackupPlanControl(tables, errors); return errors; }
it("accepts absent legacy events and a complete owned suggestion relation", () => {
  expect(validate({})).toEqual([]);
  expect(validate({ opening_plan_drafts: [draft], opening_suggestion_feedback: [event] })).toEqual([]);
});
it.each([{ owner_user_id: workspace }, { draft_id: taskId }, { identity: "a forged label" }, { suggestion_key: "other-key" }, { reason: "too_hard" }])("rejects a forged suggestion relation %j", patch => {
  expect(validate({ opening_plan_drafts: [draft], opening_suggestion_feedback: [{ ...event, ...patch }] })).not.toEqual([]);
});
it("refuses to turn an existing manual task into a coach-created task through an archive", () => {
  const receipt = { workspace_id: workspace, draft_id: draftId, source: "coach", before_blocks: [], created_task_versions: { [taskId]: 1 } };
  const task = { id: taskId, workspace_id: workspace, owner_user_id: owner, version: 1, origin: "manual", client_key: null, course_id: null, requirement_key: null };
  expect(validate({ opening_plan_drafts: [draft], opening_tasks: [task], opening_plan_acceptances: [receipt] })).toContain("plan acceptance created tasks are invalid");
  expect(validate({ opening_plan_drafts: [draft], opening_tasks: [{ ...task, origin: "planner", client_key: suggestion.key }], opening_plan_acceptances: [receipt] })).toEqual([]);
});
