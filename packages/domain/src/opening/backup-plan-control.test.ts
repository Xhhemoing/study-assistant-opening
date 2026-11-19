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

it("remains compatible with historical ordinary local-replan drafts (deferral notBefore > now, ordinary dueAt, omitted preferences)", () => {
  const ordinaryTask = {
    id: taskId,
    version: 2,
    title: "普通任务",
    minutes: 30,
    dueAt: null,
    priority: 1,
    status: "pending" as const,
    notBefore: "2026-10-16T19:10:00.000Z",
  };
  const futureBlock = {
    taskId,
    start: "2026-10-16T19:15:00.000Z",
    end: "2026-10-16T19:45:00.000Z",
    reason: "已确认",
  };
  const deferredDraft = {
    id: draftId,
    workspace_id: workspace,
    owner_user_id: owner,
    day: "2026-10-16",
    origin: "user",
    base_version: 1,
    strategy_version: "local-replan-v1",
    input_snapshot: {
      tasks: [ordinaryTask],
      localReplan: {
        kind: "local_replan_v1",
        baseAcceptedVersion: 1,
        baselineBlocks: [futureBlock],
        fixedBlocks: [],
        releasedTaskVersions: [{ id: taskId, version: 2, status: "pending" }],
        proposedAt: "2026-10-16T19:00:00.000Z",
        preserveAll: false,
      },
    },
  };
  expect(validate({ opening_plan_drafts: [deferredDraft] })).toEqual([]);

  const dueTask = {
    id: taskId,
    version: 1,
    title: "历史截止普通任务",
    minutes: 30,
    dueAt: "2026-10-16T19:30:00.000Z",
    priority: 1,
    status: "pending" as const,
  };
  const historicalDueDraft = {
    ...deferredDraft,
    input_snapshot: {
      tasks: [dueTask],
      localReplan: {
        kind: "local_replan_v1",
        baseAcceptedVersion: 1,
        baselineBlocks: [futureBlock],
        fixedBlocks: [futureBlock],
        releasedTaskVersions: [],
        proposedAt: "2026-10-16T19:00:00.000Z",
        preserveAll: false,
      },
    },
  };
  expect(validate({ opening_plan_drafts: [historicalDueDraft] })).toEqual([]);
});

it("validates local-replan drafts releasing unstarted inactive retests and rejects forged inactiveRetestTaskIds", () => {
  const retestBlock = {
    taskId,
    start: "2026-10-16T19:15:00.000Z",
    end: "2026-10-16T19:40:00.000Z",
    reason: "延迟复测",
  };
  const retestTask = {
    id: taskId,
    version: 1,
    title: "延迟复测",
    minutes: 25,
    dueAt: "2026-10-26T19:00:00.000Z",
    notBefore: "2026-10-15T19:00:00.000Z",
    priority: 1,
    status: "pending" as const,
    retest: {
      candidateId: "11111111-1111-4111-8111-111111111111",
      activityId: "22222222-2222-4222-8222-222222222222",
      courseId: "33333333-3333-4333-8333-333333333333",
      skillLabel: "矩阵秩",
      prompt: "延迟复测",
      recommendedAt: "2026-10-15T19:00:00.000Z",
      scheduledStartAt: "2026-10-16T19:15:00.000Z",
    },
  };
  const makeDraft = (preserveAll: boolean) => ({
    id: draftId,
    workspace_id: workspace,
    owner_user_id: owner,
    day: "2026-10-16",
    origin: "user",
    base_version: 1,
    strategy_version: "local-replan-v1",
    input_snapshot: {
      tasks: [retestTask],
      inactiveRetestTaskIds: [taskId],
      localReplan: {
        kind: "local_replan_v1",
        baseAcceptedVersion: 1,
        baselineBlocks: [retestBlock],
        fixedBlocks: [],
        releasedTaskVersions: [{ id: taskId, version: 1, status: "pending" }],
        proposedAt: "2026-10-16T19:00:00.000Z",
        preserveAll,
      },
    },
  });
  const cancelledActivity = {
    id: "22222222-2222-4222-8222-222222222222",
    workspace_id: workspace,
    owner_user_id: owner,
    task_id: taskId,
    status: "cancelled",
  };
  const preferences = {
    workspace_id: workspace,
    planning_settings: {
      weekOneMonday: "2026-09-07",
      periodTimes: {},
      dailyWindow: { start: "19:00", end: "21:00" },
      lunch: { start: "12:00", end: "13:00" },
      dinner: { start: "18:00", end: "19:00" },
      sleep: { start: "23:00", end: "07:00" },
      timeZone: "UTC",
    },
  };

  for (const preserveAll of [false, true]) {
    expect(validate({
      opening_plan_drafts: [makeDraft(preserveAll)],
      opening_retest_activities: [cancelledActivity],
      workspace_preferences: [preferences],
    })).toEqual([]);
  }

  // Active retest or missing retest activity cannot be claimed as inactive in an archive.
  expect(validate({
    opening_plan_drafts: [makeDraft(true)],
    opening_retest_activities: [{ ...cancelledActivity, status: "accepted" }],
    workspace_preferences: [preferences],
  })).toContain("local replan preserved baseline is invalid");
  expect(validate({
    opening_plan_drafts: [makeDraft(false)],
    opening_retest_activities: [],
    workspace_preferences: [preferences],
  })).toContain("local replan preserved baseline is invalid");
});
