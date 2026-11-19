import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  createOpeningDayAdjustmentRepository,
  createOpeningPlanningSettingsRepository,
  createOpeningPlansRepository,
} from "@aistudy/database";
import type { OpeningBackup } from "@aistudy/domain";
import { executeOpeningRestoreApply } from "../../packages/database/src/repositories/opening-backup-apply";
import { readOpeningBackupRecords } from "../../packages/database/src/repositories/opening-backup-records";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

const THU = "2026-11-19";
const FRI = "2026-11-20";
const TIME_ZONE = "Asia/Shanghai";
const THU_1855 = new Date("2026-11-19T10:55:00.000Z");

let f: OpeningFixture;

beforeAll(async () => {
  f = await createOpeningFixture();
});

beforeEach(async () => {
  await f.sql`DELETE FROM opening_plan_acceptances WHERE workspace_id = ${f.scope.workspaceId}`;
  await f.sql`DELETE FROM opening_plan_drafts WHERE workspace_id = ${f.scope.workspaceId}`;
  await f.sql`DELETE FROM opening_plan_state WHERE workspace_id = ${f.scope.workspaceId}`;
  await f.sql`DELETE FROM opening_retest_activities WHERE workspace_id = ${f.scope.workspaceId}`;
  await f.sql`DELETE FROM opening_tasks WHERE workspace_id = ${f.scope.workspaceId}`;
  await f.sql`DELETE FROM courses WHERE workspace_id = ${f.scope.workspaceId}`;
  await f.sql`DELETE FROM workspace_preferences WHERE workspace_id = ${f.scope.workspaceId}`;
  await f.sql`DELETE FROM opening_workspace_history_revisions WHERE workspace_id = ${f.scope.workspaceId}`;

  await createOpeningPlanningSettingsRepository(f.sql).save(f.scope, {
    termStartDate: "2026-09-01",
    timeZone: TIME_ZONE,
    sleepStart: "23:00",
    sleepEnd: "07:00",
    meals: [{ label: "晚饭", start: "18:00", end: "18:45" }],
    periodTimes: [{ period: 1, start: "08:00", end: "08:45" }],
  });
});

afterAll(async () => {
  await f?.close();
});

async function seedCrossDayAdjustmentWithRetest() {
  const courseId = randomUUID();
  await f.sql`INSERT INTO courses (id, workspace_id, title) VALUES (${courseId}, ${f.scope.workspaceId}, '微积分')`;
  const plans = createOpeningPlansRepository(f.sql, { now: () => THU_1855 });
  const writing = await plans.createTask(f.scope, {
    title: "英语写作",
    minutes: 15,
    priority: 2,
    dueAt: null,
    candidateId: null,
  });
  const math = await plans.createTask(f.scope, {
    title: "微积分复测",
    minutes: 25,
    priority: 1,
    dueAt: "2026-11-21T15:00:00.000Z",
    candidateId: null,
  });
  await f.sql`UPDATE opening_tasks SET course_id = ${courseId} WHERE id = ${math.id}`;
  const retestId = randomUUID();
  await f.sql`
    INSERT INTO opening_retest_activities (
      id, workspace_id, owner_user_id, course_id, skill_label, purpose,
      evidence_cycle_id, task_id, status, version,
      not_before_at, recommended_at, scheduled_start_at, deadline_at
    ) VALUES (
      ${retestId}, ${f.scope.workspaceId}, ${f.scope.ownerUserId}, ${courseId},
      '极限', 'retest', ${randomUUID()}, ${math.id}, 'accepted', 1,
      '2026-11-19T10:00:00.000Z', '2026-11-19T11:00:00.000Z',
      '2026-11-19T11:15:00.000Z', '2026-11-21T15:00:00.000Z'
    )`;
  await f.sql`
    INSERT INTO opening_plan_state (workspace_id, day, accepted_version, accepted_blocks, hard_blocks_fingerprint)
    VALUES (${f.scope.workspaceId}, ${THU}::date, 1, ${f.sql.json([
      {
        taskId: writing.id,
        start: "2026-11-19T11:00:00.000Z",
        end: "2026-11-19T11:15:00.000Z",
        reason: "planned",
      },
      {
        taskId: math.id,
        start: "2026-11-19T11:15:00.000Z",
        end: "2026-11-19T11:40:00.000Z",
        reason: "planned",
      },
    ])}, '')`;

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
  await repo.confirm(f.scope, {
    clientKey: `backup-confirm:${randomUUID()}`,
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
  });
  return { writing, math, retestId };
}

