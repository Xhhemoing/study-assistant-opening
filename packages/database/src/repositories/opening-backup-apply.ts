/**
 * Opening-scoped restore apply executor (Q03).
 *
 * Inserts allowlisted durable rows in domain OPENING_RESTORE_APPLY_ORDER inside
 * one transaction, optionally puts object bytes via an injected writer, and
 * cancels pending opening_jobs. Never restores sessions / API keys / credentials
 * / paid queues (OPENING_RESTORE_NEVER_TABLES). Native backup-restore /
 * applyRestorePlan is a different schema — not used here.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Sql } from "postgres";
import {
  normalizeOpeningRestoreHistory,
  OPENING_RESTORE_APPLY_ORDER,
  planOpeningRestoreApply,
  validateOpeningRestore,
  type OpeningBackup,
  type OpeningDeletionMark,
  type OpeningRestoreApplyPlan,
  type OpeningRestoreLearningState,
  type RestorePreview,
} from "@aistudy/domain";
import {
  evaluateOpeningRestoreEmptyNamespace,
  isOpeningRestoreNeverTable,
  readOpeningRestoreNamespaceCounts,
  type OpeningRestoreNamespaceCounts,
} from "./opening-backup-empty-namespace";
import type { OpeningMemoryDeletions } from "./opening-backup-memory-deletions";

export type OpeningRestoreObjectPut = {
  put(input: {
    sourceId: string;
    archivePath: string;
    sha256: string;
    bytes: number;
    body: Uint8Array;
  }): Promise<void>;
};

export type OpeningRestoreApplyGuarantees = {
  secretsRestored: false;
  apiKeysRestored: false;
  sessionsRestored: false;
  pendingJobs: "cancelled";
};

export type OpeningRestoreExecuteArgs = {
  confirmLocalRestore: true;
  backup: unknown;
  currentDeletionJournal?: readonly OpeningDeletionMark[];
  currentMemoryDeletions?: OpeningMemoryDeletions;
  availableCourseIds?: readonly string[];
  currentLearningState?: OpeningRestoreLearningState;
  /** Optional pre-counts; live counts are always re-read inside the transaction. */
  emptyNamespaceCounts?: OpeningRestoreNamespaceCounts;
  /** Local staging root; archivePath is resolved relative to this when present. */
  stagingDirectory?: string;
  /** In-memory object bodies keyed by archivePath (fixture / unit). */
  objectBodies?: ReadonlyMap<string, Uint8Array> | Record<string, Uint8Array>;
  /** Optional object writer. Absent + objects.length>0 → rows still apply; objectApplyDeferred. */
  objectPut?: OpeningRestoreObjectPut;
};

export type OpeningRestoreExecuteOk = {
  ok: true;
  code: "APPLY_OK";
  mutated: true;
  errors: string[];
  guarantees: OpeningRestoreApplyGuarantees;
  preview: RestorePreview;
  plan: OpeningRestoreApplyPlan;
  emptyNamespaceVerified: true;
  rowsInserted: number;
  objectsApplied: number;
  objectApplyDeferred: boolean;
  pendingJobsCancelled: number;
};

export type OpeningRestoreExecuteErr = {
  ok: false;
  code:
    | "REQUIRES_EXPLICIT_CONFIRMATION"
    | "PREFLIGHT_REJECTED"
    | "JOURNAL_DRIFT"
    | "TARGET_NOT_EMPTY"
    | "APPLY_FAILED";
  mutated: false;
  errors: string[];
  guarantees: OpeningRestoreApplyGuarantees;
  preview?: RestorePreview;
  plan?: OpeningRestoreApplyPlan;
  emptyNamespaceVerified?: boolean;
};

export type OpeningRestoreExecuteResult = OpeningRestoreExecuteOk | OpeningRestoreExecuteErr;

const RESTORE_GUARANTEES: OpeningRestoreApplyGuarantees = {
  secretsRestored: false,
  apiKeysRestored: false,
  sessionsRestored: false,
  pendingJobs: "cancelled",
};

