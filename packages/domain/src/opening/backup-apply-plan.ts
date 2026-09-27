import {
  validateOpeningRestore,
  type OpeningBackup,
  type OpeningDeletionMark,
} from "./backup-policy";
import { isJournal, isRecord } from "./backup-validation";

export type OpeningRestoreApplyPlan = {
  batches: Array<{ table: string; rows: number }>;
  objectCount: number;
};

export type OpeningRestoreApplyPlanResult =
  | { ok: true; plan: OpeningRestoreApplyPlan }
  | { ok: false; code: "REQUIRES_EXPLICIT_CONFIRMATION" | "PREFLIGHT_REJECTED" | "JOURNAL_DRIFT"; errors: string[] };

/** Fixed dependency order derived from the migrations' foreign keys. Never reorder freely. */
const APPLY_ORDER = [
  "opening_sources",
  "opening_source_chunks",
  "opening_conversations",
  "opening_turns",
  "opening_assistant_candidates",
  "opening_learning_sessions",
  "opening_problem_refs",
  "opening_help_exposures",
  "opening_learning_observations",
  "opening_memories",
  "opening_privacy_exclusions",
  "opening_tasks",
  "opening_timetable_sessions",
  "opening_hard_blocks",
  "opening_plan_state",
  "opening_plan_drafts",
  "opening_plan_acceptances",
] as const;

function sameJournal(backup: OpeningBackup, current: readonly OpeningDeletionMark[]): boolean {
  const key = (mark: OpeningDeletionMark) => `${mark.sourceId.toLowerCase()}\u0000${new Date(mark.deletedAt).toISOString()}`;
  if (backup.deletionJournal.length !== current.length) return false;
  const backupKeys = new Set(backup.deletionJournal.map(key));
  return current.every((mark) => backupKeys.has(key(mark)));
}

/**
 * Plans a restore apply; it never executes one. Requires an explicit local confirmation
 * flag, the structural privacy preflight, and an unchanged current journal. The executor
 * must still re-verify the journal in its own transaction and never restore credentials,
 * sessions, queues, budgets, or paid jobs. This plan is not authorization by itself.
 */
export function planOpeningRestoreApply(
  backup: unknown,
  currentDeletionJournal: readonly OpeningDeletionMark[],
  options: { confirmLocalRestore: boolean },
): OpeningRestoreApplyPlanResult {
  if (!isRecord(options) || options.confirmLocalRestore !== true) {
    return { ok: false, code: "REQUIRES_EXPLICIT_CONFIRMATION", errors: ["explicit local confirmation is required"] };
  }
  const preview = validateOpeningRestore(structuralCopy(backup), currentDeletionJournal);
  if (!preview.allowed) {
    return { ok: false, code: "PREFLIGHT_REJECTED", errors: preview.errors };
  }
  const journal = backup as OpeningBackup;
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
  if (Array.isArray(value)) return value.map(structuralCopy);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, structuralCopy(child)]));
  }
  return value;
}
