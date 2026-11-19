import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  assertOpeningWorkspaceCapacity,
  createOpeningDayAdjustmentRepository,
  createOpeningPlanningSettingsRepository,
  createOpeningPlansRepository,
} from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

const THU = "2026-11-19";
const FRI = "2026-11-20";
const TIME_ZONE = "Asia/Shanghai";
// 2026-11-19 18:55 Asia/Shanghai
const THU_1855 = new Date("2026-11-19T10:55:00.000Z");
// 2026-11-20 00:30 Asia/Shanghai (after midnight!)
const FRI_0030 = new Date("2026-11-19T16:30:00.000Z");

let f: OpeningFixture;

beforeAll(async () => {
  f = await createOpeningFixture();
});

beforeEach(async () => {
  await f.sql`DELETE FROM opening_plan_acceptances WHERE workspace_id = ${f.scope.workspaceId}`;
  await f.sql`DELETE FROM opening_plan_drafts WHERE workspace_id = ${f.scope.workspaceId}`;
  await f.sql`DELETE FROM opening_plan_state WHERE workspace_id = ${f.scope.workspaceId}`;
  await f.sql`DELETE FROM opening_hard_blocks WHERE workspace_id = ${f.scope.workspaceId}`;
  await f.sql`DELETE FROM opening_retest_activities WHERE workspace_id = ${f.scope.workspaceId}`;
  await f.sql`DELETE FROM opening_teaching_activities WHERE workspace_id = ${f.scope.workspaceId}`;
  await f.sql`DELETE FROM opening_tasks WHERE workspace_id = ${f.scope.workspaceId}`;
  await f.sql`DELETE FROM courses WHERE workspace_id = ${f.scope.workspaceId}`;
  await f.sql`DELETE FROM workspace_preferences WHERE workspace_id = ${f.scope.workspaceId}`;
  await f.sql`DELETE FROM opening_workspace_history_revisions WHERE workspace_id = ${f.scope.workspaceId}`;

  const settingsRepo = createOpeningPlanningSettingsRepository(f.sql);
  await settingsRepo.save(f.scope, {
    termStartDate: "2026-09-01",
    timeZone: TIME_ZONE,
    sleepStart: "23:00",
    sleepEnd: "07:00",
    meals: [
      { label: "午饭", start: "12:00", end: "12:45" },
      { label: "晚饭", start: "18:00", end: "18:45" },
    ],
    periodTimes: [
      { period: 1, start: "08:00", end: "08:45" },
      { period: 2, start: "08:55", end: "09:40" },
    ],
  });
  await f.sql`
    UPDATE workspace_preferences
    SET learning_management = ${f.sql.json({
      dailyMinutes: 90,
      bufferMinutes: 15,
      revision: 1,
      updatedAt: THU_1855.toISOString(),
    })}
    WHERE workspace_id = ${f.scope.workspaceId}`;
});

afterAll(async () => {
  await f?.close();
});

async function seedAcceptedPlan(
  day: string,
  blocks: Array<{ taskId: string; start: string; end: string; reason: string }>,
  version = 1,
) {
  await f.sql`
    INSERT INTO opening_plan_state (workspace_id, day, accepted_version, accepted_blocks, hard_blocks_fingerprint)
    VALUES (${f.scope.workspaceId}, ${day}::date, ${version}, ${f.sql.json(blocks)}, '')
    ON CONFLICT (workspace_id, day) DO UPDATE
      SET accepted_version = EXCLUDED.accepted_version,
          accepted_blocks = EXCLUDED.accepted_blocks`;
}