/** Allowlisted insert columns per APPLY_ORDER table (snake_case as exported). */
export const OPENING_RESTORE_ROW_COLUMNS: Record<(typeof OPENING_RESTORE_APPLY_ORDER)[number], readonly string[]> = {
  workspace_preferences: [
    "workspace_id", "default_entry", "ai_settings", "planning_settings",
    "assessment_enabled", "retest_suggestions_enabled", "automatic_reminders_enabled",
    "retest_suggestions_enabled_at", "automatic_reminders_enabled_at", "created_at", "updated_at",
  ],
  courses: [
    "id", "workspace_id", "title", "slug", "description", "schema_version", "archived_at",
    "assessment_enabled", "retest_suggestions_enabled", "automatic_reminders_enabled",
    "retest_suggestions_enabled_at", "automatic_reminders_enabled_at", "created_at", "updated_at",
  ],
  opening_sources: [
    "id", "workspace_id", "name", "mime", "bytes", "sha256", "version",
    "upload_state", "parse_state", "error", "created_at", "updated_at",
  ],
  course_asset_memberships: [
    "id", "workspace_id", "course_id", "asset_type", "asset_id", "role",
    "sort_order", "visibility", "created_at", "updated_at",
  ],
  opening_source_versions: [
    "source_id", "workspace_id", "version", "bytes", "sha256", "availability",
  ],
  opening_source_chunks: [
    "id", "source_id", "source_version", "page", "slide_label", "start_ms", "end_ms", "text", "created_at",
  ],
  opening_conversations: [
    "id", "workspace_id", "owner_user_id", "title", "course_id", "created_at", "updated_at",
  ],
  opening_learning_sessions: [
    "id", "workspace_id", "owner_user_id", "course_id", "skill_label", "source_ids", "created_at",
  ],
  opening_problem_refs: [
    "problem_id", "workspace_id", "session_id", "source_id", "source_version", "physical_page",
    "chunk_id", "stem_snapshot", "artifact_kind", "updated_at",
  ],
  opening_learning_history_revisions: [
    "workspace_id", "owner_user_id", "course_id", "revision",
  ],
  opening_workspace_history_revisions: [
    "workspace_id", "owner_user_id", "revision",
  ],
  opening_learning_item_versions: [
    "id", "workspace_id", "owner_user_id", "course_id", "problem_id", "source_id", "source_version",
    "physical_page", "chunk_id", "stem_snapshot", "artifact_kind", "created_at",
  ],
  opening_learning_attempts: [
    "id", "workspace_id", "owner_user_id", "session_id", "course_id", "skill_label", "requirement_key",
    "problem_id", "item_version_id", "source_ids", "source_versions", "started_at", "submitted_at",
    "observation_id", "client_key", "create_intent", "history_revision",
  ],
  opening_turns: [
    "id", "workspace_id", "conversation_id", "role", "text", "mode", "status", "client_key",
    "learning_session_id", "current_page", "chunk_id", "source_ids", "citations", "created_at",
    "intent_hash", "source_versions", "context_source_refs", "attempt_id",
  ],
  opening_assistant_candidates: [
    "id", "workspace_id", "conversation_id", "source_turn_id", "source_ids", "payload", "status",
    "created_at", "updated_at", "task_accept_client_key", "task_accept_intent", "task_result_ref",
  ],
  opening_help_exposures: [
    "id", "workspace_id", "session_id", "problem_id", "turn_id", "level", "delivered",
    "created_at", "attempt_id", "delivered_at", "history_revision",
  ],
  opening_learning_observations: [
    "id", "workspace_id", "owner_user_id", "session_id", "course_id", "skill_label", "source_ids",
    "problem_id", "retest_id", "answer", "outcome", "assistance", "client_key", "occurred_at",
    "source_turn_ids", "verdict_source", "reference_source_id", "evidence_verdict",
    "attempt_id", "item_version_id", "requirement_key", "started_at", "submitted_at", "recorded_at",
    "source_versions", "reference_check", "submitted_intent", "history_revision", "workspace_history_revision",
    "root_observation_id", "revises_observation_id", "revision_kind", "revision_reason", "actor_id",
    "effective_head_id",
  ],
  opening_memories: [
    "id", "workspace_id", "course_id", "kind", "text", "source_turn_ids", "version", "expires_at",
    "status", "last_decision_client_key", "created_at", "updated_at",
  ],
  opening_privacy_exclusions: [
    "id", "workspace_id", "source_id", "memory_id", "deleted_at", "asset_deleted_at",
  ],
  opening_tasks: [
    "id", "workspace_id", "owner_user_id", "title", "minutes", "due_at", "due_text", "priority",
    "status", "version", "candidate_id", "created_at", "updated_at",
  ],
  opening_retest_activities: [
    "id", "workspace_id", "owner_user_id", "course_id", "skill_label", "requirement_key", "purpose",
    "evidence_cycle_id", "candidate_id", "task_id", "status", "result", "version", "snoozed_until",
    "proposed_at", "accepted_at", "started_at", "completed_at", "declined_at", "cancelled_at",
    "invalidated_at", "superseded_at", "not_before_at", "recommended_at", "scheduled_start_at",
    "deadline_at", "reason", "reopened_from_activity_id", "created_at", "updated_at",
  ],
  opening_timetable_sessions: [
    "id", "workspace_id", "owner_user_id", "course_name", "course_id", "weekday", "weeks",
    "start_period", "end_period", "created_at",
  ],
  opening_hard_blocks: [
    "id", "workspace_id", "owner_user_id", "day", "start_at", "end_at", "kind", "source", "created_at",
  ],
  opening_plan_state: [
    "workspace_id", "day", "accepted_version", "accepted_blocks", "hard_blocks_fingerprint", "updated_at",
  ],
  opening_plan_drafts: [
    "id", "workspace_id", "owner_user_id", "day", "version", "base_version", "status", "blocks",
    "unscheduled_task_ids", "input_snapshot", "hard_blocks_fingerprint", "propose_client_key",
    "created_at", "updated_at",
  ],
  opening_plan_acceptances: [
    "workspace_id", "client_key", "draft_id", "day", "accepted_version", "payload_hash", "created_at",
  ],
};

