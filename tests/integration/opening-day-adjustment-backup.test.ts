import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  createOpeningDayAdjustmentRepository,
  createOpeningPlanningSettingsRepository,
  createOpeningPlansRepository,
  executeOpeningRestoreApply,
  OPENING_RESTORE_APPLY_ORDER,
  readOpeningBackupRecords,
  readOpeningRestoreNamespaceCounts,
} from "@aistudy/database";
import type { OpeningBackup } from "@aistudy/domain";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

const THU = "2026-11-19";
const FRI = "2026-11-20";
const TIME_ZONE = "Asia/Shanghai";
const THU_1855 = new Date("2026-11-19T10:55:00.000Z");

let f: OpeningFixture;

async function emptyWorkspace() {
  const snapshot = await readOpeningBackupRecords(f.sql, f.scope);
  await f.sql.begin(async (tx) => {
    for (const table of [...OPENING_RESTORE_APPLY_ORDER].reverse()) {
      if (!snapshot.tables[table]?.length) continue;
      if (table === "opening_source_chunks") {
        await tx`DELETE FROM opening_source_chunks WHERE source_id IN (SELECT id FROM opening_sources WHERE workspace_id = ${f.scope.workspaceId})`;
      } else {
        await tx`DELETE FROM ${tx(table)} WHERE workspace_id = ${f.scope.workspaceId}`;
      }
    }
  });
  const counts = await readOpeningRestoreNamespaceCounts(f.sql, f.scope.workspaceId);
  expect(Object.values(counts).every((value) => value === 0)).toBe(true);
}

beforeAll(async () => {
  f = await createOpeningFixture();
});

beforeEach(async () => {
  await emptyWorkspace();

  await createOpeningPlanningSettingsRepository(f.sql).set(f.scope, {
    weekOneMonday: "2026-09-07",
    periodTimes: { "1": { start: "08:00", end: "08:45" } },
    dailyWindow: { start: "07:30", end: "22:30" },
    lunch: { start: "12:00", end: "12:45" },
    dinner: { start: "18:00", end: "18:45" },
    sleep: { start: "23:00", end: "07:00" },
    timeZone: TIME_ZONE,
  });
});

afterAll(async () => {
  await f?.close();
});

async function seedCrossDayAdjustmentWithRetest() {
  const courseId = randomUUID();
  await f.sql`
    INSERT INTO courses (id, workspace_id, title, slug)
    VALUES (${courseId}, ${f.scope.workspaceId}, '微积分', ${`calculus-${courseId.slice(0, 8)}`})`;
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

  await emptyWorkspace();
  const live = await readOpeningBackupRecords(f.sql, f.scope);

  const result = await executeOpeningRestoreApply(f.sql, {
    confirmLocalRestore: true,
    backup,
    currentDeletionJournal: live.deletionJournal,
    currentMemoryDeletions: live.memoryDeletions,
    currentLearningState: { workspacePreferences: null, courses: [] },
  });
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, code: "APPLY_OK" });

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
  const currentLearningState = {
    workspacePreferences: snapshot.tables.workspace_preferences[0] ?? null,
    courses: snapshot.tables.courses,
  };

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

  const assertRejectedWith = async (tables: typeof snapshot.tables, expectedError: string) => {
    const result = await executeOpeningRestoreApply(f.sql, {
      confirmLocalRestore: true,
      backup: makeBackup(tables),
      currentDeletionJournal: snapshot.deletionJournal,
      currentMemoryDeletions: snapshot.memoryDeletions,
      currentLearningState,
    });
    expect(result, JSON.stringify(result)).toMatchObject({
      ok: false,
      code: "PREFLIGHT_REJECTED",
      mutated: false,
    });
    expect(result.errors.some((error) => error.includes("current learning state"))).toBe(false);
    expect(result.errors.some((error) => error.includes(expectedError)), JSON.stringify(result.errors)).toBe(true);
  };

  // 1. Missing target day state
  const missingTarget = structuredClone(snapshot.tables);
  missingTarget.opening_plan_state = missingTarget.opening_plan_state!.filter(
    (row) => String(row.day).slice(0, 10) !== FRI,
  );
  await assertRejectedWith(missingTarget, "day adjustment target day plan state is missing or behind receipt");

  // 2. Duplicate day-exception revision (distinct clientKey so revision uniqueness check is exercised)
  const duplicateExc = structuredClone(snapshot.tables);
  const excRow = duplicateExc.opening_plan_drafts!.find(
    (row) => row.strategy_version === "day-exception-v1",
  )!;
  const dupClientKey = randomUUID();
  const dupExc = structuredClone(excRow);
  dupExc.id = randomUUID();
  dupExc.propose_client_key = `day-exception:${dupClientKey}`;
  ((dupExc.input_snapshot as Record<string, unknown>).dayException as Record<string, unknown>).clientKey = dupClientKey;
  duplicateExc.opening_plan_drafts!.push(dupExc);
  await assertRejectedWith(duplicateExc, "duplicate day exception revision for localDate");

  // 3. Stripped strategy_version marker
  const stripped = structuredClone(snapshot.tables);
  const adjRow = stripped.opening_plan_drafts!.find(
    (row) => row.strategy_version === "day-adjustment-v1",
  )!;
  adjRow.strategy_version = null;
  await assertRejectedWith(stripped, "day adjustment draft marker mismatch");

  // 4. Dual-field strip (both strategy_version and input_snapshot.dayAdjustment cleared)
  const dualStripped = structuredClone(snapshot.tables);
  const dualAdj = dualStripped.opening_plan_drafts!.find(
    (row) => row.strategy_version === "day-adjustment-v1",
  )!;
  dualAdj.strategy_version = null;
  dualAdj.input_snapshot = {};
  await assertRejectedWith(dualStripped, "day adjustment draft marker mismatch");
});
