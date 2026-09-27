import type { TransactionSql } from "postgres";
import { includedProblem, includedTurn } from "./opening-backup-record-predicates";
import { cleanUuidSources, memoryNotExcluded } from "./opening-backup-record-privacy";
import type { OpeningBackupTable } from "./opening-backup-records";

type Rows = Record<string, unknown>[];
const asRows = (value: unknown): Rows => [...(value as Rows)];

/** Fixed inventory queries. Table names stay static; callers own the transaction and owner gate. */
export async function readOpeningBackupTableRows(
  tx: TransactionSql,
  id: string,
  userId: string,
): Promise<Record<OpeningBackupTable, Rows>> {
  const tables = {} as Record<OpeningBackupTable, Rows>;
  tables.opening_sources = asRows(await tx`
    SELECT id, workspace_id, name, mime, bytes, sha256, version, upload_state, parse_state, error, created_at, updated_at
    FROM opening_sources s
    WHERE s.workspace_id = ${id} AND s.upload_state = 'uploaded'
      AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id = ${id} AND e.source_id = s.id)
    ORDER BY s.id`);
  tables.opening_source_chunks = asRows(await tx`
    SELECT c.id, c.source_id, c.source_version, c.page, c.slide_label, c.start_ms, c.end_ms, c.text, c.created_at
    FROM opening_source_chunks c
    JOIN opening_sources s ON s.id = c.source_id AND s.workspace_id = ${id}
      AND s.version = c.source_version AND s.upload_state = 'uploaded'
    WHERE NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id = ${id} AND e.source_id = c.source_id)
    ORDER BY c.id`);
  tables.opening_conversations = asRows(await tx`
    SELECT id, workspace_id, owner_user_id, title, course_id, created_at, updated_at
    FROM opening_conversations WHERE workspace_id = ${id} AND owner_user_id = ${userId} ORDER BY id`);
  tables.opening_turns = asRows(await tx`
    SELECT t.id, t.workspace_id, t.conversation_id, t.role, t.text, t.mode, t.status, t.client_key,
      t.learning_session_id, t.current_page, t.chunk_id, t.source_ids, t.citations, t.created_at,
      t.intent_hash, t.source_versions
    FROM opening_turns t
    WHERE ${includedTurn(tx, id, userId, "t")}
    ORDER BY t.id`);
  tables.opening_learning_sessions = asRows(await tx`
    SELECT l.id, l.workspace_id, l.owner_user_id, l.course_id, l.skill_label, l.source_ids, l.created_at
    FROM opening_learning_sessions l
    WHERE l.workspace_id = ${id} AND l.owner_user_id = ${userId} AND ${cleanUuidSources(tx, id, tx`l.source_ids`)}
    ORDER BY l.id`);
  tables.opening_problem_refs = asRows(await tx`
    SELECT p.problem_id, p.workspace_id, p.session_id, p.source_id, p.source_version, p.physical_page,
      p.chunk_id, p.stem_snapshot, p.artifact_kind, p.updated_at
    FROM opening_problem_refs p
    WHERE ${includedProblem(tx, id, userId, "p", tx`p.session_id`)}
    ORDER BY p.problem_id`);
  tables.opening_help_exposures = asRows(await tx`
    SELECT h.id, h.workspace_id, h.session_id, h.problem_id, h.turn_id, h.level, h.delivered, h.created_at
    FROM opening_help_exposures h
    JOIN opening_learning_sessions l ON l.id = h.session_id AND l.workspace_id = ${id} AND l.owner_user_id = ${userId}
    WHERE h.workspace_id = ${id}
      AND ${cleanUuidSources(tx, id, tx`l.source_ids`)}
      AND (h.problem_id IS NULL OR ${includedProblem(tx, id, userId, tx`h.problem_id`, tx`h.session_id`)})
      AND ${includedTurn(tx, id, userId, tx`h.turn_id`)}
    ORDER BY h.id`);
  tables.opening_learning_observations = asRows(await tx`
    SELECT o.id, o.workspace_id, o.owner_user_id, o.session_id, o.course_id, o.skill_label, o.source_ids,
      o.problem_id, o.retest_id, o.answer, o.outcome, o.assistance, o.client_key, o.occurred_at,
      o.source_turn_ids, o.verdict_source, o.reference_source_id, o.evidence_verdict
    FROM opening_learning_observations o
    JOIN opening_learning_sessions l ON l.id = o.session_id AND l.workspace_id = ${id} AND l.owner_user_id = ${userId}
    WHERE o.workspace_id = ${id} AND o.owner_user_id = ${userId}
      AND ${cleanUuidSources(tx, id, tx`l.source_ids`)}
      AND ${cleanUuidSources(tx, id, tx`o.source_ids`)}
      AND (o.reference_source_id IS NULL OR EXISTS (
        SELECT 1 FROM opening_sources s
        WHERE s.id = o.reference_source_id AND s.workspace_id = ${id} AND s.upload_state = 'uploaded'
          AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id = ${id} AND e.source_id = s.id)
      ))
      AND NOT EXISTS (
        SELECT 1 FROM unnest(o.source_turn_ids) ref(turn_id) WHERE NOT ${includedTurn(tx, id, userId, tx`ref.turn_id`)}
      )
      AND (o.problem_id IS NULL OR ${includedProblem(tx, id, userId, tx`o.problem_id`, tx`o.session_id`)})
    ORDER BY o.id`);
  tables.opening_assistant_candidates = asRows(await tx`
    SELECT a.id, a.workspace_id, a.conversation_id, a.source_turn_id, a.source_ids, a.payload, a.status, a.created_at, a.updated_at
    FROM opening_assistant_candidates a
    JOIN opening_conversations c ON c.id = a.conversation_id AND c.workspace_id = ${id} AND c.owner_user_id = ${userId}
    WHERE a.workspace_id = ${id} AND jsonb_typeof(a.source_ids) = 'array'
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(a.source_ids) = 'array' THEN a.source_ids ELSE '[]'::jsonb END) source_ref(id)
        WHERE NOT EXISTS (
          SELECT 1 FROM opening_sources s WHERE s.id::text = lower(source_ref.id) AND s.workspace_id = ${id} AND s.upload_state = 'uploaded'
        ) OR EXISTS (
          SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id = ${id} AND e.source_id::text = lower(source_ref.id)
        )
      )
      AND ${includedTurn(tx, id, userId, tx`a.source_turn_id`)}
    ORDER BY a.id`);
  tables.opening_memories = asRows(await tx`
    SELECT m.id, m.workspace_id, m.course_id, m.kind, m.text, m.source_turn_ids, m.version, m.expires_at,
      m.status, m.last_decision_client_key, m.created_at, m.updated_at
    FROM opening_memories m
    WHERE m.workspace_id = ${id} AND m.status <> 'deleted' AND jsonb_typeof(m.source_turn_ids) = 'array'
      AND CASE WHEN jsonb_typeof(m.source_turn_ids) = 'array' THEN jsonb_array_length(m.source_turn_ids) > 0 ELSE false END
      AND ${memoryNotExcluded(tx, id)}
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(m.source_turn_ids) = 'array' THEN m.source_turn_ids ELSE '[]'::jsonb END) ref(turn_id)
        WHERE NOT ${includedTurn(tx, id, userId, tx`CASE WHEN ref.turn_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN ref.turn_id::uuid ELSE NULL END`)}
      )
    ORDER BY m.id`);
  tables.opening_privacy_exclusions = asRows(await tx`
    SELECT id, workspace_id, source_id, memory_id, deleted_at
    FROM opening_privacy_exclusions WHERE workspace_id = ${id} ORDER BY source_id`);
  tables.opening_tasks = asRows(await tx`
    SELECT id, workspace_id, owner_user_id, title, minutes, due_at, due_text, priority, status, version, candidate_id, created_at, updated_at
    FROM opening_tasks WHERE workspace_id = ${id} AND owner_user_id = ${userId} ORDER BY id`);
  tables.opening_timetable_sessions = asRows(await tx`
    SELECT id, workspace_id, owner_user_id, course_name, course_id, weekday, weeks, start_period, end_period, created_at
    FROM opening_timetable_sessions WHERE workspace_id = ${id} AND owner_user_id = ${userId} ORDER BY id`);
  tables.opening_hard_blocks = asRows(await tx`
    SELECT id, workspace_id, owner_user_id, day, start_at, end_at, kind, source, created_at
    FROM opening_hard_blocks WHERE workspace_id = ${id} AND owner_user_id = ${userId} ORDER BY id`);
  tables.opening_plan_state = asRows(await tx`
    SELECT workspace_id, day, accepted_version, accepted_blocks, hard_blocks_fingerprint, updated_at
    FROM opening_plan_state WHERE workspace_id = ${id} ORDER BY day`);
  tables.opening_plan_drafts = asRows(await tx`
    SELECT id, workspace_id, owner_user_id, day, version, base_version, status, blocks, unscheduled_task_ids,
      input_snapshot, hard_blocks_fingerprint, propose_client_key, created_at, updated_at
    FROM opening_plan_drafts WHERE workspace_id = ${id} AND owner_user_id = ${userId} ORDER BY id`);
  tables.opening_plan_acceptances = asRows(await tx`
    SELECT a.workspace_id, a.client_key, a.draft_id, a.day, a.accepted_version, a.payload_hash, a.created_at
    FROM opening_plan_acceptances a
    JOIN opening_plan_drafts d ON d.id = a.draft_id AND d.workspace_id = ${id} AND d.owner_user_id = ${userId}
    WHERE a.workspace_id = ${id} ORDER BY a.client_key`);
  return tables;
}