const JSONB_COLUMNS = new Set([
  "workspace_preferences.ai_settings",
  "workspace_preferences.planning_settings",
  "opening_sources.error",
  "opening_turns.citations",
  "opening_turns.source_versions",
  "opening_turns.context_source_refs",
  "opening_assistant_candidates.source_ids",
  "opening_assistant_candidates.payload",
  "opening_memories.source_turn_ids",
  "opening_learning_observations.source_versions",
  "opening_learning_observations.reference_check",
  "opening_learning_observations.submitted_intent",
  "opening_learning_attempts.source_versions",
  "opening_learning_attempts.create_intent",
  "opening_plan_state.accepted_blocks",
  "opening_plan_drafts.blocks",
  "opening_plan_drafts.unscheduled_task_ids",
  "opening_plan_drafts.input_snapshot",
]);

function bodyFromMap(
  bodies: OpeningRestoreExecuteArgs["objectBodies"],
  archivePath: string,
): Uint8Array | undefined {
  if (!bodies) return undefined;
  if (bodies instanceof Map) return bodies.get(archivePath);
  return (bodies as Record<string, Uint8Array>)[archivePath];
}

async function resolveObjectBody(
  args: OpeningRestoreExecuteArgs,
  archivePath: string,
): Promise<Uint8Array | undefined> {
  const fromMap = bodyFromMap(args.objectBodies, archivePath);
  if (fromMap) return fromMap;
  if (!args.stagingDirectory?.trim()) return undefined;
  const relative = archivePath.replace(/^[/\\]+/, "");
  if (relative.includes("..") || path.isAbsolute(archivePath)) {
    throw new Error(`unsafe archivePath: ${archivePath}`);
  }
  return new Uint8Array(await readFile(path.join(args.stagingDirectory.trim(), relative)));
}

