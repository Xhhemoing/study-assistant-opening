import { createHash, randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import {
  DAY_ADJUSTMENT_PROPOSE_KEY_PREFIX,
  DAY_ADJUSTMENT_SNAPSHOT_KIND,
  DAY_ADJUSTMENT_STRATEGY_VERSION,
  DAY_EXCEPTION_PROPOSE_KEY_PREFIX,
  DAY_EXCEPTION_SNAPSHOT_KIND,
  DAY_EXCEPTION_STRATEGY_VERSION,
  dayAdjustmentConfirmInputSchema,
  dayAdjustmentConfirmReceiptSchema,
  dayAdjustmentPreviewInputSchema,
  dayAdjustmentPreviewSchema,
  dayAdjustmentSnapshotSchema,
  dayExceptionDeclareInputSchema,
  dayExceptionReceiptSchema,
  dayExceptionSnapshotSchema,
  plannedBlockSchema,
  weekSessionSchema,
  type DayAdjustmentConfirmInput,
  type DayAdjustmentConfirmReceipt,
  type DayAdjustmentPreview,
  type DayAdjustmentQuickCandidate,
  type DayAdjustmentRetestReschedule,
  type DayAdjustmentRetestRevision,
  type DayAdjustmentSnapshot,
  type DayAdjustmentTaskRevision,
  type DayAdjustmentTaskSummary,
  type DayExceptionReceipt,
  type DayExceptionSnapshot,
  type OpeningPlanningSettings,
  type PlannedBlock,
  type Scope,
  type TimeBlock,
} from "@aistudy/contracts";
import {
  assertValidLocalDate,
  availableTimeSlots,
  deriveDayBlocks,
  findContinuousFreeSlot,
  localDateKeyInZone,
  resolveLocalDayBounds,
  resolveWorkspaceTimeZone,
} from "@aistudy/domain";
import { OpeningPlanError } from "./opening-plan-error";
import { dailyDraftAdvisoryLockKeys, fingerprintHardBlocks } from "./opening-plans";
import { lockWorkspaceLearningHistory, nextWorkspaceLearningHistoryRevision } from "./opening-learning-facts";
import {
  collectNonDaySpilloverBlocks,
  readOpeningLearningCapacity,
  type DayPlanEntry,
} from "./opening-learning-capacity";
import { evaluateDayPlanCapacity } from "./opening-learning-capacity-usage";
import { assertOpeningPlanConstraints } from "./opening-plan-constraints";
import { assertOpeningCourseRouteRetestReschedulable } from "./opening-course-route-retest-state";
import {
  effectivePlanningStartFloorMs,
  isBlockAllowedForTaskWindow,
  isBlockWithinLocalDay,
  projectCourseRoutePlanningWindow,
  readLockedTaskPlanningWindows,
  readWorkspacePlanningTimeZone,
  type CourseRoutePlanningWindowProjection,
} from "./opening-course-route-planning-window";

type Row = Record<string, unknown>;

export type DayAdjustmentFaultStage =
  | "after_source_state"
  | "after_target_state"
  | "after_retest"
  | "after_draft";

export type OpeningDayAdjustmentOptions = {
  clock?: () => Date;
  /** Test-only hook invoked inside Tx2 before commit to verify atomic rollback. */
  onBeforeCommit?: (stage: DayAdjustmentFaultStage) => Promise<void>;
};

const object = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};

function formatPlanDay(value: unknown): string {
  if (value instanceof Date) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, "0");
    const d = String(value.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const raw = String(value ?? "");
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1]!;
  throw new OpeningPlanError("VALIDATION", `invalid plan day: ${raw}`);
}

function addCalendarDays(dateKey: string, deltaDays: number): string {
  assertValidLocalDate(dateKey);
  const utcNoon = Date.parse(`${dateKey}T12:00:00.000Z`);
  return new Date(utcNoon + deltaDays * 86_400_000).toISOString().slice(0, 10);
}

function parseInstantMs(value: unknown): number | null {
  if (value == null) return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function toIsoOrNull(value: unknown): string | null {
  const ms = parseInstantMs(value);
  return ms === null ? null : new Date(ms).toISOString();
}

function normalizeBlock(block: PlannedBlock): PlannedBlock {
  return {
    taskId: block.taskId,
    start: new Date(block.start).toISOString(),
    end: new Date(block.end).toISOString(),
    reason: block.reason,
  };
}

function blockSignature(block: PlannedBlock): string {
  const normalized = normalizeBlock(block);
  return `${normalized.taskId.toLowerCase()}|${normalized.start}|${normalized.end}|${normalized.reason}`;
}

function sortBlocks(blocks: readonly PlannedBlock[]): PlannedBlock[] {
  return blocks
    .map(normalizeBlock)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.taskId.localeCompare(b.taskId));
}

function sameBlockMultiset(left: readonly PlannedBlock[], right: readonly PlannedBlock[]): boolean {
  if (left.length !== right.length) return false;
  const a = left.map(blockSignature).sort();
  const b = right.map(blockSignature).sort();
  return a.every((value, index) => value === b[index]);
}

function blocksOverlap(a: PlannedBlock, b: PlannedBlock): boolean {
  return Date.parse(a.start) < Date.parse(b.end) && Date.parse(a.end) > Date.parse(b.start);
}

function hasAnyOverlap(blocks: readonly PlannedBlock[]): boolean {
  const sorted = sortBlocks(blocks);
  for (let index = 1; index < sorted.length; index += 1) {
    if (Date.parse(sorted[index]!.start) < Date.parse(sorted[index - 1]!.end)) return true;
  }
  return false;
}

function assertValidTimeZoneStrict(value: string): string {
  let resolved: string;
  try {
    resolved = resolveWorkspaceTimeZone(value);
  } catch {
    throw new OpeningPlanError("VALIDATION", `invalid timeZone: ${value}`);
  }
  if (resolved !== value.trim()) {
    throw new OpeningPlanError("VALIDATION", `invalid timeZone: ${value}`);
  }
  return resolved;
}

