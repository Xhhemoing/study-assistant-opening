import { describe, expect, it, vi } from "vitest";
import type { Sql, TransactionSql } from "postgres";
import type { Scope, TimeBlock } from "@aistudy/contracts";
import { planDay } from "@aistudy/domain";
import { acceptOpeningPlan } from "./opening-plan-accept";
import { validateOpeningLocalReplan } from "./opening-local-replan-validation";
import { createOpeningPlansRepository } from "./opening-plans";
import {
  effectivePlanningStartFloorMs,
  isBlockAllowedForTaskWindow,
  projectCourseRoutePlanningWindow,
} from "./opening-course-route-planning-window";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const SCOPE: Scope = {
  workspaceId: id(1),
  ownerUserId: id(2),
};

const COURSE_ID = id(10);
const TASK_ID = id(11);
const CANDIDATE_ID = id(12);
const ACTIVITY_ID = id(13);
const GOAL_ID = id(14);
const REQUIREMENT_ID = id(15);
const ORIGIN_ACTIVITY_ID = id(16);
const BASELINE_OBS_ID = id(17);
const BASELINE_ROOT_ID = id(18);

// Baseline Monday 2026-10-12 19:00 UTC:
// +72h earliest start = Thursday 2026-10-15 19:00 UTC
// +14d hard deadline  = Monday   2026-10-26 19:00 UTC
const EARLIEST_AT = "2026-10-15T19:00:00.000Z";
const DEADLINE_14D = "2026-10-26T19:00:00.000Z";
const FRIDAY_SLOT_START = "2026-10-16T19:15:00.000Z";
const FRIDAY_SLOT_END = "2026-10-16T19:40:00.000Z";
const FRIDAY_1930 = "2026-10-16T19:30:00.000Z";
const ACCEPT_KEY = "course-route-retest:key-1";
const PAYLOAD_HASH = "sha256-retest-payload-hash";

function makeCourseRouteRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TASK_ID,
    workspace_id: SCOPE.workspaceId,
    owner_user_id: SCOPE.ownerUserId,
    version: 1,
    title: "矩阵秩：3天后离开原答案独立完成新题，按已确认的课程要求核对。",
    minutes: 25,
    due_at: DEADLINE_14D,
    not_before: EARLIEST_AT,
    priority: 1,
    status: "pending",
    origin: "retest",
    course_id: COURSE_ID,
    skill_label: "矩阵秩",
    requirement_key: "rank-proof",
    candidate_id: CANDIDATE_ID,
    retest_activity_id: ACTIVITY_ID,
    retest_workspace_id: SCOPE.workspaceId,
    retest_owner_user_id: SCOPE.ownerUserId,
    retest_task_id: TASK_ID,
    retest_course_id: COURSE_ID,
    retest_purpose: "retest",
    retest_status: "accepted",
    retest_candidate_id: CANDIDATE_ID,
    retest_candidate_reference_id: CANDIDATE_ID,
    retest_accept_client_key: ACCEPT_KEY,
    retest_skill_label: "矩阵秩",
    retest_requirement_key: "rank-proof",
    retest_prompt: "矩阵秩：3天后离开原答案独立完成新题，按已确认的课程要求核对。",
    retest_learning_protocol: {
      protocolId: "course-route-delayed-v1",
      goalId: GOAL_ID,
      goalRevision: 1,
      requirementId: REQUIREMENT_ID,
      requirementRevision: 1,
      stableSkillId: id(19),
      baselineObservationId: BASELINE_OBS_ID,
      baselineRootId: BASELINE_ROOT_ID,
      originActivityId: ORIGIN_ACTIVITY_ID,
      minutes: 25,
    },
    retest_not_before_at: EARLIEST_AT,
    retest_recommended_at: EARLIEST_AT,
    retest_scheduled_start_at: null,
    retest_snoozed_until: null,
    retest_deadline_at: DEADLINE_14D,
    retest_job_id: CANDIDATE_ID,
    retest_job_workspace_id: SCOPE.workspaceId,
    retest_job_owner_user_id: SCOPE.ownerUserId,
    retest_job_kind: "retest",
    retest_job_payload: {
      id: CANDIDATE_ID,
      courseId: COURSE_ID,
      skillLabel: "矩阵秩",
      requirementKey: "rank-proof",
      prompt: "矩阵秩：3天后离开原答案独立完成新题，按已确认的课程要求核对。",
      sourceIds: [id(30)],
      dueAt: EARLIEST_AT,
      accepted: true,
      kind: "task",
      evidenceObservationIds: [BASELINE_OBS_ID],
      evidenceRootIds: [BASELINE_ROOT_ID],
      acceptClientKey: ACCEPT_KEY,
      acceptPayloadHash: PAYLOAD_HASH,
      taskId: TASK_ID,
    },
    retest_job_result: {
      accepted: true,
      clientKey: ACCEPT_KEY,
      payloadHash: PAYLOAD_HASH,
      taskId: TASK_ID,
      baseVersion: 0,
      inputSnapshot: {
        kind: "retest",
        candidateId: CANDIDATE_ID,
        courseId: COURSE_ID,
        skillLabel: "矩阵秩",
        prompt: "矩阵秩：3天后离开原答案独立完成新题，按已确认的课程要求核对。",
        sourceIds: [id(30)],
        dueAt: EARLIEST_AT,
        heuristic: true,
      },
      scheduled: false,
    },
    ...overrides,
  };
}

