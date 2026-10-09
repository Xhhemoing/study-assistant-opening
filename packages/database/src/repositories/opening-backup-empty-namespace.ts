/**
 * Empty-namespace preflight for Opening restore apply (Q03).
 *
 * Pure policy + read-only count reader. Never inserts/updates/deletes.
 * A verified-empty target is still not authorization to apply rows/objects —
 * `applyOpeningRestore` stays fail-closed until an Opening insert executor exists.
 */
import type { Sql } from "postgres";
import { OPENING_BACKUP_TABLES, type OpeningBackupTable } from "./opening-backup-records";

/** Tables that must never appear in an Opening restore apply (secrets / paid queues / auth). */
export const OPENING_RESTORE_NEVER_TABLES = [
  "sessions",
  "opening_jobs",
  "opening_outbox",
  "opening_tutor_jobs",
  "opening_budget_reservations",
  "opening_connections",
  "opening_connection_credentials",
  "opening_model_provider_credentials",
] as const;

export type OpeningRestoreNamespaceCounts = Record<OpeningBackupTable, number>;

export type OpeningRestoreEmptyNamespaceResult =
  | { ok: true; totalRows: 0 }
  | { ok: false; code: "TARGET_NOT_EMPTY"; errors: string[]; totalRows: number };

function isFiniteNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Fail-closed empty-namespace policy over pre-counted durable backup tables.
 * Missing or invalid counts are treated as not empty (never assume zero).
 */
export function evaluateOpeningRestoreEmptyNamespace(
  counts: Partial<OpeningRestoreNamespaceCounts> | null | undefined,
): OpeningRestoreEmptyNamespaceResult {
  if (!counts || typeof counts !== "object") {
    return {
      ok: false,
      code: "TARGET_NOT_EMPTY",
      errors: ["empty-namespace counts are required before Opening restore apply"],
      totalRows: -1,
    };
  }
  const errors: string[] = [];
  let totalRows = 0;
  for (const table of OPENING_BACKUP_TABLES) {
    const value = counts[table];
    if (!isFiniteNonNegativeInt(value)) {
      errors.push(`missing or invalid count for ${table}`);
      continue;
    }
    totalRows += value;
    if (value > 0) errors.push(`${table} has ${value} row(s) in target namespace`);
  }
  if (errors.length) {
    return { ok: false, code: "TARGET_NOT_EMPTY", errors, totalRows: Math.max(totalRows, 0) };
  }
  return { ok: true, totalRows: 0 };
}

/**
 * Read-only per-table row counts for a workspace namespace.
 * Table names are fixed in this query (never from backup keys).
 * `opening_source_chunks` has no workspace_id — counted via opening_sources join.
 * Never touches secret/queue tables listed in OPENING_RESTORE_NEVER_TABLES.
 */
export async function readOpeningRestoreNamespaceCounts(
  sql: Sql,
  workspaceId: string,
): Promise<OpeningRestoreNamespaceCounts> {
  const id = workspaceId;
  const rows = await sql`
    SELECT 'workspace_preferences'::text AS table_name, count(*)::int AS n FROM workspace_preferences WHERE workspace_id = ${id}
    UNION ALL SELECT 'courses', count(*)::int FROM courses WHERE workspace_id = ${id}
    UNION ALL SELECT 'course_asset_memberships', count(*)::int FROM course_asset_memberships WHERE workspace_id = ${id}
    UNION ALL SELECT 'opening_sources', count(*)::int FROM opening_sources WHERE workspace_id = ${id}
    UNION ALL SELECT 'opening_source_chunks', count(*)::int FROM opening_source_chunks c
      JOIN opening_sources s ON s.id = c.source_id AND s.workspace_id = ${id}
    UNION ALL SELECT 'opening_conversations', count(*)::int FROM opening_conversations WHERE workspace_id = ${id}
    UNION ALL SELECT 'opening_turns', count(*)::int FROM opening_turns WHERE workspace_id = ${id}
    UNION ALL SELECT 'opening_learning_sessions', count(*)::int FROM opening_learning_sessions WHERE workspace_id = ${id}
    UNION ALL SELECT 'opening_problem_refs', count(*)::int FROM opening_problem_refs WHERE workspace_id = ${id}
    UNION ALL SELECT 'opening_help_exposures', count(*)::int FROM opening_help_exposures WHERE workspace_id = ${id}
    UNION ALL SELECT 'opening_learning_observations', count(*)::int FROM opening_learning_observations WHERE workspace_id = ${id}
    UNION ALL SELECT 'opening_assistant_candidates', count(*)::int FROM opening_assistant_candidates WHERE workspace_id = ${id}
    UNION ALL SELECT 'opening_memories', count(*)::int FROM opening_memories WHERE workspace_id = ${id}
    UNION ALL SELECT 'opening_privacy_exclusions', count(*)::int FROM opening_privacy_exclusions WHERE workspace_id = ${id}
    UNION ALL SELECT 'opening_tasks', count(*)::int FROM opening_tasks WHERE workspace_id = ${id}
    UNION ALL SELECT 'opening_retest_activities', count(*)::int FROM opening_retest_activities WHERE workspace_id = ${id}
    UNION ALL SELECT 'opening_timetable_sessions', count(*)::int FROM opening_timetable_sessions WHERE workspace_id = ${id}
    UNION ALL SELECT 'opening_hard_blocks', count(*)::int FROM opening_hard_blocks WHERE workspace_id = ${id}
    UNION ALL SELECT 'opening_plan_state', count(*)::int FROM opening_plan_state WHERE workspace_id = ${id}
    UNION ALL SELECT 'opening_plan_drafts', count(*)::int FROM opening_plan_drafts WHERE workspace_id = ${id}
    UNION ALL SELECT 'opening_plan_acceptances', count(*)::int FROM opening_plan_acceptances WHERE workspace_id = ${id}
    UNION ALL SELECT 'opening_source_versions', count(*)::int FROM opening_source_versions WHERE workspace_id = ${id}
    UNION ALL SELECT 'opening_learning_item_versions', count(*)::int FROM opening_learning_item_versions WHERE workspace_id = ${id}
    UNION ALL SELECT 'opening_learning_attempts', count(*)::int FROM opening_learning_attempts WHERE workspace_id = ${id}
    UNION ALL SELECT 'opening_learning_history_revisions', count(*)::int FROM opening_learning_history_revisions WHERE workspace_id = ${id}
    UNION ALL SELECT 'opening_workspace_history_revisions', count(*)::int FROM opening_workspace_history_revisions WHERE workspace_id = ${id}
  `;

  const counts = Object.fromEntries(
    OPENING_BACKUP_TABLES.map((table) => [table, -1]),
  ) as OpeningRestoreNamespaceCounts;
  for (const row of rows) {
    const name = String((row as { table_name: string }).table_name);
    if ((OPENING_BACKUP_TABLES as readonly string[]).includes(name)) {
      counts[name as OpeningBackupTable] = Number((row as { n: number }).n);
    }
  }
  return counts;
}

/** True when a backup table name is permanently banned from restore apply. */
export function isOpeningRestoreNeverTable(table: string): boolean {
  return (OPENING_RESTORE_NEVER_TABLES as readonly string[]).includes(table);
}