/** Deterministic SHA-256 hash of a day-adjustment confirmation intent for idempotency checks. */
export function computeDayAdjustmentConfirmPayloadHash(input: DayAdjustmentConfirmInput): string {
  const canonical = {
    sourceDate: input.sourceDate,
    ...(input.targetDate && !input.targetActions ? { targetDate: input.targetDate } : {}),
    expectedTimeZone: input.expectedTimeZone.trim(),
    expectedExceptionRevision: input.expectedExceptionRevision,
    expectedBudgetRevision: input.expectedBudgetRevision,
    expectedSourceAcceptedVersion: input.expectedSourceAcceptedVersion,
    expectedTargetAcceptedVersion: input.expectedTargetAcceptedVersion ?? null,
    expectedTaskRevisions: [...input.expectedTaskRevisions]
      .map((item) => ({ taskId: item.taskId.toLowerCase(), version: item.version }))
      .sort((a, b) => a.taskId.localeCompare(b.taskId)),
    expectedRetestRevisions: [...input.expectedRetestRevisions]
      .map((item) => ({
        retestId: item.retestId.toLowerCase(),
        taskId: item.taskId.toLowerCase(),
        version: item.version,
        scheduledStartAt: item.scheduledStartAt ? new Date(item.scheduledStartAt).toISOString() : null,
      }))
      .sort((a, b) => a.retestId.localeCompare(b.retestId)),
    sourceActions: {
      keptBlocks: input.sourceActions.keptBlocks.map(blockSignature).sort(),
      removedBlocks: input.sourceActions.removedBlocks.map(blockSignature).sort(),
      addedBlocks: input.sourceActions.addedBlocks.map(blockSignature).sort(),
    },
    targetActions: input.targetActions
      ? {
          targetDate: input.targetActions.targetDate,
          addedBlocks: input.targetActions.addedBlocks.map(blockSignature).sort(),
        }
      : null,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function buildDayExceptionReceipt(
  id: string,
  snapshot: DayExceptionSnapshot,
  replayed: boolean,
): DayExceptionReceipt {
  return dayExceptionReceiptSchema.parse({
    id,
    localDate: snapshot.localDate,
    timeZone: snapshot.timeZone,
    effectiveAt: snapshot.effectiveAt,
    remainingMinutes: snapshot.remainingMinutes,
    expectedExceptionRevision: snapshot.expectedExceptionRevision,
    revision: snapshot.revision,
    replayed,
  });
}

function buildConfirmReceipt(
  draftId: string,
  snapshot: DayAdjustmentSnapshot,
  replayed: boolean,
): DayAdjustmentConfirmReceipt {
  return dayAdjustmentConfirmReceiptSchema.parse({
    draftId,
    clientKey: snapshot.clientKey,
    timeZone: snapshot.timeZone,
    confirmedAt: snapshot.confirmedAt,
    exceptionDraftId: snapshot.exceptionDraftId,
    exceptionRevision: snapshot.exceptionRevision,
    sourceDate: snapshot.sourceDate,
    sourceBeforeVersion: snapshot.sourceDay.beforeVersion,
    sourceAfterVersion: snapshot.sourceDay.afterVersion,
    sourceBlocks: snapshot.sourceDay.afterBlocks,
    targetDate: snapshot.targetDate,
    targetBeforeVersion: snapshot.targetDay?.beforeVersion ?? null,
    targetAfterVersion: snapshot.targetDay?.afterVersion ?? null,
    targetBlocks: snapshot.targetDay?.afterBlocks ?? null,
    retestReschedules: snapshot.retestReschedules,
    replayed,
  });
}

async function readDayConstraints(
  tx: Sql | TransactionSql,
  scope: Scope,
  day: string,
  timeZone: string,
  settings: OpeningPlanningSettings | null,
): Promise<{ constraints: TimeBlock[]; fingerprint: string }> {
  const { dayStart, nextDayStart } = resolveLocalDayBounds(day, timeZone);
  let constraints: TimeBlock[] = [];
  if (settings) {
    const sessions = await tx`
      SELECT course_name, course_id, weekday, weeks, start_period, end_period
      FROM opening_timetable_sessions
      WHERE workspace_id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
      ORDER BY weekday, start_period`;
    constraints = deriveDayBlocks(
      day,
      settings,
      sessions.map((row) =>
        weekSessionSchema.parse({
          courseName: row.course_name,
          courseId: row.course_id ?? null,
          weekday: Number(row.weekday),
          weeks: row.weeks,
          startPeriod: Number(row.start_period),
          endPeriod: Number(row.end_period),
        }),
      ),
    );
  } else {
    constraints = [{ start: dayStart.toISOString(), end: nextDayStart.toISOString(), kind: "free" }];
  }
  const locked = await tx`
    SELECT start_at, end_at, kind
    FROM opening_hard_blocks
    WHERE workspace_id = ${scope.workspaceId}
      AND owner_user_id = ${scope.ownerUserId}
      AND day = ${day}::date
      AND kind <> 'free'
      AND (kind = 'locked' OR ${settings == null})`;
  for (const row of locked) {
    constraints.push({
      start: new Date(row.start_at as string | Date).toISOString(),
      end: new Date(row.end_at as string | Date).toISOString(),
      kind: (row.kind ?? "locked") as TimeBlock["kind"],
    });
  }
  return { constraints, fingerprint: fingerprintHardBlocks(constraints) };
}

function computeFreeSlots(
  constraints: readonly TimeBlock[],
  occupiedBlocks: readonly PlannedBlock[],
  earliestMs: number,
  dayStartMs: number,
  nextDayStartMs: number,
): TimeBlock[] {
  const rawFree = availableTimeSlots([
    ...constraints,
    ...occupiedBlocks.map((block) => ({ start: block.start, end: block.end, kind: "locked" as const })),
  ]);
  const floorMs = Math.max(earliestMs, dayStartMs);
  const clipped: TimeBlock[] = [];
  for (const slot of rawFree) {
    const start = Math.max(Date.parse(slot.start), floorMs);
    const end = Math.min(Date.parse(slot.end), nextDayStartMs);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      clipped.push({
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        kind: "free",
      });
    }
  }
  return clipped;
}

function subtractBlockFromFreeSlots(freeSlots: readonly TimeBlock[], block: PlannedBlock): TimeBlock[] {
  return availableTimeSlots([
    ...freeSlots,
    { start: block.start, end: block.end, kind: "locked" as const },
  ]);
}

type TaskPreviewRecord = {
  id: string;
  title: string;
  minutes: number;
  priority: number;
  version: number;
  status: string;
  courseId: string | null;
  retestId: string | null;
  retestVersion: number | null;
  retestStatus: string | null;
  retestScheduledStartAt: string | null;
  retestNotBeforeAt: string | null;
  retestSnoozedUntil: string | null;
  retestDeadlineAt: string | null;
  window: CourseRoutePlanningWindowProjection;
};

const MAX_PREVIEW_ARRAY = 200;
const MAX_PREVIEW_REVISIONS = 400;
const MAX_PREVIEW_ISSUES = 50;
const ACTIVE_RETEST_STATUSES = new Set(["accepted", "in_progress"]);

function blockOverlapsRange(block: PlannedBlock, rangeStartMs: number, rangeEndMs: number): boolean {
  const startMs = Date.parse(block.start);
  const endMs = Date.parse(block.end);
  return Number.isFinite(startMs) && Number.isFinite(endMs) && startMs < rangeEndMs && endMs > rangeStartMs;
}

function collectTargetSpilloverBlocks(input: {
  targetDate: string;
  targetDayStartMs: number;
  targetNextDayStartMs: number;
  sourceDate: string;
  sourceBeforeBlocks: readonly PlannedBlock[];
  sourceAfterBlocks: readonly PlannedBlock[];
  targetBeforeBlocks: readonly PlannedBlock[];
  targetPlanEntries: readonly DayPlanEntry[];
}): PlannedBlock[] {
  const excludeSignatures = new Set<string>([
    ...input.targetBeforeBlocks.map(blockSignature),
    ...input.sourceBeforeBlocks.map(blockSignature),
  ]);
  const fromOtherDays = collectNonDaySpilloverBlocks({
    day: input.targetDate,
    dayStartMs: input.targetDayStartMs,
    nextDayStartMs: input.targetNextDayStartMs,
    planEntries: input.targetPlanEntries,
    excludeDays: new Set([input.sourceDate]),
    excludeBlockSignatures: excludeSignatures,
  });
  const fromSourceRetained = input.sourceAfterBlocks
    .filter((block) => blockOverlapsRange(block, input.targetDayStartMs, input.targetNextDayStartMs))
    .map(normalizeBlock);
  return sortBlocks([...fromOtherDays, ...fromSourceRetained]);
}

function effectiveQuickSlotBoundsMs(task: {
  window: CourseRoutePlanningWindowProjection;
  retestNotBeforeAt: string | null;
  retestSnoozedUntil: string | null;
  retestDeadlineAt: string | null;
}): { earliestMs: number | null; dueMs: number | null } {
  const floorCandidates = [
    effectivePlanningStartFloorMs(task.window),
    parseInstantMs(task.retestNotBeforeAt),
    parseInstantMs(task.retestSnoozedUntil),
  ].filter((value): value is number => value !== null);
  const earliestMs = floorCandidates.length ? Math.max(...floorCandidates) : null;

  const dueCandidates = [
    parseInstantMs(task.window.dueAt),
    parseInstantMs(task.retestDeadlineAt),
  ].filter((value): value is number => value !== null);
  const dueMs = dueCandidates.length ? Math.min(...dueCandidates) : null;
  return { earliestMs, dueMs };
}

function effectiveRescheduleBoundsMs(task: {
  window: CourseRoutePlanningWindowProjection;
  retestNotBeforeAt: string | null;
  retestSnoozedUntil: string | null;
  retestDeadlineAt: string | null;
}): { earliestMs: number | null; dueMs: number | null } {
  const floorCandidates = [
    parseInstantMs(task.window.notBefore),
    parseInstantMs(task.retestNotBeforeAt),
    parseInstantMs(task.retestSnoozedUntil),
  ].filter((value): value is number => value !== null);
  const earliestMs = floorCandidates.length ? Math.max(...floorCandidates) : null;

  const dueCandidates = [
    parseInstantMs(task.window.dueAt),
    parseInstantMs(task.retestDeadlineAt),
  ].filter((value): value is number => value !== null);
  const dueMs = dueCandidates.length ? Math.min(...dueCandidates) : null;
  return { earliestMs, dueMs };
}

export function createOpeningDayAdjustmentRepository(
  sql: Sql,
  options: OpeningDayAdjustmentOptions = {},
) {
  const clock = options.clock ?? (() => new Date());

  return {
    /**
     * Tx1: Declare today's remaining available minutes (e.g. 15 min).
     * Never mutates opening_plan_state; idempotent by clientKey (even after midnight).
     */
    async declareToday(scope: Scope, raw: unknown): Promise<DayExceptionReceipt> {
      const input = dayExceptionDeclareInputSchema.parse(raw);
      try {
        assertValidLocalDate(input.localDate);
      } catch {
        throw new OpeningPlanError("VALIDATION", `invalid localDate: ${input.localDate}`);
      }
      const expectedTz = assertValidTimeZoneStrict(input.expectedTimeZone);
      const proposeClientKey = `${DAY_EXCEPTION_PROPOSE_KEY_PREFIX}${input.clientKey}`;

      return sql.begin(async (tx) => {
        // Lock order: day advisory lock -> workspace learning history -> workspace row.
        const [a, b] = dailyDraftAdvisoryLockKeys(scope.workspaceId, input.localDate);
        await tx`SELECT pg_advisory_xact_lock(${a}, ${b})`;
        await lockWorkspaceLearningHistory(tx, scope);
        const [owner] = await tx`
          SELECT id FROM workspaces
          WHERE id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
          FOR UPDATE`;
        if (!owner) throw new OpeningPlanError("NOT_FOUND", "workspace not found");

        // Tenant-scoped idempotent replay check before clock/date checks (replays even after midnight).
        const [existing] = await tx`
          SELECT id, workspace_id, owner_user_id, day, version, base_version, strategy_version, input_snapshot, propose_client_key
          FROM opening_plan_drafts
          WHERE workspace_id = ${scope.workspaceId}
            AND owner_user_id = ${scope.ownerUserId}
            AND propose_client_key = ${proposeClientKey}
          FOR UPDATE`;
        if (existing) {
          if (existing.strategy_version !== DAY_EXCEPTION_STRATEGY_VERSION) {
            throw new OpeningPlanError("CONFLICT", "clientKey already used for a different request", "selection_mismatch");
          }
          const saved = dayExceptionSnapshotSchema.safeParse(object(existing.input_snapshot).dayException);
          if (!saved.success) {
            throw new OpeningPlanError("CONFLICT", "stored day exception record is invalid", "selection_mismatch");
          }
          const sameIntent = saved.data.clientKey === input.clientKey
            && saved.data.localDate === input.localDate
            && saved.data.timeZone === expectedTz
            && saved.data.expectedExceptionRevision === input.expectedExceptionRevision
            && saved.data.remainingMinutes === input.remainingMinutes;
          if (!sameIntent) {
            throw new OpeningPlanError("CONFLICT", "clientKey selection differs", "selection_mismatch");
          }
          return buildDayExceptionReceipt(String(existing.id), saved.data, true);
        }

        // CAS on exception revision for (workspace, owner, localDate) — acquire row locks before reading clock().
        const priorRows = await tx`
          SELECT id, version
          FROM opening_plan_drafts
          WHERE workspace_id = ${scope.workspaceId}
            AND owner_user_id = ${scope.ownerUserId}
            AND day = ${input.localDate}::date
            AND strategy_version = ${DAY_EXCEPTION_STRATEGY_VERSION}
          ORDER BY version DESC
          FOR UPDATE`;

        // Read clock ONLY after holding all locks and excluding idempotent replay.
        const now = clock();

        // Verify workspace timeZone and that localDate is still today.
        const currentTimeZone = await readWorkspacePlanningTimeZone(tx, scope);
        if (currentTimeZone !== expectedTz) {
          throw new OpeningPlanError("CONFLICT", "工作区时区已变化，请刷新后再声明今日可用时长。", "stale_version");
        }
        const today = localDateKeyInZone(now, currentTimeZone);
        if (input.localDate !== today) {
          throw new OpeningPlanError("CONFLICT", "仅能为今天声明当日临时可用时长，请刷新日期。", "stale_version");
        }

        const currentRevision = priorRows.length ? Number(priorRows[0]!.version) : 0;
        if (currentRevision !== input.expectedExceptionRevision) {
          throw new OpeningPlanError("CONFLICT", "今日临时可用时长已更新，请刷新后再提交。", "stale_version");
        }

        const draftId = randomUUID();
        const nextRevision = currentRevision + 1;
        const snapshot: DayExceptionSnapshot = dayExceptionSnapshotSchema.parse({
          kind: DAY_EXCEPTION_SNAPSHOT_KIND,
          clientKey: input.clientKey,
          localDate: input.localDate,
          timeZone: currentTimeZone,
          effectiveAt: now.toISOString(),
          remainingMinutes: input.remainingMinutes,
          expectedExceptionRevision: input.expectedExceptionRevision,
          revision: nextRevision,
        });
        const reasonsMarker = {
          dayException: {
            kind: DAY_EXCEPTION_SNAPSHOT_KIND,
            localDate: input.localDate,
            revision: nextRevision,
          },
        };

        await tx`
          INSERT INTO opening_plan_drafts (
            id, workspace_id, owner_user_id, day, version, base_version, status,
            blocks, unscheduled_task_ids, hard_blocks_fingerprint, input_snapshot,
            propose_client_key, origin, suggested_tasks, reasons, strategy_version
          ) VALUES (
            ${draftId}, ${scope.workspaceId}, ${scope.ownerUserId},
            ${input.localDate}::date, ${nextRevision}, ${input.expectedExceptionRevision},
            'accepted', '[]'::jsonb, '[]'::jsonb, '', ${tx.json({ dayException: snapshot })},
            ${proposeClientKey}, 'user', '[]'::jsonb, ${tx.json(reasonsMarker)}, ${DAY_EXCEPTION_STRATEGY_VERSION}
          )`;

        return buildDayExceptionReceipt(draftId, snapshot, false);
      });
    },

    /**
     * Read-only preview: computes diff, continuous free slots, indivisible quick candidates,
     * post-replacement capacity, usage_uncertain detection, and all expected revisions.
     */
    async preview(scope: Scope, raw: unknown = {}): Promise<DayAdjustmentPreview> {
      const input = dayAdjustmentPreviewInputSchema.parse(raw ?? {});
      const now = clock();

      return sql.begin("isolation level repeatable read read only", async (tx) => {
        const current = await readOpeningLearningCapacity(tx, scope, now);
        const timeZone = current.timeZone;
        const sourceDate = input.date ?? current.localDate;
        try {
          assertValidLocalDate(sourceDate);
        } catch {
          throw new OpeningPlanError("VALIDATION", `invalid date: ${sourceDate}`);
        }
        const sourceBounds = resolveLocalDayBounds(sourceDate, timeZone);
        const sourceCap = sourceDate === current.localDate
          ? current
          : await readOpeningLearningCapacity(tx, scope, sourceBounds.dayStart);
        const dayException = sourceCap.dayException;

        const targetDate = input.targetDate === null
          ? null
          : input.targetDate !== undefined
            ? input.targetDate
            : addCalendarDays(sourceDate, 1);
        if (targetDate !== null) {
          try {
            assertValidLocalDate(targetDate);
          } catch {
            throw new OpeningPlanError("VALIDATION", `invalid targetDate: ${targetDate}`);
          }
          if (targetDate <= sourceDate) {
            throw new OpeningPlanError("VALIDATION", "目标改期日期必须晚于当前日期。");
          }
        }

        const [sourcePlanRow] = await tx`
          SELECT accepted_version, accepted_blocks
          FROM opening_plan_state
          WHERE workspace_id = ${scope.workspaceId} AND day = ${sourceDate}::date`;
        const sourceAcceptedVersion = sourcePlanRow ? Number(sourcePlanRow.accepted_version) : 0;
        const sourceBeforeBlocks = sortBlocks(
          sourcePlanRow ? plannedBlockSchema.array().max(200).parse(sourcePlanRow.accepted_blocks ?? []) : [],
        );

        const sourceSpilloverBlocks = collectNonDaySpilloverBlocks({
          day: sourceDate,
          dayStartMs: sourceBounds.dayStart.getTime(),
          nextDayStartMs: sourceBounds.nextDayStart.getTime(),
          planEntries: sourceCap.planEntries,
          excludeBlockSignatures: new Set(sourceBeforeBlocks.map(blockSignature)),
        });
        const sourceSpilloverTaskIds = new Set(sourceSpilloverBlocks.map((b) => b.taskId));

        let targetCap: Awaited<ReturnType<typeof readOpeningLearningCapacity>> | null = null;
        let targetBounds: ReturnType<typeof resolveLocalDayBounds> | null = null;
        let targetAcceptedVersion: number | null = null;
        let targetBeforeBlocks: PlannedBlock[] = [];
        let targetNonSourceSpilloverBlocks: PlannedBlock[] = [];
        if (targetDate !== null) {
          targetBounds = resolveLocalDayBounds(targetDate, timeZone);
          targetCap = await readOpeningLearningCapacity(tx, scope, targetBounds.dayStart);
          const [targetPlanRow] = await tx`
            SELECT accepted_version, accepted_blocks
            FROM opening_plan_state
            WHERE workspace_id = ${scope.workspaceId} AND day = ${targetDate}::date`;
          targetAcceptedVersion = targetPlanRow ? Number(targetPlanRow.accepted_version) : 0;
          targetBeforeBlocks = sortBlocks(
            targetPlanRow ? plannedBlockSchema.array().max(200).parse(targetPlanRow.accepted_blocks ?? []) : [],
          );
          targetNonSourceSpilloverBlocks = collectNonDaySpilloverBlocks({
            day: targetDate,
            dayStartMs: targetBounds.dayStart.getTime(),
            nextDayStartMs: targetBounds.nextDayStart.getTime(),
            planEntries: targetCap.planEntries,
            excludeDays: new Set([sourceDate]),
            excludeBlockSignatures: new Set([
              ...targetBeforeBlocks.map(blockSignature),
              ...sourceBeforeBlocks.map(blockSignature),
            ]),
          });
        }
        const targetPreScheduledTaskIds = new Set<string>([
          ...targetBeforeBlocks.map((b) => b.taskId),
          ...targetNonSourceSpilloverBlocks.map((b) => b.taskId),
        ]);

        const [activeCourseRows, activeTaskRows, taskRows] = await Promise.all([
          tx`SELECT id FROM courses WHERE workspace_id = ${scope.workspaceId} AND archived_at IS NULL`,
          tx`SELECT create_intent->>'taskId' AS task_id FROM opening_teaching_activities
            WHERE workspace_id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
              AND status IN ('active', 'paused') AND create_intent->>'source' = 'task'`,
          tx`SELECT
              t.id, t.workspace_id, t.owner_user_id, t.title, t.minutes, t.priority, t.version, t.status,
              t.due_at, t.not_before, t.course_id, t.candidate_id, t.origin,
              a.id AS retest_activity_id, a.workspace_id AS retest_workspace_id, a.owner_user_id AS retest_owner_user_id,
              a.task_id AS retest_task_id, a.course_id AS retest_course_id, a.purpose AS retest_purpose,
              a.status AS retest_status, a.version AS retest_version, a.candidate_id AS retest_candidate_id,
              a.candidate_reference_id AS retest_candidate_reference_id, a.accept_client_key AS retest_accept_client_key,
              a.learning_protocol AS retest_learning_protocol, a.not_before_at AS retest_not_before_at,
              a.recommended_at AS retest_recommended_at, a.scheduled_start_at AS retest_scheduled_start_at,
              a.snoozed_until AS retest_snoozed_until, a.deadline_at AS retest_deadline_at,
              j.id AS retest_job_id, j.workspace_id AS retest_job_workspace_id, j.owner_user_id AS retest_job_owner_user_id,
              j.kind AS retest_job_kind, j.payload AS retest_job_payload, j.result AS retest_job_result
            FROM opening_tasks t
            LEFT JOIN opening_retest_activities a
              ON a.task_id = t.id AND a.workspace_id = t.workspace_id AND a.owner_user_id = t.owner_user_id
            LEFT JOIN opening_jobs j
              ON j.id = a.candidate_id AND j.workspace_id = t.workspace_id AND j.owner_user_id = t.owner_user_id AND j.kind = 'retest'
            WHERE t.workspace_id = ${scope.workspaceId} AND t.owner_user_id = ${scope.ownerUserId}
            ORDER BY t.id ASC`,
        ]);

        const activeCourseIds = new Set(activeCourseRows.map((row) => String(row.id)));
        const activeTeachingTaskIds = new Set(activeTaskRows.map((row) => String(row.task_id)));
        const taskMap = new Map<string, TaskPreviewRecord>();
        for (const rawRow of taskRows) {
          const row = rawRow as Row;
          const window = projectCourseRoutePlanningWindow(row, scope);
          taskMap.set(String(row.id), {
            id: String(row.id),
            title: String(row.title),
            minutes: Number(row.minutes),
            priority: Number(row.priority),
            version: Number(row.version),
            status: String(row.status),
            courseId: row.course_id ? String(row.course_id) : null,
            retestId: row.retest_activity_id ? String(row.retest_activity_id) : null,
            retestVersion: row.retest_version != null ? Number(row.retest_version) : null,
            retestStatus: row.retest_status ? String(row.retest_status) : null,
            retestScheduledStartAt: toIsoOrNull(row.retest_scheduled_start_at),
            retestNotBeforeAt: toIsoOrNull(row.retest_not_before_at),
            retestSnoozedUntil: toIsoOrNull(row.retest_snoozed_until),
            retestDeadlineAt: toIsoOrNull(row.retest_deadline_at),
            window,
          });
        }

        const effectiveAtMs = dayException ? Date.parse(dayException.effectiveAt) : now.getTime();
        const capacityBefore = evaluateDayPlanCapacity({
          day: { localDate: sourceDate, timeZone },
          budget: sourceCap.budget,
          dayException,
          activities: sourceCap.activities,
          tasks: sourceCap.tasks,
          afterBlocks: sortBlocks([...sourceBeforeBlocks, ...sourceSpilloverBlocks]),
        });

        const blockers: string[] = [];
        if (dayException && dayException.timeZone !== timeZone) {
          blockers.push("工作区时区已在声明今日可用时长后发生变化，请刷新并重新声明今日可用时长。");
        }
        if (targetCap?.dayException && targetCap.dayException.timeZone !== timeZone) {
          blockers.push("目标日期临时调整记录的时区与当前工作区时区不一致，请刷新核对。");
        }
        const hasExplicitDiff = input.moveTaskIds !== undefined || input.removeTaskIds !== undefined;
        let keptBlocks: PlannedBlock[] = [];
        let removedBlocks: PlannedBlock[] = [];
        let moveTaskIds: string[] = [];

        if (hasExplicitDiff) {
          const moveSet = new Set(input.moveTaskIds ?? []);
          const removeSet = new Set(input.removeTaskIds ?? []);
          const allRequested = new Set([...moveSet, ...removeSet]);
          const beforeTaskIds = new Set(sourceBeforeBlocks.map((b) => b.taskId));
          for (const id of allRequested) {
            if (!beforeTaskIds.has(id)) {
              throw new OpeningPlanError("VALIDATION", "所选任务不在当日已接受安排中。");
            }
          }
          for (const block of sourceBeforeBlocks) {
            if (allRequested.has(block.taskId)) {
              if (Date.parse(block.end) <= effectiveAtMs) {
                blockers.push("已结束的历史时段不能移出，已自动保留。");
                keptBlocks.push(block);
              } else {
                removedBlocks.push(block);
              }
            } else {
              keptBlocks.push(block);
            }
          }
          moveTaskIds = [...moveSet].filter((id) => removedBlocks.some((b) => b.taskId === id));
        } else if (dayException && capacityBefore.shortfallMinutes > 0) {
          const fixedPast: PlannedBlock[] = [];
          const adjustableFuture: PlannedBlock[] = [];
          for (const block of sourceBeforeBlocks) {
            if (Date.parse(block.end) <= effectiveAtMs || activeTeachingTaskIds.has(block.taskId)) {
              fixedPast.push(block);
            } else {
              adjustableFuture.push(block);
            }
          }
          // Prefer keeping tasks that fit within availableLowerMinutes (higher priority, then shorter duration).
          let remainingForFuture = capacityBefore.availableLowerMinutes;
          const ordered = [...adjustableFuture].sort((a, b) => {
            const ta = taskMap.get(a.taskId);
            const tb = taskMap.get(b.taskId);
            const da = Math.max(0, (Date.parse(a.end) - Math.max(Date.parse(a.start), effectiveAtMs)) / 60_000);
            const db = Math.max(0, (Date.parse(b.end) - Math.max(Date.parse(b.start), effectiveAtMs)) / 60_000);
            const aFits = da <= remainingForFuture ? 0 : 1;
            const bFits = db <= remainingForFuture ? 0 : 1;
            if (aFits !== bFits) return aFits - bFits;
            if (da !== db) return da - db;
            return (tb?.priority ?? 0) - (ta?.priority ?? 0) || Date.parse(a.start) - Date.parse(b.start);
          });
          const keptIds = new Set<string>(fixedPast.map((b) => b.taskId));
          const movedIds: string[] = [];
          for (const block of ordered) {
            const postMinutes = Math.max(0, (Date.parse(block.end) - Math.max(Date.parse(block.start), effectiveAtMs)) / 60_000);
            if (postMinutes <= remainingForFuture + 1e-6) {
              keptIds.add(block.taskId);
              remainingForFuture -= postMinutes;
            } else {
              movedIds.push(block.taskId);
            }
          }
          keptBlocks = sourceBeforeBlocks.filter((b) => keptIds.has(b.taskId));
          removedBlocks = sourceBeforeBlocks.filter((b) => !keptIds.has(b.taskId));
          moveTaskIds = targetDate !== null ? movedIds : [];
        } else {
          keptBlocks = [...sourceBeforeBlocks];
          removedBlocks = [];
          moveTaskIds = [];
        }

        const sourceFloorMs = Math.max(now.getTime(), effectiveAtMs, sourceBounds.dayStart.getTime());
        const { constraints: sourceConstraints } = await readDayConstraints(
          tx,
          scope,
          sourceDate,
          timeZone,
          sourceCap.settings,
        );
        const sourceFreeSlotsAfterKept = computeFreeSlots(
          sourceConstraints,
          sortBlocks([...keptBlocks, ...sourceSpilloverBlocks]),
          sourceFloorMs,
          sourceBounds.dayStart.getTime(),
          sourceBounds.nextDayStart.getTime(),
        );

        const moveTaskIdSet = new Set(moveTaskIds);
        const sourceAddedBlocks: PlannedBlock[] = [];
        if (input.quickTaskId) {
          const quickTask = taskMap.get(input.quickTaskId);
          if (!quickTask || quickTask.status !== "pending") {
            blockers.push("所选快速任务不存在或已完成，无法安排到今日。");
          } else if (quickTask.courseId && !activeCourseIds.has(quickTask.courseId)) {
            blockers.push(`任务「${quickTask.title}」所属课程已归档，无法安排。`);
          } else if (activeTeachingTaskIds.has(quickTask.id)) {
            blockers.push(`任务「${quickTask.title}」正在进行中，无法重复安排。`);
          } else if (keptBlocks.some((b) => b.taskId === quickTask.id) || sourceSpilloverTaskIds.has(quickTask.id)) {
            blockers.push(`任务「${quickTask.title}」已在今日保留安排中。`);
          } else if (moveTaskIdSet.has(quickTask.id)) {
            blockers.push(`任务「${quickTask.title}」正在改期到目标日期，不能同时安排在今日。`);
          } else if (targetDate !== null && targetPreScheduledTaskIds.has(quickTask.id)) {
            blockers.push(`任务「${quickTask.title}」已在 ${targetDate} 的安排中，不能重复安排到今日。`);
          } else if (quickTask.retestId && !quickTask.window.retestActive) {
            blockers.push(`任务「${quickTask.title}」对应的复测已失效，无法安排。`);
          } else {
            const { earliestMs: taskFloorMs, dueMs } = effectiveQuickSlotBoundsMs(quickTask);
            const earliestMs = Math.max(sourceFloorMs, taskFloorMs ?? 0);
            const preferredStartMs = input.quickStartAt ? Date.parse(input.quickStartAt) : null;
            const slot = findContinuousFreeSlot({
              freeSlots: sourceFreeSlotsAfterKept,
              durationMinutes: quickTask.minutes,
              earliestMs,
              dueMs,
              preferredStartMs,
              confirmBufferNowMs: now.getTime(),
            });
            if (!slot) {
              blockers.push(`任务「${quickTask.title}」需要完整 ${quickTask.minutes} 分钟连续时段，无法截断放入今日剩余时间。`);
            } else {
              const candidateBlock: PlannedBlock = {
                taskId: quickTask.id,
                start: slot.start,
                end: slot.end,
                reason: "planned",
              };
              if (!isBlockAllowedForTaskWindow(candidateBlock, quickTask.window, sourceDate, timeZone)) {
                blockers.push(`任务「${quickTask.title}」不在今日允许的时间窗口内。`);
              } else {
                sourceAddedBlocks.push(candidateBlock);
              }
            }
          }
        }

        const sourceAfterBlocks = sortBlocks([...keptBlocks, ...sourceAddedBlocks]);
        const sourceFreeSlots = computeFreeSlots(
          sourceConstraints,
          sortBlocks([...sourceAfterBlocks, ...sourceSpilloverBlocks]),
          sourceFloorMs,
          sourceBounds.dayStart.getTime(),
          sourceBounds.nextDayStart.getTime(),
        );

        const targetSpilloverBlocks = targetDate !== null && targetCap !== null && targetBounds !== null
          ? collectTargetSpilloverBlocks({
              targetDate,
              targetDayStartMs: targetBounds.dayStart.getTime(),
              targetNextDayStartMs: targetBounds.nextDayStart.getTime(),
              sourceDate,
              sourceBeforeBlocks,
              sourceAfterBlocks,
              targetBeforeBlocks,
              targetPlanEntries: targetCap.planEntries,
            })
          : [];

        let targetFreeSlots: TimeBlock[] = [];
        const targetAddedBlocks: PlannedBlock[] = [];
        const unplacedMoveTaskIds: string[] = [];

        if (targetDate !== null && targetBounds !== null) {
          const { constraints: targetConstraints } = await readDayConstraints(
            tx,
            scope,
            targetDate,
            timeZone,
            sourceCap.settings,
          );
          const targetOccupiedBeforeBlocks = sortBlocks([...targetBeforeBlocks, ...targetSpilloverBlocks]);
          const targetFloorMs = Math.max(now.getTime(), targetBounds.dayStart.getTime());
          targetFreeSlots = computeFreeSlots(
            targetConstraints,
            targetOccupiedBeforeBlocks,
            targetFloorMs,
            targetBounds.dayStart.getTime(),
            targetBounds.nextDayStart.getTime(),
          );

          const placementByTaskId = new Map<string, number>();
          for (const placement of input.targetPlacements ?? []) {
            placementByTaskId.set(placement.taskId, Date.parse(placement.start));
          }
          if (input.targetStartAt && moveTaskIds.length === 1 && !placementByTaskId.has(moveTaskIds[0]!)) {
            placementByTaskId.set(moveTaskIds[0]!, Date.parse(input.targetStartAt));
          }

          let remainingTargetFree = [...targetFreeSlots];
          for (const taskId of moveTaskIds) {
            const task = taskMap.get(taskId);
            if (!task || task.status !== "pending") {
              unplacedMoveTaskIds.push(taskId);
              blockers.push("待移出任务不存在或已完成，无法改期。");
              continue;
            }
            if (task.courseId && !activeCourseIds.has(task.courseId)) {
              unplacedMoveTaskIds.push(taskId);
              blockers.push(`任务「${task.title}」所属课程已归档，无法改期。`);
              continue;
            }
            if (activeTeachingTaskIds.has(task.id)) {
              unplacedMoveTaskIds.push(taskId);
              blockers.push(`任务「${task.title}」正在学习中，无法改期。`);
              continue;
            }
            if (targetOccupiedBeforeBlocks.some((b) => b.taskId === task.id)) {
              unplacedMoveTaskIds.push(taskId);
              blockers.push(`任务「${task.title}」已在 ${targetDate} 的安排中。`);
              continue;
            }
            if (task.retestId && task.retestStatus !== "accepted") {
              unplacedMoveTaskIds.push(taskId);
              blockers.push(`复测「${task.title}」已开始或失效，无法改期。`);
              continue;
            }
            const { earliestMs: taskFloor, dueMs } = effectiveRescheduleBoundsMs(task);
            const earliestMs = Math.max(targetFloorMs, taskFloor ?? 0);
            const preferredStartMs = placementByTaskId.get(taskId) ?? null;
            const slot = findContinuousFreeSlot({
              freeSlots: remainingTargetFree,
              durationMinutes: task.minutes,
              earliestMs,
              dueMs,
              preferredStartMs,
            });
            if (!slot) {
              unplacedMoveTaskIds.push(taskId);
              blockers.push(`任务「${task.title}」需要完整 ${task.minutes} 分钟连续时段，${targetDate} 暂无合适空闲。`);
              continue;
            }
            const candidateBlock: PlannedBlock = {
              taskId: task.id,
              start: slot.start,
              end: slot.end,
              reason: "planned",
            };
            const effectiveWindow = task.retestId
              ? { ...task.window, scheduledStartAt: candidateBlock.start }
              : task.window;
            if (
              !isBlockWithinLocalDay(candidateBlock, targetDate, timeZone)
              || !isBlockAllowedForTaskWindow(candidateBlock, effectiveWindow, targetDate, timeZone)
            ) {
              unplacedMoveTaskIds.push(taskId);
              blockers.push(`任务「${task.title}」改期到 ${targetDate} 会超出允许的起止时间窗口。`);
              continue;
            }
            targetAddedBlocks.push(candidateBlock);
            remainingTargetFree = subtractBlockFromFreeSlots(remainingTargetFree, candidateBlock);
          }
        }

        const targetAfterBlocks = sortBlocks([...targetBeforeBlocks, ...targetAddedBlocks]);
        const movedToTargetTaskIds = new Set(targetAddedBlocks.map((b) => b.taskId));
        const capacityAfter = evaluateDayPlanCapacity({
          day: { localDate: sourceDate, timeZone },
          budget: sourceCap.budget,
          dayException,
          activities: sourceCap.activities,
          tasks: sourceCap.tasks,
          afterBlocks: sortBlocks([...sourceAfterBlocks, ...sourceSpilloverBlocks]),
          excludeTaskIds: movedToTargetTaskIds,
        });
        const targetCapacityAfter = targetDate !== null && targetCap !== null
          ? evaluateDayPlanCapacity({
              day: { localDate: targetDate, timeZone },
              budget: targetCap.budget,
              dayException: targetCap.dayException,
              activities: targetCap.activities,
              tasks: targetCap.tasks,
              afterBlocks: sortBlocks([...targetAfterBlocks, ...targetSpilloverBlocks]),
            })
          : null;

        if (capacityAfter.usageUncertain || targetCapacityAfter?.usageUncertain) {
          blockers.push("存在跨过今日临时调整时刻的学习记录，剩余可用时长暂无法准确确认，请先刷新核对。");
        }
        if (capacityAfter.shortfallMinutes > 0) {
          blockers.push(`今日安排仍超出剩余可用时长 ${capacityAfter.shortfallMinutes} 分钟，请先移出更多任务。`);
        }
        if (targetCapacityAfter && targetCapacityAfter.shortfallMinutes > 0) {
          blockers.push(`目标日期 ${targetDate} 的剩余预算不足，缺口 ${targetCapacityAfter.shortfallMinutes} 分钟。`);
        }

        // Compute indivisible quick-slot candidates against keptBlocks + movedToTargetTaskIds.
        const keptTaskIds = new Set(keptBlocks.map((b) => b.taskId));
        const removedTaskIds = new Set(removedBlocks.map((b) => b.taskId));
        const quickCandidates: DayAdjustmentQuickCandidate[] = [];
        for (const task of taskMap.values()) {
          if (task.status !== "pending") continue;
          if (keptTaskIds.has(task.id) || removedTaskIds.has(task.id)) continue;
          if (sourceSpilloverTaskIds.has(task.id)) continue;
          if (targetDate !== null && targetPreScheduledTaskIds.has(task.id)) continue;
          if (task.courseId && !activeCourseIds.has(task.courseId)) continue;
          if (activeTeachingTaskIds.has(task.id)) continue;
          if (task.retestId && !task.window.retestActive) continue;

          const { earliestMs: taskFloorMs, dueMs } = effectiveQuickSlotBoundsMs(task);
          const earliestMs = Math.max(sourceFloorMs, taskFloorMs ?? 0);
          const slot = findContinuousFreeSlot({
            freeSlots: sourceFreeSlotsAfterKept,
            durationMinutes: task.minutes,
            earliestMs,
            dueMs,
            confirmBufferNowMs: now.getTime(),
          });
          const candidateBlock = slot
            ? { taskId: task.id, start: slot.start, end: slot.end, reason: "planned" as const }
            : null;
          const windowOk = candidateBlock
            ? isBlockAllowedForTaskWindow(candidateBlock, task.window, sourceDate, timeZone)
            : false;
          const capWithCandidate = candidateBlock && windowOk
            ? evaluateDayPlanCapacity({
                day: { localDate: sourceDate, timeZone },
                budget: sourceCap.budget,
                dayException,
                activities: sourceCap.activities,
                tasks: sourceCap.tasks,
                afterBlocks: sortBlocks([...keptBlocks, ...sourceSpilloverBlocks, candidateBlock]),
                excludeTaskIds: movedToTargetTaskIds,
              })
            : null;

          if (candidateBlock && windowOk && capWithCandidate && !capWithCandidate.usageUncertain && capWithCandidate.shortfallMinutes === 0) {
            quickCandidates.push({
              taskId: task.id,
              title: task.title,
              minutes: task.minutes,
              version: task.version,
              fits: true,
              shortfallMinutes: 0,
              reason: `完整 ${task.minutes} 分钟可放入今日剩余连续空闲时段。`,
              suggestedSlot: slot,
            });
          } else {
            const capShortfall = capWithCandidate?.shortfallMinutes
              ?? Math.max(0, task.minutes - capacityAfter.availableUpperMinutes);
            const reason = capWithCandidate?.usageUncertain
              ? "当前存在跨时段记录，剩余可用时长暂不确定。"
              : capShortfall > 0
                ? `需要完整 ${task.minutes} 分钟（不可截断），当前还差 ${Math.ceil(capShortfall)} 分钟。`
                : !slot
                  ? `需要完整 ${task.minutes} 分钟连续空闲时段，今日剩余时段不足。`
                  : "不在今日允许的时间窗口内。";
            quickCandidates.push({
              taskId: task.id,
              title: task.title,
              minutes: task.minutes,
              version: task.version,
              fits: false,
              shortfallMinutes: Math.round(capShortfall * 1000) / 1000,
              reason,
              suggestedSlot: null,
            });
          }
        }
        quickCandidates.sort((a, b) =>
          Number(b.fits) - Number(a.fits)
          || a.minutes - b.minutes
          || a.taskId.localeCompare(b.taskId),
        );
        let boundedQuickCandidates = quickCandidates.slice(0, MAX_PREVIEW_ARRAY);
        if (
          input.quickTaskId
          && !boundedQuickCandidates.some((item) => item.taskId === input.quickTaskId)
        ) {
          const selectedCandidate = quickCandidates.find((item) => item.taskId === input.quickTaskId);
          if (selectedCandidate) {
            boundedQuickCandidates = [
              ...boundedQuickCandidates.slice(0, MAX_PREVIEW_ARRAY - 1),
              selectedCandidate,
            ];
          }
        }

        const requiredConfirmTaskIds = [...new Set([
          ...removedBlocks.map((b) => b.taskId),
          ...sourceAddedBlocks.map((b) => b.taskId),
          ...targetAddedBlocks.map((b) => b.taskId),
        ])].sort();
        const requiredConfirmTaskSet = new Set(requiredConfirmTaskIds);
        const remainingSourceTaskIds = [...new Set([
          ...sourceBeforeBlocks.map((b) => b.taskId),
          ...sourceAfterBlocks.map((b) => b.taskId),
        ])]
          .filter((id) => !requiredConfirmTaskSet.has(id))
          .sort();
        const sourceReferencedSet = new Set([
          ...requiredConfirmTaskIds,
          ...remainingSourceTaskIds,
        ]);
        const remainingTargetTaskIds = [...new Set([
          ...targetBeforeBlocks.map((b) => b.taskId),
          ...targetAfterBlocks.map((b) => b.taskId),
        ])]
          .filter((id) => !sourceReferencedSet.has(id))
          .sort();
        const boundedReferencedTaskIds = [
          ...requiredConfirmTaskIds,
          ...remainingSourceTaskIds,
          ...remainingTargetTaskIds,
        ]
          .slice(0, MAX_PREVIEW_REVISIONS)
          .sort();
        const boundedReferencedTaskSet = new Set(boundedReferencedTaskIds);
        if (
          requiredConfirmTaskIds.length > MAX_PREVIEW_REVISIONS
          || requiredConfirmTaskIds.some((id) => !boundedReferencedTaskSet.has(id))
        ) {
          blockers.push("本次调整涉及的变更任务数量超出单次确认上限，请分批调整后再确认。");
        }

        const taskRevisions: DayAdjustmentTaskRevision[] = [];
        const retestRevisions: DayAdjustmentRetestRevision[] = [];
        const tasks: DayAdjustmentTaskSummary[] = [];
        for (const taskId of boundedReferencedTaskIds) {
          const task = taskMap.get(taskId);
          if (!task) continue;
          taskRevisions.push({ taskId: task.id, version: task.version });
          if (task.retestId && task.retestVersion != null) {
            retestRevisions.push({
              retestId: task.retestId,
              taskId: task.id,
              version: task.retestVersion,
              scheduledStartAt: task.retestScheduledStartAt,
            });
          }
          tasks.push({
            taskId: task.id,
            title: task.title,
            minutes: task.minutes,
            version: task.version,
            isRetest: task.retestId !== null,
            retestId: task.retestId,
            retestVersion: task.retestVersion,
            retestScheduledStartAt: task.retestScheduledStartAt,
            dueAt: task.window.dueAt,
            notBefore: task.window.notBefore,
          });
        }
        retestRevisions.sort((a, b) => a.retestId.localeCompare(b.retestId));

        const hasChanges = removedBlocks.length > 0 || sourceAddedBlocks.length > 0 || targetAddedBlocks.length > 0;
        let status: DayAdjustmentPreview["status"];
        let canConfirm = false;
        if (!dayException) {
          status = "no_exception";
        } else if (capacityAfter.usageUncertain || targetCapacityAfter?.usageUncertain) {
          status = "usage_uncertain";
        } else if (
          capacityAfter.shortfallMinutes > 0
          || (targetCapacityAfter?.shortfallMinutes ?? 0) > 0
          || unplacedMoveTaskIds.length > 0
          || blockers.length > 0
        ) {
          status = "shortfall";
        } else if (!hasChanges) {
          status = "no_change";
        } else {
          status = "ready";
          canConfirm = true;
        }

        return dayAdjustmentPreviewSchema.parse({
          status,
          sourceDate,
          targetDate,
          timeZone,
          now: now.toISOString(),
          dayException: dayException ? buildDayExceptionReceipt(dayException.id, dayException, false) : null,
          exceptionRevision: dayException?.revision ?? 0,
          budgetRevision: sourceCap.budget?.revision ?? null,
          sourceAcceptedVersion,
          targetAcceptedVersion,
          sourceBeforeBlocks,
          sourceAfterBlocks,
          targetBeforeBlocks,
          targetAfterBlocks,
          keptBlocks,
          removedBlocks,
          sourceAddedBlocks,
          targetAddedBlocks,
          sourceFreeSlots: sourceFreeSlots.slice(0, MAX_PREVIEW_ARRAY),
          targetFreeSlots: targetFreeSlots.slice(0, MAX_PREVIEW_ARRAY),
          capacityBefore,
          capacityAfter,
          targetCapacityAfter,
          taskRevisions,
          retestRevisions,
          tasks,
          quickCandidates: boundedQuickCandidates,
          unplacedMoveTaskIds: unplacedMoveTaskIds.slice(0, MAX_PREVIEW_ISSUES),
          blockers: [...new Set(blockers)].slice(0, MAX_PREVIEW_ISSUES),
          canConfirm,
        });
      });
    },

    /**
     * Tx2: Atomically confirm same-day quick-slot replacement and/or cross-day reschedule
     * (including optional retest scheduled_start_at update) under strict lock ordering.
     */
    async confirm(scope: Scope, raw: unknown): Promise<DayAdjustmentConfirmReceipt> {
      const input = dayAdjustmentConfirmInputSchema.parse(raw);
      try {
        assertValidLocalDate(input.sourceDate);
      } catch {
        throw new OpeningPlanError("VALIDATION", `invalid sourceDate: ${input.sourceDate}`);
      }
      const expectedTz = assertValidTimeZoneStrict(input.expectedTimeZone);
      const targetActions = input.targetActions ?? null;
      const guardTargetDate = targetActions?.targetDate ?? input.targetDate ?? null;
      if (targetActions && input.targetDate && input.targetDate !== targetActions.targetDate) {
        throw new OpeningPlanError("VALIDATION", "targetDate must match targetActions.targetDate");
      }
      if (guardTargetDate !== null) {
        try {
          assertValidLocalDate(guardTargetDate);
        } catch {
          throw new OpeningPlanError("VALIDATION", `invalid targetDate: ${guardTargetDate}`);
        }
        if (guardTargetDate <= input.sourceDate) {
          throw new OpeningPlanError("VALIDATION", "targetDate must be after sourceDate");
        }
      }
      if (targetActions) {
        if (targetActions.addedBlocks.length === 0) {
          throw new OpeningPlanError("VALIDATION", "targetActions must include at least one block");
        }
        if (input.expectedTargetAcceptedVersion == null) {
          throw new OpeningPlanError("VALIDATION", "expectedTargetAcceptedVersion is required when targetActions is provided");
        }
      } else if (
        input.sourceActions.removedBlocks.length === 0
        && input.sourceActions.addedBlocks.length === 0
      ) {
        throw new OpeningPlanError("VALIDATION", "no adjustment changes to confirm");
      }

      const payloadHash = computeDayAdjustmentConfirmPayloadHash(input);
      const shouldGuardTarget =
        targetActions !== null
        || (guardTargetDate !== null && input.sourceActions.addedBlocks.length > 0);
      const lockDates = [...new Set([
        input.sourceDate,
        ...(shouldGuardTarget && guardTargetDate !== null ? [guardTargetDate] : []),
      ])].sort();

      return sql.begin(async (tx) => {
        // STRICT TX2 LOCK ORDER:
        // 1. Deduplicated involved dates in ascending YYYY-MM-DD order (dailyDraftAdvisoryLockKeys)
        for (const day of lockDates) {
          const [a, b] = dailyDraftAdvisoryLockKeys(scope.workspaceId, day);
          await tx`SELECT pg_advisory_xact_lock(${a}, ${b})`;
        }
        // 2. Workspace learning history revision lock
        await lockWorkspaceLearningHistory(tx, scope);
        // 3. Workspace row lock
        const [owner] = await tx`
          SELECT id FROM workspaces
          WHERE id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
          FOR UPDATE`;
        if (!owner) throw new OpeningPlanError("NOT_FOUND", "workspace not found");

        // 4. Persistent idempotency receipt check (after auth/workspace lock, before clock & fact re-checks)
        const [receipt] = await tx`
          SELECT draft_id, day, accepted_version, payload_hash, source
          FROM opening_plan_acceptances
          WHERE workspace_id = ${scope.workspaceId} AND client_key = ${input.clientKey}
          FOR UPDATE`;
        if (receipt) {
          if (receipt.payload_hash !== payloadHash) {
            throw new OpeningPlanError("CONFLICT", "clientKey selection differs", "selection_mismatch");
          }
          const [draftRow] = await tx`
            SELECT id, owner_user_id, strategy_version, input_snapshot
            FROM opening_plan_drafts
            WHERE id = ${receipt.draft_id} AND workspace_id = ${scope.workspaceId}`;
          if (
            !draftRow
            || String(draftRow.owner_user_id) !== scope.ownerUserId
            || draftRow.strategy_version !== DAY_ADJUSTMENT_STRATEGY_VERSION
          ) {
            throw new OpeningPlanError("CONFLICT", "clientKey already used for another operation", "selection_mismatch");
          }
          const saved = dayAdjustmentSnapshotSchema.safeParse(object(draftRow.input_snapshot).dayAdjustment);
          if (!saved.success) {
            throw new OpeningPlanError("CONFLICT", "stored day adjustment receipt is invalid", "selection_mismatch");
          }
          return buildConfirmReceipt(String(draftRow.id), saved.data, true);
        }

        // 5. Lock existing opening_plan_state rows in ascending day order (NEVER insert target row yet!)
        const lockedStates = await tx`
          SELECT day, accepted_version, accepted_blocks, hard_blocks_fingerprint
          FROM opening_plan_state
          WHERE workspace_id = ${scope.workspaceId} AND day = ANY(${lockDates}::date[])
          ORDER BY day ASC
          FOR UPDATE`;
        const stateByDay = new Map<string, Row>();
        for (const row of lockedStates) {
          stateByDay.set(formatPlanDay(row.day), row as Row);
        }

        const sourceStateRow = stateByDay.get(input.sourceDate) ?? null;
        const sourceBeforeVersion = sourceStateRow ? Number(sourceStateRow.accepted_version) : 0;
        const sourceBeforeBlocks = sortBlocks(
          sourceStateRow ? plannedBlockSchema.array().max(200).parse(sourceStateRow.accepted_blocks ?? []) : [],
        );
        if (sourceBeforeVersion !== input.expectedSourceAcceptedVersion) {
          throw new OpeningPlanError("CONFLICT", "当日计划版本已变化，请刷新后再确认。", "stale_version");
        }

        const targetStateRow = shouldGuardTarget && guardTargetDate !== null
          ? (stateByDay.get(guardTargetDate) ?? null)
          : null;
        const targetBeforeVersion = targetActions ? (targetStateRow ? Number(targetStateRow.accepted_version) : 0) : null;
        const targetBeforeBlocks = shouldGuardTarget
          ? sortBlocks(targetStateRow ? plannedBlockSchema.array().max(200).parse(targetStateRow.accepted_blocks ?? []) : [])
          : [];
        if (targetActions && targetBeforeVersion !== (input.expectedTargetAcceptedVersion ?? 0)) {
          throw new OpeningPlanError("CONFLICT", "目标日期计划版本已变化，请刷新后再确认。", "stale_version");
        }

        // Verify workspace timeZone, active dayException revision/timeZone, and budget revision.
        const timeZone = await readWorkspacePlanningTimeZone(tx, scope);
        if (timeZone !== expectedTz) {
          throw new OpeningPlanError("CONFLICT", "工作区时区已变化，请刷新后再确认。", "stale_version");
        }
        const sourceBounds = resolveLocalDayBounds(input.sourceDate, timeZone);
        const sourceCap = await readOpeningLearningCapacity(
          tx,
          scope,
          sourceBounds.dayStart,
        );
        if (!sourceCap.dayException || sourceCap.dayException.revision !== input.expectedExceptionRevision) {
          throw new OpeningPlanError("CONFLICT", "当日临时可用时长已变化，请刷新后再确认。", "stale_version");
        }
        if (sourceCap.dayException.timeZone !== timeZone) {
          throw new OpeningPlanError("CONFLICT", "今日临时调整记录的时区与当前工作区时区不一致，请重新声明今日剩余时长。", "stale_version");
        }
        if ((sourceCap.budget?.revision ?? null) !== input.expectedBudgetRevision) {
          throw new OpeningPlanError("CONFLICT", "工作区共同预算已变化，请刷新后再确认。", "stale_version");
        }

        const sourceSpilloverBlocks = collectNonDaySpilloverBlocks({
          day: input.sourceDate,
          dayStartMs: sourceBounds.dayStart.getTime(),
          nextDayStartMs: sourceBounds.nextDayStart.getTime(),
          planEntries: sourceCap.planEntries,
          excludeBlockSignatures: new Set(sourceBeforeBlocks.map(blockSignature)),
        });
        const sourceSpilloverTaskIds = new Set(sourceSpilloverBlocks.map((b) => b.taskId));

        const targetBounds = shouldGuardTarget && guardTargetDate !== null
          ? resolveLocalDayBounds(guardTargetDate, timeZone)
          : null;
        const targetCap = shouldGuardTarget && targetBounds
          ? await readOpeningLearningCapacity(tx, scope, targetBounds.dayStart)
          : null;
        if (targetActions && targetCap?.dayException && targetCap.dayException.timeZone !== timeZone) {
          throw new OpeningPlanError("CONFLICT", "目标日期临时调整记录的时区与当前工作区时区不一致，请刷新核对。", "stale_version");
        }
        const targetNonSourceSpilloverBlocks = shouldGuardTarget && guardTargetDate !== null && targetBounds && targetCap
          ? collectNonDaySpilloverBlocks({
              day: guardTargetDate,
              dayStartMs: targetBounds.dayStart.getTime(),
              nextDayStartMs: targetBounds.nextDayStart.getTime(),
              planEntries: targetCap.planEntries,
              excludeDays: new Set([input.sourceDate]),
              excludeBlockSignatures: new Set([
                ...targetBeforeBlocks.map(blockSignature),
                ...sourceBeforeBlocks.map(blockSignature),
              ]),
            })
          : [];
        const targetExistingTaskIds = new Set<string>([
          ...targetBeforeBlocks.map((b) => b.taskId),
          ...targetNonSourceSpilloverBlocks.map((b) => b.taskId),
        ]);

        // Verify structural source diff integrity.
        const keptBlocks = sortBlocks(input.sourceActions.keptBlocks);
        const removedBlocks = sortBlocks(input.sourceActions.removedBlocks);
        const sourceAddedBlocks = sortBlocks(input.sourceActions.addedBlocks);
        if (!sameBlockMultiset(sourceBeforeBlocks, [...keptBlocks, ...removedBlocks])) {
          throw new OpeningPlanError("CONFLICT", "当日已有安排已变化，请刷新后再确认。", "stale_version");
        }
        const effectiveAtMs = Date.parse(sourceCap.dayException.effectiveAt);
        if (removedBlocks.some((block) => Date.parse(block.end) <= effectiveAtMs)) {
          throw new OpeningPlanError("CONFLICT", "已结束的历史时段不能移出，请刷新核对。", "slot_expired");
        }

        const keptTaskIds = new Set(keptBlocks.map((b) => b.taskId));
        const sourceAddedTaskIds = sourceAddedBlocks.map((b) => b.taskId);
        if (
          new Set(sourceAddedTaskIds).size !== sourceAddedTaskIds.length
          || sourceAddedTaskIds.some((id) => keptTaskIds.has(id) || sourceSpilloverTaskIds.has(id))
          || (shouldGuardTarget && sourceAddedTaskIds.some((id) => targetExistingTaskIds.has(id)))
          || hasAnyOverlap(sourceAddedBlocks)
          || sourceAddedBlocks.some((added) =>
            keptBlocks.some((kept) => blocksOverlap(added, kept))
            || sourceSpilloverBlocks.some((existing) => blocksOverlap(added, existing)),
          )
        ) {
          throw new OpeningPlanError("CONFLICT", "当日新增时段与保留安排冲突，请重新选择。", "stale_version");
        }
        for (const block of sourceAddedBlocks) {
          if (!isBlockWithinLocalDay(block, input.sourceDate, timeZone)) {
            throw new OpeningPlanError("VALIDATION", "当日新增时段超出当日日期范围。");
          }
        }
        const sourceAfterBlocks = sortBlocks([...keptBlocks, ...sourceAddedBlocks]);
        const sourceAfterTaskIds = new Set(sourceAfterBlocks.map((b) => b.taskId));

        // Verify structural target diff integrity (when cross-day).
        const targetSpilloverBlocks = targetActions && targetBounds && targetCap
          ? collectTargetSpilloverBlocks({
              targetDate: targetActions.targetDate,
              targetDayStartMs: targetBounds.dayStart.getTime(),
              targetNextDayStartMs: targetBounds.nextDayStart.getTime(),
              sourceDate: input.sourceDate,
              sourceBeforeBlocks,
              sourceAfterBlocks,
              targetBeforeBlocks,
              targetPlanEntries: targetCap.planEntries,
            })
          : [];
        const targetOccupiedBeforeBlocks = targetActions
          ? sortBlocks([...targetBeforeBlocks, ...targetSpilloverBlocks])
          : [];
        const targetAddedBlocks = targetActions ? sortBlocks(targetActions.addedBlocks) : [];
        if (targetActions) {
          const removedTaskIds = new Set(removedBlocks.map((b) => b.taskId));
          const targetAddedTaskIds = targetAddedBlocks.map((b) => b.taskId);
          if (
            new Set(targetAddedTaskIds).size !== targetAddedTaskIds.length
            || targetAddedTaskIds.some((id) => !removedTaskIds.has(id))
            || targetAddedTaskIds.some((id) => sourceAfterTaskIds.has(id))
            || targetAddedTaskIds.some((id) => targetOccupiedBeforeBlocks.some((existing) => existing.taskId === id))
            || hasAnyOverlap(targetAddedBlocks)
            || targetAddedBlocks.some((added) => targetOccupiedBeforeBlocks.some((existing) => blocksOverlap(added, existing)))
          ) {
            throw new OpeningPlanError("CONFLICT", "目标日期安排冲突，请刷新后重新选择。", "stale_version");
          }
          for (const block of targetAddedBlocks) {
            if (!isBlockWithinLocalDay(block, targetActions.targetDate, timeZone)) {
              throw new OpeningPlanError("VALIDATION", "目标日期时段超出该日期本地时间范围。");
            }
          }
        }
        const targetAfterBlocks = targetActions ? sortBlocks([...targetBeforeBlocks, ...targetAddedBlocks]) : [];

        // 6. Lock relevant retest rows in ascending ID order, then lock tasks via #449 readLockedTaskPlanningWindows.
        const involvedTaskIds = [...new Set([
          ...sourceBeforeBlocks.map((b) => b.taskId),
          ...sourceAddedBlocks.map((b) => b.taskId),
          ...targetAddedBlocks.map((b) => b.taskId),
        ])].sort();

        const lockedRetests = involvedTaskIds.length
          ? await tx`
              SELECT id, task_id, course_id, status, version, scheduled_start_at, recommended_at,
                     not_before_at, snoozed_until, deadline_at, learning_protocol
              FROM opening_retest_activities
              WHERE workspace_id = ${scope.workspaceId}
                AND owner_user_id = ${scope.ownerUserId}
                AND task_id = ANY(${involvedTaskIds}::uuid[])
              ORDER BY id ASC
              FOR UPDATE`
          : [];
        const retestByTaskId = new Map<string, Row>();
        for (const row of lockedRetests) {
          retestByTaskId.set(String(row.task_id), row as Row);
        }

        const lockedTasks = await readLockedTaskPlanningWindows(tx, scope, involvedTaskIds);
        if (lockedTasks.length !== involvedTaskIds.length) {
          throw new OpeningPlanError("CONFLICT", "关联任务不存在或已变更，请刷新核对。", "task_changed");
        }
        const taskById = new Map(lockedTasks.map((item) => [item.id, item]));

        // Verify expected task revisions & retest revisions.
        const expectedTaskVersions = new Map(
          input.expectedTaskRevisions.map((item) => [item.taskId, item.version]),
        );
        const mutatedTaskIds = new Set<string>([
          ...removedBlocks.map((b) => b.taskId),
          ...sourceAddedBlocks.map((b) => b.taskId),
          ...targetAddedBlocks.map((b) => b.taskId),
        ]);
        for (const [taskId, expectedVersion] of expectedTaskVersions) {
          const actual = taskById.get(taskId);
          if (actual && actual.version !== expectedVersion) {
            throw new OpeningPlanError("CONFLICT", "任务版本已变化，请刷新后再确认。", "task_changed");
          }
        }
        for (const taskId of mutatedTaskIds) {
          const task = taskById.get(taskId);
          const expectedVersion = expectedTaskVersions.get(taskId);
          if (!task || expectedVersion === undefined || task.version !== expectedVersion || task.status !== "pending") {
            throw new OpeningPlanError("CONFLICT", "所选任务状态或版本已变化，请刷新后再确认。", "task_changed");
          }
        }

        // Check active courses & absence of active/paused task teaching activities for mutated tasks.
        const mutatedList = [...mutatedTaskIds];
        if (mutatedList.length) {
          const activeTeaching = await tx`
            SELECT create_intent->>'taskId' AS task_id
            FROM opening_teaching_activities
            WHERE workspace_id = ${scope.workspaceId}
              AND owner_user_id = ${scope.ownerUserId}
              AND status IN ('active', 'paused')
              AND create_intent->>'source' = 'task'
              AND create_intent->>'taskId' = ANY(${mutatedList})`;
          if (activeTeaching.length > 0) {
            throw new OpeningPlanError("CONFLICT", "所选任务正在学习中，不能改期或移除，请先结束当前学习。", "task_changed");
          }
          const courseRows = await tx`
            SELECT DISTINCT course_id
            FROM opening_tasks
            WHERE id = ANY(${mutatedList}::uuid[])
              AND workspace_id = ${scope.workspaceId}
              AND owner_user_id = ${scope.ownerUserId}
              AND course_id IS NOT NULL`;
          const courseIds = courseRows.map((row) => String(row.course_id));
          if (courseIds.length) {
            const activeCourses = await tx`
              SELECT id FROM courses
              WHERE id = ANY(${courseIds}::uuid[])
                AND workspace_id = ${scope.workspaceId}
                AND archived_at IS NULL
              FOR SHARE`;
            if (activeCourses.length !== courseIds.length) {
              throw new OpeningPlanError("CONFLICT", "任务关联的课程已归档，不能改期或安排。", "task_changed");
            }
          }
        }

        // Read clock ONLY after holding all locks and excluding idempotent replay.
        const now = clock();
        const sourceSlotFloorMs = Math.max(now.getTime(), effectiveAtMs);
        for (const block of sourceAddedBlocks) {
          if (Date.parse(block.start) < sourceSlotFloorMs) {
            throw new OpeningPlanError("CONFLICT", "所选今日时段已过期，请刷新后重新选择。", "slot_expired");
          }
        }
        if (targetActions) {
          for (const block of targetAddedBlocks) {
            if (Date.parse(block.start) < now.getTime()) {
              throw new OpeningPlanError("CONFLICT", "目标时段已过期，请刷新后重新选择。", "slot_expired");
            }
          }
        }

        const expectedRetestByTaskId = new Map(
          input.expectedRetestRevisions.map((item) => [item.taskId, item]),
        );

        // Verify indivisible duration and task planning windows for sourceAddedBlocks.
        for (const block of sourceAddedBlocks) {
          const task = taskById.get(block.taskId)!;
          const durationMs = Date.parse(block.end) - Date.parse(block.start);
          if (durationMs !== task.minutes * 60_000) {
            throw new OpeningPlanError("VALIDATION", `任务需要完整 ${task.minutes} 分钟连续时段，不能截断安排。`);
          }
          const retestRow = retestByTaskId.get(block.taskId);
          if (
            (task.window.hasRetestActivity && !task.window.retestActive)
            || (retestRow && !ACTIVE_RETEST_STATUSES.has(String(retestRow.status)))
          ) {
            throw new OpeningPlanError("CONFLICT", "关联复测已失效，不能安排到今日。", "task_changed");
          }
          const { earliestMs, dueMs } = effectiveQuickSlotBoundsMs({
            window: task.window,
            retestNotBeforeAt: retestRow ? toIsoOrNull(retestRow.not_before_at) : null,
            retestSnoozedUntil: retestRow ? toIsoOrNull(retestRow.snoozed_until) : null,
            retestDeadlineAt: retestRow ? toIsoOrNull(retestRow.deadline_at) : null,
          });
          const blockStartMs = Date.parse(block.start);
          const blockEndMs = Date.parse(block.end);
          if (
            (earliestMs !== null && blockStartMs < earliestMs)
            || (dueMs !== null && blockEndMs > dueMs)
            || !isBlockAllowedForTaskWindow(block, task.window, input.sourceDate, timeZone)
          ) {
            throw new OpeningPlanError("CONFLICT", "当日新增时段超出任务允许的时间窗口。", "task_changed");
          }
        }

        // Verify indivisible duration, task windows, and strict retest rescheduling for targetAddedBlocks.
        const retestReschedulesToApply: DayAdjustmentRetestReschedule[] = [];
        for (const block of targetAddedBlocks) {
          const task = taskById.get(block.taskId)!;
          const durationMs = Date.parse(block.end) - Date.parse(block.start);
          if (durationMs !== task.minutes * 60_000) {
            throw new OpeningPlanError("VALIDATION", `改期任务需要完整 ${task.minutes} 分钟连续时段，不能截断安排。`);
          }
          const retestRow = retestByTaskId.get(block.taskId);
          if (retestRow) {
            const expectedRetest = expectedRetestByTaskId.get(block.taskId);
            const currentScheduledIso = toIsoOrNull(retestRow.scheduled_start_at);
            if (
              !expectedRetest
              || expectedRetest.retestId !== String(retestRow.id)
              || expectedRetest.version !== Number(retestRow.version)
              || (expectedRetest.scheduledStartAt ? new Date(expectedRetest.scheduledStartAt).toISOString() : null) !== currentScheduledIso
            ) {
              throw new OpeningPlanError("CONFLICT", "复测预约版本已变化，请刷新后再确认。", "task_changed");
            }
            // Strictly verify accepted status, active course, course-route protocol & un-retracted baseline.
            try {
              await assertOpeningCourseRouteRetestReschedulable(tx, scope, String(retestRow.id), now);
            } catch (error) {
              const message = error instanceof Error ? error.message : "复测当前不可改约，请刷新核对。";
              throw new OpeningPlanError("CONFLICT", message, "task_changed");
            }
            const newStartMs = Date.parse(block.start);
            const newEndMs = Date.parse(block.end);
            const { earliestMs, dueMs } = effectiveRescheduleBoundsMs({
              window: task.window,
              retestNotBeforeAt: toIsoOrNull(retestRow.not_before_at),
              retestSnoozedUntil: toIsoOrNull(retestRow.snoozed_until),
              retestDeadlineAt: toIsoOrNull(retestRow.deadline_at),
            });
            const effectiveWindow = { ...task.window, scheduledStartAt: block.start };
            if (
              (earliestMs !== null && newStartMs < earliestMs)
              || (dueMs !== null && newEndMs > dueMs)
              || !isBlockAllowedForTaskWindow(block, effectiveWindow, targetActions!.targetDate, timeZone)
            ) {
              throw new OpeningPlanError("CONFLICT", "复测改约时间超出允许的最早开始时间或截止窗口。", "task_changed");
            }
            retestReschedulesToApply.push({
              retestId: String(retestRow.id),
              taskId: block.taskId,
              beforeVersion: Number(retestRow.version),
              afterVersion: Number(retestRow.version) + 1,
              beforeScheduledStartAt: currentScheduledIso,
              afterScheduledStartAt: new Date(newStartMs).toISOString(),
            });
          } else {
            if (!isBlockAllowedForTaskWindow(block, task.window, targetActions!.targetDate, timeZone)) {
              throw new OpeningPlanError("CONFLICT", "改期时段超出任务允许的时间窗口。", "task_changed");
            }
          }
        }
        retestReschedulesToApply.sort((a, b) => a.retestId.localeCompare(b.retestId));

        // Verify timetable and hard-block constraints on both days.
        if (sourceAddedBlocks.length > 0) {
          await assertOpeningPlanConstraints(
            tx,
            scope,
            input.sourceDate,
            sourceAddedBlocks,
            Boolean(sourceCap.settings),
          );
        }
        if (targetActions) {
          await assertOpeningPlanConstraints(
            tx,
            scope,
            targetActions.targetDate,
            targetAddedBlocks,
            Boolean(sourceCap.settings),
          );
        }

        // Verify post-replacement capacity on both days (fail-closed on shortfall or usageUncertain).
        const movedToTargetTaskIds = new Set(targetAddedBlocks.map((b) => b.taskId));
        const sourceEval = evaluateDayPlanCapacity({
          day: { localDate: input.sourceDate, timeZone },
          budget: sourceCap.budget,
          dayException: sourceCap.dayException,
          activities: sourceCap.activities,
          tasks: sourceCap.tasks,
          afterBlocks: sortBlocks([...sourceAfterBlocks, ...sourceSpilloverBlocks]),
          excludeTaskIds: movedToTargetTaskIds,
        });
        if (sourceEval.usageUncertain) {
          throw new OpeningPlanError("CONFLICT", "存在跨过今日临时调整时刻的学习记录，剩余可用时长暂无法确认，请先刷新核对。", "stale_version");
        }
        if (sourceEval.shortfallMinutes > 0) {
          throw new OpeningPlanError("CONFLICT", `调整后的今日安排仍超出可用时长 ${sourceEval.shortfallMinutes} 分钟，请继续调整。`, "stale_version");
        }

        if (targetActions && targetCap) {
          const targetEval = evaluateDayPlanCapacity({
            day: { localDate: targetActions.targetDate, timeZone },
            budget: targetCap.budget,
            dayException: targetCap.dayException,
            activities: targetCap.activities,
            tasks: targetCap.tasks,
            afterBlocks: sortBlocks([...targetAfterBlocks, ...targetSpilloverBlocks]),
          });
          if (targetEval.usageUncertain) {
            throw new OpeningPlanError("CONFLICT", "目标日期存在不确定的学习时长记录，暂无法确认改期。", "stale_version");
          }
          if (targetEval.shortfallMinutes > 0) {
            throw new OpeningPlanError("CONFLICT", `目标日期 ${targetActions.targetDate} 的剩余预算不足，缺口 ${targetEval.shortfallMinutes} 分钟。`, "stale_version");
          }
        }

        // ALL VALIDATIONS PASSED — ATOMIC COMMIT SECTION.
        const sourceAfterVersion = sourceBeforeVersion + 1;
        const { fingerprint: sourceFingerprint } = await readDayConstraints(
          tx,
          scope,
          input.sourceDate,
          timeZone,
          sourceCap.settings,
        );
        await tx`
          INSERT INTO opening_plan_state (workspace_id, day, accepted_version, accepted_blocks, hard_blocks_fingerprint, updated_at)
          VALUES (${scope.workspaceId}, ${input.sourceDate}::date, ${sourceAfterVersion}, ${tx.json(sourceAfterBlocks)}, ${sourceFingerprint}, now())
          ON CONFLICT (workspace_id, day) DO UPDATE
            SET accepted_version = EXCLUDED.accepted_version,
                accepted_blocks = EXCLUDED.accepted_blocks,
                hard_blocks_fingerprint = EXCLUDED.hard_blocks_fingerprint,
                updated_at = now()`;
        if (options.onBeforeCommit) await options.onBeforeCommit("after_source_state");

        let targetAfterVersion: number | null = null;
        if (targetActions) {
          targetAfterVersion = targetBeforeVersion! + 1;
          const { fingerprint: targetFingerprint } = await readDayConstraints(
            tx,
            scope,
            targetActions.targetDate,
            timeZone,
            sourceCap.settings,
          );
          await tx`
            INSERT INTO opening_plan_state (workspace_id, day, accepted_version, accepted_blocks, hard_blocks_fingerprint, updated_at)
            VALUES (${scope.workspaceId}, ${targetActions.targetDate}::date, ${targetAfterVersion}, ${tx.json(targetAfterBlocks)}, ${targetFingerprint}, now())
            ON CONFLICT (workspace_id, day) DO UPDATE
              SET accepted_version = EXCLUDED.accepted_version,
                  accepted_blocks = EXCLUDED.accepted_blocks,
                  hard_blocks_fingerprint = EXCLUDED.hard_blocks_fingerprint,
                  updated_at = now()`;
          if (options.onBeforeCommit) await options.onBeforeCommit("after_target_state");
        }

        if (retestReschedulesToApply.length > 0) {
          await nextWorkspaceLearningHistoryRevision(tx, scope);
          for (const item of retestReschedulesToApply) {
            const updatedRetests = await tx`
              UPDATE opening_retest_activities
              SET scheduled_start_at = ${item.afterScheduledStartAt}::timestamptz,
                  version = ${item.afterVersion},
                  updated_at = now()
              WHERE id = ${item.retestId}
                AND workspace_id = ${scope.workspaceId}
                AND owner_user_id = ${scope.ownerUserId}
                AND version = ${item.beforeVersion}
              RETURNING id`;
            if (!updatedRetests.length) {
              throw new OpeningPlanError("CONFLICT", "复测版本已并发变更，请刷新重试。", "task_changed");
            }
          }
          if (options.onBeforeCommit) await options.onBeforeCommit("after_retest");
        }

        const draftId = randomUUID();
        const confirmedAt = now.toISOString();
        const snapshot: DayAdjustmentSnapshot = dayAdjustmentSnapshotSchema.parse({
          kind: DAY_ADJUSTMENT_SNAPSHOT_KIND,
          clientKey: input.clientKey,
          payloadHash,
          confirmedAt,
          timeZone,
          sourceDate: input.sourceDate,
          targetDate: targetActions ? targetActions.targetDate : null,
          exceptionDraftId: sourceCap.dayException.id,
          exceptionRevision: sourceCap.dayException.revision,
          budgetRevision: sourceCap.budget?.revision ?? null,
          sourceDay: {
            day: input.sourceDate,
            beforeVersion: sourceBeforeVersion,
            afterVersion: sourceAfterVersion,
            beforeBlocks: sourceBeforeBlocks,
            afterBlocks: sourceAfterBlocks,
            keptBlocks,
            removedBlocks,
            addedBlocks: sourceAddedBlocks,
          },
          targetDay: targetActions
            ? {
                day: targetActions.targetDate,
                beforeVersion: targetBeforeVersion!,
                afterVersion: targetAfterVersion!,
                beforeBlocks: targetBeforeBlocks,
                afterBlocks: targetAfterBlocks,
                addedBlocks: targetAddedBlocks,
              }
            : null,
          retestReschedules: retestReschedulesToApply,
        });
        const adjustmentProposeKey = `${DAY_ADJUSTMENT_PROPOSE_KEY_PREFIX}${draftId}`;
        const adjustmentReasons = {
          dayAdjustment: {
            kind: DAY_ADJUSTMENT_SNAPSHOT_KIND,
            sourceDate: input.sourceDate,
            targetDate: targetActions ? targetActions.targetDate : null,
            exceptionDraftId: sourceCap.dayException.id,
          },
        };

        await tx`
          INSERT INTO opening_plan_drafts (
            id, workspace_id, owner_user_id, day, version, base_version, status,
            blocks, unscheduled_task_ids, hard_blocks_fingerprint, input_snapshot,
            propose_client_key, origin, suggested_tasks, reasons, strategy_version
          ) VALUES (
            ${draftId}, ${scope.workspaceId}, ${scope.ownerUserId},
            ${input.sourceDate}::date, ${sourceAfterVersion}, ${sourceBeforeVersion}, 'accepted',
            ${tx.json(sourceAfterBlocks)}, '[]'::jsonb, ${sourceFingerprint},
            ${tx.json({ dayAdjustment: snapshot })}, ${adjustmentProposeKey}, 'user', '[]'::jsonb,
            ${tx.json(adjustmentReasons)}, ${DAY_ADJUSTMENT_STRATEGY_VERSION}
          )`;
        if (options.onBeforeCommit) await options.onBeforeCommit("after_draft");

        await tx`
          INSERT INTO opening_plan_acceptances (
            workspace_id, client_key, draft_id, day, accepted_version, payload_hash,
            source, before_blocks, created_task_versions
          ) VALUES (
            ${scope.workspaceId}, ${input.clientKey}, ${draftId},
            ${input.sourceDate}::date, ${sourceAfterVersion}, ${payloadHash},
            'learner', ${tx.json(sourceBeforeBlocks)}, '{}'::jsonb
          )`;

        return buildConfirmReceipt(draftId, snapshot, false);
      });
    },
  };
}
