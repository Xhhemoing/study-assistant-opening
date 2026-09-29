import type { Sql, TransactionSql } from "postgres";
import { includedLearningSession } from "./opening-backup-record-privacy";
import { contextSourceRefsIncluded } from "./opening-context-provenance";

type Tx = Sql | TransactionSql;
type Fragment = ReturnType<Tx>;
const TURN = "t";
const PROBLEM = "p";

const ALLOWED = new Set(["p", "p2", "t", "chunk_id", "citations", "conversation_id", "learning_session_id", "problem_id", "session_id", "source_id", "source_ids", "source_version", "source_versions", "workspace_id"]);
function raw(tx: Tx, reference: string): Fragment {
  const parts = reference.split(".");
  if ((parts.length !== 1 && parts.length !== 2) || parts.some((part) => !ALLOWED.has(part))) {
    throw new Error("invalid backup sql identifier");
  }
  const sql = reference;
  const unsafe = (tx as unknown as { unsafe?: (value: string) => Fragment }).unsafe;
  if (unsafe) return unsafe.call(tx, sql);
  return tx([sql] as unknown as TemplateStringsArray);
}

function versionsObject(tx: Tx, _turn: "t"): Fragment {
  return tx`CASE WHEN jsonb_typeof(${raw(tx, "t.source_versions")}) = 'object' THEN ${raw(tx, "t.source_versions")} ELSE NULL END`;
}

/** Fail closed: missing, non-object, non-numeric, or non-integer versions are not included. */
function sourceVersionsIncluded(tx: Tx, id: string, _turn: "t", history = false) {
  return tx`
    jsonb_typeof(${raw(tx, "t.source_versions")}) = 'object'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_each(${versionsObject(tx, _turn)}) version_entry(source_key, source_value)
      WHERE source_key !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        OR jsonb_typeof(source_value) <> 'number'
        OR (source_value #>> '{}') !~ '^[0-9]+$'
        OR NOT EXISTS (
          SELECT 1 FROM opening_sources s
          WHERE s.id::text = lower(source_key) AND s.workspace_id = ${id} AND s.upload_state = 'uploaded'
            AND (${history} OR s.version::text = source_value #>> '{}')
            AND NOT EXISTS (
              SELECT 1 FROM opening_privacy_exclusions e
              WHERE e.workspace_id = ${id} AND e.source_id = s.id
            )
        )
    )`;
}

/** Migration 0017 stores citations as jsonb. Scan sourceId/sourceVersion; malformed arrays fail closed. */
function citationsIncluded(tx: Tx, id: string, _turn: "t", history = false) {
  return tx`
    jsonb_typeof(${raw(tx, "t.citations")}) = 'array'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(${raw(tx, "t.citations")}) citation
      WHERE jsonb_typeof(citation) <> 'object'
        OR jsonb_typeof(citation->'sourceVersion') IS DISTINCT FROM 'number'
        OR citation->>'sourceId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR citation->>'sourceVersion' !~ '^[0-9]+$'
        OR NOT EXISTS (
          SELECT 1 FROM opening_sources s
          WHERE s.id::text = lower(citation->>'sourceId') AND s.workspace_id = ${id}
            AND s.upload_state = 'uploaded' AND (${history} OR s.version::text = citation->>'sourceVersion')
            AND NOT EXISTS (
              SELECT 1 FROM opening_privacy_exclusions e
              WHERE e.workspace_id = ${id} AND e.source_id = s.id
            )
        )
    )`;
}

function turnSourcesIncluded(tx: Tx, id: string, userId: string, _turn: "t", history = false) {
  return tx`
    NOT EXISTS (
      SELECT 1 FROM unnest(${raw(tx, "t.source_ids")}) sid(id)
      WHERE NOT EXISTS (
        SELECT 1 FROM opening_sources s
        WHERE s.id = sid.id AND s.workspace_id = ${id} AND s.upload_state = 'uploaded'
          AND NOT EXISTS (
            SELECT 1 FROM opening_privacy_exclusions e
            WHERE e.workspace_id = ${id} AND e.source_id = s.id
          )
      )
    )
    AND ${sourceVersionsIncluded(tx, id, _turn, history)}
    AND ${citationsIncluded(tx, id, _turn, history)}
    AND ((t.role = 'user' AND t.context_source_refs IS NULL)
      OR ${contextSourceRefsIncluded(tx, id, tx`t.context_source_refs`, history)})
    AND (t.learning_session_id IS NULL OR ${includedLearningSession(tx, id, userId, tx`t.learning_session_id`)})
    AND (${raw(tx, "t.chunk_id")} IS NULL OR EXISTS (
      SELECT 1 FROM opening_source_chunks k
      JOIN opening_sources s ON s.id = k.source_id AND s.workspace_id = ${id}
        AND (${history} OR s.version = k.source_version) AND s.upload_state = 'uploaded'
      WHERE k.id = ${raw(tx, "t.chunk_id")}
        AND NOT EXISTS (
          SELECT 1 FROM opening_privacy_exclusions e
          WHERE e.workspace_id = ${id} AND e.source_id = k.source_id
        )
    ))`;
}