it("roundtrips day-exception + cross-day reschedule + retest reschedule through real backup export and restore apply", async () => {
  const { retestId } = await seedCrossDayAdjustmentWithRetest();
  const snapshot = await readOpeningBackupRecords(f.sql, f.scope);
  const backup: OpeningBackup = {
    format: "opening-backup",
    version: 1,
    workspaceId: f.scope.workspaceId,
    privacyEpoch: snapshot.privacyEpoch,
    deletionJournal: snapshot.deletionJournal,
    memoryDeletions: snapshot.memoryDeletions,
    tables: snapshot.tables,
    objects: [],
  };

  await f.sql`DELETE FROM opening_plan_acceptances WHERE workspace_id = ${f.scope.workspaceId}`;
  await f.sql`DELETE FROM opening_plan_drafts WHERE workspace_id = ${f.scope.workspaceId}`;
  await f.sql`DELETE FROM opening_plan_state WHERE workspace_id = ${f.scope.workspaceId}`;
  await f.sql`DELETE FROM opening_retest_activities WHERE workspace_id = ${f.scope.workspaceId}`;
  await f.sql`DELETE FROM opening_tasks WHERE workspace_id = ${f.scope.workspaceId}`;

  const result = await executeOpeningRestoreApply(f.sql, {
    confirmLocalRestore: true,
    backup,
    currentMemoryDeletions: snapshot.memoryDeletions,
  });
  expect(result).toMatchObject({ ok: true, code: "APPLY_OK" });

  const states = await f.sql`
    SELECT day::text AS day, accepted_version FROM opening_plan_state
    WHERE workspace_id = ${f.scope.workspaceId} ORDER BY day ASC`;
  expect(states).toHaveLength(2);
  expect(Number(states[0]!.accepted_version)).toBe(2);
  expect(Number(states[1]!.accepted_version)).toBe(1);

  const [retest] = await f.sql`
    SELECT version, scheduled_start_at FROM opening_retest_activities WHERE id = ${retestId}`;
  expect(Number(retest!.version)).toBe(2);
  expect(new Date(retest!.scheduled_start_at as Date).toISOString()).toBe("2026-11-20T11:15:00.000Z");
});

it("rejects tampered backup archives (missing target day, duplicate revision, stripped marker) before any restore mutation", async () => {
  await seedCrossDayAdjustmentWithRetest();
  const snapshot = await readOpeningBackupRecords(f.sql, f.scope);

  const makeBackup = (tables: typeof snapshot.tables): OpeningBackup => ({
    format: "opening-backup",
    version: 1,
    workspaceId: f.scope.workspaceId,
    privacyEpoch: snapshot.privacyEpoch,
    deletionJournal: snapshot.deletionJournal,
    memoryDeletions: snapshot.memoryDeletions,
    tables,
    objects: [],
  });

  // 1. Missing target day state
  const missingTarget = structuredClone(snapshot.tables);
  missingTarget.opening_plan_state = missingTarget.opening_plan_state!.filter(
    (row) => String(row.day).slice(0, 10) !== FRI,
  );
  expect(
    await executeOpeningRestoreApply(f.sql, {
      confirmLocalRestore: true,
      backup: makeBackup(missingTarget),
      currentMemoryDeletions: snapshot.memoryDeletions,
    }),
  ).toMatchObject({ ok: false, code: "PREFLIGHT_REJECTED", mutated: false });

  // 2. Duplicate day-exception revision
  const duplicateExc = structuredClone(snapshot.tables);
  const excRow = duplicateExc.opening_plan_drafts!.find(
    (row) => row.strategy_version === "day-exception-v1",
  )!;
  duplicateExc.opening_plan_drafts!.push({ ...structuredClone(excRow), id: randomUUID() });
  expect(
    await executeOpeningRestoreApply(f.sql, {
      confirmLocalRestore: true,
      backup: makeBackup(duplicateExc),
      currentMemoryDeletions: snapshot.memoryDeletions,
    }),
  ).toMatchObject({ ok: false, code: "PREFLIGHT_REJECTED", mutated: false });

  // 3. Stripped strategy_version marker
  const stripped = structuredClone(snapshot.tables);
  const adjRow = stripped.opening_plan_drafts!.find(
    (row) => row.strategy_version === "day-adjustment-v1",
  )!;
  adjRow.strategy_version = null;
  expect(
    await executeOpeningRestoreApply(f.sql, {
      confirmLocalRestore: true,
      backup: makeBackup(stripped),
      currentMemoryDeletions: snapshot.memoryDeletions,
    }),
  ).toMatchObject({ ok: false, code: "PREFLIGHT_REJECTED", mutated: false });
});
