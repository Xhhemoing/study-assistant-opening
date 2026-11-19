import { expect, it } from "vitest";
import { validateBackupPlanControl } from "./backup-plan-control";
import { OPENING_RESTORE_APPLY_ORDER, planOpeningRestoreApply } from "./backup-apply-plan";
import type { OpeningBackup } from "./backup-policy";
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

function makeBackup(overrides: Partial<Record<string, Record<string, unknown>[]>>): OpeningBackup {
  return {
    format: "opening-backup",
    version: 1,
    workspaceId: workspace,
    privacyEpoch: 4,
    deletionJournal: [],
    tables: Object.fromEntries(
      OPENING_RESTORE_APPLY_ORDER.map((table) => [table, overrides[table] ?? []]),
    ),
    objects: [],
  };
}

function makePreferencesRow(timeZone: string): Record<string, unknown> {
  return {
    workspace_id: workspace,
    assessment_enabled: true,
    retest_suggestions_enabled: true,
    automatic_reminders_enabled: false,
    retest_suggestions_enabled_at: null,
    automatic_reminders_enabled_at: null,
    planning_settings: {
      weekOneMonday: "2026-09-07",
      periodTimes: {},
      dailyWindow: { start: "19:00", end: "21:00" },
      lunch: { start: "12:00", end: "13:00" },
      dinner: { start: "18:00", end: "19:00" },
      sleep: { start: "23:00", end: "07:00" },
      timeZone,
    },
  };
}

const emptyLearningState = { workspacePreferences: null, courses: [] } as const;

it("accepts a pre-PR#449 legacy preserveAll local-replan draft preserving deferred/inactive retest blocks through planOpeningRestoreApply", () => {
  const courseId = "33333333-3333-4333-8333-333333333333";
  const inactiveTaskId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const deferredBlock = {
    taskId,
    start: "2026-10-16T19:15:00.000Z",
    end: "2026-10-16T19:40:00.000Z",
    reason: "延迟复测",
  };
  const inactiveBlock = {
    taskId: inactiveTaskId,
    start: "2026-10-16T19:45:00.000Z",
    end: "2026-10-16T20:10:00.000Z",
    reason: "历史已取消复测",
  };
  const deferredRetestTask = {
    id: taskId,
    version: 2,
    title: "已延期历史复测",
    minutes: 25,
    dueAt: "2026-10-26T19:00:00.000Z",
    notBefore: "2026-10-16T20:00:00.000Z",
    priority: 1,
    status: "pending" as const,
    retest: {
      candidateId: "11111111-1111-4111-8111-111111111111",
      activityId: "22222222-2222-4222-8222-222222222222",
      courseId,
      skillLabel: "矩阵秩",
      prompt: "延迟复测",
      recommendedAt: "2026-10-15T19:00:00.000Z",
    },
  };
  const inactiveRetestTask = {
    id: inactiveTaskId,
    version: 1,
    title: "非活跃历史复测",
    minutes: 25,
    dueAt: "2026-10-26T19:00:00.000Z",
    notBefore: "2026-10-15T19:00:00.000Z",
    priority: 1,
    status: "pending" as const,
    retest: {
      candidateId: "44444444-4444-4444-8444-444444444444",
      activityId: "55555555-5555-4555-8555-555555555555",
      courseId,
      skillLabel: "特征值",
      prompt: "延迟复测",
      recommendedAt: "2026-10-15T19:00:00.000Z",
    },
  };
  const legacyDraft = {
    id: draftId,
    workspace_id: workspace,
    owner_user_id: owner,
    day: "2026-10-16",
    origin: "user",
    base_version: 1,
    strategy_version: "local-replan-v1",
    input_snapshot: {
      tasks: [deferredRetestTask, inactiveRetestTask],
      localReplan: {
        kind: "local_replan_v1",
        baseAcceptedVersion: 1,
        baselineBlocks: [deferredBlock, inactiveBlock],
        fixedBlocks: [deferredBlock, inactiveBlock],
        releasedTaskVersions: [],
        proposedAt: "2026-10-16T19:00:00.000Z",
        preserveAll: true,
      },
    },
  };
  const archive = makeBackup({
    opening_tasks: [
      { id: taskId, workspace_id: workspace, owner_user_id: owner, version: 2, origin: "retest", course_id: courseId },
      { id: inactiveTaskId, workspace_id: workspace, owner_user_id: owner, version: 1, origin: "retest", course_id: courseId },
    ],
    opening_plan_drafts: [legacyDraft],
    opening_retest_activities: [
      {
        id: "22222222-2222-4222-8222-222222222222",
        workspace_id: workspace,
        owner_user_id: owner,
        course_id: courseId,
        candidate_id: null,
        task_id: taskId,
        reopened_from_activity_id: null,
        status: "accepted",
      },
      {
        id: "55555555-5555-4555-8555-555555555555",
        workspace_id: workspace,
        owner_user_id: owner,
        course_id: courseId,
        candidate_id: null,
        task_id: inactiveTaskId,
        reopened_from_activity_id: null,
        status: "cancelled",
      },
    ],
    workspace_preferences: [makePreferencesRow("UTC")],
  });

  const plan = planOpeningRestoreApply(archive, [], {
    confirmLocalRestore: true,
    availableCourseIds: [courseId],
    currentLearningState: emptyLearningState,
  });
  expect(plan).toEqual({ ok: true, plan: expect.any(Object) });

  // Forging a legacy preserveAll draft that drops a baseline block is still rejected.
  const forged = makeBackup({
    ...archive.tables,
    opening_plan_drafts: [{
      ...legacyDraft,
      input_snapshot: {
        ...legacyDraft.input_snapshot,
        localReplan: {
          ...legacyDraft.input_snapshot.localReplan,
          fixedBlocks: [],
        },
      },
    }],
  });
  expect(planOpeningRestoreApply(forged, [], {
    confirmLocalRestore: true,
    availableCourseIds: [courseId],
    currentLearningState: emptyLearningState,
  })).toMatchObject({
    ok: false,
    code: "PREFLIGHT_REJECTED",
    errors: ["local replan preserved baseline is invalid"],
  });
});