describe("opening-day-adjustment repository (kernel-v2 Phase 2)", () => {
  it("declares 15 min on Thu without advancing plan state, then atomically keeps Writing 15m and moves Math 25m to Fri 19:15", async () => {
    const plans = createOpeningPlansRepository(f.sql, { now: () => THU_1855 });
    const writing = await plans.createTask(f.scope, {
      title: "英语写作",
      minutes: 15,
      priority: 2,
      dueAt: null,
      candidateId: null,
    });
    const math = await plans.createTask(f.scope, {
      title: "高等数学",
      minutes: 25,
      priority: 1,
      dueAt: null,
      candidateId: null,
    });

    const writingBlock = {
      taskId: writing.id,
      start: "2026-11-19T11:00:00.000Z", // 19:00 Asia/Shanghai
      end: "2026-11-19T11:15:00.000Z",
      reason: "planned",
    };
    const mathBlock = {
      taskId: math.id,
      start: "2026-11-19T11:15:00.000Z",
      end: "2026-11-19T11:40:00.000Z",
      reason: "planned",
    };
    await seedAcceptedPlan(THU, [writingBlock, mathBlock], 1);

    const repo = createOpeningDayAdjustmentRepository(f.sql, { clock: () => THU_1855 });
    const declareKey = randomUUID();
    const exc = await repo.declareToday(f.scope, {
      clientKey: declareKey,
      localDate: THU,
      expectedTimeZone: TIME_ZONE,
      expectedExceptionRevision: 0,
      remainingMinutes: 15,
    });
    expect(exc).toMatchObject({
      id: declareKey,
      localDate: THU,
      timeZone: TIME_ZONE,
      remainingMinutes: 15,
      revision: 1,
      replayed: false,
    });

    // Tx1 must NOT advance opening_plan_state.
    const [thuStateAfterDeclare] = await f.sql`
      SELECT accepted_version FROM opening_plan_state WHERE workspace_id = ${f.scope.workspaceId} AND day = ${THU}::date`;
    expect(Number(thuStateAfterDeclare!.accepted_version)).toBe(1);

    // Preview with explicit Fri 19:15 target slot.
    const fri1915 = "2026-11-20T11:15:00.000Z";
    const preview = await repo.preview(f.scope, {
      date: THU,
      targetDate: FRI,
      targetStartAt: fri1915,
    });
    expect(preview.status).toBe("ready");
    expect(preview.canConfirm).toBe(true);
    expect(preview.capacityBefore.shortfallMinutes).toBe(25);
    expect(preview.capacityAfter.shortfallMinutes).toBe(0);
    expect(preview.keptBlocks.map((b) => b.taskId)).toEqual([writing.id]);
    expect(preview.removedBlocks.map((b) => b.taskId)).toEqual([math.id]);
    expect(preview.targetAddedBlocks).toEqual([
      {
        taskId: math.id,
        start: fri1915,
        end: "2026-11-20T11:40:00.000Z",
        reason: "planned",
      },
    ]);

    // Confirm atomically (Tx2).
    const confirmKey = `day-adjust:${randomUUID()}`;
    const confirmInput = {
      clientKey: confirmKey,
      sourceDate: THU,
      expectedTimeZone: TIME_ZONE,
      expectedExceptionRevision: preview.exceptionRevision,
      expectedBudgetRevision: preview.budgetRevision,
      expectedSourceAcceptedVersion: preview.sourceAcceptedVersion,
      expectedTargetAcceptedVersion: preview.targetAcceptedVersion,
      expectedTaskRevisions: preview.taskRevisions,
      expectedRetestRevisions: preview.retestRevisions,
      sourceActions: {
        keptBlocks: preview.keptBlocks,
        removedBlocks: preview.removedBlocks,
        addedBlocks: preview.sourceAddedBlocks,
      },
      targetActions: {
        targetDate: FRI,
        addedBlocks: preview.targetAddedBlocks,
      },
    };
    const receipt = await repo.confirm(f.scope, confirmInput);
    expect(receipt).toMatchObject({
      sourceDate: THU,
      sourceBeforeVersion: 1,
      sourceAfterVersion: 2,
      targetDate: FRI,
      targetBeforeVersion: 0,
      targetAfterVersion: 1,
      replayed: false,
    });

    // Both days updated atomically.
    const states = await f.sql`
      SELECT day::text AS day, accepted_version, accepted_blocks
      FROM opening_plan_state
      WHERE workspace_id = ${f.scope.workspaceId}
      ORDER BY day ASC`;
    expect(states).toHaveLength(2);
    expect(Number(states[0]!.accepted_version)).toBe(2);
    expect((states[0]!.accepted_blocks as Array<{ taskId: string }>).map((b) => b.taskId)).toEqual([writing.id]);
    expect(Number(states[1]!.accepted_version)).toBe(1);
    expect((states[1]!.accepted_blocks as Array<{ taskId: string }>).map((b) => b.taskId)).toEqual([math.id]);

    // After midnight, same-key replay succeeds for BOTH Tx1 and Tx2, and different intent returns selection_mismatch.
    const afterMidnightRepo = createOpeningDayAdjustmentRepository(f.sql, { clock: () => FRI_0030 });
    const replayedExc = await afterMidnightRepo.declareToday(f.scope, {
      clientKey: declareKey,
      localDate: THU,
      expectedTimeZone: TIME_ZONE,
      expectedExceptionRevision: 0,
      remainingMinutes: 15,
    });
    expect(replayedExc.replayed).toBe(true);
    await expect(
      afterMidnightRepo.declareToday(f.scope, {
        clientKey: declareKey,
        localDate: THU,
        expectedTimeZone: TIME_ZONE,
        expectedExceptionRevision: 0,
        remainingMinutes: 20,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", reason: "selection_mismatch" });

    const replayedConfirm = await afterMidnightRepo.confirm(f.scope, confirmInput);
    expect(replayedConfirm.replayed).toBe(true);
    expect(replayedConfirm.draftId).toBe(receipt.draftId);
    await expect(
      afterMidnightRepo.confirm(f.scope, {
        ...confirmInput,
        expectedSourceAcceptedVersion: 99,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", reason: "selection_mismatch" });
  });

  it("supports moving an oversized block out and filling the vacated slot with an indivisible quick task in one diff, while rejecting 25m truncation", async () => {
    const plans = createOpeningPlansRepository(f.sql, { now: () => THU_1855 });
    const math = await plans.createTask(f.scope, {
      title: "高等数学",
      minutes: 25,
      priority: 1,
      dueAt: null,
      candidateId: null,
    });
    const quick = await plans.createTask(f.scope, {
      title: "单词速记",
      minutes: 15,
      priority: 2,
      dueAt: null,
      candidateId: null,
    });
    const tooBig = await plans.createTask(f.scope, {
      title: "深度推导",
      minutes: 25,
      priority: 2,
      dueAt: null,
      candidateId: null,
    });

    await seedAcceptedPlan(
      THU,
      [
        {
          taskId: math.id,
          start: "2026-11-19T11:00:00.000Z",
          end: "2026-11-19T11:25:00.000Z",
          reason: "planned",
        },
      ],
      1,
    );

    const repo = createOpeningDayAdjustmentRepository(f.sql, { clock: () => THU_1855 });
    await repo.declareToday(f.scope, {
      clientKey: randomUUID(),
      localDate: THU,
      expectedTimeZone: TIME_ZONE,
      expectedExceptionRevision: 0,
      remainingMinutes: 15,
    });

    const preview = await repo.preview(f.scope, {
      date: THU,
      targetDate: FRI,
      moveTaskIds: [math.id],
      quickTaskId: quick.id,
      quickStartAt: "2026-11-19T11:00:00.000Z",
    });
    expect(preview.status).toBe("ready");
    expect(preview.sourceAddedBlocks).toHaveLength(1);
    expect(preview.sourceAddedBlocks[0]!.taskId).toBe(quick.id);
    expect(preview.targetAddedBlocks[0]!.taskId).toBe(math.id);
    const bigCandidate = preview.quickCandidates.find((c) => c.taskId === tooBig.id);
    expect(bigCandidate?.fits).toBe(false);

    // Attempting to truncate 25m task into 15m slot on confirm is strictly rejected.
    await expect(
      repo.confirm(f.scope, {
        clientKey: `day-adjust:truncate:${randomUUID()}`,
        sourceDate: THU,
        expectedTimeZone: TIME_ZONE,
        expectedExceptionRevision: 1,
        expectedBudgetRevision: 1,
        expectedSourceAcceptedVersion: 1,
        expectedTargetAcceptedVersion: 0,
        expectedTaskRevisions: [
          ...preview.taskRevisions,
          { taskId: tooBig.id, version: tooBig.version },
        ],
        expectedRetestRevisions: [],
        sourceActions: {
          keptBlocks: [],
          removedBlocks: preview.removedBlocks,
          addedBlocks: [
            {
              taskId: tooBig.id,
              start: "2026-11-19T11:00:00.000Z",
              end: "2026-11-19T11:15:00.000Z",
              reason: "planned",
            },
          ],
        },
        targetActions: {
          targetDate: FRI,
          addedBlocks: preview.targetAddedBlocks,
        },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rolls back completely on mid-transaction fault with zero partial writes and zero stray target day state row", async () => {
    const plans = createOpeningPlansRepository(f.sql, { now: () => THU_1855 });
    const math = await plans.createTask(f.scope, {
      title: "高等数学",
      minutes: 25,
      priority: 1,
      dueAt: null,
      candidateId: null,
    });
    await seedAcceptedPlan(
      THU,
      [
        {
          taskId: math.id,
          start: "2026-11-19T11:00:00.000Z",
          end: "2026-11-19T11:25:00.000Z",
          reason: "planned",
        },
      ],
      1,
    );

    const faultRepo = createOpeningDayAdjustmentRepository(f.sql, {
      clock: () => THU_1855,
      onBeforeCommit: async (stage) => {
        if (stage === "after_target_state") throw new Error("injected_fault");
      },
    });
    await faultRepo.declareToday(f.scope, {
      clientKey: randomUUID(),
      localDate: THU,
      expectedTimeZone: TIME_ZONE,
      expectedExceptionRevision: 0,
      remainingMinutes: 15,
    });
    const preview = await faultRepo.preview(f.scope, { date: THU, targetDate: FRI });

    await expect(
      faultRepo.confirm(f.scope, {
        clientKey: `day-adjust:fault:${randomUUID()}`,
        sourceDate: THU,
        expectedTimeZone: TIME_ZONE,
        expectedExceptionRevision: preview.exceptionRevision,
        expectedBudgetRevision: preview.budgetRevision,
        expectedSourceAcceptedVersion: preview.sourceAcceptedVersion,
        expectedTargetAcceptedVersion: preview.targetAcceptedVersion,
        expectedTaskRevisions: preview.taskRevisions,
        expectedRetestRevisions: preview.retestRevisions,
        sourceActions: {
          keptBlocks: preview.keptBlocks,
          removedBlocks: preview.removedBlocks,
          addedBlocks: preview.sourceAddedBlocks,
        },
        targetActions: {
          targetDate: FRI,
          addedBlocks: preview.targetAddedBlocks,
        },
      }),
    ).rejects.toThrow("injected_fault");

    const states = await f.sql`
      SELECT day::text AS day, accepted_version FROM opening_plan_state
      WHERE workspace_id = ${f.scope.workspaceId} ORDER BY day ASC`;
    expect(states).toHaveLength(1);
    expect(states[0]!.day).toBe(THU);
    expect(Number(states[0]!.accepted_version)).toBe(1);
    expect(
      await f.sql`SELECT id FROM opening_plan_acceptances WHERE workspace_id = ${f.scope.workspaceId}`,
    ).toHaveLength(0);
  });

  it("atomically updates retest scheduled_start_at and history revision, and enforces retest status and window guardrails", async () => {
    const courseId = randomUUID();
    await f.sql`
      INSERT INTO courses (id, workspace_id, title)
      VALUES (${courseId}, ${f.scope.workspaceId}, '微积分')`;
    const plans = createOpeningPlansRepository(f.sql, { now: () => THU_1855 });
    const task = await plans.createTask(f.scope, {
      title: "极限复测",
      minutes: 25,
      priority: 1,
      dueAt: "2026-11-21T15:00:00.000Z",
      candidateId: null,
    });
    await f.sql`UPDATE opening_tasks SET course_id = ${courseId} WHERE id = ${task.id}`;
    const retestId = randomUUID();
    await f.sql`
      INSERT INTO opening_retest_activities (
        id, workspace_id, owner_user_id, course_id, skill_label, purpose,
        evidence_cycle_id, task_id, status, version,
        not_before_at, recommended_at, scheduled_start_at, deadline_at
      ) VALUES (
        ${retestId}, ${f.scope.workspaceId}, ${f.scope.ownerUserId}, ${courseId},
        '极限与连续', 'retest', ${randomUUID()}, ${task.id}, 'accepted', 1,
        '2026-11-19T10:00:00.000Z', '2026-11-19T11:00:00.000Z',
        '2026-11-19T11:15:00.000Z', '2026-11-20T12:00:00.000Z'
      )`;
    await seedAcceptedPlan(
      THU,
      [
        {
          taskId: task.id,
          start: "2026-11-19T11:15:00.000Z",
          end: "2026-11-19T11:40:00.000Z",
          reason: "planned",
        },
      ],
      1,
    );

    const repo = createOpeningDayAdjustmentRepository(f.sql, { clock: () => THU_1855 });
    await repo.declareToday(f.scope, {
      clientKey: randomUUID(),
      localDate: THU,
      expectedTimeZone: TIME_ZONE,
      expectedExceptionRevision: 0,
      remainingMinutes: 15,
    });
    const preview = await repo.preview(f.scope, {
      date: THU,
      targetDate: FRI,
      targetStartAt: "2026-11-20T11:15:00.000Z",
    });

    // Reject rescheduling past retest deadline_at (12:00Z).
    await expect(
      repo.confirm(f.scope, {
        clientKey: `day-adjust:past-deadline:${randomUUID()}`,
        sourceDate: THU,
        expectedTimeZone: TIME_ZONE,
        expectedExceptionRevision: preview.exceptionRevision,
        expectedBudgetRevision: preview.budgetRevision,
        expectedSourceAcceptedVersion: preview.sourceAcceptedVersion,
        expectedTargetAcceptedVersion: preview.targetAcceptedVersion,
        expectedTaskRevisions: preview.taskRevisions,
        expectedRetestRevisions: preview.retestRevisions,
        sourceActions: {
          keptBlocks: [],
          removedBlocks: preview.removedBlocks,
          addedBlocks: [],
        },
        targetActions: {
          targetDate: FRI,
          addedBlocks: [
            {
              taskId: task.id,
              start: "2026-11-20T11:50:00.000Z",
              end: "2026-11-20T12:15:00.000Z",
              reason: "planned",
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", reason: "task_changed" });

    // Valid reschedule within deadline updates retest scheduled_start_at & version + history revision once.
    const [histBefore] = await f.sql`
      SELECT revision FROM opening_workspace_history_revisions WHERE workspace_id = ${f.scope.workspaceId}`;
    const receipt = await repo.confirm(f.scope, {
      clientKey: `day-adjust:retest-ok:${randomUUID()}`,
      sourceDate: THU,
      expectedTimeZone: TIME_ZONE,
      expectedExceptionRevision: preview.exceptionRevision,
      expectedBudgetRevision: preview.budgetRevision,
      expectedSourceAcceptedVersion: preview.sourceAcceptedVersion,
      expectedTargetAcceptedVersion: preview.targetAcceptedVersion,
      expectedTaskRevisions: preview.taskRevisions,
      expectedRetestRevisions: preview.retestRevisions,
      sourceActions: {
        keptBlocks: [],
        removedBlocks: preview.removedBlocks,
        addedBlocks: [],
      },
      targetActions: {
        targetDate: FRI,
        addedBlocks: preview.targetAddedBlocks,
      },
    });
    expect(receipt.retestReschedules).toHaveLength(1);
    expect(receipt.retestReschedules[0]).toMatchObject({
      retestId,
      beforeVersion: 1,
      afterVersion: 2,
      afterScheduledStartAt: "2026-11-20T11:15:00.000Z",
    });
    const [retestAfter] = await f.sql`
      SELECT version, scheduled_start_at FROM opening_retest_activities WHERE id = ${retestId}`;
    expect(Number(retestAfter!.version)).toBe(2);
    expect(new Date(retestAfter!.scheduled_start_at as Date).toISOString()).toBe("2026-11-20T11:15:00.000Z");
    const [histAfter] = await f.sql`
      SELECT revision FROM opening_workspace_history_revisions WHERE workspace_id = ${f.scope.workspaceId}`;
    expect(Number(histAfter!.revision)).toBe(Number(histBefore?.revision ?? 0) + 1);
  });

  it("blocks ordinary acceptPlan bypass on day-exception/day-adjustment drafts and enforces active dayException in shared capacity", async () => {
    const plans = createOpeningPlansRepository(f.sql, { now: () => THU_1855 });
    const repo = createOpeningDayAdjustmentRepository(f.sql, { clock: () => THU_1855 });
    const exc = await repo.declareToday(f.scope, {
      clientKey: randomUUID(),
      localDate: THU,
      expectedTimeZone: TIME_ZONE,
      expectedExceptionRevision: 0,
      remainingMinutes: 15,
    });

    // Cannot accept day-exception-v1 draft via ordinary acceptPlan.
    await expect(
      plans.acceptPlan(f.scope, {
        draftId: exc.id,
        expectedBaseVersion: 0,
        clientKey: `bypass:${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // Shared capacity admission enforces active 15-min exception (25m rejected, 15m allowed).
    await expect(
      f.sql.begin((tx) =>
        assertOpeningWorkspaceCapacity(tx, f.scope, { minutes: 25, targetAt: THU_1855 }, THU_1855),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      f.sql.begin((tx) =>
        assertOpeningWorkspaceCapacity(tx, f.scope, { minutes: 15, targetAt: THU_1855 }, THU_1855),
      ),
    ).resolves.toBeTruthy();

    // Concurrent single-day acceptPlan + cross-day confirm completes without deadlock or partial writes.
    const writing = await plans.createTask(f.scope, {
      title: "英语写作",
      minutes: 15,
      priority: 1,
      dueAt: null,
      candidateId: null,
    });
    const math = await plans.createTask(f.scope, {
      title: "高等数学",
      minutes: 25,
      priority: 1,
      dueAt: null,
      candidateId: null,
    });
    await seedAcceptedPlan(
      THU,
      [
        {
          taskId: math.id,
          start: "2026-11-19T11:15:00.000Z",
          end: "2026-11-19T11:40:00.000Z",
          reason: "planned",
        },
      ],
      1,
    );
    const ordinaryDraft = await plans.proposePlan(f.scope, {
      date: THU,
      tasks: [writing],
      free: [{ start: "2026-11-19T11:00:00.000Z", end: "2026-11-19T11:15:00.000Z", kind: "free" }],
      blocks: [{ taskId: writing.id, start: "2026-11-19T11:00:00.000Z", end: "2026-11-19T11:15:00.000Z", reason: "planned" }],
      unscheduledTaskIds: [],
    });
    const preview = await repo.preview(f.scope, { date: THU, targetDate: FRI });

    const results = await Promise.allSettled([
      plans.acceptPlan(f.scope, {
        draftId: ordinaryDraft.id,
        expectedBaseVersion: 1,
        clientKey: `race-ordinary:${randomUUID()}`,
      }),
      repo.confirm(f.scope, {
        clientKey: `race-adjust:${randomUUID()}`,
        sourceDate: THU,
        expectedTimeZone: TIME_ZONE,
        expectedExceptionRevision: preview.exceptionRevision,
        expectedBudgetRevision: preview.budgetRevision,
        expectedSourceAcceptedVersion: preview.sourceAcceptedVersion,
        expectedTargetAcceptedVersion: preview.targetAcceptedVersion,
        expectedTaskRevisions: preview.taskRevisions,
        expectedRetestRevisions: preview.retestRevisions,
        sourceActions: {
          keptBlocks: preview.keptBlocks,
          removedBlocks: preview.removedBlocks,
          addedBlocks: preview.sourceAddedBlocks,
        },
        targetActions: {
          targetDate: FRI,
          addedBlocks: preview.targetAddedBlocks,
        },
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });
});