function filterPayload(
  tx: Sql,
  table: (typeof OPENING_RESTORE_APPLY_ORDER)[number],
  row: Record<string, unknown>,
  workspaceId: string,
): Record<string, unknown> | null {
  const allowed = OPENING_RESTORE_ROW_COLUMNS[table];
  const payload: Record<string, unknown> = {};
  for (const col of allowed) {
    if (!(col in row)) continue;
    let value = row[col];
    if (value === undefined) continue;
    if (col === "workspace_id" && typeof value === "string" && value.toLowerCase() !== workspaceId.toLowerCase()) {
      throw new Error(`${table} row workspace_id diverges from backup workspace`);
    }
    if (JSONB_COLUMNS.has(`${table}.${col}`) && value !== null && typeof value === "object" && !(value instanceof Date)) {
      value = tx.json(value as never);
    }
    payload[col] = value;
  }
  return Object.keys(payload).length ? payload : null;
}

/**
 * Mutating Opening restore apply. Caller must already have passed confirm +
 * structural gates (or this re-checks them). Re-reads empty-namespace counts
 * inside the transaction. Does not restore secrets/sessions/API keys.
 */
export async function executeOpeningRestoreApply(
  sql: Sql,
  args: OpeningRestoreExecuteArgs,
): Promise<OpeningRestoreExecuteResult> {
  if (args.confirmLocalRestore !== true) {
    return {
      ok: false,
      code: "REQUIRES_EXPLICIT_CONFIRMATION",
      mutated: false,
      errors: ["explicit local confirmation is required (--confirm-local-restore)"],
      guarantees: RESTORE_GUARANTEES,
    };
  }

  const journal = args.currentDeletionJournal ?? [];
  const preview = validateOpeningRestore(args.backup, journal, args.currentMemoryDeletions);
  const planned = planOpeningRestoreApply(args.backup, journal, {
    confirmLocalRestore: true,
    availableCourseIds: args.availableCourseIds,
    currentLearningState: args.currentLearningState,
    currentMemoryDeletions: args.currentMemoryDeletions,
  });
  if (!planned.ok) {
    return {
      ok: false,
      code: planned.code === "REQUIRES_EXPLICIT_CONFIRMATION"
        ? "REQUIRES_EXPLICIT_CONFIRMATION"
        : planned.code,
      mutated: false,
      errors: planned.errors,
      guarantees: RESTORE_GUARANTEES,
      preview,
    };
  }

  if (args.emptyNamespaceCounts !== undefined) {
    const pre = evaluateOpeningRestoreEmptyNamespace(args.emptyNamespaceCounts);
    if (!pre.ok) {
      return {
        ok: false,
        code: "TARGET_NOT_EMPTY",
        mutated: false,
        errors: pre.errors,
        guarantees: RESTORE_GUARANTEES,
        preview,
        plan: planned.plan,
        emptyNamespaceVerified: false,
      };
    }
  }

  const backup = normalizeOpeningRestoreHistory(args.backup as OpeningBackup);
  const workspaceId = backup.workspaceId;

  try {
    let rowsInserted = 0;
    let objectsApplied = 0;
    let objectApplyDeferred = false;
    let pendingJobsCancelled = 0;

    await sql.begin(async (tx) => {
      const liveCounts = await readOpeningRestoreNamespaceCounts(tx as unknown as Sql, workspaceId);
      const emptyLive = evaluateOpeningRestoreEmptyNamespace(liveCounts);
      if (!emptyLive.ok) {
        const err = new Error(`TARGET_NOT_EMPTY:${emptyLive.errors.join("|")}`);
        (err as Error & { code?: string }).code = "TARGET_NOT_EMPTY";
        throw err;
      }

      const cancelled = await tx`
        UPDATE opening_jobs
        SET state = 'cancelled', updated_at = now()
        WHERE workspace_id = ${workspaceId}
          AND state IN ('queued', 'running')
        RETURNING id
      `;
      pendingJobsCancelled = cancelled.length;

      for (const table of OPENING_RESTORE_APPLY_ORDER) {
        if (isOpeningRestoreNeverTable(table)) {
          throw new Error(`refusing to restore banned table ${table}`);
        }
        const rows = (backup.tables[table] as Record<string, unknown>[] | undefined) ?? [];
        for (const row of rows) {
          if (!row || typeof row !== "object") continue;
          const payload = filterPayload(tx as unknown as Sql, table, row, workspaceId);
          if (!payload) continue;
          await tx`INSERT INTO ${tx(table)} ${tx(payload)}`;
          rowsInserted += 1;
        }
      }

      if (backup.objects.length > 0 && !args.objectPut) {
        objectApplyDeferred = true;
      } else if (args.objectPut) {
        for (const object of backup.objects) {
          const body = await resolveObjectBody(args, object.archivePath);
          if (!body) {
            throw new Error(`missing object bytes for ${object.archivePath}`);
          }
          await args.objectPut.put({
            sourceId: object.sourceId,
            archivePath: object.archivePath,
            sha256: object.sha256,
            bytes: object.bytes,
            body,
          });
          objectsApplied += 1;
        }
      }
    });

    return {
      ok: true,
      code: "APPLY_OK",
      mutated: true,
      errors: objectApplyDeferred
        ? ["row apply succeeded; object apply deferred (no objectPut / staging bodies)"]
        : [],
      guarantees: RESTORE_GUARANTEES,
      preview,
      plan: planned.plan,
      emptyNamespaceVerified: true,
      rowsInserted,
      objectsApplied,
      objectApplyDeferred,
      pendingJobsCancelled,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("TARGET_NOT_EMPTY:") || (error as { code?: string }).code === "TARGET_NOT_EMPTY") {
      const details = message.startsWith("TARGET_NOT_EMPTY:")
        ? message.slice("TARGET_NOT_EMPTY:".length).split("|").filter(Boolean)
        : [message];
      return {
        ok: false,
        code: "TARGET_NOT_EMPTY",
        mutated: false,
        errors: details.length ? details : [message],
        guarantees: RESTORE_GUARANTEES,
        preview,
        plan: planned.plan,
        emptyNamespaceVerified: false,
      };
    }
    return {
      ok: false,
      code: "APPLY_FAILED",
      mutated: false,
      errors: [message],
      guarantees: RESTORE_GUARANTEES,
      preview,
      plan: planned.plan,
    };
  }
}