describe("projectCourseRoutePlanningWindow", () => {
  it("passes ordinary tasks and non-course-route retests through unchanged", () => {
    const ordinary = projectCourseRoutePlanningWindow({
      id: TASK_ID,
      due_at: FRIDAY_1930,
      not_before: EARLIEST_AT,
    }, SCOPE);
    expect(ordinary).toEqual({
      isCourseRouteRetest: false,
      hasRetestActivity: false,
      retestStatus: null,
      retestActive: true,
      legacyMiswrittenDueAt: false,
      dueAt: FRIDAY_1930,
      notBefore: EARLIEST_AT,
      recommendedAt: null,
      scheduledStartAt: null,
      deadlineAt: null,
    });

    const otherRetest = projectCourseRoutePlanningWindow(
      makeCourseRouteRow({
        due_at: EARLIEST_AT,
        retest_learning_protocol: null,
        retest_scheduled_start_at: FRIDAY_SLOT_START,
      }),
      SCOPE,
    );
    expect(otherRetest.isCourseRouteRetest).toBe(false);
    expect(otherRetest.hasRetestActivity).toBe(true);
    expect(otherRetest.legacyMiswrittenDueAt).toBe(false);
    expect(otherRetest.dueAt).toBe(EARLIEST_AT);
    expect(otherRetest.recommendedAt).toBe(EARLIEST_AT);
    expect(otherRetest.scheduledStartAt).toBe(FRIDAY_SLOT_START);
  });

  it("projects newly written course-route delayed retests with real 14-day dueAt and 72h notBefore", () => {
    const projected = projectCourseRoutePlanningWindow(makeCourseRouteRow(), SCOPE);
    expect(projected).toMatchObject({
      isCourseRouteRetest: true,
      retestActive: true,
      legacyMiswrittenDueAt: false,
      dueAt: DEADLINE_14D,
      notBefore: EARLIEST_AT,
      recommendedAt: EARLIEST_AT,
      scheduledStartAt: null,
      deadlineAt: DEADLINE_14D,
    });
  });

  it("recovers proven legacy miswritten due_at === 72h even after mutable task.not_before changes", () => {
    const legacyUntouched = projectCourseRoutePlanningWindow(
      makeCourseRouteRow({ due_at: EARLIEST_AT }),
      SCOPE,
    );
    expect(legacyUntouched.legacyMiswrittenDueAt).toBe(true);
    expect(legacyUntouched.dueAt).toBe(DEADLINE_14D);
    expect(legacyUntouched.notBefore).toBe(EARLIEST_AT);

    // Deferring the task mutates task.not_before so task.not_before !== task.due_at.
    // Proof relies on the immutable opening_jobs candidate receipt, not mutable equality.
    const deferredTime = "2026-10-16T10:00:00.000Z";
    const legacyDeferred = projectCourseRoutePlanningWindow(
      makeCourseRouteRow({ due_at: EARLIEST_AT, not_before: deferredTime }),
      SCOPE,
    );
    expect(legacyDeferred.legacyMiswrittenDueAt).toBe(true);
    expect(legacyDeferred.dueAt).toBe(DEADLINE_14D);
    expect(legacyDeferred.notBefore).toBe(deferredTime);

    const legacyClearedNotBefore = projectCourseRoutePlanningWindow(
      makeCourseRouteRow({ due_at: EARLIEST_AT, not_before: null }),
      SCOPE,
    );
    expect(legacyClearedNotBefore.legacyMiswrittenDueAt).toBe(true);
    expect(legacyClearedNotBefore.dueAt).toBe(DEADLINE_14D);
    expect(legacyClearedNotBefore.notBefore).toBe(EARLIEST_AT);
  });

  it("conservatively preserves task.due_at whenever legacy miswrite cannot be proven", () => {
    const baseLegacy = makeCourseRouteRow({ due_at: EARLIEST_AT });
    const unprovableCases: Array<[string, Record<string, unknown>]> = [
      ["missing opening_jobs receipt", { retest_job_id: null, retest_job_payload: null, retest_job_result: null }],
      ["mismatched acceptClientKey", { retest_accept_client_key: "other-key" }],
      ["mismatched payloadHash", {
        retest_job_result: { ...(baseLegacy.retest_job_result as Record<string, unknown>), payloadHash: "other-hash" },
      }],
      ["mismatched snapshot dueAt", {
        retest_job_result: {
          ...(baseLegacy.retest_job_result as Record<string, unknown>),
          inputSnapshot: {
            ...((baseLegacy.retest_job_result as Record<string, unknown>).inputSnapshot as Record<string, unknown>),
            dueAt: FRIDAY_1930,
          },
        },
      }],
      ["mismatched evidenceObservationIds", {
        retest_job_payload: { ...(baseLegacy.retest_job_payload as Record<string, unknown>), evidenceObservationIds: [id(99)] },
      }],
      ["non-retest origin", { origin: "manual" }],
      ["missing deadline_at (never clear dueAt to null)", { retest_deadline_at: null }],
      ["mutable task.not_before === task.due_at with non-72h deadline", {
        due_at: FRIDAY_1930,
        not_before: FRIDAY_1930,
      }],
    ];

    for (const [label, patch] of unprovableCases) {
      const projected = projectCourseRoutePlanningWindow({ ...baseLegacy, ...patch }, SCOPE);
      expect(projected.legacyMiswrittenDueAt, label).toBe(false);
      expect(projected.dueAt, label).toBe(patch.due_at ?? EARLIEST_AT);
    }
  });

  it("honors any earlier confirmed deadline on either task.due_at or retest.deadline_at", () => {
    const earlierTaskDue = projectCourseRoutePlanningWindow(
      makeCourseRouteRow({ due_at: FRIDAY_1930, retest_deadline_at: DEADLINE_14D }),
      SCOPE,
    );
    expect(earlierTaskDue.legacyMiswrittenDueAt).toBe(false);
    expect(earlierTaskDue.dueAt).toBe(FRIDAY_1930);

    const narrowedRetestDeadline = projectCourseRoutePlanningWindow(
      makeCourseRouteRow({ due_at: DEADLINE_14D, retest_deadline_at: FRIDAY_1930 }),
      SCOPE,
    );
    expect(narrowedRetestDeadline.dueAt).toBe(FRIDAY_1930);

    const legacyWithNarrowedDeadline = projectCourseRoutePlanningWindow(
      makeCourseRouteRow({ due_at: EARLIEST_AT, retest_deadline_at: FRIDAY_1930 }),
      SCOPE,
    );
    expect(legacyWithNarrowedDeadline.legacyMiswrittenDueAt).toBe(true);
    expect(legacyWithNarrowedDeadline.dueAt).toBe(FRIDAY_1930);
  });

  it("keeps notBefore as earliest-start/deferral floor without projecting scheduledStartAt while computing effectivePlanningStartFloorMs accurately", () => {
    const snoozed = "2026-10-16T12:00:00.000Z";
    const reserved = "2026-10-16T18:00:00.000Z";

    const withSnoozeAndReservation = projectCourseRoutePlanningWindow(
      makeCourseRouteRow({
        retest_snoozed_until: snoozed,
        retest_scheduled_start_at: reserved,
      }),
      SCOPE,
    );
    expect(withSnoozeAndReservation.notBefore).toBe(snoozed);
    expect(withSnoozeAndReservation.recommendedAt).toBe(EARLIEST_AT);
    expect(withSnoozeAndReservation.scheduledStartAt).toBe(reserved);
    expect(effectivePlanningStartFloorMs(withSnoozeAndReservation)).toBe(Date.parse(reserved));

    // When explicit scheduledStartAt is earlier than recommendedAt, scheduledStartAt replaces
    // recommendedAt as the target while retest_not_before_at still enforces the 72h floor
    // and notBefore stays at the 72h earliest-start floor rather than copying scheduledStartAt.
    const earlierRecommended = "2026-10-17T19:00:00.000Z";
    const earlierReservation = "2026-10-16T09:00:00.000Z";
    const movedEarlier = projectCourseRoutePlanningWindow(
      makeCourseRouteRow({
        retest_recommended_at: earlierRecommended,
        retest_scheduled_start_at: earlierReservation,
      }),
      SCOPE,
    );
    expect(movedEarlier.notBefore).toBe(EARLIEST_AT);
    expect(movedEarlier.recommendedAt).toBe(earlierRecommended);
    expect(movedEarlier.scheduledStartAt).toBe(earlierReservation);
    expect(effectivePlanningStartFloorMs(movedEarlier)).toBe(Date.parse(earlierReservation));
  });

  it("tracks retestActive status and rejects cross-scope or mismatched ownership rows", () => {
    for (const activeStatus of ["accepted", "in_progress"]) {
      expect(projectCourseRoutePlanningWindow(makeCourseRouteRow({ retest_status: activeStatus }), SCOPE).retestActive).toBe(true);
    }
    for (const inactiveStatus of ["cancelled", "declined", "invalidated", "superseded", "completed"]) {
      expect(projectCourseRoutePlanningWindow(makeCourseRouteRow({ retest_status: inactiveStatus }), SCOPE).retestActive).toBe(false);
    }

    const wrongOwner = projectCourseRoutePlanningWindow(
      makeCourseRouteRow({ due_at: EARLIEST_AT, retest_owner_user_id: id(999) }),
      SCOPE,
    );
    expect(wrongOwner.isCourseRouteRetest).toBe(false);
    expect(wrongOwner.dueAt).toBe(EARLIEST_AT);

    const wrongCourse = projectCourseRoutePlanningWindow(
      makeCourseRouteRow({ due_at: EARLIEST_AT, retest_course_id: id(998) }),
      SCOPE,
    );
    expect(wrongCourse.isCourseRouteRetest).toBe(false);
    expect(wrongCourse.dueAt).toBe(EARLIEST_AT);
  });

  it("Counterexample 1: listTasks + planDay handles new and legacy-miswritten rows across all three deadline windows", async () => {
    const fridaySlot: TimeBlock[] = [{ start: FRIDAY_SLOT_START, end: FRIDAY_SLOT_END, kind: "free" }];

    for (const [label, row] of [
      ["new format (due_at = +14d)", makeCourseRouteRow({ due_at: DEADLINE_14D })],
      ["legacy miswritten (due_at = +72h)", makeCourseRouteRow({ due_at: EARLIEST_AT })],
    ] as const) {
      // 1) Real 14-day deadline -> full 25m block on Friday 19:15-19:40 UTC.
      const repo14d = createOpeningPlansRepository(vi.fn().mockResolvedValue([row]) as unknown as Sql);
      const tasks14d = await repo14d.listTasks(SCOPE);
      expect(tasks14d[0]?.dueAt, label).toBe(DEADLINE_14D);
      const plan14d = planDay(tasks14d, fridaySlot, { planningNow: "2026-10-16T19:00:00.000Z" });
      expect(plan14d.blocks, label).toEqual([
        expect.objectContaining({ taskId: TASK_ID, start: FRIDAY_SLOT_START, end: FRIDAY_SLOT_END }),
      ]);
      expect(plan14d.unscheduledTaskIds, label).toEqual([]);

      // 2) Confirmed earlier deadline (Friday 19:30) -> no_slot_before_deadline.
      const earlierRow = { ...row, retest_deadline_at: FRIDAY_1930 };
      const repoEarlier = createOpeningPlansRepository(vi.fn().mockResolvedValue([earlierRow]) as unknown as Sql);
      const tasksEarlier = await repoEarlier.listTasks(SCOPE);
      expect(tasksEarlier[0]?.dueAt, label).toBe(FRIDAY_1930);
      const planEarlier = planDay(tasksEarlier, fridaySlot, { planningNow: "2026-10-16T19:00:00.000Z" });
      expect(planEarlier.blocks, label).toEqual([]);
      expect(planEarlier.unscheduled, label).toEqual([{ taskId: TASK_ID, reason: "no_slot_before_deadline" }]);

      // 3) Truly past 14-day hard deadline -> deadline_passed.
      const pastSlot: TimeBlock[] = [{
        start: "2026-10-27T19:15:00.000Z",
        end: "2026-10-27T19:40:00.000Z",
        kind: "free",
      }];
      const planPast = planDay(tasks14d, pastSlot, { planningNow: "2026-10-27T19:00:00.000Z" });
      expect(planPast.blocks, label).toEqual([]);
      expect(planPast.unscheduled, label).toEqual([{ taskId: TASK_ID, reason: "deadline_passed" }]);
    }
  });

  it("validateOpeningLocalReplan accepts proven legacy miswritten retest and rejects post-proposal cancel, snooze, deadline narrowing, or forged end-past-deadline", async () => {
    const day = "2026-10-16";
    const now = new Date("2026-10-16T19:00:00.000Z");
    const legacyRow = makeCourseRouteRow({ due_at: EARLIEST_AT });
    const [projectedTask] = await createOpeningPlansRepository(
      vi.fn().mockResolvedValue([legacyRow]) as unknown as Sql,
    ).listTasks(SCOPE);
    expect(projectedTask?.dueAt).toBe(DEADLINE_14D);

    const blocks = [{
      taskId: TASK_ID,
      start: FRIDAY_SLOT_START,
      end: FRIDAY_SLOT_END,
      reason: "延迟复测",
    }];
    const explicitFree: TimeBlock[] = [{ start: FRIDAY_SLOT_START, end: FRIDAY_SLOT_END, kind: "free" }];
    const draft = {
      id: id(50),
      day,
      origin: "user",
      strategy_version: "local-replan-v1",
      suggested_tasks: [],
      input_snapshot: {
        tasks: [projectedTask],
        localReplan: {
          kind: "local_replan_v1",
          baseAcceptedVersion: 1,
          baselineBlocks: [],
          fixedBlocks: [],
          releasedTaskVersions: [],
          proposedAt: now.toISOString(),
          preserveAll: false,
          explicitFree,
        },
      },
    };
    const makeTx = (row: Record<string, unknown>): TransactionSql => {
      const fn = (parts: TemplateStringsArray) => {
        if (!parts.raw) return {};
        const query = parts.join("?");
        if (query.includes("FROM opening_teaching_activities")) return Promise.resolve([]);
        if (query.includes("FROM opening_tasks")) return Promise.resolve([row]);
        if (query.includes("FROM opening_hard_blocks")) return Promise.resolve([]);
        if (query.includes("FROM opening_timetable_sessions")) return Promise.resolve([]);
        if (query.includes("planning_settings")) {
          return Promise.resolve([{
            planning_settings: {
              weekOneMonday: "2026-09-07",
              periodTimes: {},
              dailyWindow: { start: "19:15", end: "19:40" },
              lunch: { start: "12:00", end: "13:00" },
              dinner: { start: "18:00", end: "19:00" },
              sleep: { start: "23:00", end: "07:00" },
              timeZone: "UTC",
            },
          }]);
        }
        throw new Error(`Unexpected SQL: ${query}`);
      };
      return Object.assign(fn, { json: (v: unknown) => v }) as unknown as TransactionSql;
    };

    const state = { accepted_version: 1, accepted_blocks: [] };
    // Unchanged legacy-miswritten row validates cleanly without false task_changed.
    await expect(validateOpeningLocalReplan(makeTx(legacyRow), SCOPE, {
      day, state, draft, blocks, now,
    })).resolves.toBeUndefined();

    // Post-proposal cancel, snooze, and deadline narrowing all reject with task_changed.
    await expect(validateOpeningLocalReplan(
      makeTx({ ...legacyRow, retest_status: "cancelled" }),
      SCOPE,
      { day, state, draft, blocks, now },
    )).rejects.toMatchObject({ code: "CONFLICT", reason: "task_changed" });

    await expect(validateOpeningLocalReplan(
      makeTx({ ...legacyRow, retest_snoozed_until: "2026-10-17T19:00:00.000Z" }),
      SCOPE,
      { day, state, draft, blocks, now },
    )).rejects.toMatchObject({ code: "CONFLICT", reason: "task_changed" });

    await expect(validateOpeningLocalReplan(
      makeTx({ ...legacyRow, retest_deadline_at: FRIDAY_1930 }),
      SCOPE,
      { day, state, draft, blocks, now },
    )).rejects.toMatchObject({ code: "CONFLICT", reason: "task_changed" });

    // Forged draft with start < 19:30 deadline but end (19:40) > 19:30 deadline is rejected.
    const narrowedRow = makeCourseRouteRow({ due_at: FRIDAY_1930, retest_deadline_at: FRIDAY_1930 });
    const [narrowedTask] = await createOpeningPlansRepository(
      vi.fn().mockResolvedValue([narrowedRow]) as unknown as Sql,
    ).listTasks(SCOPE);
    await expect(validateOpeningLocalReplan(
      makeTx(narrowedRow),
      SCOPE,
      {
        day,
        state,
        draft: { ...draft, input_snapshot: { ...draft.input_snapshot, tasks: [narrowedTask] } },
        blocks,
        now,
      },
    )).rejects.toMatchObject({ code: "CONFLICT", reason: "task_changed" });
  });

  it("acceptOpeningPlan accepts proven legacy miswritten retest and rejects cancel, snooze, narrowing, and end-past-deadline without bumping version", async () => {
    const day = "2026-10-16";
    const now = new Date("2026-10-16T19:00:00.000Z");
    const draftId = id(60);
    const legacyRow = makeCourseRouteRow({ due_at: EARLIEST_AT });
    const [projectedTask] = await createOpeningPlansRepository(
      vi.fn().mockResolvedValue([legacyRow]) as unknown as Sql,
    ).listTasks(SCOPE);
    const blocks = [{
      taskId: TASK_ID,
      start: FRIDAY_SLOT_START,
      end: FRIDAY_SLOT_END,
      reason: "延迟复测",
    }];

    function makeAcceptSql(taskRow: Record<string, unknown>, snapshotTask = projectedTask) {
      let acceptedVersion = 0;
      const draftRow = {
        id: draftId,
        workspace_id: SCOPE.workspaceId,
        owner_user_id: SCOPE.ownerUserId,
        day,
        version: 0,
        base_version: 0,
        status: "draft",
        blocks,
        unscheduled_task_ids: [],
        suggested_tasks: [],
        origin: "user",
        strategy_version: null,
        hard_blocks_fingerprint: "fp",
        input_snapshot: { tasks: [snapshotTask], free: [] },
      };
      const fn = (parts: TemplateStringsArray) => {
        if (!parts.raw) return {};
        const query = parts.join("?");
        if (query.includes("SELECT day FROM opening_plan_drafts")) return Promise.resolve([{ day }]);
        if (query.includes("pg_advisory_xact_lock") || query.includes("opening_workspace_history_revisions")) return Promise.resolve([]);
        if (query.includes("FROM workspaces")) return Promise.resolve([{ id: SCOPE.workspaceId }]);
        if (query.includes("FROM courses")) return Promise.resolve([{ id: COURSE_ID }]);
        if (query.includes("INSERT INTO opening_plan_state")) return Promise.resolve([]);
        if (query.includes("FROM opening_plan_state")) {
          return Promise.resolve([{ accepted_version: acceptedVersion, accepted_blocks: [], hard_blocks_fingerprint: "fp" }]);
        }
        if (query.includes("SELECT * FROM opening_plan_drafts")) return Promise.resolve([draftRow]);
        if (query.includes("FROM opening_plan_drafts") && query.includes("strategy_version")) return Promise.resolve([]);
        if (query.includes("FROM opening_plan_acceptances")) return Promise.resolve([]);
        if (query.includes("FROM opening_hard_blocks") || query.includes("FROM opening_timetable_sessions")) return Promise.resolve([]);
        if (query.includes("FROM opening_teaching_activities")
          || query.includes("FROM opening_retest_activities")
          || query.includes("FROM opening_learning_goals")
          || query.includes("FROM workspace_preferences")) return Promise.resolve([]);
        if (query.includes("FROM opening_tasks")) return Promise.resolve([taskRow]);
        if (query.includes("UPDATE opening_plan_state")) {
          acceptedVersion += 1;
          return Promise.resolve([]);
        }
        if (query.includes("UPDATE opening_plan_drafts")) {
          return Promise.resolve([{ ...draftRow, status: "accepted", version: acceptedVersion }]);
        }
        if (query.includes("INSERT INTO opening_plan_acceptances")) return Promise.resolve([]);
        throw new Error(`Unexpected SQL: ${query}`);
      };
      const sql = Object.assign(fn, {
        json: (v: unknown) => v,
        begin: async (run: (tx: TransactionSql) => unknown) => run(sql as unknown as TransactionSql),
      }) as unknown as Sql;
      return { sql, getAcceptedVersion: () => acceptedVersion };
    }

    const ok = makeAcceptSql(legacyRow);
    const accepted = await acceptOpeningPlan(ok.sql, SCOPE, { draftId, expectedBaseVersion: 0, clientKey: "ok-key" }, now);
    expect(accepted).toMatchObject({ status: "accepted", version: 1 });
    expect(ok.getAcceptedVersion()).toBe(1);

    for (const [label, mutated] of [
      ["cancelled", { ...legacyRow, retest_status: "cancelled" }],
      ["snoozed", { ...legacyRow, retest_snoozed_until: "2026-10-17T19:00:00.000Z" }],
      ["deadline_narrowed", { ...legacyRow, retest_deadline_at: FRIDAY_1930 }],
    ] as const) {
      const ctx = makeAcceptSql(mutated);
      await expect(
        acceptOpeningPlan(ctx.sql, SCOPE, { draftId, expectedBaseVersion: 0, clientKey: `fail-${label}` }, now),
        label,
      ).rejects.toMatchObject({ code: "CONFLICT", reason: "task_changed" });
      expect(ctx.getAcceptedVersion(), label).toBe(0);
    }

    // Forged draft where block starts legally (19:15) but ends past confirmed 19:30 deadline.
    const earlierRow = makeCourseRouteRow({ due_at: FRIDAY_1930, retest_deadline_at: FRIDAY_1930 });
    const [earlierTask] = await createOpeningPlansRepository(
      vi.fn().mockResolvedValue([earlierRow]) as unknown as Sql,
    ).listTasks(SCOPE);
    const forged = makeAcceptSql(earlierRow, earlierTask);
    await expect(
      acceptOpeningPlan(forged.sql, SCOPE, { draftId, expectedBaseVersion: 0, clientKey: "fail-end-past-due" }, now),
    ).rejects.toMatchObject({ code: "CONFLICT", reason: "task_changed" });
    expect(forged.getAcceptedVersion()).toBe(0);
  });

  it("rejects cross-day explicit scheduledStartAt in acceptOpeningPlan and validateOpeningLocalReplan (including Asia/Shanghai boundary)", async () => {
    const friday = "2026-10-16";
    const fridayNow = new Date("2026-10-16T19:00:00.000Z");
    const fridayBlock = {
      taskId: TASK_ID,
      start: FRIDAY_SLOT_START,
      end: FRIDAY_SLOT_END,
      reason: "forged-cross-day",
    };

    const cases = [
      {
        label: "Thursday reservation forged onto Friday (UTC)",
        timeZone: "UTC",
        day: friday,
        now: fridayNow,
        scheduledStartAt: "2026-10-15T19:15:00.000Z",
        block: fridayBlock,
      },
      {
        label: "Saturday reservation forged onto Friday (UTC)",
        timeZone: "UTC",
        day: friday,
        now: fridayNow,
        scheduledStartAt: "2026-10-17T19:15:00.000Z",
        block: fridayBlock,
      },
      {
        label: "2026-10-15T16:30Z (= 2026-10-16 00:30 Asia/Shanghai) forged onto 2026-10-15 in Asia/Shanghai",
        timeZone: "Asia/Shanghai",
        day: "2026-10-15",
        now: new Date("2026-10-15T12:00:00.000Z"),
        scheduledStartAt: "2026-10-15T16:30:00.000Z",
        notBefore: "2026-10-14T19:00:00.000Z",
        block: {
          taskId: TASK_ID,
          start: "2026-10-15T13:00:00.000Z",
          end: "2026-10-15T13:25:00.000Z",
          reason: "forged-shanghai-prev-day",
        },
      },
    ] as const;

    for (const c of cases) {
      const row = makeCourseRouteRow({
        retest_scheduled_start_at: c.scheduledStartAt,
        ...("notBefore" in c ? { not_before: c.notBefore, retest_not_before_at: c.notBefore } : {}),
      });
      const [task] = await createOpeningPlansRepository(
        vi.fn().mockResolvedValue([row]) as unknown as Sql,
      ).listTasks(SCOPE);

      // 1) Ordinary acceptOpeningPlan rejects cross-day forged draft without bumping version.
      let acceptedVersion = 0;
      const draftId = id(70);
      const draftRow = {
        id: draftId,
        workspace_id: SCOPE.workspaceId,
        owner_user_id: SCOPE.ownerUserId,
        day: c.day,
        version: 0,
        base_version: 0,
        status: "draft",
        blocks: [c.block],
        unscheduled_task_ids: [],
        suggested_tasks: [],
        origin: "user",
        strategy_version: null,
        hard_blocks_fingerprint: "fp",
        input_snapshot: { tasks: [task], free: [] },
      };
      const fn = (parts: TemplateStringsArray) => {
        if (!parts.raw) return {};
        const query = parts.join("?");
        if (query.includes("SELECT day FROM opening_plan_drafts")) return Promise.resolve([{ day: c.day }]);
        if (query.includes("pg_advisory_xact_lock") || query.includes("opening_workspace_history_revisions")) return Promise.resolve([]);
        if (query.includes("FROM workspaces")) return Promise.resolve([{ id: SCOPE.workspaceId }]);
        if (query.includes("FROM courses")) return Promise.resolve([{ id: COURSE_ID }]);
        if (query.includes("INSERT INTO opening_plan_state")) return Promise.resolve([]);
        if (query.includes("FROM opening_plan_state")) {
          return Promise.resolve([{ accepted_version: acceptedVersion, accepted_blocks: [], hard_blocks_fingerprint: "fp" }]);
        }
        if (query.includes("SELECT * FROM opening_plan_drafts")) return Promise.resolve([draftRow]);
        if (query.includes("FROM opening_plan_drafts") && query.includes("strategy_version")) return Promise.resolve([]);
        if (query.includes("FROM opening_plan_acceptances")) return Promise.resolve([]);
        if (query.includes("FROM opening_hard_blocks") || query.includes("FROM opening_timetable_sessions")) return Promise.resolve([]);
        if (query.includes("FROM workspace_preferences")) {
          return Promise.resolve([{
            planning_settings: {
              weekOneMonday: "2026-09-07",
              periodTimes: {},
              dailyWindow: { start: "08:00", end: "22:00" },
              lunch: { start: "12:00", end: "13:00" },
              dinner: { start: "18:00", end: "19:00" },
              sleep: { start: "23:00", end: "07:00" },
              timeZone: c.timeZone,
            },
          }]);
        }
        if (query.includes("FROM opening_teaching_activities")
          || query.includes("FROM opening_retest_activities")
          || query.includes("FROM opening_learning_goals")) return Promise.resolve([]);
        if (query.includes("FROM opening_tasks")) return Promise.resolve([row]);
        if (query.includes("UPDATE opening_plan_state")) {
          acceptedVersion += 1;
          return Promise.resolve([]);
        }
        throw new Error(`Unexpected SQL: ${query}`);
      };
      const sql = Object.assign(fn, {
        json: (v: unknown) => v,
        begin: async (run: (tx: TransactionSql) => unknown) => run(sql as unknown as TransactionSql),
      }) as unknown as Sql;

      await expect(
        acceptOpeningPlan(sql, SCOPE, { draftId, expectedBaseVersion: 0, clientKey: `cross-day-${c.label}` }, c.now),
        c.label,
      ).rejects.toMatchObject({ code: "CONFLICT", reason: "task_changed" });
      expect(acceptedVersion, c.label).toBe(0);

      // 2) Local replan validation also rejects forged fresh block for cross-day reservation.
      const localDraft = {
        id: id(71),
        day: c.day,
        origin: "user",
        strategy_version: "local-replan-v1",
        suggested_tasks: [],
        input_snapshot: {
          tasks: [task],
          localReplan: {
            kind: "local_replan_v1",
            baseAcceptedVersion: 1,
            baselineBlocks: [],
            fixedBlocks: [],
            releasedTaskVersions: [],
            proposedAt: c.now.toISOString(),
            preserveAll: false,
            explicitFree: [{ start: c.block.start, end: c.block.end, kind: "free" }],
          },
        },
      };
      await expect(
        validateOpeningLocalReplan(sql as unknown as TransactionSql, SCOPE, {
          day: c.day,
          state: { accepted_version: 1, accepted_blocks: [] },
          draft: localDraft,
          blocks: [c.block],
          now: c.now,
        }),
        `localReplan: ${c.label}`,
      ).rejects.toMatchObject({ code: "CONFLICT", reason: "task_changed" });
    }
  });

  it("validateOpeningLocalReplan re-checks futureFixed retest blocks for active status, deferral/snooze, deadline narrowing, and cross-day reservation", async () => {
    const day = "2026-10-16";
    const now = new Date("2026-10-16T19:00:00.000Z");
    const fixedBlock = {
      taskId: TASK_ID,
      start: FRIDAY_SLOT_START,
      end: FRIDAY_SLOT_END,
      reason: "已确认复测",
    };
    const otherTaskId = id(88);
    const otherTaskRow = {
      id: otherTaskId,
      workspace_id: SCOPE.workspaceId,
      owner_user_id: SCOPE.ownerUserId,
      version: 1,
      title: "普通任务",
      minutes: 20,
      due_at: null,
      not_before: null,
      priority: 1,
      status: "pending",
      origin: "manual",
    };
    const newBlock = {
      taskId: otherTaskId,
      start: "2026-10-16T19:45:00.000Z",
      end: "2026-10-16T20:05:00.000Z",
      reason: "新增任务",
    };
    const activeRow = makeCourseRouteRow({ retest_scheduled_start_at: FRIDAY_SLOT_START });
    const [retestTask, otherTask] = await createOpeningPlansRepository(
      vi.fn().mockResolvedValue([activeRow, otherTaskRow]) as unknown as Sql,
    ).listTasks(SCOPE);

    const draft = {
      id: id(72),
      day,
      origin: "user",
      strategy_version: "local-replan-v1",
      suggested_tasks: [],
      input_snapshot: {
        tasks: [retestTask, otherTask],
        localReplan: {
          kind: "local_replan_v1",
          baseAcceptedVersion: 1,
          baselineBlocks: [fixedBlock],
          fixedBlocks: [fixedBlock],
          releasedTaskVersions: [],
          proposedAt: now.toISOString(),
          preserveAll: false,
          explicitFree: [{ start: "2026-10-16T19:00:00.000Z", end: "2026-10-16T21:00:00.000Z", kind: "free" }],
        },
      },
    };
    const makeTx = (row: Record<string, unknown>): TransactionSql => {
      const fn = (parts: TemplateStringsArray) => {
        if (!parts.raw) return {};
        const query = parts.join("?");
        if (query.includes("FROM opening_teaching_activities")) return Promise.resolve([]);
        if (query.includes("FROM opening_tasks")) return Promise.resolve([row, otherTaskRow]);
        if (query.includes("FROM opening_hard_blocks") || query.includes("FROM opening_timetable_sessions")) return Promise.resolve([]);
        if (query.includes("planning_settings")) {
          return Promise.resolve([{
            planning_settings: {
              weekOneMonday: "2026-09-07",
              periodTimes: {},
              dailyWindow: { start: "19:00", end: "21:00" },
              lunch: { start: "12:00", end: "13:00" },
              dinner: { start: "18:00", end: "19:00" },
              sleep: { start: "23:00", end: "07:00" },
              timeZone: "UTC",
            },
          }]);
        }
        throw new Error(`Unexpected SQL: ${query}`);
      };
      return Object.assign(fn, { json: (v: unknown) => v }) as unknown as TransactionSql;
    };
    const state = { accepted_version: 1, accepted_blocks: [fixedBlock] };
    const blocks = [fixedBlock, newBlock];

    // Active & legal futureFixed validates cleanly.
    await expect(validateOpeningLocalReplan(makeTx(activeRow), SCOPE, {
      day, state, draft, blocks, now,
    })).resolves.toBeUndefined();

    // Mutating the retest activity after proposal rejects even though scheduledNew === false.
    for (const [label, mutated] of [
      ["cancelled", { ...activeRow, retest_status: "cancelled" }],
      ["invalidated", { ...activeRow, retest_status: "invalidated" }],
      ["snoozed past start", { ...activeRow, retest_snoozed_until: "2026-10-16T20:00:00.000Z" }],
      ["deadline narrowed before end", { ...activeRow, retest_deadline_at: FRIDAY_1930 }],
      ["moved scheduledStartAt to another day", { ...activeRow, retest_scheduled_start_at: "2026-10-17T19:15:00.000Z" }],
    ] as const) {
      await expect(
        validateOpeningLocalReplan(makeTx(mutated), SCOPE, { day, state, draft, blocks, now }),
        label,
      ).rejects.toMatchObject({ code: "CONFLICT", reason: "task_changed" });
    }
  });

  it("rejects same-day explicit reservation paired with a forged cross-day block in isBlockAllowedForTaskWindow, acceptOpeningPlan, and validateOpeningLocalReplan", async () => {
    const friday = "2026-10-16";
    const fridayNow = new Date("2026-10-16T19:00:00.000Z");
    const fridayRow = makeCourseRouteRow({ retest_scheduled_start_at: FRIDAY_SLOT_START });
    const fridayWindow = projectCourseRoutePlanningWindow(fridayRow, SCOPE);
    const forgedSaturdayBlock = {
      taskId: TASK_ID,
      start: "2026-10-17T19:15:00.000Z",
      end: "2026-10-17T19:40:00.000Z",
      reason: "forged-saturday-block",
    };

    // 1) Pure helper boundary checks (UTC & Asia/Shanghai).
    expect(isBlockAllowedForTaskWindow(
      { start: FRIDAY_SLOT_START, end: FRIDAY_SLOT_END },
      fridayWindow,
      friday,
      "UTC",
    )).toBe(true);
    expect(isBlockAllowedForTaskWindow(
      { start: "2026-10-16T23:35:00.000Z", end: "2026-10-17T00:00:00.000Z" },
      fridayWindow,
      friday,
      "UTC",
    )).toBe(true);
    expect(isBlockAllowedForTaskWindow(forgedSaturdayBlock, fridayWindow, friday, "UTC")).toBe(false);
    expect(isBlockAllowedForTaskWindow(
      { start: "2026-10-16T23:50:00.000Z", end: "2026-10-17T00:15:00.000Z" },
      fridayWindow,
      friday,
      "UTC",
    )).toBe(false);

    const shanghaiWindow = projectCourseRoutePlanningWindow(
      makeCourseRouteRow({ retest_scheduled_start_at: "2026-10-16T11:15:00.000Z" }),
      SCOPE,
    );
    expect(isBlockAllowedForTaskWindow(
      { start: "2026-10-16T11:15:00.000Z", end: "2026-10-16T11:40:00.000Z" },
      shanghaiWindow,
      friday,
      "Asia/Shanghai",
    )).toBe(true);
    // 2026-10-16T16:15Z is 2026-10-17 00:15 in Asia/Shanghai -> outside 2026-10-16 local day.
    expect(isBlockAllowedForTaskWindow(
      { start: "2026-10-16T16:15:00.000Z", end: "2026-10-16T16:40:00.000Z" },
      shanghaiWindow,
      friday,
      "Asia/Shanghai",
    )).toBe(false);

    // 2) Ordinary acceptOpeningPlan rejects Friday reservation + forged Saturday block without bumping version.
    const [fridayTask] = await createOpeningPlansRepository(
      vi.fn().mockResolvedValue([fridayRow]) as unknown as Sql,
    ).listTasks(SCOPE);
    let acceptedVersion = 0;
    const draftId = id(75);
    const draftRow = {
      id: draftId,
      workspace_id: SCOPE.workspaceId,
      owner_user_id: SCOPE.ownerUserId,
      day: friday,
      version: 0,
      base_version: 0,
      status: "draft",
      blocks: [forgedSaturdayBlock],
      unscheduled_task_ids: [],
      suggested_tasks: [],
      origin: "user",
      strategy_version: null,
      hard_blocks_fingerprint: "fp",
      input_snapshot: { tasks: [fridayTask], free: [] },
    };
    const fn = (parts: TemplateStringsArray) => {
      if (!parts.raw) return {};
      const query = parts.join("?");
      if (query.includes("SELECT day FROM opening_plan_drafts")) return Promise.resolve([{ day: friday }]);
      if (query.includes("pg_advisory_xact_lock") || query.includes("opening_workspace_history_revisions")) return Promise.resolve([]);
      if (query.includes("FROM workspaces")) return Promise.resolve([{ id: SCOPE.workspaceId }]);
      if (query.includes("FROM courses")) return Promise.resolve([{ id: COURSE_ID }]);
      if (query.includes("INSERT INTO opening_plan_state")) return Promise.resolve([]);
      if (query.includes("FROM opening_plan_state")) {
        return Promise.resolve([{ accepted_version: acceptedVersion, accepted_blocks: [], hard_blocks_fingerprint: "fp" }]);
      }
      if (query.includes("SELECT * FROM opening_plan_drafts")) return Promise.resolve([draftRow]);
      if (query.includes("FROM opening_plan_drafts") && query.includes("strategy_version")) return Promise.resolve([]);
      if (query.includes("FROM opening_plan_acceptances")) return Promise.resolve([]);
      if (query.includes("FROM opening_hard_blocks") || query.includes("FROM opening_timetable_sessions")) return Promise.resolve([]);
      if (query.includes("FROM workspace_preferences")) {
        return Promise.resolve([{
          planning_settings: {
            weekOneMonday: "2026-09-07",
            periodTimes: {},
            dailyWindow: { start: "19:00", end: "21:00" },
            lunch: { start: "12:00", end: "13:00" },
            dinner: { start: "18:00", end: "19:00" },
            sleep: { start: "23:00", end: "07:00" },
            timeZone: "UTC",
          },
        }]);
      }
      if (query.includes("FROM opening_teaching_activities")
        || query.includes("FROM opening_retest_activities")
        || query.includes("FROM opening_learning_goals")) return Promise.resolve([]);
      if (query.includes("FROM opening_tasks")) return Promise.resolve([fridayRow]);
      if (query.includes("UPDATE opening_plan_state")) {
        acceptedVersion += 1;
        return Promise.resolve([]);
      }
      throw new Error(`Unexpected SQL: ${query}`);
    };
    const sql = Object.assign(fn, {
      json: (v: unknown) => v,
      begin: async (run: (tx: TransactionSql) => unknown) => run(sql as unknown as TransactionSql),
    }) as unknown as Sql;

    await expect(
      acceptOpeningPlan(sql, SCOPE, { draftId, expectedBaseVersion: 0, clientKey: "same-day-res-forged-sat-block" }, fridayNow),
    ).rejects.toMatchObject({ code: "CONFLICT", reason: "task_changed" });
    expect(acceptedVersion).toBe(0);

    // 3) Local replan validation rejects forged Saturday block in both fresh and futureFixed.
    const freshDraft = {
      id: id(76),
      day: friday,
      origin: "user",
      strategy_version: "local-replan-v1",
      suggested_tasks: [],
      input_snapshot: {
        tasks: [fridayTask],
        localReplan: {
          kind: "local_replan_v1",
          baseAcceptedVersion: 1,
          baselineBlocks: [],
          fixedBlocks: [],
          releasedTaskVersions: [],
          proposedAt: fridayNow.toISOString(),
          preserveAll: false,
        },
      },
    };
    await expect(
      validateOpeningLocalReplan(sql as unknown as TransactionSql, SCOPE, {
        day: friday,
        state: { accepted_version: 1, accepted_blocks: [] },
        draft: freshDraft,
        blocks: [forgedSaturdayBlock],
        now: fridayNow,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", reason: "task_changed" });

    const fixedDraft = {
      id: id(77),
      day: friday,
      origin: "user",
      strategy_version: "local-replan-v1",
      suggested_tasks: [],
      input_snapshot: {
        tasks: [fridayTask],
        localReplan: {
          kind: "local_replan_v1",
          baseAcceptedVersion: 1,
          baselineBlocks: [forgedSaturdayBlock],
          fixedBlocks: [forgedSaturdayBlock],
          releasedTaskVersions: [],
          proposedAt: fridayNow.toISOString(),
          preserveAll: true,
        },
      },
    };
    await expect(
      validateOpeningLocalReplan(sql as unknown as TransactionSql, SCOPE, {
        day: friday,
        state: { accepted_version: 1, accepted_blocks: [forgedSaturdayBlock] },
        draft: fixedDraft,
        blocks: [forgedSaturdayBlock],
        now: fridayNow,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
