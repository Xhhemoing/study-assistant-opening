import {
  DAY_ADJUSTMENT_STRATEGY_VERSION,
  DAY_EXCEPTION_STRATEGY_VERSION,
  dayAdjustmentSnapshotSchema,
  dayExceptionSnapshotSchema,
  plannedBlockSchema,
  type DayAdjustmentSnapshot,
  type DayExceptionSnapshot,
  type PlannedBlock,
} from "@aistudy/contracts";
import { assertValidLocalDate, isInstantOnLocalDay, resolveLocalDayBounds, resolveWorkspaceTimeZone } from "./local-day-bounds";
import { isRecord, isUuid } from "./backup-validation";

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

function dateKey(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value ?? "").slice(0, 10);
}

function sameUuid(left: unknown, right: unknown): boolean {
  return isUuid(left) && isUuid(right) && left.toLowerCase() === right.toLowerCase();
}

function isoMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") return Date.parse(value);
  return Number.NaN;
}

function validTimeZone(value: string): string | null {
  try {
    const resolved = resolveWorkspaceTimeZone(value);
    return resolved === value.trim() ? resolved : null;
  } catch {
    return null;
  }
}

function validLocalDate(value: string): boolean {
  try {
    assertValidLocalDate(value);
    return true;
  } catch {
    return false;
  }
}

function blockSignature(block: PlannedBlock): string {
  return `${block.taskId.toLowerCase()}|${new Date(block.start).toISOString()}|${new Date(block.end).toISOString()}|${block.reason}`;
}

function sameBlockMultiset(left: readonly PlannedBlock[], right: readonly PlannedBlock[]): boolean {
  if (left.length !== right.length) return false;
  const a = left.map(blockSignature).sort();
  const b = right.map(blockSignature).sort();
  return a.every((value, index) => value === b[index]);
}