/** In-memory object put for unit / fixture tests. */
export function createMemoryOpeningRestoreObjectPut(): OpeningRestoreObjectPut & {
  store: Map<string, Uint8Array>;
} {
  const store = new Map<string, Uint8Array>();
  return {
    store,
    async put(input) {
      store.set(input.archivePath, input.body);
    },
  };
}


/** Minimal storage surface for live MinIO / S3 restore puts. */
export type OpeningRestoreObjectStorage = {
  finalKey(sourceId: string, version: number): string;
  putObject(key: string, body: Uint8Array, input?: { mime?: string }): Promise<void>;
};

/**
 * Parse `objects/<sourceId>/v<N>.bin` → version N.
 * Fail-closed on path traversal or sourceId mismatch.
 */
export function parseOpeningRestoreObjectVersion(archivePath: string, sourceId: string): number {
  const relative = archivePath.replace(/^[/\\]+/, "");
  if (relative.includes("..") || path.isAbsolute(archivePath)) {
    throw new Error(`unsafe archivePath: ${archivePath}`);
  }
  const expected = `objects/${sourceId}/v`;
  if (!relative.startsWith(expected) || !relative.endsWith(".bin")) {
    throw new Error(`archivePath does not match sourceId: ${archivePath}`);
  }
  const match = /^objects\/[^/]+\/v(\d+)\.bin$/.exec(relative);
  if (!match) {
    throw new Error(`cannot parse version from archivePath: ${archivePath}`);
  }
  return Number(match[1]);
}

/**
 * Live OpeningS3 / MinIO object put adapter for restore apply.
 * Writes to `finalKey(sourceId, version)` derived from archivePath.
 * Tracks keys put for dedicated cleanup (never wipe shared bucket).
 */
export function createOpeningS3RestoreObjectPut(
  storage: OpeningRestoreObjectStorage,
): OpeningRestoreObjectPut & { keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    async put(input) {
      const version = parseOpeningRestoreObjectVersion(input.archivePath, input.sourceId);
      const key = storage.finalKey(input.sourceId, version);
      await storage.putObject(key, input.body, { mime: "application/octet-stream" });
      keys.push(key);
    },
  };
}