/** Direct reads use the outer alias. Nested reads correlate through the supplied id fragment. */
export function includedTurn(tx: Tx, id: string, userId: string, turn: typeof TURN | Fragment, history = false) {
  if (turn !== TURN) {
    return tx`
      EXISTS (
        SELECT 1 FROM opening_turns t
        JOIN opening_conversations c ON c.id = t.conversation_id
          AND c.workspace_id = ${id} AND c.owner_user_id = ${userId}
        WHERE t.id = ${turn as Fragment} AND t.workspace_id = ${id}
          AND ${turnSourcesIncluded(tx, id, userId, "t", history)}
      )`;
  }
  return tx`
    EXISTS (
      SELECT 1 FROM opening_conversations c
      WHERE c.id = ${raw(tx, "t.conversation_id")}
        AND c.workspace_id = ${id} AND c.owner_user_id = ${userId}
    )
    AND ${raw(tx, "t.workspace_id")} = ${id}
    AND ${turnSourcesIncluded(tx, id, userId, "t", history)}`;
}

export function includedProblem(
  tx: Tx, id: string, userId: string, problem: typeof PROBLEM | Fragment, session?: Fragment, history = false,
) {
  const direct = problem === PROBLEM;
  const problemId = direct ? raw(tx, "p.problem_id") : problem as Fragment;
  const sessionId = direct ? raw(tx, "p.session_id") : session as Fragment;
  const row = direct ? raw(tx, "p") : raw(tx, "p2");
  return direct ? tx`
    ${raw(tx, "p.workspace_id")} = ${id}
    AND ${includedLearningSession(tx, id, userId, raw(tx, "p.session_id"))}
    AND EXISTS (
      SELECT 1 FROM opening_sources s
      WHERE s.id = ${raw(tx, "p.source_id")} AND s.workspace_id = ${id}
        AND (${history} OR s.version = ${raw(tx, "p.source_version")}) AND s.upload_state = 'uploaded'
        AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id = ${id} AND e.source_id = s.id)
    )
    AND (${raw(tx, "p.chunk_id")} IS NULL OR EXISTS (
      SELECT 1 FROM opening_source_chunks k
      WHERE k.id = ${raw(tx, "p.chunk_id")} AND k.source_id = ${raw(tx, "p.source_id")}
        AND k.source_version = ${raw(tx, "p.source_version")}
    ))` : tx`
    EXISTS (
      SELECT 1 FROM opening_problem_refs ${row}
      WHERE ${raw(tx, "p2.problem_id")} = ${problemId}
        AND (${history} OR ${raw(tx, "p2.session_id")} = ${sessionId})
        AND ${raw(tx, "p2.workspace_id")} = ${id}
        AND ${includedLearningSession(tx, id, userId, raw(tx, "p2.session_id"))}
        AND EXISTS (
          SELECT 1 FROM opening_sources s
          WHERE s.id = ${raw(tx, "p2.source_id")} AND s.workspace_id = ${id}
            AND (${history} OR s.version = ${raw(tx, "p2.source_version")}) AND s.upload_state = 'uploaded'
            AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id = ${id} AND e.source_id = s.id)
        )
        AND (${raw(tx, "p2.chunk_id")} IS NULL OR EXISTS (
          SELECT 1 FROM opening_source_chunks k
          WHERE k.id = ${raw(tx, "p2.chunk_id")} AND k.source_id = ${raw(tx, "p2.source_id")}
            AND k.source_version = ${raw(tx, "p2.source_version")}
        ))
    )`;
}