function blockWithinLocalDay(block: PlannedBlock, day: string, timeZone: string): boolean {
  const startMs = Date.parse(block.start);
  const endMs = Date.parse(block.end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return false;
  try {
    const { dayStart, nextDayStart } = resolveLocalDayBounds(day, timeZone);
    return startMs >= dayStart.getTime() && startMs < nextDayStart.getTime() && endMs <= nextDayStart.getTime();
  } catch {
    return false;
  }
}

function blocksOverlap(a: PlannedBlock, b: PlannedBlock): boolean {
  return Date.parse(a.start) < Date.parse(b.end) && Date.parse(a.end) > Date.parse(b.start);
}

function hasAnyOverlap(blocks: readonly PlannedBlock[]): boolean {
  const sorted = [...blocks].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  for (let index = 1; index < sorted.length; index += 1) {
    if (Date.parse(sorted[index]!.start) < Date.parse(sorted[index - 1]!.end)) return true;
  }
  return false;
}

type ValidatedException = {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  snapshot: DayExceptionSnapshot;
};

/**
 * Independent restore preflight for kernel-v2 Phase 2 day-exception & atomic cross-day
 * adjustment records. Legacy archives without day-exception/day-adjustment markers pass untouched.
 */
export function validateBackupDayAdjustment(tables: Tables, errors: string[]): void {
  const draftRows = tables.opening_plan_drafts ?? [];
  const stateRows = tables.opening_plan_state ?? [];
  const acceptanceRows = tables.opening_plan_acceptances ?? [];
  const taskRows = tables.opening_tasks ?? [];
  const retestRows = tables.opening_retest_activities ?? [];

  const relevantDrafts = draftRows.filter((row) => {
    const snapshot = isRecord(row.input_snapshot) ? row.input_snapshot : null;
    return row.strategy_version === DAY_EXCEPTION_STRATEGY_VERSION
      || row.strategy_version === DAY_ADJUSTMENT_STRATEGY_VERSION
      || snapshot?.dayException !== undefined
      || snapshot?.dayAdjustment !== undefined;
  });

  if (relevantDrafts.length === 0) return;

  const statesByKey = new Map<string, Row>();
  for (const row of stateRows) {
    if (!isUuid(row.workspace_id)) continue;
    const key = `${row.workspace_id.toLowerCase()}/${dateKey(row.day)}`;
    statesByKey.set(key, row);
  }

  const tasksById = new Map<string, Row>();
  for (const row of taskRows) {
    if (isUuid(row.id)) tasksById.set(row.id.toLowerCase(), row);
  }

  const retestsById = new Map<string, Row>();
  for (const row of retestRows) {
    if (isUuid(row.id)) retestsById.set(row.id.toLowerCase(), row);
  }

  const acceptancesByDraftId = new Map<string, Row[]>();
  for (const row of acceptanceRows) {
    if (!isUuid(row.draft_id)) continue;
    const id = row.draft_id.toLowerCase();
    const list = acceptancesByDraftId.get(id) ?? [];
    list.push(row);
    acceptancesByDraftId.set(id, list);
  }

  const validatedExceptions = new Map<string, ValidatedException>();
  const exceptionsByWorkspaceDay = new Map<string, ValidatedException[]>();
  const exceptionDayRevisionKeys = new Set<string>();
  const exceptionWorkspaceDayRevisionKeys = new Set<string>();
  const adjustmentRows: Array<{ row: Row; snapshot: DayAdjustmentSnapshot }> = [];

  for (const row of relevantDrafts) {
    const snapshot = isRecord(row.input_snapshot) ? row.input_snapshot : null;
    const hasExceptionStrategy = row.strategy_version === DAY_EXCEPTION_STRATEGY_VERSION;
    const hasAdjustmentStrategy = row.strategy_version === DAY_ADJUSTMENT_STRATEGY_VERSION;
    const hasExceptionSnapshot = snapshot?.dayException !== undefined;
    const hasAdjustmentSnapshot = snapshot?.dayAdjustment !== undefined;

    if ((hasExceptionStrategy || hasExceptionSnapshot) && (hasAdjustmentStrategy || hasAdjustmentSnapshot)) {
      errors.push("day adjustment draft carries conflicting exception and adjustment markers");
      continue;
    }

    if (hasExceptionStrategy !== hasExceptionSnapshot) {
      errors.push("day exception draft marker mismatch");
      continue;
    }

    if (hasAdjustmentStrategy !== hasAdjustmentSnapshot) {
      errors.push("day adjustment draft marker mismatch");
      continue;
    }

    if (!isUuid(row.id) || !isUuid(row.workspace_id) || !isUuid(row.owner_user_id)) {
      errors.push("day adjustment draft identity or scope is invalid");
      continue;
    }

    if (hasExceptionStrategy) {
      const parsed = dayExceptionSnapshotSchema.safeParse(snapshot?.dayException);
      const parsedBlocks = plannedBlockSchema.array().safeParse(row.blocks ?? []);
      const suggestedTasks = Array.isArray(row.suggested_tasks) ? row.suggested_tasks : null;
      if (!parsed.success
        || !parsedBlocks.success
        || parsedBlocks.data.length !== 0
        || suggestedTasks === null
        || suggestedTasks.length !== 0
        || row.origin !== "user"
        || row.status !== "accepted"
        || row.propose_client_key != null) {
        errors.push("day exception draft structure or snapshot is invalid");
        continue;
      }
      const exc = parsed.data;
      const tz = validTimeZone(exc.timeZone);
      if (!tz || !validLocalDate(exc.localDate) || dateKey(row.day) !== exc.localDate) {
        errors.push("day exception localDate or timeZone is invalid");
        continue;
      }
      if (!isInstantOnLocalDay(exc.effectiveAt, exc.localDate, tz)) {
        errors.push("day exception effectiveAt does not fall on its localDate in saved timeZone");
        continue;
      }
      if (exc.revision !== exc.expectedExceptionRevision + 1
        || Number(row.version) !== exc.revision
        || Number(row.base_version) !== exc.expectedExceptionRevision) {
        errors.push("day exception revision metadata is invalid");
        continue;
      }
      const id = row.id.toLowerCase();
      if (validatedExceptions.has(id)) {
        errors.push("day exception identity is duplicated");
        continue;
      }
      if ((acceptancesByDraftId.get(id)?.length ?? 0) > 0) {
        errors.push("day exception draft must not have an acceptance receipt");
        continue;
      }
      const workspaceDayRevKey = `${row.workspace_id.toLowerCase()}/${exc.localDate}/${exc.revision}`;
      const scopeDayRevKey = `${row.workspace_id.toLowerCase()}/${row.owner_user_id.toLowerCase()}/${exc.localDate}/${exc.revision}`;
      if (exceptionDayRevisionKeys.has(scopeDayRevKey) || exceptionWorkspaceDayRevisionKeys.has(workspaceDayRevKey)) {
        errors.push("duplicate day exception revision for localDate");
        continue;
      }
      exceptionDayRevisionKeys.add(scopeDayRevKey);
      exceptionWorkspaceDayRevisionKeys.add(workspaceDayRevKey);
      const entry: ValidatedException = {
        id,
        workspaceId: row.workspace_id.toLowerCase(),
        ownerUserId: row.owner_user_id.toLowerCase(),
        snapshot: exc,
      };
      validatedExceptions.set(id, entry);
      const groupKey = `${entry.workspaceId}/${entry.ownerUserId}/${exc.localDate}`;
      const list = exceptionsByWorkspaceDay.get(groupKey) ?? [];
      list.push(entry);
      exceptionsByWorkspaceDay.set(groupKey, list);
      continue;
    }

    if (hasAdjustmentStrategy) {
      const parsed = dayAdjustmentSnapshotSchema.safeParse(snapshot?.dayAdjustment);
      const parsedBlocks = plannedBlockSchema.array().safeParse(row.blocks ?? []);
      const suggestedTasks = Array.isArray(row.suggested_tasks) ? row.suggested_tasks : null;
      if (!parsed.success
        || !parsedBlocks.success
        || suggestedTasks === null
        || suggestedTasks.length !== 0
        || row.origin !== "user"
        || row.status !== "accepted"
        || row.propose_client_key != null) {
        errors.push("day adjustment draft structure or snapshot is invalid");
        continue;
      }
      if (!sameBlockMultiset(parsedBlocks.data, parsed.data.sourceDay.afterBlocks)) {
        errors.push("day adjustment draft blocks do not match sourceDay.afterBlocks");
        continue;
      }
      adjustmentRows.push({ row, snapshot: parsed.data });
    }
  }

  // Verify each (workspace, owner, localDate) exception revision chain is contiguous starting at 1.
  for (const chain of exceptionsByWorkspaceDay.values()) {
    const sorted = [...chain].sort((a, b) => a.snapshot.revision - b.snapshot.revision);
    for (let index = 0; index < sorted.length; index += 1) {
      const expectedRev = index + 1;
      const item = sorted[index]!;
      if (item.snapshot.revision !== expectedRev || item.snapshot.expectedExceptionRevision !== expectedRev - 1) {
        errors.push("day exception revision chain is discontinuous");
        break;
      }
    }
  }

  const changedDayVersionClaims = new Set<string>();
  const adjustmentDraftIds = new Set<string>();

  for (const { row, snapshot: adj } of adjustmentRows) {
    const draftId = String(row.id).toLowerCase();
    const workspaceId = String(row.workspace_id).toLowerCase();
    const ownerUserId = String(row.owner_user_id).toLowerCase();

    if (adjustmentDraftIds.has(draftId)) {
      errors.push("day adjustment draft identity is duplicated");
      continue;
    }
    adjustmentDraftIds.add(draftId);

    const tz = validTimeZone(adj.timeZone);
    if (!tz || !validLocalDate(adj.sourceDate) || dateKey(row.day) !== adj.sourceDate || adj.sourceDay.day !== adj.sourceDate) {
      errors.push("day adjustment sourceDate or timeZone is invalid");
      continue;
    }

    if (adj.sourceDay.afterVersion !== adj.sourceDay.beforeVersion + 1
      || Number(row.base_version) !== adj.sourceDay.beforeVersion
      || Number(row.version) !== adj.sourceDay.afterVersion) {
      errors.push("day adjustment source day version progression is invalid");
      continue;
    }

    const exceptionEntry = validatedExceptions.get(adj.exceptionDraftId.toLowerCase());
    if (!exceptionEntry
      || exceptionEntry.workspaceId !== workspaceId
      || exceptionEntry.ownerUserId !== ownerUserId
      || exceptionEntry.snapshot.localDate !== adj.sourceDate
      || exceptionEntry.snapshot.revision !== adj.exceptionRevision) {
      errors.push("day adjustment exception reference or scope is invalid");
      continue;
    }

    const keptBlocks = adj.sourceDay.keptBlocks ?? [];
    const removedBlocks = adj.sourceDay.removedBlocks ?? [];
    if (!sameBlockMultiset(adj.sourceDay.beforeBlocks, [...keptBlocks, ...removedBlocks])
      || !sameBlockMultiset(adj.sourceDay.afterBlocks, [...keptBlocks, ...adj.sourceDay.addedBlocks])) {
      errors.push("day adjustment source day block diff is inconsistent");
      continue;
    }

    if (new Set(adj.sourceDay.addedBlocks.map((b) => b.taskId.toLowerCase())).size !== adj.sourceDay.addedBlocks.length
      || adj.sourceDay.addedBlocks.some((b) => !blockWithinLocalDay(b, adj.sourceDate, tz))
      || hasAnyOverlap(adj.sourceDay.addedBlocks)
      || adj.sourceDay.addedBlocks.some((added) => keptBlocks.some((kept) => blocksOverlap(added, kept)))) {
      errors.push("day adjustment source added blocks are invalid");
      continue;
    }

    const sourceState = statesByKey.get(`${workspaceId}/${adj.sourceDate}`);
    if (!sourceState || !Number.isSafeInteger(Number(sourceState.accepted_version))
      || Number(sourceState.accepted_version) < adj.sourceDay.afterVersion) {
      errors.push("day adjustment source day plan state is missing or behind receipt");
      continue;
    }
    if (Number(sourceState.accepted_version) === adj.sourceDay.afterVersion) {
      const stateBlocks = plannedBlockSchema.array().safeParse(sourceState.accepted_blocks ?? []);
      if (!stateBlocks.success || !sameBlockMultiset(stateBlocks.data, adj.sourceDay.afterBlocks)) {
        errors.push("day adjustment source day plan state blocks do not match receipt");
        continue;
      }
    }

    const sourceClaimKey = `${workspaceId}/${adj.sourceDate}/${adj.sourceDay.afterVersion}`;
    if (changedDayVersionClaims.has(sourceClaimKey)) {
      errors.push("day adjustment duplicates source day accepted version");
      continue;
    }
    changedDayVersionClaims.add(sourceClaimKey);

    // Cross-owner check on all referenced tasks included in the archive.
    const referencedTaskIds = new Set<string>([
      ...adj.sourceDay.beforeBlocks.map((b) => b.taskId.toLowerCase()),
      ...adj.sourceDay.afterBlocks.map((b) => b.taskId.toLowerCase()),
      ...(adj.targetDay?.addedBlocks.map((b) => b.taskId.toLowerCase()) ?? []),
      ...adj.retestReschedules.map((r) => r.taskId.toLowerCase()),
    ]);
    let ownerMismatch = false;
    for (const taskId of referencedTaskIds) {
      const taskRow = tasksById.get(taskId);
      if (taskRow && (!sameUuid(taskRow.workspace_id, workspaceId) || !sameUuid(taskRow.owner_user_id, ownerUserId))) {
        ownerMismatch = true;
        break;
      }
    }
    if (ownerMismatch) {
      errors.push("day adjustment references a task owned by another user or workspace");
      continue;
    }

    // Target day validation (must match nullability and be atomically present in plan state).
    if ((adj.targetDate === null) !== (adj.targetDay === null)) {
      errors.push("day adjustment targetDate and targetDay mismatch");
      continue;
    }

    if (adj.targetDay !== null && adj.targetDate !== null) {
      const target = adj.targetDay;
      if (!validLocalDate(adj.targetDate)
        || target.day !== adj.targetDate
        || adj.targetDate <= adj.sourceDate
        || target.afterVersion !== target.beforeVersion + 1
        || target.addedBlocks.length === 0) {
        errors.push("day adjustment target day metadata or version progression is invalid");
        continue;
      }
      if (!sameBlockMultiset(target.afterBlocks, [...target.beforeBlocks, ...target.addedBlocks])) {
        errors.push("day adjustment target day block diff is inconsistent");
        continue;
      }
      const removedTaskIds = new Set(removedBlocks.map((b) => b.taskId.toLowerCase()));
      const addedTargetTaskIds = target.addedBlocks.map((b) => b.taskId.toLowerCase());
      if (new Set(addedTargetTaskIds).size !== addedTargetTaskIds.length
        || addedTargetTaskIds.some((id) => !removedTaskIds.has(id))
        || target.addedBlocks.some((b) => !blockWithinLocalDay(b, adj.targetDate!, tz))
        || hasAnyOverlap(target.addedBlocks)
        || target.addedBlocks.some((added) => target.beforeBlocks.some((existing) => blocksOverlap(added, existing)))) {
        errors.push("day adjustment target added blocks are invalid");
        continue;
      }
      const targetState = statesByKey.get(`${workspaceId}/${adj.targetDate}`);
      if (!targetState || !Number.isSafeInteger(Number(targetState.accepted_version))
        || Number(targetState.accepted_version) < target.afterVersion) {
        errors.push("day adjustment target day plan state is missing or behind receipt");
        continue;
      }
      if (Number(targetState.accepted_version) === target.afterVersion) {
        const stateBlocks = plannedBlockSchema.array().safeParse(targetState.accepted_blocks ?? []);
        if (!stateBlocks.success || !sameBlockMultiset(stateBlocks.data, target.afterBlocks)) {
          errors.push("day adjustment target day plan state blocks do not match receipt");
          continue;
        }
      }
      const targetClaimKey = `${workspaceId}/${adj.targetDate}/${target.afterVersion}`;
      if (changedDayVersionClaims.has(targetClaimKey)) {
        errors.push("day adjustment duplicates target day accepted version");
        continue;
      }
      changedDayVersionClaims.add(targetClaimKey);
    } else if (adj.retestReschedules.length > 0) {
      errors.push("day adjustment retest reschedules require a target day");
      continue;
    }

    // Retest reschedules integrity & scope.
    let retestInvalid = false;
    const seenRetests = new Set<string>();
    for (const item of adj.retestReschedules) {
      const retestId = item.retestId.toLowerCase();
      if (seenRetests.has(retestId) || item.afterVersion !== item.beforeVersion + 1) {
        retestInvalid = true;
        break;
      }
      seenRetests.add(retestId);
      const retestRow = retestsById.get(retestId);
      if (!retestRow
        || !sameUuid(retestRow.workspace_id, workspaceId)
        || !sameUuid(retestRow.owner_user_id, ownerUserId)
        || !sameUuid(retestRow.task_id, item.taskId)
        || !Number.isSafeInteger(Number(retestRow.version))
        || Number(retestRow.version) < item.afterVersion) {
        retestInvalid = true;
        break;
      }
      const targetBlock = adj.targetDay?.addedBlocks.find((b) => sameUuid(b.taskId, item.taskId));
      if (!targetBlock || isoMs(targetBlock.start) !== isoMs(item.afterScheduledStartAt)) {
        retestInvalid = true;
        break;
      }
      if (Number(retestRow.version) === item.afterVersion
        && isoMs(retestRow.scheduled_start_at) !== isoMs(item.afterScheduledStartAt)) {
        retestInvalid = true;
        break;
      }
    }
    if (retestInvalid) {
      errors.push("day adjustment retest reschedule record is invalid");
      continue;
    }

    // Unique acceptance receipt association.
    const receipts = acceptancesByDraftId.get(draftId) ?? [];
    if (receipts.length !== 1) {
      errors.push("day adjustment acceptance receipt is missing or duplicated");
      continue;
    }
    const receipt = receipts[0]!;
    const receiptBeforeBlocks = plannedBlockSchema.array().safeParse(receipt.before_blocks ?? []);
    if (!sameUuid(receipt.workspace_id, workspaceId)
      || receipt.client_key !== adj.clientKey
      || dateKey(receipt.day) !== adj.sourceDate
      || Number(receipt.accepted_version) !== adj.sourceDay.afterVersion
      || receipt.payload_hash !== adj.payloadHash
      || receipt.source !== "learner"
      || !receiptBeforeBlocks.success
      || !sameBlockMultiset(receiptBeforeBlocks.data, adj.sourceDay.beforeBlocks)) {
      errors.push("day adjustment acceptance receipt does not match adjustment snapshot");
    }
  }
}
