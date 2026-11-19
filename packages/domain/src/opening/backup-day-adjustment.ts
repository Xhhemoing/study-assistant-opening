import {
  DAY_ADJUSTMENT_PROPOSE_KEY_PREFIX,
  DAY_ADJUSTMENT_SNAPSHOT_KIND,
  DAY_ADJUSTMENT_STRATEGY_VERSION,
  DAY_EXCEPTION_PROPOSE_KEY_PREFIX,
  DAY_EXCEPTION_SNAPSHOT_KIND,
  DAY_EXCEPTION_STRATEGY_VERSION,
  dayAdjustmentSnapshotSchema,
  dayExceptionSnapshotSchema,
  isReservedDayAdjustmentProposeKey,
  isReservedDayExceptionProposeKey,
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

function readDraftEvidence(row: Row) {
  const snapshot = isRecord(row.input_snapshot) ? row.input_snapshot : null;
  const reasons = isRecord(row.reasons) ? row.reasons : null;
  const summaryJson = isRecord(row.summary_json) ? row.summary_json : null;
  const proposeKey = typeof row.propose_client_key === "string" ? row.propose_client_key : "";

  const hasExceptionStrategy = row.strategy_version === DAY_EXCEPTION_STRATEGY_VERSION;
  const hasAdjustmentStrategy = row.strategy_version === DAY_ADJUSTMENT_STRATEGY_VERSION;
  const hasExceptionSnapshot = snapshot?.dayException !== undefined;
  const hasAdjustmentSnapshot = snapshot?.dayAdjustment !== undefined;
  const hasExceptionProposeKey = isReservedDayExceptionProposeKey(row.propose_client_key, row.strategy_version);
  const hasAdjustmentProposeKey = isReservedDayAdjustmentProposeKey(row.propose_client_key, row.strategy_version);
  const hasExceptionReasons = reasons?.dayException !== undefined || summaryJson?.dayException !== undefined;
  const hasAdjustmentReasons = reasons?.dayAdjustment !== undefined || summaryJson?.dayAdjustment !== undefined;

  const hasAnyException = hasExceptionStrategy || hasExceptionSnapshot || hasExceptionProposeKey || hasExceptionReasons;
  const hasAnyAdjustment = hasAdjustmentStrategy || hasAdjustmentSnapshot || hasAdjustmentProposeKey || hasAdjustmentReasons;

  return {
    snapshot,
    reasons,
    proposeKey,
    hasExceptionStrategy,
    hasAdjustmentStrategy,
    hasExceptionSnapshot,
    hasAdjustmentSnapshot,
    hasExceptionProposeKey,
    hasAdjustmentProposeKey,
    hasExceptionReasons,
    hasAdjustmentReasons,
    hasAnyException,
    hasAnyAdjustment,
  };
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

  // Structural cross-day draft reuse checks (fail-closed even if markers were stripped).
  const acceptanceDaysByDraftId = new Map<string, Set<string>>();
  for (const row of acceptanceRows) {
    if (!isUuid(row.draft_id)) continue;
    const id = row.draft_id.toLowerCase();
    const days = acceptanceDaysByDraftId.get(id) ?? new Set<string>();
    days.add(dateKey(row.day));
    acceptanceDaysByDraftId.set(id, days);
  }
  for (const days of acceptanceDaysByDraftId.values()) {
    if (days.size > 1) {
      errors.push("day adjustment acceptance draft spans multiple days");
      break;
    }
  }

  const relevantDrafts = draftRows.filter((row) => {
    const ev = readDraftEvidence(row);
    return ev.hasAnyException || ev.hasAnyAdjustment;
  });

  if (relevantDrafts.length === 0) return;

  const draftsById = new Map<string, Row>();
  for (const row of draftRows) {
    if (isUuid(row.id)) draftsById.set(row.id.toLowerCase(), row);
  }

  const statesByKey = new Map<string, Row>();
  const statesByWorkspace = new Map<string, Array<{ day: string; row: Row }>>();
  for (const row of stateRows) {
    if (!isUuid(row.workspace_id)) continue;
    const ws = row.workspace_id.toLowerCase();
    const day = dateKey(row.day);
    statesByKey.set(`${ws}/${day}`, row);
    const list = statesByWorkspace.get(ws) ?? [];
    list.push({ day, row });
    statesByWorkspace.set(ws, list);
  }

  const tasksById = new Map<string, Row>();
  for (const row of taskRows) {
    if (isUuid(row.id)) tasksById.set(row.id.toLowerCase(), row);
  }

  const retestsById = new Map<string, Row>();
  const retestsByWorkspaceTask = new Map<string, Row[]>();
  for (const row of retestRows) {
    if (isUuid(row.id)) retestsById.set(row.id.toLowerCase(), row);
    if (isUuid(row.workspace_id) && isUuid(row.task_id)) {
      const key = `${row.workspace_id.toLowerCase()}/${row.task_id.toLowerCase()}`;
      const list = retestsByWorkspaceTask.get(key) ?? [];
      list.push(row);
      retestsByWorkspaceTask.set(key, list);
    }
  }

  const acceptancesByDraftId = new Map<string, Row[]>();
  const accountedVersionsByScopeDay = new Map<string, { versions: Set<number>; maxVersion: number }>();
  const recordAccountedVersion = (workspaceId: string, ownerUserId: string, day: string, version: number) => {
    if (!Number.isSafeInteger(version) || version <= 0) return;
    const key = `${workspaceId}/${ownerUserId}/${day}`;
    const entry = accountedVersionsByScopeDay.get(key) ?? { versions: new Set<number>(), maxVersion: 0 };
    entry.versions.add(version);
    if (version > entry.maxVersion) entry.maxVersion = version;
    accountedVersionsByScopeDay.set(key, entry);
  };

  for (const row of acceptanceRows) {
    if (!isUuid(row.draft_id)) continue;
    const id = row.draft_id.toLowerCase();
    const list = acceptancesByDraftId.get(id) ?? [];
    list.push(row);
    acceptancesByDraftId.set(id, list);

    if (isUuid(row.workspace_id)) {
      const ws = row.workspace_id.toLowerCase();
      const linkedDraft = draftsById.get(id);
      if (linkedDraft && sameUuid(linkedDraft.workspace_id, ws) && isUuid(linkedDraft.owner_user_id)) {
        const owner = linkedDraft.owner_user_id.toLowerCase();
        const day = dateKey(row.day);
        recordAccountedVersion(ws, owner, day, Number(row.accepted_version));
        if (row.undone_at != null) {
          recordAccountedVersion(ws, owner, day, Number(row.undo_result_version));
        }
      }
    }
  }

  const validatedExceptions = new Map<string, ValidatedException>();
  const exceptionsByWorkspaceDay = new Map<string, ValidatedException[]>();
  const exceptionDayRevisionKeys = new Set<string>();
  const exceptionWorkspaceDayRevisionKeys = new Set<string>();
  const exceptionProposeKeys = new Set<string>();
  const adjustmentProposeKeys = new Set<string>();
  const adjustmentRows: Array<{ row: Row; snapshot: DayAdjustmentSnapshot }> = [];

  for (const row of relevantDrafts) {
    const ev = readDraftEvidence(row);

    if (ev.hasAnyException && ev.hasAnyAdjustment) {
      errors.push("day adjustment draft carries conflicting exception and adjustment markers");
      continue;
    }

    if (ev.hasAnyException && !(ev.hasExceptionStrategy && ev.hasExceptionSnapshot && ev.hasExceptionProposeKey && ev.hasExceptionReasons)) {
      errors.push("day exception draft marker mismatch");
      continue;
    }

    if (ev.hasAnyAdjustment && !(ev.hasAdjustmentStrategy && ev.hasAdjustmentSnapshot && ev.hasAdjustmentProposeKey && ev.hasAdjustmentReasons)) {
      errors.push("day adjustment draft marker mismatch");
      continue;
    }

    if (!isUuid(row.id) || !isUuid(row.workspace_id) || !isUuid(row.owner_user_id)) {
      errors.push("day adjustment draft identity or scope is invalid");
      continue;
    }

    const workspaceId = row.workspace_id.toLowerCase();
    const ownerUserId = row.owner_user_id.toLowerCase();

    if (ev.hasExceptionStrategy) {
      const parsed = dayExceptionSnapshotSchema.safeParse(ev.snapshot?.dayException);
      const parsedBlocks = plannedBlockSchema.array().safeParse(row.blocks ?? []);
      const suggestedTasks = Array.isArray(row.suggested_tasks) ? row.suggested_tasks : null;
      const reasonMarker = isRecord(ev.reasons?.dayException) ? ev.reasons.dayException : null;
      if (!parsed.success
        || !parsedBlocks.success
        || parsedBlocks.data.length !== 0
        || suggestedTasks === null
        || suggestedTasks.length !== 0
        || row.origin !== "user"
        || row.status !== "accepted"
        || !reasonMarker) {
        errors.push("day exception draft structure or snapshot is invalid");
        continue;
      }
      const exc = parsed.data;
      const expectedProposeKey = `${DAY_EXCEPTION_PROPOSE_KEY_PREFIX}${exc.clientKey}`;
      if (ev.proposeKey !== expectedProposeKey
        || reasonMarker.kind !== DAY_EXCEPTION_SNAPSHOT_KIND
        || reasonMarker.localDate !== exc.localDate
        || Number(reasonMarker.revision) !== exc.revision) {
        errors.push("day exception draft marker mismatch");
        continue;
      }
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
      const scopedProposeKey = `${workspaceId}/${ownerUserId}/${ev.proposeKey.toLowerCase()}`;
      if (exceptionProposeKeys.has(scopedProposeKey)) {
        errors.push("duplicate day exception propose_client_key");
        continue;
      }
      exceptionProposeKeys.add(scopedProposeKey);
      if ((acceptancesByDraftId.get(id)?.length ?? 0) > 0) {
        errors.push("day exception draft must not have an acceptance receipt");
        continue;
      }
      const workspaceDayRevKey = `${workspaceId}/${exc.localDate}/${exc.revision}`;
      const scopeDayRevKey = `${workspaceId}/${ownerUserId}/${exc.localDate}/${exc.revision}`;
      if (exceptionDayRevisionKeys.has(scopeDayRevKey) || exceptionWorkspaceDayRevisionKeys.has(workspaceDayRevKey)) {
        errors.push("duplicate day exception revision for localDate");
        continue;
      }
      exceptionDayRevisionKeys.add(scopeDayRevKey);
      exceptionWorkspaceDayRevisionKeys.add(workspaceDayRevKey);
      const entry: ValidatedException = {
        id,
        workspaceId,
        ownerUserId,
        snapshot: exc,
      };
      validatedExceptions.set(id, entry);
      const groupKey = `${entry.workspaceId}/${entry.ownerUserId}/${exc.localDate}`;
      const list = exceptionsByWorkspaceDay.get(groupKey) ?? [];
      list.push(entry);
      exceptionsByWorkspaceDay.set(groupKey, list);
      continue;
    }

    if (ev.hasAdjustmentStrategy) {
      const parsed = dayAdjustmentSnapshotSchema.safeParse(ev.snapshot?.dayAdjustment);
      const parsedBlocks = plannedBlockSchema.array().safeParse(row.blocks ?? []);
      const suggestedTasks = Array.isArray(row.suggested_tasks) ? row.suggested_tasks : null;
      const reasonMarker = isRecord(ev.reasons?.dayAdjustment) ? ev.reasons.dayAdjustment : null;
      if (!parsed.success
        || !parsedBlocks.success
        || suggestedTasks === null
        || suggestedTasks.length !== 0
        || row.origin !== "user"
        || row.status !== "accepted"
        || !reasonMarker) {
        errors.push("day adjustment draft structure or snapshot is invalid");
        continue;
      }
      const adj = parsed.data;
      const expectedProposeKey = `${DAY_ADJUSTMENT_PROPOSE_KEY_PREFIX}${String(row.id).toLowerCase()}`;
      if (!ev.proposeKey.startsWith(DAY_ADJUSTMENT_PROPOSE_KEY_PREFIX)
        || ev.proposeKey.toLowerCase() !== expectedProposeKey
        || reasonMarker.kind !== DAY_ADJUSTMENT_SNAPSHOT_KIND
        || reasonMarker.sourceDate !== adj.sourceDate
        || (reasonMarker.targetDate ?? null) !== adj.targetDate
        || !sameUuid(reasonMarker.exceptionDraftId, adj.exceptionDraftId)) {
        errors.push("day adjustment draft marker mismatch");
        continue;
      }
      const scopedProposeKey = `${workspaceId}/${ownerUserId}/${ev.proposeKey.toLowerCase()}`;
      if (adjustmentProposeKeys.has(scopedProposeKey)) {
        errors.push("duplicate day adjustment propose_client_key");
        continue;
      }
      adjustmentProposeKeys.add(scopedProposeKey);
      if (!sameBlockMultiset(parsedBlocks.data, adj.sourceDay.afterBlocks)) {
        errors.push("day adjustment draft blocks do not match sourceDay.afterBlocks");
        continue;
      }
      adjustmentRows.push({ row, snapshot: adj });
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
    if (exceptionEntry.snapshot.timeZone !== adj.timeZone) {
      errors.push("day adjustment timeZone does not match referenced day exception");
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
      const sourceAfterTaskIds = new Set(adj.sourceDay.afterBlocks.map((b) => b.taskId.toLowerCase()));
      const targetBeforeTaskIds = new Set(target.beforeBlocks.map((b) => b.taskId.toLowerCase()));
      const addedTargetTaskIds = target.addedBlocks.map((b) => b.taskId.toLowerCase());
      if (new Set(addedTargetTaskIds).size !== addedTargetTaskIds.length
        || addedTargetTaskIds.some((id) => !removedTaskIds.has(id))
        || addedTargetTaskIds.some((id) => sourceAfterTaskIds.has(id) || targetBeforeTaskIds.has(id))
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

    // Retest reschedules integrity & scope (forward + reverse completeness).
    let retestInvalid = false;
    const seenRetests = new Set<string>();
    const rescheduledRetestByTaskId = new Map<string, string>();
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
      rescheduledRetestByTaskId.set(item.taskId.toLowerCase(), retestId);
    }
    if (retestInvalid) {
      errors.push("day adjustment retest reschedule record is invalid");
      continue;
    }

    if (adj.targetDay) {
      let missingReverseRetest = false;
      for (const block of adj.targetDay.addedBlocks) {
        const taskId = block.taskId.toLowerCase();
        const matchingRetests = retestsByWorkspaceTask.get(`${workspaceId}/${taskId}`) ?? [];
        for (const retestRow of matchingRetests) {
          if (!sameUuid(retestRow.owner_user_id, ownerUserId)) {
            missingReverseRetest = true;
            break;
          }
          const recordedRetestId = rescheduledRetestByTaskId.get(taskId);
          if (!recordedRetestId || !sameUuid(retestRow.id, recordedRetestId)) {
            missingReverseRetest = true;
            break;
          }
        }
        if (missingReverseRetest) break;
      }
      if (missingReverseRetest) {
        errors.push("day adjustment missing retest reschedule record for moved retest task");
        continue;
      }
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
      continue;
    }

    if (adj.targetDay !== null && adj.targetDate !== null) {
      recordAccountedVersion(workspaceId, ownerUserId, adj.targetDate, adj.targetDay.afterVersion);
    }
  }

  // Cross-table stripping bypass guard: if a day has a validated day-exception, an unmarked accepted
  // draft on that day must not remove tasks that appear on a later day's opening_plan_state whose
  // accepted_version is not accounted for by an acceptance receipt (or validated adjustment) on
  // (workspace_id, owner_user_id, target_day).
  for (const row of draftRows) {
    if (!isUuid(row.id) || !isUuid(row.workspace_id) || !isUuid(row.owner_user_id)) continue;
    if (row.status !== "accepted") continue;
    const draftId = row.id.toLowerCase();
    if (validatedExceptions.has(draftId) || adjustmentDraftIds.has(draftId)) continue;
    const workspaceId = row.workspace_id.toLowerCase();
    const ownerUserId = row.owner_user_id.toLowerCase();
    const draftDay = dateKey(row.day);
    if (!exceptionsByWorkspaceDay.has(`${workspaceId}/${ownerUserId}/${draftDay}`)) continue;

    const receipts = acceptancesByDraftId.get(draftId) ?? [];
    if (receipts.length === 0) continue;
    const draftBlocksParsed = plannedBlockSchema.array().safeParse(row.blocks ?? []);
    if (!draftBlocksParsed.success) continue;
    const draftTaskIds = new Set(draftBlocksParsed.data.map((b) => b.taskId.toLowerCase()));

    const removedTaskIds = new Set<string>();
    for (const receipt of receipts) {
      const beforeParsed = plannedBlockSchema.array().safeParse(receipt.before_blocks ?? []);
      if (!beforeParsed.success) continue;
      for (const block of beforeParsed.data) {
        const taskId = block.taskId.toLowerCase();
        if (!draftTaskIds.has(taskId)) removedTaskIds.add(taskId);
      }
    }
    if (removedTaskIds.size === 0) continue;

    const wsStates = statesByWorkspace.get(workspaceId) ?? [];
    let strippedDetected = false;
    for (const stateEntry of wsStates) {
      if (stateEntry.day <= draftDay) continue;
      const stateVersion = Number(stateEntry.row.accepted_version);
      const accounted = accountedVersionsByScopeDay.get(`${workspaceId}/${ownerUserId}/${stateEntry.day}`);
      const hasMatchingVersionReceipt = Number.isSafeInteger(stateVersion)
        && stateVersion > 0
        && accounted !== undefined
        && accounted.versions.has(stateVersion)
        && stateVersion <= accounted.maxVersion;
      if (hasMatchingVersionReceipt) continue;
      const stateBlocksParsed = plannedBlockSchema.array().safeParse(stateEntry.row.accepted_blocks ?? []);
      if (!stateBlocksParsed.success) continue;
      if (stateBlocksParsed.data.some((b) => removedTaskIds.has(b.taskId.toLowerCase()))) {
        strippedDetected = true;
        break;
      }
    }
    if (strippedDetected) {
      errors.push("unmarked accepted draft appears to have stripped day adjustment markers");
    }
  }
}