it("accepts a confirmed UTC Friday 19:15 retest draft through planOpeningRestoreApply after workspace timeZone switches to Asia/Shanghai", () => {
  const courseId = "33333333-3333-4333-8333-333333333333";
  const retestBlock = {
    taskId,
    start: "2026-10-16T19:15:00.000Z",
    end: "2026-10-16T19:40:00.000Z",
    reason: "延迟复测预约",
  };
  const retestTask = {
    id: taskId,
    version: 1,
    title: "周五 UTC 延迟复测",
    minutes: 25,
    dueAt: "2026-10-26T19:00:00.000Z",
    notBefore: "2026-10-15T19:00:00.000Z",
    priority: 1,
    status: "pending" as const,
    retest: {
      candidateId: "11111111-1111-4111-8111-111111111111",
      activityId: "22222222-2222-4222-8222-222222222222",
      courseId,
      skillLabel: "矩阵秩",
      prompt: "延迟复测",
      recommendedAt: "2026-10-15T19:00:00.000Z",
      scheduledStartAt: "2026-10-16T19:15:00.000Z",
    },
  };
  const makeDraft = (snapshotTimeZone: unknown) => ({
    id: draftId,
    workspace_id: workspace,
    owner_user_id: owner,
    day: "2026-10-16",
    origin: "user",
    base_version: 1,
    status: "accepted",
    strategy_version: "local-replan-v1",
    input_snapshot: {
      tasks: [retestTask],
      timeZone: snapshotTimeZone,
      localReplan: {
        kind: "local_replan_v1",
        baseAcceptedVersion: 1,
        baselineBlocks: [retestBlock],
        fixedBlocks: [retestBlock],
        releasedTaskVersions: [],
        proposedAt: "2026-10-16T19:00:00.000Z",
        preserveAll: false,
      },
    },
  });
  const shanghaiPreferences = [makePreferencesRow("Asia/Shanghai")];
  const retestTaskRows = [{
    id: taskId,
    workspace_id: workspace,
    owner_user_id: owner,
    version: 1,
    origin: "retest",
    course_id: courseId,
  }];
  const activeRetestActivity = [{
    id: "22222222-2222-4222-8222-222222222222",
    workspace_id: workspace,
    owner_user_id: owner,
    course_id: courseId,
    candidate_id: null,
    task_id: taskId,
    reopened_from_activity_id: null,
    status: "accepted",
  }];

  const archive = makeBackup({
    opening_tasks: retestTaskRows,
    opening_plan_drafts: [makeDraft("UTC")],
    opening_retest_activities: activeRetestActivity,
    workspace_preferences: shanghaiPreferences,
  });
  expect(planOpeningRestoreApply(archive, [], {
    confirmLocalRestore: true,
    availableCourseIds: [courseId],
    currentLearningState: emptyLearningState,
  })).toEqual({ ok: true, plan: expect.any(Object) });

  // A new-head draft claiming Asia/Shanghai for the same UTC 19:15 (Saturday CST) block MUST still be rejected.
  const wrongZoneArchive = makeBackup({
    opening_tasks: retestTaskRows,
    opening_plan_drafts: [makeDraft("Asia/Shanghai")],
    opening_retest_activities: activeRetestActivity,
    workspace_preferences: shanghaiPreferences,
  });
  expect(planOpeningRestoreApply(wrongZoneArchive, [], {
    confirmLocalRestore: true,
    availableCourseIds: [courseId],
    currentLearningState: emptyLearningState,
  })).toMatchObject({
    ok: false,
    code: "PREFLIGHT_REJECTED",
    errors: ["local replan preserved baseline is invalid"],
  });

  // Invalid snapshot timeZone is rejected as an invalid snapshot.
  const invalidZoneArchive = makeBackup({
    opening_tasks: retestTaskRows,
    opening_plan_drafts: [makeDraft("Invalid/Zone")],
    opening_retest_activities: activeRetestActivity,
    workspace_preferences: shanghaiPreferences,
  });
  expect(planOpeningRestoreApply(invalidZoneArchive, [], {
    confirmLocalRestore: true,
    availableCourseIds: [courseId],
    currentLearningState: emptyLearningState,
  })).toMatchObject({
    ok: false,
    code: "PREFLIGHT_REJECTED",
    errors: ["local replan snapshot is invalid"],
  });
});
