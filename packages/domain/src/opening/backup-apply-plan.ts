import { learningStateRestoreErrors, type OpeningRestoreLearningState } from "./backup-learning-state";
import {
  validateOpeningRestore,
  type OpeningBackup,
  type OpeningDeletionMark,
} from "./backup-policy";
import { isJournal, isRecord, isUuid } from "./backup-validation";

export type OpeningRestoreApplyPlan = {
  batches: Array<{ table: string; rows: number }>;
  objectCount: number;
};

type OpeningRestoreApplyOptions = {
  confirmLocalRestore: boolean;
  /** IDs already present in the target workspace, queried by the DB executor. */
  availableCourseIds?: readonly string[];
  /** Actual owner-scoped target state, not values read from the archive. */
  currentLearningState?: OpeningRestoreLearningState;
};

export type OpeningRestoreApplyPlanResult =
  | { ok: true; plan: OpeningRestoreApplyPlan }
  | { ok: false; code: "REQUIRES_EXPLICIT_CONFIRMATION" | "PREFLIGHT_REJECTED" | "JOURNAL_DRIFT"; errors: string[] };

/** Fixed dependency order derived from the migrations' foreign keys. Never reorder freely. */
const APPLY_ORDER = [
  "workspace_preferences",
  "courses",
  "opening_sources",
  "course_asset_memberships",
  "opening_source_versions",
  "opening_source_chunks",
  "opening_conversations",
  "opening_learning_sessions",
  "opening_problem_refs",
  "opening_learning_history_revisions",
  "opening_learning_item_versions",
  "opening_learning_attempts",
  "opening_turns",
  "opening_assistant_candidates",
  "opening_help_exposures",
  "opening_learning_observations",
  "opening_memories",
  "opening_privacy_exclusions",
  "opening_tasks",
  "opening_retest_activities",
  "opening_timetable_sessions",
  "opening_hard_blocks",
  "opening_plan_state",
  "opening_plan_drafts",
  "opening_plan_acceptances",
] as const;

function sameJournal(backup: OpeningBackup, current: readonly OpeningDeletionMark[]): boolean {
  const key = (mark: OpeningDeletionMark) => `${mark.sourceId.toLowerCase()}\u0000${new Date(mark.deletedAt).toISOString()}\u0000${mark.assetDeletedAt ? new Date(mark.assetDeletedAt).toISOString() : ""}`;
  if (backup.deletionJournal.length !== current.length) return false;
  const backupKeys = new Set(backup.deletionJournal.map(key));
  return current.every((mark) => backupKeys.has(key(mark)));
}

function courseReferences(tables: Record<string, unknown[]>): { ids: string[]; errors: string[] } {
  const ids = new Set<string>();
  const errors: string[] = [];
  for (const [table, rows] of Object.entries(tables)) {
    for (const row of rows) {
      if (!row || typeof row !== "object" || !("course_id" in row)) continue;
      const value = (row as Record<string, unknown>).course_id;
      if (value == null) continue;
      if (typeof value !== "string" || !isUuid(value)) {
        errors.push(`${table} has an invalid course reference`);
        continue;
      }
      ids.add(value.toLowerCase());
    }
  }
  return { ids: [...ids], errors };
}

/**
 * Plans a restore apply; it never executes one. Requires an explicit local confirmation
 * flag, the structural privacy preflight, and an unchanged current journal. The executor
 * must still re-verify the journal in its own transaction and never restore credentials,
 * sessions, queues, budgets, or paid jobs. Re-read current learning state in that transaction;
 * retain activation triggers and do not dispatch external jobs while restoring. A clean-target
 * plan does not prove that a future executor suppresses reminder backlog. This is not authorization.
 */
export function planOpeningRestoreApply(
  backup: unknown,
  currentDeletionJournal: readonly OpeningDeletionMark[],
  options: OpeningRestoreApplyOptions,
): OpeningRestoreApplyPlanResult {
  if (!isRecord(options) || options.confirmLocalRestore !== true) {
    return { ok: false, code: "REQUIRES_EXPLICIT_CONFIRMATION", errors: ["explicit local confirmation is required"] };
  }
  const preview = validateOpeningRestore(structuralCopy(backup), currentDeletionJournal);
  if (!preview.allowed) {
    return { ok: false, code: "PREFLIGHT_REJECTED", errors: preview.errors };
  }
  const journal = backup as OpeningBackup;
  const stateErrors = learningStateRestoreErrors(journal.tables, journal.workspaceId, options.currentLearningState);
  if (stateErrors.length) return { ok: false, code: "PREFLIGHT_REJECTED", errors: stateErrors };
  const references = courseReferences(journal.tables);
  const includedCourses = new Set((journal.tables.courses ?? []).map(row => String((row as Record<string, unknown>).id).toLowerCase()));
  references.ids = references.ids.filter(id => !includedCourses.has(id));
  if (references.errors.length) return { ok: false, code: "PREFLIGHT_REJECTED", errors: references.errors };
  if (references.ids.length) {
    if (options.availableCourseIds === undefined) {
      return { ok: false, code: "PREFLIGHT_REJECTED", errors: ["target course preflight is required before restoring course-linked records"] };
    }
    if (!Array.isArray(options.availableCourseIds)) {
      return { ok: false, code: "PREFLIGHT_REJECTED", errors: ["target course preflight returned an invalid course list"] };
    }
    const available = new Set<string>();
    for (const id of options.availableCourseIds) {
      if (typeof id !== "string" || !isUuid(id)) {
        return { ok: false, code: "PREFLIGHT_REJECTED", errors: ["target course preflight returned an invalid course identity"] };
      }
      available.add(id.toLowerCase());
    }
    const missing = references.ids.filter((id) => !available.has(id));
    if (missing.length) return { ok: false, code: "PREFLIGHT_REJECTED", errors: missing.map(id => `target workspace is missing course ${id}`) };
  }
  if (!isJournal(journal.deletionJournal) || !sameJournal(journal, currentDeletionJournal)) {
    return { ok: false, code: "JOURNAL_DRIFT", errors: ["current deletion journal diverged from the backup"] };
  }
  const tables = journal.tables;
  return {
    ok: true,
    plan: {
      batches: APPLY_ORDER.map((table) => ({ table, rows: (tables[table] as unknown[] | undefined)?.length ?? 0 })),
      objectCount: journal.objects.length,
    },
  };
}

function structuralCopy(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(structuralCopy);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, structuralCopy(child)]));
  }
  return value;
}
